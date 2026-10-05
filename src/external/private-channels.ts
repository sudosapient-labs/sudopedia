import { z } from "zod"
import { decryptToken } from "@/lib/crypto"
import { privateSlackChannelContainerTag } from "../brain/memory/writeback"
import { memoryClient } from "../memory/client"
import type { Principal, SearchInput } from "./contracts"
import { ExternalError } from "./errors"
import { sharedSearchRequest } from "./search-request"

const unavailable = () => new ExternalError("private_access_unverified", 503,
	"Private-channel access could not be verified; search coverage is incomplete")
const incomplete = () => new ExternalError("private_access_incomplete", 503,
	"Private-channel discovery or membership verification exceeded its bounded coverage")
const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/)
const cursorMetadata = z.object({ next_cursor: z.string().max(1000).optional() }).optional()
const identitySchema = z.object({
	team_id: slackId, slack_user_id: slackId, bot_token_enc: z.string().min(1),
	bot_user_id: slackId.nullable(), scopes: z.string().nullable(),
})
// Validate the fields consumed by private recall. The SDK only parses JSON; its
// TypeScript response types are not runtime validation. Memories-only searches
// must not silently drop malformed rows or accept historical chunk results.
const privateMemorySchema = z.object({
	id: z.string().min(1).max(200), memory: z.string(),
	similarity: z.number().finite(),
	metadata: z.record(z.string(), z.unknown()).nullable().optional(),
	updatedAt: z.string().optional(), chunk: z.never().optional(),
})
function privateRequestBudget() {
	// Stay below the Free-plan 50 external-subrequest ceiling, leaving room for
	// shared/personal recall and transport overhead. No retries in either path.
	let remaining = 40
	return (count = 1) => {
		if (count > remaining) throw incomplete()
		remaining -= count
	}
}

/** Strict live Slack reads only. No retry, cache, partial-on-error or Slack writes. */
export async function livePrivateChannels(token: string,
	identity: { teamId: string; slackUserId: string; botUserId: string | null; scopes: string | null },
	requestSignal: AbortSignal, fetcher: typeof fetch = fetch,
	consumeRequest = privateRequestBudget()): Promise<string[]> {
	const controller = new AbortController()
	const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(8000), controller.signal])
	try {
		const scopes = new Set((identity.scopes ?? "").split(/[\s,]+/))
		if (["groups:read", "users:read", "team:read"].some((s) => !scopes.has(s)) ||
			!slackId.safeParse(identity.teamId).success || !slackId.safeParse(identity.slackUserId).success ||
			identity.slackUserId === identity.botUserId) throw unavailable()
		const call = async (method: string, params: Record<string, string> = {}) => {
			signal.throwIfAborted()
			const url = new URL(`https://slack.com/api/${method}`)
			for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
			consumeRequest()
			const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal })
			if (!response.ok || !response.body) throw unavailable()
			const reader = response.body.getReader()
			const chunks: Uint8Array[] = []; let size = 0
			try {
				while (true) {
					signal.throwIfAborted()
					const { done, value } = await reader.read()
					if (done) break
					size += value.byteLength
					if (size > 256 * 1024) { await reader.cancel(); throw unavailable() }
					chunks.push(value)
				}
			} finally { reader.releaseLock() }
			const bytes = new Uint8Array(size); let offset = 0
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
			const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes))
			if (!z.object({ ok: z.literal(true) }).safeParse(data).success) throw unavailable()
			return data
		}
		const auth = z.object({ team_id: slackId, user_id: slackId }).parse(await call("auth.test"))
		if (auth.team_id !== identity.teamId ||
			(identity.botUserId && auth.user_id !== identity.botUserId)) throw unavailable()
		const { user } = z.object({ user: z.object({ id: slackId, team_id: slackId,
			deleted: z.literal(false), is_bot: z.literal(false) }) }).parse(
			await call("users.info", { user: identity.slackUserId }))
		if (user.id !== identity.slackUserId || user.team_id !== identity.teamId || user.id === auth.user_id)
			throw unavailable()
		// Bot-visible channel discovery is NOT employee authorization. Positive live
		// conversations.members evidence below is required before each channel search.
		const channels = new Set<string>(); let cursor = ""
		const seen = new Set<string>()
		for (let page = 0; page < 3; page++) {
			const data = z.object({ channels: z.array(z.object({ id: slackId,
				is_private: z.boolean(), is_archived: z.boolean() })).max(200),
				response_metadata: cursorMetadata }).parse(await call("conversations.list", {
				types: "private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}),
			}))
			for (const channel of data.channels)
				if (channel.is_private && !channel.is_archived) channels.add(channel.id)
			if (channels.size > 20) throw incomplete()
			cursor = data.response_metadata?.next_cursor?.trim() ?? ""
			if (!cursor) break
			if (seen.has(cursor) || page === 2) throw incomplete()
			seen.add(cursor)
		}
		const permitted: string[] = [], queue = [...channels]
		await Promise.all(Array.from({ length: 2 }, async () => {
			while (queue.length) {
				const channel = queue.shift()!; let cursor = ""
				const seen = new Set<string>()
				for (let page = 0; page < 5; page++) {
					const data = z.object({ members: z.array(slackId).max(200), response_metadata: cursorMetadata })
						.parse(await call("conversations.members", { channel, limit: "200", ...(cursor ? { cursor } : {}) }))
					if (data.members.includes(identity.slackUserId)) { permitted.push(channel); break }
					cursor = data.response_metadata?.next_cursor?.trim() ?? ""
					if (!cursor) break
					if (seen.has(cursor) || page === 4) throw incomplete()
					seen.add(cursor)
				}
			}
		}))
		signal.throwIfAborted()
		return permitted.sort()
	} catch (error) {
		controller.abort()
		if (error instanceof ExternalError) throw error
		throw unavailable() // Never leak tokens, names, Slack errors or caller data.
	}
}

