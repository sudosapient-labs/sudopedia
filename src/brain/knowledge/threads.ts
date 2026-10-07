import type { CompanyBrainAgent } from "../turn/agent"
import { getSlackThreadHistoryPage } from "../slack/client"
import { KnowledgeBudget, KnowledgeProviderError, slackEvidence, slackKnowledgeRequest, slackKnowledgeToken } from "./adapters"
import { getSource, revokeSource, stageEvents, upsertSource } from "./store"
import type { EvidenceEvent, KnowledgeSource } from "./types"

function ensure(agent: CompanyBrainAgent) {
	agent.sql`CREATE TABLE IF NOT EXISTS brain_knowledge_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_slack_thread (source_id TEXT NOT NULL, thread_ts TEXT NOT NULL, cursor TEXT, checked_at INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY(source_id,thread_ts))`
	if (!agent.sql<{ name: string }>`PRAGMA table_info(knowledge_slack_thread)`.some(column => column.name === "seen")) {
		agent.sql`ALTER TABLE knowledge_slack_thread ADD COLUMN seen TEXT NOT NULL DEFAULT '[]'`
	}
}

export function rememberSlackThreads(agent: CompanyBrainAgent, source: KnowledgeSource, events: EvidenceEvent[], roots: string[] = []) {
	if (source.provider !== "slack" || source.state === "revoked" || source.state === "unsupported" || source.audience.kind !== "slack_channel") return
	ensure(agent)
	const known = new Set(roots)
	for (const event of events) {
		const root = event.sourceId === source.id && event.context?.startsWith("slack-thread:") ? event.context.slice("slack-thread:".length) : undefined
		if (root && root !== event.objectId) known.add(root)
	}
	for (const root of known) {
		if (root.length > 32 || !/^\d+\.\d+$/.test(root) || agent.sql`SELECT thread_ts FROM knowledge_slack_thread WHERE source_id=${source.id} AND thread_ts=${root}`.length) continue
		if (agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_slack_thread`[0]!.n >= 1000) {
			upsertSource(agent, { ...source, coverage: [...new Set([...source.coverage, "thread_registry_capacity_exceeded"])] }); break
		}
		agent.sql`INSERT INTO knowledge_slack_thread(source_id,thread_ts) VALUES(${source.id},${root})`
	}
}

/** Fair catch-up of known old roots; unknown roots outside backfill remain uncovered. */
export async function reconcileSlackThreads(agent: CompanyBrainAgent, env: Env, orgId: string, budget: KnowledgeBudget) {
	ensure(agent)
	if (budget.remaining < 4) return
	const now = Date.now()
	const rows = agent.sql<{ source_id: string; thread_ts: string; cursor: string | null; seen: string }>`SELECT t.source_id,t.thread_ts,t.cursor,t.seen FROM knowledge_slack_thread t JOIN knowledge_source s ON s.id=t.source_id WHERE json_extract(s.data,'$.orgId')=${orgId} AND t.next_check <= ${now} AND COALESCE((SELECT CAST(value AS INTEGER) FROM brain_knowledge_runtime WHERE key='cooldown:' || json_extract(s.data,'$.connectionId')),0) <= ${now} ORDER BY t.checked_at,t.source_id,t.thread_ts LIMIT 1`
	for (const row of rows) {
		const source = getSource(agent, row.source_id)
		if (!source || source.state === "revoked" || source.state === "unsupported" || source.provider !== "slack" || source.audience.kind !== "slack_channel") {
			agent.sql`DELETE FROM knowledge_slack_thread WHERE source_id=${row.source_id}`; continue
		}
		try {
			budget.take()
			const workspace = await env.DB.prepare("SELECT bot_token_enc FROM slack_workspace WHERE org_id=? AND team_id=? LIMIT 1")
				.bind(orgId, source.audience.teamId).first<{ bot_token_enc: string }>()
			if (!workspace) throw new KnowledgeProviderError("revoked")
			const token = await slackKnowledgeToken(env, workspace.bot_token_enc)
			const info = await slackKnowledgeRequest(token, "conversations.info", { channel: source.audience.channelId }, budget)
			const membership = (info.channel as { is_member?: boolean } | undefined)?.is_member
			if (membership === false) throw new KnowledgeProviderError("revoked")
			if (membership !== true) throw new KnowledgeProviderError("invalid_response")
			budget.take()
			const page = await getSlackThreadHistoryPage(token, source.audience.channelId, row.thread_ts, { cursor: row.cursor ?? undefined, limit: 15, signal: budget.signal() })
			if (!page.ok) throw new KnowledgeProviderError(page.retryAfterSeconds ? "rate_limited" : ["token_revoked", "account_inactive", "not_in_channel", "channel_not_found"].includes(page.error ?? "") ? "revoked" : "provider_failed", (page.retryAfterSeconds ?? 0) * 1000)
			const seen: number[] = JSON.parse(row.seen)
			let hash = 2166136261
			for (const character of page.nextCursor ?? "") hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
			if (!Array.isArray(page.items) || page.items.length > 15 || !Array.isArray(seen) || seen.length > 512 || !seen.every(Number.isSafeInteger) || !page.complete && (!page.nextCursor || page.nextCursor === row.cursor || page.nextCursor.length > 2048 || seen.includes(hash) || seen.length >= 512)) throw new KnowledgeProviderError("invalid_response")
			const events = page.items.flatMap(raw => { const event = slackEvidence(source, raw, now); return event ? [event] : [] })
			stageEvents(agent, source, events)
			// Thread fetch progress is separate from successful knowledge processing.
			agent.sql`UPDATE knowledge_slack_thread SET cursor=${page.complete ? null : page.nextCursor!},seen=${JSON.stringify(page.complete ? [] : [...seen, hash])},checked_at=${now},next_check=${now + (page.complete ? 30 * 60_000 : 60_000)},error=NULL WHERE source_id=${row.source_id} AND thread_ts=${row.thread_ts}`
			const current = getSource(agent, source.id) ?? source
			upsertSource(agent, { ...current, nextCheckAt: now,
				coverage: [...new Set(current.coverage.filter(c => c !== "no_thread_reconciliation").concat("known_thread_reconciliation", "unknown_roots_outside_backfill_uncovered", "missed_deletions_unverified"))] })
		} catch (error) {
			const code = error instanceof KnowledgeProviderError ? error.code : "provider_failed"
			const current = getSource(agent, source.id) ?? source
			if (code === "revoked" || current.state === "revoked") {
				revokeSource(agent, source.id)
				agent.sql`DELETE FROM knowledge_slack_thread WHERE source_id=${source.id}`
				continue
			}
			const delay = error instanceof KnowledgeProviderError ? Math.max(60_000, Math.min(7 * 86_400_000, error.retryAfterMs)) : 60_000
			if (code === "rate_limited") {
				const key = `cooldown:${source.connectionId}`
				const prior = agent.sql<{ value: string }>`SELECT value FROM brain_knowledge_runtime WHERE key=${key}`[0]
				const until = Math.max(now + delay, Number(prior?.value) || 0)
				agent.sql`INSERT INTO brain_knowledge_runtime(key,value) VALUES(${key},${JSON.stringify(until)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
			}
			if (code === "invalid_response") agent.sql`UPDATE knowledge_slack_thread SET cursor=NULL,seen='[]' WHERE source_id=${row.source_id} AND thread_ts=${row.thread_ts}`
			agent.sql`UPDATE knowledge_slack_thread SET checked_at=${now},next_check=${now + delay},error=${code} WHERE source_id=${row.source_id} AND thread_ts=${row.thread_ts}`
			upsertSource(agent, { ...current, coverage: [...new Set([...current.coverage, `thread_${code}`])], error: `thread_${code}` })
		}
	}
}
