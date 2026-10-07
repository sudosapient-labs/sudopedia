import { decryptToken } from "@/lib/crypto"
import { createHash } from "node:crypto"
import { getSlackChannelHistoryPage } from "../slack/client"
import { connectMcpClient } from "../tools/mcp/client"
import { connectToolProvider, type ProviderTool, type ToolProviderHandle } from "../tools/mcp/provider"
import type { McpConnectionRow } from "../tools/mcp/store"
import type { EvidenceEvent, KnowledgeSource } from "./types"

/** Only fixed codes leave this module: provider exceptions may contain tokens. */
export class KnowledgeProviderError extends Error {
	constructor(public readonly code: "provider_failed" | "rate_limited" | "invalid_response" | "unsupported_schema" | "budget_exhausted" | "revoked", public readonly retryAfterMs = 0) {
		super(code)
	}
}

export class KnowledgeBudget {
	constructor(public remaining: number, public readonly deadline: number, private readonly cancellation?: AbortSignal) {}
	take(count = 1) {
		if (this.cancellation?.aborted || this.remaining < count || Date.now() >= this.deadline) throw new KnowledgeProviderError("budget_exhausted")
		this.remaining -= count
	}
	signal() {
		const timeout = AbortSignal.timeout(Math.max(1, Math.min(10_000, this.deadline - Date.now())))
		return this.cancellation ? AbortSignal.any([timeout, this.cancellation]) : timeout
	}
}

export type PollPage = { events: EvidenceEvent[]; cursor: string | null; processedThrough: number; complete: boolean; threadRoots?: string[] }
type WindowCursor = { since: number; through: number; next?: string; seen?: number[] }
const OVERLAP_MS = 60_000
const TEXT_LIMIT = 12_000

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function string(value: unknown): string { return typeof value === "string" ? value : "" }
function timestamp(value: unknown): number { return typeof value === "number" ? value : Date.parse(string(value)) }
function label(value: unknown): string {
	if (typeof value === "string") return value
	const row = record(value)
	return [row.id, row.name, row.email].filter(v => typeof v === "string").join(" ")
}

function providerFailure(error: unknown): KnowledgeProviderError {
	if (error instanceof KnowledgeProviderError) return error
	const row = record(error), data = record(row.data), response = record(row.response)
	const header = response.headers instanceof Headers ? response.headers.get("retry-after") : undefined
	const seconds = Number(row.retryAfterSeconds ?? data.retryAfterSeconds ?? header)
	if (Number.isFinite(seconds) && seconds > 0) return new KnowledgeProviderError("rate_limited", Math.min(7 * 86_400, seconds) * 1000)
	return new KnowledgeProviderError(row.status === 429 || data.status === 429 ? "rate_limited" : "provider_failed")
}

export function readWindow(source: KnowledgeSource, now: number, backfillMs: number): WindowCursor {
	if (source.cursor) {
		try {
			const row = record(JSON.parse(source.cursor))
			if (typeof row.since === "number" && typeof row.through === "number" && Number.isFinite(row.since) && Number.isFinite(row.through) && row.since <= row.through && (!row.next || typeof row.next === "string")) {
				return { since: row.since, through: row.through, ...(row.next ? { next: String(row.next) } : {}), ...(Array.isArray(row.seen) && row.seen.length <= 512 && row.seen.every(v => Number.isSafeInteger(v)) ? { seen: row.seen as number[] } : {}) }
			}
		} catch { /* Restart from the committed watermark, never skip ahead. */ }
	}
	return { since: Math.max(0, (source.processedThrough ?? now - backfillMs) - OVERLAP_MS), through: now }
}

function continuedWindow(window: WindowCursor, next: string): string {
	// Compact hashes keep durable cursors bounded while detecting multi-page cycles.
	let hash = 2166136261
	for (const character of next) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
	const seen = window.seen ?? []
	if (!next || next === window.next || next.length > 2048 || seen.includes(hash) || seen.length >= 512) throw new KnowledgeProviderError("invalid_response")
	const cursor = JSON.stringify({ ...window, next, seen: [...seen, hash] })
	if (cursor.length > 8192) throw new KnowledgeProviderError("invalid_response")
	return cursor
}

/** Inspect live schemas; never synthesize unknown required arguments. */
export function linearIssueTool(tools: ProviderTool[]): ProviderTool | undefined {
	const tool = tools.find(t => t.name === "list_issues" && t.annotations?.destructiveHint !== true && t.annotations?.readOnlyHint !== false)
	if (!tool) return undefined
	const props = record(tool.inputSchema.properties)
	if (!["updatedAt", "orderBy", "cursor", "limit"].every(key => key in props)) return undefined
	if (record(props.updatedAt).type !== "string" || record(props.cursor).type !== "string" || record(props.limit).type !== "number" && record(props.limit).type !== "integer") return undefined
	const order = record(props.orderBy)
	if (Array.isArray(order.enum) && !order.enum.includes("updatedAt")) return undefined
	if ((tool.inputSchema.required ?? []).some(key => !["updatedAt", "orderBy", "limit"].includes(key))) return undefined
	return tool
}

