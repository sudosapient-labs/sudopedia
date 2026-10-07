import { z } from "zod"
import type { CompanyBrainAgent } from "../turn/agent"
import { brainAgent } from "../turn/agent"
import { KnowledgeBudget, KnowledgeProviderError } from "./adapters"
import { ensureKnowledgeTables, getSource, listSources } from "./store"

/** Hash rather than persist credential material. Conservatively treats credential
 * refreshes as a new generation too; discovery must establish a new identity. */
export async function liveLinearIdentity(agent: CompanyBrainAgent, connectionId: string) {
	const row = await brainAgent(agent).env.DB.prepare(`SELECT c.user_id,c.created_at,c.updated_at,c.access_token,c.refresh_token,c.server_url,c.auth_type,c.metadata
		FROM mcp_connection c JOIN member m ON m.user_id=c.user_id AND m.organization_id=c.org_id
		WHERE c.id=? AND c.org_id=? AND c.server_slug='linear' AND c.status='active' LIMIT 1`)
		.bind(connectionId, agent.name).first<Record<string, unknown>>()
	if (!row || typeof row.user_id !== "string") return null
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(row)))
	return { owner: row.user_id, generation: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") }
}

function currentIdentity(agent: CompanyBrainAgent, base: string): string {
	agent.sql`CREATE TABLE IF NOT EXISTS brain_knowledge_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
	const row = agent.sql<{ value: string }>`SELECT value FROM brain_knowledge_runtime WHERE key=${base}`[0]
	try { return row ? JSON.parse(row.value) : base } catch { return "" }
}

const QUARANTINE_TTL = 86_400_000

function expireQuarantine(agent: CompanyBrainAgent) {
	// Bulk expiry also runs at admission: a full unresolved queue cannot prevent
	// new deliveries forever, even when tick budgets are exhausted.
	const expired = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE processed=0 AND disposition != 'retry' AND received_at <= ${Date.now() - QUARANTINE_TTL}`[0]!.n
	if (!expired) return
	agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='',disposition='quarantine_expired' WHERE processed=0 AND disposition != 'retry' AND received_at <= ${Date.now() - QUARANTINE_TTL}`
	ensureKnowledgeTables(agent)
	const key = "slack-inbox:quarantine-expired"
	const prior = agent.sql<{ value: string }>`SELECT value FROM brain_knowledge_runtime WHERE key=${key}`[0]
	let count = 0
	try { count = Number(JSON.parse(prior?.value ?? "{}").count) || 0 } catch { /* fail closed diagnostics */ }
	agent.sql`INSERT INTO brain_knowledge_runtime(key,value) VALUES(${key},${JSON.stringify({ count: count + expired, lastExpiredAt: Date.now(), coverage: "webhook_quarantine_expired_reconciliation_required" })}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
	// Coverage only: never copy body/channel text into diagnostics or model state.
	for (const source of listSources(agent).filter(s => s.orgId === agent.name && ["slack", "slack_installation"].includes(s.provider) && s.state !== "revoked")) {
		const data = JSON.stringify({ ...source, coverage: [...new Set(source.coverage.concat("webhook_quarantine_expired_reconciliation_required"))] })
		agent.sql`UPDATE knowledge_source SET data=${data} WHERE id=${source.id}`
	}
}

function purgeRevoked(agent: CompanyBrainAgent) {
	ensureKnowledgeTables(agent)
	for (const source of listSources(agent)) {
		if (source.orgId !== agent.name || source.provider !== "slack" || source.state !== "revoked") continue
		// Revocation clears audience; channel identity remains in the runtime map
		// (or the original base ID). Never let an old revoked generation suppress
		// deliveries for a newly discovered generation.
		const base = source.id.split(":").slice(0, 3).join(":")
		if (currentIdentity(agent, base) !== source.id) continue
		const [, team, channel] = base.split(":")
		if (!team || !channel) continue
		agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='',disposition='revoked' WHERE processed=0 AND json_valid(data) AND json_extract(data,'$.team_id')=${team} AND json_extract(data,'$.event.channel')=${channel}`
	}
}

async function slackDisposition(agent: CompanyBrainAgent, raw: z.infer<typeof deliverySchema>): Promise<"ready" | "unknown" | "terminal"> {
	const workspace = await brainAgent(agent).env.DB.prepare("SELECT team_id FROM slack_workspace WHERE team_id=? AND org_id=? LIMIT 1")
		.bind(raw.team_id, agent.name).first()
	if (!workspace) return "terminal"
	return localSlackDisposition(agent, raw)
}

function localSlackDisposition(agent: CompanyBrainAgent, raw: z.infer<typeof deliverySchema>): "ready" | "unknown" | "terminal" {
	ensureKnowledgeTables(agent)
	const source = getSource(agent, currentIdentity(agent, `slack:${raw.team_id}:${raw.event.channel}`))
	if (!source) return "unknown"
	if (source.state === "revoked" || source.provider !== "slack" || source.orgId !== agent.name || source.connectionId !== `slack:${raw.team_id}` || source.audience.kind !== "slack_channel" || source.audience.teamId !== raw.team_id || source.audience.channelId !== raw.event.channel) return "terminal"
	return "ready"
}

const deliverySchema = z.object({ type: z.literal("event_callback"), team_id: z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/),
	event_id: z.string().min(1).max(200), event: z.object({ type: z.literal("message"),
		channel: z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/) }).passthrough() }).passthrough()

function ensureInbox(agent: CompanyBrainAgent) {
	agent.sql`CREATE TABLE IF NOT EXISTS brain_knowledge_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_slack_inbox (event_id TEXT PRIMARY KEY, data TEXT NOT NULL, received_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`
	if (!agent.sql<{ name: string }>`PRAGMA table_info(knowledge_slack_inbox)`.some(c => c.name === "disposition")) agent.sql`ALTER TABLE knowledge_slack_inbox ADD COLUMN disposition TEXT NOT NULL DEFAULT 'pending'`
}

/** Caller has verified the raw-body Slack signature. No provider/model network
 * call is made before durable acknowledgement; sources are authorized later. */
export async function receiveSlackKnowledge(agent: CompanyBrainAgent, raw: unknown): Promise<boolean> {
	const parsed = deliverySchema.safeParse(raw)
	if (!parsed.success) return false
	const delivery = parsed.data, data = JSON.stringify(delivery)
	if (new TextEncoder().encode(data).length > 64 * 1024) throw new Error("Knowledge inbox payload limit")
	const installation = await brainAgent(agent).env.DB.prepare("SELECT team_id FROM slack_workspace WHERE team_id=? AND org_id=? LIMIT 1")
		.bind(delivery.team_id, agent.name).first()
	if (!installation) return false
	ensureInbox(agent)
	purgeRevoked(agent)
	expireQuarantine(agent)
	// SQL and checks execute synchronously, so DO input gates cannot interleave.
	const existing = agent.sql`SELECT event_id FROM knowledge_slack_inbox WHERE event_id=${delivery.event_id}`
	if (!existing.length) {
		if (localSlackDisposition(agent, delivery) === "terminal") {
			agent.sql`INSERT INTO knowledge_slack_inbox(event_id,data,received_at,processed,disposition) VALUES(${delivery.event_id},'',${Date.now()},1,'revoked')`
			return true
		}
		const count = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE processed=0`[0]!.n
		if (count >= 1000) throw new Error("Knowledge inbox full")
		agent.sql`INSERT INTO knowledge_slack_inbox(event_id,data,received_at) VALUES(${delivery.event_id},${data},${Date.now()})`
	}
	await agent.ensureKnowledgeSchedule()
	return true
}

export async function drainSlackKnowledgeInbox(agent: CompanyBrainAgent, sharedBudget?: KnowledgeBudget): Promise<void> {
	ensureInbox(agent)
	purgeRevoked(agent)
	expireQuarantine(agent)
	const { ingestSlackKnowledgeEvent } = await import("./runtime")
	for (const row of agent.sql<{ event_id: string; data: string; attempts: number }>`SELECT event_id,data,attempts FROM knowledge_slack_inbox WHERE processed=0 AND next_attempt <= ${Date.now()} ORDER BY next_attempt,received_at LIMIT 3`) {
		// One live workspace check here, plus runtime's workspace/channel checks.
		if (sharedBudget && (sharedBudget.remaining < 3 || Date.now() >= sharedBudget.deadline)) break
		let retryAfterMs = 0
		try {
			const parsed = deliverySchema.safeParse(JSON.parse(row.data))
			if (!parsed.success) { agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='',disposition='invalid' WHERE event_id=${row.event_id}`; continue }
			const raw = parsed.data
			const event = raw.event as { subtype?: string; ts?: string; deleted_ts?: string; message?: { ts?: string } }
			// Non-content message notices are terminal, not pending forever.
			const usableTs = event.subtype === "message_deleted" ? event.deleted_ts : event.subtype === "message_changed" ? event.message?.ts : event.ts
			sharedBudget?.take()
			const disposition = await slackDisposition(agent, raw)
			if (event.subtype && !["message_deleted", "message_changed", "bot_message", "thread_broadcast", "file_share", "me_message"].includes(event.subtype) || !usableTs || !/^\d+\.\d+$/.test(usableTs) || disposition === "terminal" || disposition === "ready" && await ingestSlackKnowledgeEvent(agent, raw, sharedBudget)) {
				agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='',disposition='terminal' WHERE event_id=${row.event_id}`
				continue
			}
			// Ingestion can revoke the source after live conversations.info.
			if (localSlackDisposition(agent, raw) === "terminal" || disposition === "ready") { agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='',disposition='invalid' WHERE event_id=${row.event_id}`; continue }
			agent.sql`UPDATE knowledge_slack_inbox SET disposition='quarantine' WHERE event_id=${row.event_id}`
		} catch (error) {
			if (error instanceof SyntaxError || error instanceof KnowledgeProviderError && ["revoked", "unsupported_schema"].includes(error.code)) {
				agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='',disposition='invalid' WHERE event_id=${row.event_id}`; continue
			}
			if (error instanceof KnowledgeProviderError) retryAfterMs = error.retryAfterMs
			agent.sql`UPDATE knowledge_slack_inbox SET disposition='retry' WHERE event_id=${row.event_id}`
		}
		const attempts = Math.min(row.attempts + 1, 30)
		agent.sql`UPDATE knowledge_slack_inbox SET attempts=${attempts},next_attempt=${Date.now() + Math.max(retryAfterMs, Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 6)))} WHERE event_id=${row.event_id}`
	}
	// Compact receipts only; object ordering/tombstones in the knowledge layer
	// remain durable and reject replays even after receipt retention expires.
	agent.sql`DELETE FROM knowledge_slack_inbox WHERE processed=1 AND received_at < ${Date.now() - 30 * 86_400_000}`
}
