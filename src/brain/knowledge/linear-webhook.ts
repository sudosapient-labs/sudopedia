import { z } from "zod"
import { encryptToken, decryptToken } from "@/lib/crypto"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { ensureKnowledgeTables, listSources, stageEvents, upsertSource } from "./store"
import type { EvidenceEvent } from "./types"

export const linearWebhookConfigSchema = z.strictObject({ organizationId: z.string().uuid(),
	secret: z.string().min(16).max(256), consent: z.literal(true) })
const envelopeSchema = z.object({ action: z.enum(["create", "update", "remove"]), type: z.string().max(100),
	organizationId: z.string().uuid(), webhookTimestamp: z.number().int().safe(),
	data: z.object({ id: z.string().uuid() }).passthrough() }).passthrough()

function tables(agent: CompanyBrainAgent) {
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_linear_webhook_config (connection_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, secret_enc TEXT NOT NULL)`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_linear_inbox (delivery_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0)`
}

/** An explicit owner setup, not automatic admin escalation or publication. */
export async function configureLinearWebhook(agent: CompanyBrainAgent, userId: string, connectionId: string,
	input: z.infer<typeof linearWebhookConfigSchema>): Promise<void> {
	const parsed = linearWebhookConfigSchema.parse(input), env = brainAgent(agent).env
	const connection = await env.DB.prepare(`SELECT c.id FROM mcp_connection c
		JOIN member m ON m.user_id=c.user_id AND m.organization_id=c.org_id
		WHERE c.id=? AND c.org_id=? AND c.user_id=? AND c.server_slug='linear' AND c.status='active' LIMIT 1`)
		.bind(connectionId, agent.name, userId).first()
	if (!connection) throw new Error("Personal Linear owner required")
	const encrypted = await encryptToken(parsed.secret, env.ENCRYPTION_SECRET)
	tables(agent)
	agent.sql`INSERT INTO knowledge_linear_webhook_config VALUES(${connectionId},${parsed.organizationId},${encrypted})
		ON CONFLICT(connection_id) DO UPDATE SET organization_id=excluded.organization_id,secret_enc=excluded.secret_enc`
	await agent.ensureKnowledgeSchedule()
}

export async function receiveLinearWebhook(agent: CompanyBrainAgent, connectionId: string,
	body: string, signature: string, deliveryId: string): Promise<boolean> {
	if (new TextEncoder().encode(body).length > 64 * 1024 || !/^[a-fA-F0-9]{64}$/.test(signature) || !/^[a-zA-Z0-9-]{1,200}$/.test(deliveryId)) return false
	tables(agent)
	const config = agent.sql<{ organization_id: string; secret_enc: string }>`SELECT organization_id,secret_enc FROM knowledge_linear_webhook_config WHERE connection_id=${connectionId}`[0]
	if (!config) return false
	const secret = await decryptToken(config.secret_enc, brainAgent(agent).env.ENCRYPTION_SECRET)
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
	const bytes = Uint8Array.from(signature.match(/../g)!, s => parseInt(s, 16))
	if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body))) return false
	const parsed = envelopeSchema.safeParse(JSON.parse(body))
	if (!parsed.success || parsed.data.organizationId !== config.organization_id || Math.abs(Date.now() - parsed.data.webhookTimestamp) > 5 * 60_000) return false
	// Explicitly supported entity only; comments and other resources are shown as
	// uncovered, not guessed to be issue updates.
	if (parsed.data.type !== "Issue") return true
	if (!agent.sql`SELECT delivery_id FROM knowledge_linear_inbox WHERE delivery_id=${deliveryId}`.length) {
		const count = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_linear_inbox WHERE processed=0`[0]!.n
		if (count >= 1000) throw new Error("Knowledge inbox full")
		agent.sql`INSERT INTO knowledge_linear_inbox(delivery_id,connection_id,data,received_at) VALUES(${deliveryId},${connectionId},${body},${Date.now()})`
	}
	await agent.ensureKnowledgeSchedule()
	return true
}

export async function drainLinearWebhookInbox(agent: CompanyBrainAgent): Promise<void> {
	tables(agent); ensureKnowledgeTables(agent)
	for (const row of agent.sql<{ delivery_id: string; connection_id: string; data: string }>`SELECT delivery_id,connection_id,data FROM knowledge_linear_inbox WHERE processed=0 AND next_attempt <= ${Date.now()} ORDER BY next_attempt,received_at LIMIT 3`) {
		try {
			const source = listSources(agent).find(s => s.connectionId === row.connection_id && s.provider === "linear" && s.state !== "revoked")
			if (!source) throw new Error("Awaiting discovery")
			const input = envelopeSchema.parse(JSON.parse(row.data)), data = input.data
			const occurredAt = Date.parse(String(data.updatedAt ?? ""))
			const deleted = input.action === "remove"
			const version = deleted ? input.webhookTimestamp : occurredAt
			if (!Number.isSafeInteger(version)) throw new Error("Missing event version")
			const event: EvidenceEvent = { sourceId: source.id, eventId: `${source.id}:linear-delivery:${row.delivery_id}`, objectId: data.id,
				version, occurredAt: version, observedAt: Date.now(), deleted,
				url: typeof data.url === "string" ? data.url : "", text: deleted ? "" : JSON.stringify(data).slice(0, 32000), audience: source.audience }
			stageEvents(agent, source, [event])
			upsertSource(agent, { ...source, nextCheckAt: Date.now(), coverage: [...new Set(source.coverage.filter(c => c !== "no_deletion_feed").concat("signed_issue_webhooks", "comments_not_covered", "webhook_reconciliation_partial"))] })
			agent.sql`UPDATE knowledge_linear_inbox SET processed=1,data='' WHERE delivery_id=${row.delivery_id}`
		} catch {
			agent.sql`UPDATE knowledge_linear_inbox SET next_attempt=${Date.now() + 5 * 60_000} WHERE delivery_id=${row.delivery_id}`
		}
	}
	agent.sql`DELETE FROM knowledge_linear_inbox WHERE processed=1 AND received_at < ${Date.now() - 30 * 86_400_000}`
}
