import { db, eq } from "@repo/db"
import { mcpConnection } from "../../db/schema/brain/mcp"
import { slackWorkspace } from "../../db/schema/slack"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import type { McpConnectionRow } from "../tools/mcp/store"
import { KnowledgeBudget, KnowledgeProviderError, inspectKnowledgeTools, linearIssueTool, openKnowledgeProvider, pollLinear, pollSlack, slackEvidence, slackKnowledgeRequest, slackKnowledgeToken } from "./adapters"
import { reasonEvents } from "./reasoning"
import { commitKnowledge, ensureKnowledgeTables, getSource, listPendingEvents, listSources, pruneKnowledge, revokeSource, stageEvents, upsertSource, reasoningContext, visible } from "./store"
import type { Audience, KnowledgeSource } from "./types"
import { rememberSlackThreads, reconcileSlackThreads } from "./threads"

const CALLBACK = "runKnowledgeTick"
const running = new WeakSet<object>()
type Installation = typeof slackWorkspace.$inferSelect
type RuntimeConfig = { minIntervalMs: number; maxIntervalMs: number; backfillMs: number; retentionMs: number; maxSources: number; maxPages: number; maxEvents: number; pageSize: number; maxSubrequests: number; tickMs: number }

/** Optional bindings only; no change to the generated Env contract is needed. */
export function knowledgeRuntimeConfig(env: Env): RuntimeConfig {
	const config = env as unknown as Record<string, unknown>
	const number = (key: string, fallback: number, min: number, max: number) => {
		const value = Number(config[`KNOWLEDGE_${key}`])
		return Number.isFinite(value) && value > 0 ? Math.floor(Math.max(min, Math.min(max, value))) : fallback
	}
	const minIntervalMs = number("MIN_INTERVAL_MS", 60_000, 60_000, 3_600_000)
	return { minIntervalMs, maxIntervalMs: Math.max(minIntervalMs, number("MAX_INTERVAL_MS", 3_600_000, 60_000, 86_400_000)), backfillMs: number("BACKFILL_MS", 7 * 86_400_000, 60_000, 30 * 86_400_000), retentionMs: number("RETENTION_MS", 90 * 86_400_000, 86_400_000, 365 * 86_400_000), maxSources: number("MAX_SOURCES", 6, 1, 20), maxPages: number("MAX_PAGES", 6, 1, 20), maxEvents: number("MAX_EVENTS", 150, 1, 500), pageSize: number("PAGE_SIZE", 25, 1, 100), maxSubrequests: number("MAX_SUBREQUESTS", 30, 4, 50), tickMs: number("TICK_MS", 25_000, 1000, 45_000) }
}