export async function openKnowledgeProvider(env: Env, row: McpConnectionRow, budget: KnowledgeBudget): Promise<ToolProviderHandle> {
	budget.take(6) // Conservative reserve for transport initialization, OAuth, and cleanup.
	try {
		const origin = env.PUBLIC_URL || env.CONSUMER_APP_URL
		if (!origin) throw new KnowledgeProviderError("provider_failed")
		const callbackUrl = new URL("/brain/mcp-connections/callback", origin).toString()
		if (row.runtime === "embedded") return await connectToolProvider(env, row, callbackUrl)
		const signal = budget.signal()
		const handle = await connectMcpClient(env, row, callbackUrl, { signal, timeoutMs: Math.max(1, Math.min(10_000, budget.deadline - Date.now())) })
		return {
			listTools: async () => (await handle.client.listTools(undefined, { signal: budget.signal(), timeout: Math.max(1, Math.min(10_000, budget.deadline - Date.now())) })).tools,
			callTool: (name, args) => handle.client.callTool({ name, arguments: args }, undefined, { signal: budget.signal(), timeout: Math.max(1, Math.min(10_000, budget.deadline - Date.now())) }),
			close: handle.close,
		}
	} catch (error) { throw providerFailure(error) }
}

export async function inspectKnowledgeTools(handle: ToolProviderHandle, budget: KnowledgeBudget): Promise<ProviderTool[]> {
	// Bounded first listTools page. Missing tools on later pages mean partial coverage,
	// not permission to guess names or invoke arbitrary discovery tools.
	budget.take()
	try { return await handle.listTools() } catch (error) { throw providerFailure(error) }
}

function decodeMcp(value: unknown): Record<string, unknown> {
	const result = record(value)
	if (result.isError === true) throw new KnowledgeProviderError("provider_failed")
	if (result.structuredContent) return record(result.structuredContent)
	if (Array.isArray(result.content)) {
		for (const part of result.content) {
			const block = record(part)
			if (block.type === "text" && typeof block.text === "string") {
				if (block.text.length > 1_000_000) throw new KnowledgeProviderError("invalid_response")
				try { return record(JSON.parse(block.text)) } catch { /* Never parse prose with a model. */ }
			}
		}
		throw new KnowledgeProviderError("invalid_response")
	}
	return result
}

export async function pollLinear(source: KnowledgeSource, handle: ToolProviderHandle, tool: ProviderTool, budget: KnowledgeBudget, opts: { now: number; backfillMs: number; limit: number }): Promise<PollPage> {
	const window = readWindow(source, opts.now, opts.backfillMs)
	const args: Record<string, unknown> = { updatedAt: new Date(window.since).toISOString(), orderBy: "updatedAt", limit: opts.limit, ...(window.next ? { cursor: window.next } : {}) }
	const props = record(tool.inputSchema.properties)
	// Linear's published orderBy is a field, not an ascending guarantee. Request
	// ascending only when the actual schema supports it; watermark the whole window.
	for (const key of ["orderDirection", "sortDirection", "direction"]) {
		const property = record(props[key])
		if (Array.isArray(property.enum) && property.enum.includes("asc")) args[key] = "asc"
	}
	budget.take()
	let result: Record<string, unknown>
	try { result = decodeMcp(await handle.callTool(tool.name, args)) }
	catch (error) { throw providerFailure(error) }
	if (!Array.isArray(result.issues) || result.issues.length > opts.limit) throw new KnowledgeProviderError("invalid_response")
	const pageInfo = record(result.pageInfo)
	const more = result.hasNextPage ?? pageInfo.hasNextPage
	const next = string(result.cursor) || string(result.nextCursor) || string(pageInfo.endCursor)
	if (more !== false && more !== true && !next) throw new KnowledgeProviderError("invalid_response")
	const complete = more === false || more === undefined && !next
	if (!complete && (!next || next === window.next)) throw new KnowledgeProviderError("invalid_response")
	const events = result.issues.map(value => {
		const issue = record(value)
		const id = string(issue.id), updated = timestamp(issue.updatedAt)
		if (!id || !Number.isFinite(updated)) throw new KnowledgeProviderError("invalid_response")
		return { sourceId: source.id, eventId: `${source.id}:${id}:${updated}`, objectId: id, version: updated, occurredAt: updated, observedAt: opts.now, deleted: false, url: string(issue.url), audience: source.audience,
			text: [`Linear issue ${string(issue.identifier)} (${id})`, string(issue.title), `Status: ${label(issue.status ?? issue.state) || "unknown"}`, `Assignee: ${label(issue.assignee) || "unassigned"}`, string(issue.description)].join("\n").slice(0, Math.min(TEXT_LIMIT, Math.floor(300_000 / opts.limit / 4))) } satisfies EvidenceEvent
	}).filter(event => event.occurredAt >= window.since && event.occurredAt <= window.through).sort((a, b) => a.version - b.version || a.objectId.localeCompare(b.objectId))
	return { events, cursor: complete ? null : continuedWindow(window, next), processedThrough: complete ? window.through : source.processedThrough ?? window.since, complete }
}