export async function privateChannelSearch(env: Env, input: SearchInput,
	principal: Principal, requestSignal: AbortSignal,
	// Used only by the separately bundled fictional Worker. Never caller input.
	adapters?: { slackFetch?: typeof fetch; search?: (containerTag: string, signal: AbortSignal) => Promise<{ results: unknown[] }> }) {
	const controller = new AbortController()
	const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(8000), controller.signal])
	try {
		const consumeRequest = privateRequestBudget()
		// Require exactly one active identity; do not guess a workspace or email-match.
		const rows = await env.DB.prepare(`SELECT w.team_id, w.bot_token_enc, w.bot_user_id, w.scopes, s.slack_user_id
			FROM slack_workspace w JOIN slack_workspace_member s ON s.team_id=w.team_id AND s.org_id=w.org_id
			JOIN member m ON m.user_id=s.user_id AND m.organization_id=w.org_id
			JOIN user u ON u.id=s.user_id AND u.deleted=0
			WHERE w.org_id=? AND s.user_id=? AND s.status='active' LIMIT 2`)
			.bind(principal.orgId, principal.userId).all<unknown>()
		if (rows.results.length !== 1) throw unavailable()
		const identity = identitySchema.parse(rows.results[0])
		const token = await decryptToken(identity.bot_token_enc, env.ENCRYPTION_SECRET)
		const channels = await livePrivateChannels(token, { teamId: identity.team_id,
			slackUserId: identity.slack_user_id, botUserId: identity.bot_user_id, scopes: identity.scopes }, signal, adapters?.slackFetch, consumeRequest)
		// Reserve every permitted channel search before dispatching any of them.
		// Exhaustion must deny coverage, not return a partial/empty success.
		consumeRequest(channels.length)
		const responseSchema = z.object({ results: z.array(privateMemorySchema).max(input.limit) })
		const queue = [...channels], results: z.infer<typeof privateMemorySchema>[] = []
		await Promise.all(Array.from({ length: 2 }, async () => {
			while (queue.length) {
				signal.throwIfAborted()
				const channel = queue.shift()!
				const containerTag = privateSlackChannelContainerTag(channel)
				const response = adapters?.search ? await adapters.search(containerTag, signal) : await memoryClient(env).search.memories({
					...sharedSearchRequest(input), containerTag,
					searchMode: "memories",
				}, { signal, timeout: 8000, maxRetries: 0 })
				results.push(...responseSchema.parse(response).results)
			}
		}))
		signal.throwIfAborted()
		// Rank before the global projection. Never allocate private edit references.
		results.sort((a, b) => b.similarity - a.similarity)
		return { results: results.slice(0, input.limit), truncated: results.length > input.limit }
	} catch (error) {
		controller.abort()
		if (error instanceof ExternalError) throw error
		throw unavailable()
	}
}
