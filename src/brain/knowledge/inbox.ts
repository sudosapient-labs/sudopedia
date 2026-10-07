import { z } from "zod"
import type { CompanyBrainAgent } from "../turn/agent"
import { brainAgent } from "../turn/agent"
import { KnowledgeBudget, KnowledgeProviderError } from "./adapters"

const deliverySchema = z.object({ type: z.literal("event_callback"), team_id: z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/),
	event_id: z.string().min(1).max(200), event: z.object({ type: z.literal("message"),
		channel: z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/) }).passthrough() }).passthrough()

function ensureInbox(agent: CompanyBrainAgent) {
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_slack_inbox (event_id TEXT PRIMARY KEY, data TEXT NOT NULL, received_at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`
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
	// SQL and checks execute synchronously, so DO input gates cannot interleave.
	const existing = agent.sql`SELECT event_id FROM knowledge_slack_inbox WHERE event_id=${delivery.event_id}`
	if (!existing.length) {
		const count = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE processed=0`[0]!.n
		if (count >= 1000) throw new Error("Knowledge inbox full")
		agent.sql`INSERT INTO knowledge_slack_inbox(event_id,data,received_at) VALUES(${delivery.event_id},${data},${Date.now()})`
	}
	await agent.ensureKnowledgeSchedule()
	return true
}

export async function drainSlackKnowledgeInbox(agent: CompanyBrainAgent, sharedBudget?: KnowledgeBudget): Promise<void> {
	ensureInbox(agent)
	const { ingestSlackKnowledgeEvent } = await import("./runtime")
	for (const row of agent.sql<{ event_id: string; data: string; attempts: number }>`SELECT event_id,data,attempts FROM knowledge_slack_inbox WHERE processed=0 AND next_attempt <= ${Date.now()} ORDER BY next_attempt,received_at LIMIT 3`) {
		if (sharedBudget && (sharedBudget.remaining < 2 || Date.now() >= sharedBudget.deadline)) break
		let retryAfterMs = 0
		try {
			const raw = JSON.parse(row.data)
			const event = raw.event as { subtype?: string; ts?: string; deleted_ts?: string; message?: { ts?: string } }
			// Non-content message notices are terminal, not pending forever.
			const usableTs = event.subtype === "message_deleted" ? event.deleted_ts : event.subtype === "message_changed" ? event.message?.ts : event.ts
			if (!usableTs || !/^\d+\.\d+$/.test(usableTs) || await ingestSlackKnowledgeEvent(agent, raw, sharedBudget)) {
				agent.sql`UPDATE knowledge_slack_inbox SET processed=1,data='' WHERE event_id=${row.event_id}`
				continue
			}
		} catch (error) { if (error instanceof KnowledgeProviderError) retryAfterMs = error.retryAfterMs }
		const attempts = Math.min(row.attempts + 1, 30)
		agent.sql`UPDATE knowledge_slack_inbox SET attempts=${attempts},next_attempt=${Date.now() + Math.max(retryAfterMs, Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts, 6)))} WHERE event_id=${row.event_id}`
	}
	// Compact receipts only; object ordering/tombstones in the knowledge layer
	// remain durable and reject replays even after receipt retention expires.
	agent.sql`DELETE FROM knowledge_slack_inbox WHERE processed=1 AND received_at < ${Date.now() - 30 * 86_400_000}`
}