function metadata(agent: CompanyBrainAgent) {
	agent.sql`CREATE TABLE IF NOT EXISTS brain_knowledge_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
	return {
		get<T>(key: string, fallback: T): T {
			const row = agent.sql<{ value: string }>`SELECT value FROM brain_knowledge_runtime WHERE key = ${key}`[0]
			try { return row ? JSON.parse(row.value) as T : fallback } catch { return fallback }
		},
		set(key: string, value: unknown) { agent.sql`INSERT INTO brain_knowledge_runtime (key, value) VALUES (${key}, ${JSON.stringify(value)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value` },
	}
}

function newSource(id: string, orgId: string, connectionId: string, provider: string, ownerUserId: string | null, audience: Audience, config: RuntimeConfig): KnowledgeSource {
	const baseline = provider === "slack" ? 30 * 60_000 : provider === "linear" ? 60_000 : 2 * 3_600_000
	return { id, orgId, connectionId, provider, ownerUserId, audience, state: "partial", coverage: ["discovery_pending"], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: Date.now(), intervalMs: Math.max(config.minIntervalMs, Math.min(config.maxIntervalMs, baseline)), failures: 0, error: null }
}

function sourceIdentity(agent: CompanyBrainAgent, base: string, renew = false): string {
	const state = metadata(agent)
	const current = state.get(base, base)
	if (!renew) return current
	const next = `${base}:${crypto.randomUUID()}`
	state.set(base, next)
	return next
}

async function proposalsFor(agent: CompanyBrainAgent, env: Env, source: KnowledgeSource, events: Parameters<typeof reasonEvents>[1], budget: KnowledgeBudget) {
	// Shared credentials with unverified content ACLs must not become model facts.
	if (!visible(source.audience)) throw new KnowledgeProviderError("unsupported_schema")
	if (events.every(e => e.deleted)) return { proposals: [], context: [] }
	budget.take()
	const context = reasoningContext(agent, source.id, events)
	return { proposals: await reasonEvents(env, events, context, AbortSignal.timeout(Math.max(1, budget.deadline - Date.now()))), context }
}

async function connectionRows(env: Env, orgId: string) {
	// Intentionally not listConnectionsForActor: scan every actual row, including
	// peer-owned credentials and multiple connections with the same slug.
	return db(env).select().from(mcpConnection).where(eq(mcpConnection.orgId, orgId))
}
async function installations(env: Env, orgId: string) {
	return db(env).select().from(slackWorkspace).where(eq(slackWorkspace.orgId, orgId))
}

function isLinearConnection(row: McpConnectionRow): boolean {
	try {
		const url = new URL(row.serverUrl ?? "")
		return row.serverSlug === "linear" && url.protocol === "https:" && url.hostname === "mcp.linear.app" && !url.port && !url.username && !url.password
	} catch { return false }
}

function failure(source: KnowledgeSource, error: unknown, config: RuntimeConfig, now: number): KnowledgeSource {
	const safe = error instanceof KnowledgeProviderError ? error : new KnowledgeProviderError("provider_failed")
	const intervalMs = Math.min(config.maxIntervalMs, Math.max(config.minIntervalMs, source.intervalMs * 2))
	return { ...source, state: safe.code === "revoked" ? "revoked" : safe.code === "unsupported_schema" ? "unsupported" : "error", failures: Math.min(30, source.failures + 1), error: safe.code, intervalMs, lastCheckedAt: now, nextCheckAt: now + Math.max(intervalMs, Math.min(7 * 86_400_000, safe.retryAfterMs)) }
}

function recordFailure(agent: CompanyBrainAgent, source: KnowledgeSource, error: unknown, config: RuntimeConfig, now: number) {
	const current = getSource(agent, source.id) ?? source
	// Revocation can interleave with network/model awaits. It must always win.
	if (current.state === "revoked") return
	const failed = failure(current, error, config, now)
	upsertSource(agent, failed)
	if (failed.state === "revoked") revokeSource(agent, failed.id)
}

/** Register every row immediately; capability/channel exploration rotates in bounded chunks. */
export async function discoverKnowledgeSources(agent: CompanyBrainAgent, orgId: string, providedBudget?: KnowledgeBudget): Promise<KnowledgeSource[]> {
	ensureKnowledgeTables(agent)
	const env = brainAgent(agent).env, config = knowledgeRuntimeConfig(env), now = Date.now()
	const budget = providedBudget ?? new KnowledgeBudget(config.maxSubrequests, now + config.tickMs)
	const state = metadata(agent)
	budget.take(2)
	const [connections, workspaces] = await Promise.all([connectionRows(env, orgId), installations(env, orgId)])
	const existing = new Map(listSources(agent).filter(s => s.orgId === orgId).map(s => [s.id, s]))
	const liveConnections = new Set(connections.map(c => c.id)), liveTeams = new Set(workspaces.map(w => w.teamId))
	for (const source of existing.values()) {
		if (source.provider.startsWith("slack")) {
			if (!liveTeams.has(source.connectionId.replace(/^slack:/, ""))) revokeSource(agent, source.id)
		} else if (!liveConnections.has(source.connectionId)) revokeSource(agent, source.id)
	}
	for (const row of connections) {
		let id = sourceIdentity(agent, `mcp:${row.id}`)
		let prior = getSource(agent, id)
		if (prior && row.status === "active" && (prior.state === "revoked" || prior.ownerUserId !== row.userId)) {
			if (prior.state !== "revoked") revokeSource(agent, prior.id)
			id = sourceIdentity(agent, `mcp:${row.id}`, true)
			prior = undefined
		}
		const source = prior ?? newSource(id, orgId, row.id, row.serverSlug, row.userId, { kind: "users", userIds: row.userId ? [row.userId] : [] }, config)
		// Recompute audience, never retain a formerly broader grant after ownership changes.
		source.ownerUserId = row.userId
		source.audience = { kind: "users", userIds: row.userId ? [row.userId] : [] }
		if (row.status !== "active") {
			if (!prior) upsertSource(agent, source)
			revokeSource(agent, id)
			continue
		}
		upsertSource(agent, source)
	}
	// Keep installation-level coverage visible, even if scopes/channel listing fail.
	for (const workspace of workspaces) {
		let id = sourceIdentity(agent, `slack-install:${workspace.teamId}`)
		if (getSource(agent, id)?.state === "revoked") id = sourceIdentity(agent, `slack-install:${workspace.teamId}`, true)
		const source = getSource(agent, id) ?? newSource(id, orgId, `slack:${workspace.teamId}`, "slack_installation", null, { kind: "users", userIds: [] }, config)
		upsertSource(agent, source)
	}
	const candidates: Array<{ kind: "mcp"; row: McpConnectionRow } | { kind: "slack"; row: Installation }> = [
		...connections.filter(c => c.status === "active").map(row => ({ kind: "mcp" as const, row })),
		...workspaces.map(row => ({ kind: "slack" as const, row })),
	].sort((a, b) => (a.kind === "mcp" ? a.row.id : a.row.teamId).localeCompare(b.kind === "mcp" ? b.row.id : b.row.teamId))
	if (candidates.length && budget.remaining >= 3) {
		const index = state.get("discovery_rotation", 0) % candidates.length
		state.set("discovery_rotation", (index + 1) % candidates.length)
		const candidate = candidates[index]!
		const id = sourceIdentity(agent, candidate.kind === "mcp" ? `mcp:${candidate.row.id}` : `slack-install:${candidate.row.teamId}`)
		let source = getSource(agent, id)!
		const lastDiscovery = state.get(`checked:${id}`, 0)
		if (source.nextCheckAt <= now && (source.coverage.includes("discovery_pending") || now - lastDiscovery >= 3_600_000 || candidate.kind === "slack" && state.get<string | null>(`channels:${id}`, null) !== null)) {
			try {
				if (candidate.kind === "mcp") {
					const handle = await openKnowledgeProvider(env, candidate.row, budget)
					try {
						const tools = await inspectKnowledgeTools(handle, budget)
						const supported = isLinearConnection(candidate.row) && linearIssueTool(tools)
						source = { ...source, state: supported ? "partial" : "unsupported", coverage: supported ? ["issues_updated_window", "no_acl_verification", "no_deletion_feed", "tool_catalog_first_page"] : ["no_verified_scan_adapter", "tool_catalog_first_page"], error: null, failures: 0 }
					} finally { await handle.close() }
				} else {
					const token = await slackKnowledgeToken(env, candidate.row.botTokenEnc)
					const cursor = state.get<string | null>(`channels:${id}`, null)
					const page = await slackKnowledgeRequest(token, "users.conversations", { types: "public_channel,private_channel", exclude_archived: "true", limit: "100", ...(cursor ? { cursor } : {}) }, budget)
					if (!Array.isArray(page.channels)) throw new KnowledgeProviderError("invalid_response")
					const seen = new Set(state.get<string[]>(`seen:${id}`, []))
					for (const channel of page.channels as Array<{ id?: string }>) {
						if (!channel.id) continue
						seen.add(channel.id)
						const base = `slack:${candidate.row.teamId}:${channel.id}`
						let channelId = sourceIdentity(agent, base)
						if (getSource(agent, channelId)?.state === "revoked") channelId = sourceIdentity(agent, base, true)
						const channelSource = getSource(agent, channelId) ?? newSource(channelId, orgId, `slack:${candidate.row.teamId}`, "slack", null, { kind: "slack_channel", teamId: candidate.row.teamId, channelId: channel.id }, config)
						if (channelSource.state !== "error") channelSource.state = "partial"
						channelSource.coverage = [...new Set(["joined_channel_history", "webhook_replies_edits_deletions", ...(channelSource.coverage.includes("known_thread_reconciliation") ? channelSource.coverage.filter(c => c !== "no_thread_reconciliation") : ["no_thread_reconciliation"])])]
						upsertSource(agent, channelSource)
					}
					const next = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor?.trim() || null
					if (next && next === cursor) throw new KnowledgeProviderError("invalid_response")
					if (!next) {
						for (const prior of listSources(agent)) if (prior.orgId === orgId && prior.provider === "slack" && prior.connectionId === source.connectionId && prior.audience.kind === "slack_channel" && !seen.has(prior.audience.channelId)) revokeSource(agent, prior.id)
						state.set(`seen:${id}`, [])
					} else state.set(`seen:${id}`, [...seen])
					state.set(`channels:${id}`, next)
					source = { ...source, state: "partial", coverage: next ? ["joined_channel_discovery_in_progress"] : ["joined_channels_discovered", "no_thread_reconciliation"], error: null, failures: 0 }
				}
				state.set(`checked:${id}`, now)
				// Capability inspection must not defer already-due content ingestion.
				if (candidate.kind === "slack") {
					source.lastCheckedAt = now
					source.nextCheckAt = now + config.minIntervalMs
				}
				upsertSource(agent, source)
			} catch (error) {
				if (!(error instanceof KnowledgeProviderError && error.code === "budget_exhausted")) recordFailure(agent, source, error, config, now)
			}
		}
	}
	return listSources(agent).filter(s => s.orgId === orgId)
}

/** A durable cron survives missed alarms/restarts. Every invocation processes overdue work. */
export async function ensureKnowledgeSchedule(agent: CompanyBrainAgent, orgId: string): Promise<void> {
	const schedules = agent.getSchedules<{ orgId: string }>().filter(s => s.callback === CALLBACK)
	const keep = schedules.find(s => s.type === "cron" && s.cron === "* * * * *" && s.payload?.orgId === orgId)
	for (const schedule of schedules) if (schedule.id !== keep?.id) await agent.cancelSchedule(schedule.id)
	if (!keep) await agent.schedule("* * * * *", CALLBACK, { orgId })
}

export async function runKnowledgeTick(agent: CompanyBrainAgent, payload: { orgId: string }, sharedBudget?: KnowledgeBudget): Promise<void> {
	if (!payload.orgId || running.has(agent)) return
	running.add(agent)
	const env = brainAgent(agent).env, config = knowledgeRuntimeConfig(env), now = Date.now()
	const budget = sharedBudget ?? new KnowledgeBudget(config.maxSubrequests, now + config.tickMs)
	try {
		await ensureKnowledgeSchedule(agent, payload.orgId)
		await discoverKnowledgeSources(agent, payload.orgId, budget)
		await reconcileSlackThreads(agent, env, payload.orgId, budget)
		const due = listSources(agent).filter(s => ["active", "partial", "error"].includes(s.state) && s.provider !== "slack_installation" && !s.coverage.includes("discovery_pending") && s.nextCheckAt <= now)
		// Oldest attempted first rotates fairly, including repeated provider failures.
		due.sort((a, b) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0) || a.id.localeCompare(b.id))
		budget.take(2)
		const [connections, workspaces] = await Promise.all([connectionRows(env, payload.orgId), installations(env, payload.orgId)])
		const state = metadata(agent)
		let eventsLeft = config.maxEvents, pagesLeft = config.maxPages
		for (const source of due.slice(0, config.maxSources)) {
			if (!eventsLeft || !pagesLeft || budget.remaining < 3 || Date.now() >= budget.deadline) break
			if (source.provider === "slack" && state.get(`cooldown:${source.connectionId}`, 0) > now) continue
			if (!visible(source.audience)) {
				upsertSource(agent, { ...source, state: "partial", coverage: [...new Set([...source.coverage, "source_audience_unverified"])], error: "source_audience_unverified", nextCheckAt: now + config.maxIntervalMs })
				continue
			}
			try {
				const pending = listPendingEvents(agent, source.id, Math.min(eventsLeft, config.pageSize))
				if (pending.length) {
					// A staged checkpoint is not the source cursor. It is promoted only
					// after every pending chunk commits, including after configuration changes.
					const state = metadata(agent)
					const checkpoint = state.get<{ cursor: string | null; processedThrough: number } | null>(`pending:${source.id}`, null)
					const { proposals, context } = await proposalsFor(agent, env, source, pending, budget)
					const priorWatermark = source.processedThrough ?? Math.max(0, Math.min(...pending.map(e => e.observedAt)) - config.backfillMs - 60_000)
					commitKnowledge(agent, source.id, pending.map(e => e.eventId), proposals, priorWatermark, context)
					eventsLeft -= pending.length; pagesLeft--
					const current = getSource(agent, source.id)!
					const drained = !listPendingEvents(agent, source.id, 1).length
					upsertSource(agent, { ...current, ...(checkpoint && drained ? { cursor: checkpoint.cursor, processedThrough: checkpoint.processedThrough } : {}), lastCheckedAt: now, nextCheckAt: now + config.minIntervalMs, failures: 0, error: null, state: "partial" })
					if (drained) state.set(`pending:${source.id}`, null)
					continue
				}
				const opts = { now, backfillMs: config.backfillMs, limit: Math.min(eventsLeft, config.pageSize) }
				let page
				if (source.provider === "linear") {
					const row = connections.find(c => c.id === source.connectionId && c.status === "active")
					if (!row) { revokeSource(agent, source.id); continue }
					if (!isLinearConnection(row)) throw new KnowledgeProviderError("unsupported_schema")
					const handle = await openKnowledgeProvider(env, row, budget)
					try {
						const tool = linearIssueTool(await inspectKnowledgeTools(handle, budget))
						if (!tool) throw new KnowledgeProviderError("unsupported_schema")
						page = await pollLinear(source, handle, tool, budget, opts)
					} finally { await handle.close() }
				} else if (source.provider === "slack" && source.audience.kind === "slack_channel") {
					const teamId = source.audience.teamId
					const install = workspaces.find(w => w.teamId === teamId)
					if (!install) { revokeSource(agent, source.id); continue }
					const token = await slackKnowledgeToken(env, install.botTokenEnc)
					const membership = await slackKnowledgeRequest(token, "conversations.info", { channel: source.audience.channelId }, budget)
					if ((membership.channel as { is_member?: boolean } | undefined)?.is_member !== true) { revokeSource(agent, source.id); continue }
					page = await pollSlack(source, token, budget, opts)
				} else continue
				pagesLeft--; eventsLeft -= page.events.length
				stageEvents(agent, source, page.events)
				rememberSlackThreads(agent, source, page.events, page.threadRoots)
				metadata(agent).set(`pending:${source.id}`, { cursor: page.cursor, processedThrough: page.processedThrough })
				const staged = listPendingEvents(agent, source.id, opts.limit)
				if (staged.length) {
					const { proposals, context } = await proposalsFor(agent, env, source, staged, budget)
					commitKnowledge(agent, source.id, staged.map(e => e.eventId), proposals, page.processedThrough, context)
				}
				const current = getSource(agent, source.id)!
				const trackerMax = source.provider === "linear" ? Math.min(config.maxIntervalMs, 5 * 60_000) : config.maxIntervalMs
				const activityMin = source.provider === "slack" ? Math.max(config.minIntervalMs, 5 * 60_000) : config.minIntervalMs
				const intervalMs = !page.complete ? config.minIntervalMs : page.events.length
					? Math.max(activityMin, Math.floor(source.intervalMs / 2))
					: Math.min(trackerMax, Math.max(config.minIntervalMs, source.intervalMs * 2))
				// Cursor only changes after commit. Empty successful pages may advance a
				// checked watermark but must never pretend that knowledge was processed.
				upsertSource(agent, { ...current, cursor: page.cursor, processedThrough: page.processedThrough, state: "partial", lastCheckedAt: now, nextCheckAt: now + intervalMs, intervalMs, failures: 0, error: null })
				metadata(agent).set(`pending:${source.id}`, null)
			} catch (error) {
				if (error instanceof KnowledgeProviderError && error.code === "budget_exhausted") break
				if (source.provider === "slack" && error instanceof KnowledgeProviderError && error.code === "rate_limited") state.set(`cooldown:${source.connectionId}`, now + Math.max(config.minIntervalMs, Math.min(7 * 86_400_000, error.retryAfterMs)))
				recordFailure(agent, source, error, config, now)
			}
		}
		if (now - state.get("last_pruned", 0) >= 86_400_000) { pruneKnowledge(agent, config.retentionMs); state.set("last_pruned", now) }
	} finally { running.delete(agent) }
}

/** Call only after the parent verifies Slack signatures and resolves the owning org. */
export async function ingestSlackKnowledgeEvent(agent: CompanyBrainAgent, payload?: unknown, sharedBudget?: KnowledgeBudget): Promise<boolean> {
	if (!payload || typeof payload !== "object") return false
	const envelope = payload as { team_id?: string; event_id?: string; event?: { type?: string; channel?: string; event_ts?: string } }
	if (envelope.event?.type !== "message" || !envelope.team_id || !envelope.event.channel) return false
	ensureKnowledgeTables(agent)
	const source = getSource(agent, sourceIdentity(agent, `slack:${envelope.team_id}:${envelope.event.channel}`))
	if (!source || source.state === "revoked" || source.provider !== "slack") return false
	const env = brainAgent(agent).env, config = knowledgeRuntimeConfig(env), now = Date.now()
	// Verify the installation still exists and the bot is still joined; no source
	// is invented from an untrusted webhook and no broad publication is performed.
	const budget = sharedBudget ?? new KnowledgeBudget(2, now + 10_000)
	budget.take()
	const workspace = (await installations(env, source.orgId)).find(w => w.teamId === envelope.team_id)
	if (!workspace) { revokeSource(agent, source.id); return false }
	try {
		const token = await slackKnowledgeToken(env, workspace.botTokenEnc)
		const cooldown = metadata(agent).get(`cooldown:${source.connectionId}`, 0)
		if (cooldown > now) throw new KnowledgeProviderError("rate_limited", cooldown - now)
		const info = await slackKnowledgeRequest(token, "conversations.info", { channel: envelope.event.channel }, budget)
		if ((info.channel as { is_member?: boolean } | undefined)?.is_member !== true) { revokeSource(agent, source.id); return false }
		const event = slackEvidence(source, envelope.event, now, envelope.event_id, envelope.event.event_ts)
		if (!event) return false
		stageEvents(agent, source, [event])
		rememberSlackThreads(agent, source, [event])
		upsertSource(agent, { ...(getSource(agent, source.id) ?? source), nextCheckAt: now })
		await ensureKnowledgeSchedule(agent, source.orgId)
		return true
	} catch (error) {
		if (error instanceof KnowledgeProviderError && error.code === "rate_limited") metadata(agent).set(`cooldown:${source.connectionId}`, now + Math.max(config.minIntervalMs, error.retryAfterMs))
		recordFailure(agent, source, error, config, now)
		throw error instanceof KnowledgeProviderError ? error : new KnowledgeProviderError("provider_failed")
	}
}
