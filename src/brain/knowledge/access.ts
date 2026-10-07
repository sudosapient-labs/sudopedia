import { z } from "zod"
import { decryptToken } from "@/lib/crypto"
import type { Principal } from "../../external/contracts"
import type { Audience, KnowledgeSource } from "./types"

const slackId = z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/)
const identitySchema = z.object({ team_id: slackId, slack_user_id: slackId,
	bot_user_id: slackId.nullable(), bot_token_enc: z.string().min(1) })

// Positive, live authorization only. Never use an ingested membership snapshot
// to grant access; missing/failed/bounded permission checks mean no access.
export async function knowledgeAccess(env: Env, principal: Principal,
	signal: AbortSignal, fetcher: typeof fetch = fetch) {
	const member = await env.DB.prepare(`SELECT m.user_id FROM member m
		JOIN user u ON u.id=m.user_id AND u.deleted=0
		WHERE m.organization_id=? AND m.user_id=? LIMIT 1`)
		.bind(principal.orgId, principal.userId).first()
	if (!member) return { source: async (_: KnowledgeSource, _metadataOnly = false) => false,
		audience: async (_: Audience) => false, incomplete: () => true }
	let budget = 30, incomplete = false
	const cache = new Map<string, boolean>()
	const call = async (token: string, method: string, params: Record<string, string>) => {
		if (--budget < 0) throw new Error("permission budget")
		const url = new URL(`https://slack.com/api/${method}`)
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
		const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal })
		if (!response.ok) throw new Error("permission unavailable")
		if (Number(response.headers.get("content-length")) > 256 * 1024) throw new Error("permission response limit")
		if (!response.body) throw new Error("permission response missing")
		const reader = response.body.getReader(), chunks: Uint8Array[] = []
		let bytes = 0
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				bytes += value.byteLength
				if (bytes > 256 * 1024) { await reader.cancel(); throw new Error("permission response limit") }
				chunks.push(value)
			}
		} finally { reader.releaseLock() }
		const data = new Uint8Array(bytes); let offset = 0
		for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
		const body: unknown = JSON.parse(new TextDecoder().decode(data))
		return z.object({ ok: z.literal(true) }).passthrough().parse(body)
	}
	const audience = async (acl: Audience): Promise<boolean> => {
		if (principal.kind !== "employee") return false
		if (acl.kind === "intersection") {
			if (!acl.audiences.length || acl.audiences.length > 32) return false
			for (const child of acl.audiences) if (!await audience(child)) return false
			return true
		}
		if (acl.kind === "users") return principal.grants.includes("memory.personal:read") && acl.userIds.includes(principal.userId)
		if (!principal.grants.includes("memory.private-channel:read")) return false
		const key = `${acl.teamId}:${acl.channelId}`
		if (cache.has(key)) return cache.get(key)!
		try {
			const raw = await env.DB.prepare(`SELECT w.team_id,w.bot_token_enc,w.bot_user_id,s.slack_user_id
				FROM slack_workspace w JOIN slack_workspace_member s ON s.team_id=w.team_id AND s.org_id=w.org_id
				WHERE w.org_id=? AND w.team_id=? AND s.user_id=? AND s.status='active' LIMIT 1`)
				.bind(principal.orgId, acl.teamId, principal.userId).first()
			const identity = identitySchema.parse(raw)
			const token = await decryptToken(identity.bot_token_enc, env.ENCRYPTION_SECRET)
			const auth = z.object({ team_id: slackId, user_id: slackId }).parse(await call(token, "auth.test", {}))
			if (auth.team_id !== acl.teamId || !identity.bot_user_id || auth.user_id !== identity.bot_user_id || auth.user_id === identity.slack_user_id) throw new Error("identity mismatch")
			const { user } = z.object({ user: z.object({ id: slackId, team_id: slackId,
				deleted: z.literal(false), is_bot: z.literal(false) }) }).parse(await call(token, "users.info", { user: identity.slack_user_id }))
			if (user.id !== identity.slack_user_id || user.team_id !== acl.teamId) throw new Error("identity mismatch")
			const { channel } = z.object({ channel: z.object({ id: slackId, is_member: z.literal(true),
				is_archived: z.literal(false) }) }).parse(await call(token, "conversations.info", { channel: acl.channelId }))
			if (channel.id !== acl.channelId) throw new Error("channel mismatch")
			let cursor = "", allowed = false
			const seen = new Set<string>()
			for (let page = 0; page < 5; page++) {
				const data = z.object({ members: z.array(slackId).max(200),
					response_metadata: z.object({ next_cursor: z.string().max(1000).optional() }).optional() })
					.parse(await call(token, "conversations.members", { channel: acl.channelId, limit: "200", ...(cursor ? { cursor } : {}) }))
				if (data.members.includes(identity.slack_user_id)) { allowed = true; break }
				cursor = data.response_metadata?.next_cursor?.trim() ?? ""
				if (!cursor) break
				if (seen.has(cursor) || page === 4) throw new Error("incomplete membership")
				seen.add(cursor)
			}
			cache.set(key, allowed); return allowed
		} catch { incomplete = true; cache.set(key, false); return false }
	}
	const source = async (row: KnowledgeSource, metadataOnly = false): Promise<boolean> => {
		if (row.orgId !== principal.orgId || (!metadataOnly && row.state === "revoked")) return false
		if (row.provider !== "slack") {
			const connection = await env.DB.prepare(`SELECT id,status FROM mcp_connection
				WHERE id=? AND org_id=? AND (user_id=? OR user_id IS NULL) LIMIT 1`)
				.bind(row.connectionId, principal.orgId, principal.userId).first()
			if (!connection) return false
			if (metadataOnly) return true // Connection metadata, never its contents.
			if ((connection as { status: string }).status !== "active") return false
		}
		return audience(row.audience)
	}
	return { source, audience, incomplete: () => incomplete }
}
