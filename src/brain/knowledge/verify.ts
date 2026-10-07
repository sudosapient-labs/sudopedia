import { getConnectionById } from "../tools/mcp/store"
import { KnowledgeBudget, inspectKnowledgeTools, openKnowledgeProvider, slackEvidence, slackKnowledgeRequest, slackKnowledgeToken } from "./adapters"
import type { ToolProviderHandle } from "../tools/mcp/provider"
import type { EvidenceEvent, KnowledgeSource } from "./types"
import { redactKnowledgeSecrets } from "./secrets"

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Live object access is distinct from locally connected-account ownership.
 * The provider may revoke a team's permissions without changing our D1 row. */
export function evidenceVerifier(env: Env, deadline = Date.now() + 7000, cancellation?: AbortSignal) {
	const handles = new Map<string, ToolProviderHandle>()
	const toolNames = new Map<string, string>()
	const cache = new Map<string, boolean>()
	// Runtime emits at most 3 batch + 2 context objects. This bounded allowance
	// also covers separate MCP setup/catalog reservations for all five sources.
	const budget = new KnowledgeBudget(40, deadline, cancellation)
	let incomplete = false
	const verify = async (source: KnowledgeSource, event: EvidenceEvent, historical = false): Promise<boolean> => {
		const key = `${source.id}:${event.objectId}:${event.version}:${event.contentFingerprint ?? "legacy"}:${historical}`
		if (Date.now() >= deadline || cancellation?.aborted) { incomplete = true; return false }
		if (cache.has(key)) return cache.get(key)!
		try {
			if (source.provider === "slack") {
				if (source.audience.kind !== "slack_channel" || !/^\d+\.\d+$/.test(event.objectId)) throw new Error("Invalid Slack evidence")
				budget.take()
				const workspace = await env.DB.prepare("SELECT bot_token_enc FROM slack_workspace WHERE org_id=? AND team_id=? LIMIT 1")
					.bind(source.orgId, source.audience.teamId).first<{ bot_token_enc: string }>()
				if (!workspace) throw new Error("Installation unavailable")
				const token = await slackKnowledgeToken(env, workspace.bot_token_enc)
				const root = event.context?.replace(/^slack-thread:/, "") ?? event.objectId
				const reply = root !== event.objectId
				const response = await slackKnowledgeRequest(token, reply ? "conversations.replies" : "conversations.history", {
					channel: source.audience.channelId, ...(reply ? { ts: root } : {}), oldest: event.objectId,
					latest: event.objectId, inclusive: "true", limit: "1",
				}, budget)
				const raw = Array.isArray(response.messages) ? response.messages.find(message => record(message).ts === event.objectId) : undefined
				const live = raw ? slackEvidence(source, raw, Date.now()) : null
				// Webhook delivery time can differ from Slack's edit timestamp. Match
				// normalized content too, so missed edits cannot pass as current.
				const contentMatches = live && (event.contentFingerprint
					? live.contentFingerprint === event.contentFingerprint && live.contentVersion === event.contentVersion
					: redactKnowledgeSecrets(live.text).slice(0, event.text.length) === event.text && live.version <= event.version)
				const allowed = !!live && !live.deleted && (historical
					? (live.contentVersion ?? live.version) >= (event.contentVersion ?? event.version)
					: !!contentMatches)
				if (!allowed) incomplete = true
				cache.set(key, allowed); return allowed
			}
			if (source.provider !== "linear") throw new Error("No verified object access adapter")
			const connection = await getConnectionById(env, source.connectionId)
			if (!connection || connection.orgId !== source.orgId || connection.status !== "active" ||
				!connection.serverUrl || new URL(connection.serverUrl).hostname !== "mcp.linear.app") throw new Error("Connection unavailable")
			let handle = handles.get(source.id)
			if (!handle) { handle = await openKnowledgeProvider(env, connection, budget); handles.set(source.id, handle) }
			let toolName = toolNames.get(source.id)
			if (!toolName) {
				const tools = await inspectKnowledgeTools(handle, budget)
				const tool = tools.find(t => t.name === "get_issue" && t.annotations?.destructiveHint !== true && t.annotations?.readOnlyHint !== false)
				const props = record(tool?.inputSchema.properties)
				if (!tool || record(props.id).type !== "string" || (tool.inputSchema.required ?? []).some(k => k !== "id")) throw new Error("Unsupported permission schema")
				toolName = tool.name; toolNames.set(source.id, toolName)
			}
			budget.take()
			const response = record(await handle.callTool(toolName, { id: event.objectId }))
			if (response.isError) throw new Error("Object unavailable")
			let row = record(response.structuredContent)
			if (!Object.keys(row).length && Array.isArray(response.content)) {
				const text = response.content.map(record).find(c => c.type === "text" && typeof c.text === "string")?.text
				if (typeof text !== "string" || text.length > 256 * 1024) throw new Error("Invalid permission result")
				row = record(JSON.parse(text))
			}
			if (row.issue) row = record(row.issue)
			// A newer live snapshot makes the recorded current fact stale. Withhold
			// it until background reasoning commits the new version; never describe
			// old evidence as current simply because access is still valid.
			const version = Date.parse(String(row.updatedAt ?? ""))
			const allowed = row.id === event.objectId && Number.isFinite(version) && (historical ? version >= event.version : version === event.version)
			if (!allowed) incomplete = true
			cache.set(key, allowed); return allowed
		} catch { incomplete = true; cache.set(key, false); return false }
	}
	return { verify, incomplete: () => incomplete, close: async () => {
		await Promise.all([...handles.values()].map(h => h.close().catch(() => {})))
	} }
}