export async function slackKnowledgeToken(env: Env, encrypted: string): Promise<string> {
	try { return await decryptToken(encrypted, env.ENCRYPTION_SECRET) } catch { throw new KnowledgeProviderError("provider_failed") }
}

/** Single non-retrying Slack request, preserving Retry-After without raw errors. */
export async function slackKnowledgeRequest(token: string, method: "users.conversations" | "conversations.info" | "conversations.history" | "conversations.replies", params: Record<string, string>, budget: KnowledgeBudget): Promise<Record<string, unknown>> {
	budget.take()
	try {
		const url = new URL(`https://slack.com/api/${method}`)
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
		const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: budget.signal() })
		if (response.status === 429) throw new KnowledgeProviderError("rate_limited", Math.max(1, Number(response.headers.get("retry-after")) || 1) * 1000)
		if (!response.ok) throw new KnowledgeProviderError("provider_failed")
		if (Number(response.headers.get("content-length")) > 256 * 1024 || !response.body) throw new KnowledgeProviderError("invalid_response")
		const reader = response.body.getReader(), chunks: Uint8Array[] = []
		let size = 0
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				size += value.byteLength
				if (size > 256 * 1024) { await reader.cancel(); throw new KnowledgeProviderError("invalid_response") }
				chunks.push(value)
			}
		} finally { reader.releaseLock() }
		const data = new Uint8Array(size); let offset = 0
		for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
		const body = record(JSON.parse(new TextDecoder().decode(data)))
		if (body.ok !== true) throw new KnowledgeProviderError(["token_revoked", "account_inactive", "not_in_channel", "channel_not_found"].includes(string(body.error)) ? "revoked" : "provider_failed")
		return body
	} catch (error) { throw error instanceof KnowledgeProviderError ? error : new KnowledgeProviderError("provider_failed") }
}

export function slackEvidence(source: KnowledgeSource, raw: unknown, now: number, eventId?: string, eventTs?: string): EvidenceEvent | null {
	const outer = record(raw)
	const deleted = outer.subtype === "message_deleted"
	const message = outer.subtype === "message_changed" ? record(outer.message) : outer
	const ts = string(deleted ? outer.deleted_ts : message.ts)
	if (!/^\d+\.\d+$/.test(ts)) return null
	const versionTs = eventTs || string(record(message.edited).ts) || string(outer.event_ts) || ts
	const version = Math.round(Number(versionTs) * 1_000_000)
	if (!Number.isSafeInteger(version)) return null
	const audience = source.audience
	if (audience.kind !== "slack_channel") return null
	const content = `Slack message ${ts}; user ${string(message.user)}; thread ${string(message.thread_ts) || ts}\n${string(message.text)}`
	const contentVersion = Math.round(Number(string(record(message.edited).ts) || ts) * 1_000_000)
	if (!Number.isSafeInteger(contentVersion)) return null
	return { sourceId: source.id, eventId: `${source.id}:${eventId || `${ts}:${version}:${deleted ? "deleted" : "message"}`}`, objectId: ts, version,
		occurredAt: Math.round(Number(ts) * 1000), observedAt: now, deleted, audience,
		url: `https://app.slack.com/archives/${audience.channelId}/p${ts.replace(".", "")}`,
		text: deleted ? "" : content.slice(0, TEXT_LIMIT),
		contentFingerprint: createHash("sha256").update(content).digest("hex"), contentVersion,
		context: `slack-thread:${string(message.thread_ts) || ts}`,
	}
}

export async function pollSlack(source: KnowledgeSource, token: string, budget: KnowledgeBudget, opts: { now: number; backfillMs: number; limit: number }): Promise<PollPage> {
	if (source.audience.kind !== "slack_channel") throw new KnowledgeProviderError("invalid_response")
	const window = readWindow(source, opts.now, opts.backfillMs)
	budget.take()
	const page = await getSlackChannelHistoryPage(token, source.audience.channelId, { oldest: String(window.since / 1000), latest: String(window.through / 1000), cursor: window.next, limit: opts.limit, signal: budget.signal() })
	if (!page.ok) throw new KnowledgeProviderError(page.retryAfterSeconds ? "rate_limited" : "provider_failed", (page.retryAfterSeconds ?? 0) * 1000)
	if (page.items.length > opts.limit || !page.complete && (!page.nextCursor || page.nextCursor === window.next)) throw new KnowledgeProviderError("invalid_response")
	const events = page.items.flatMap(message => { const event = slackEvidence(source, message, opts.now); return event ? [{ ...event, text: event.text.slice(0, Math.min(TEXT_LIMIT, Math.floor(300_000 / opts.limit / 4))) }] : [] }).sort((a, b) => a.version - b.version)
	return { events, cursor: page.complete ? null : continuedWindow(window, page.nextCursor ?? ""), processedThrough: page.complete ? window.through : source.processedThrough ?? window.since, complete: page.complete,
		threadRoots: page.items.filter(m => (m.reply_count ?? 0) > 0 && m.ts).map(m => m.ts!) }
}
