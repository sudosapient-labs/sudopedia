import { z } from "zod"
import { encryptToken, decryptToken } from "@/lib/crypto"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { ensureKnowledgeTables, listSources, revokeSource, stageEvents, upsertSource } from "./store"
import type { EvidenceEvent } from "./types"
import { liveLinearIdentity } from "./inbox"

export const linearWebhookConfigSchema = z.strictObject({ organizationId: z.string().uuid(),
	secret: z.string().min(16).max(256), consent: z.literal(true) })
const envelopeSchema = z.object({ action: z.enum(["create", "update", "remove"]), type: z.string().max(100),
	organizationId: z.string().uuid(), webhookTimestamp: z.number().int().safe(),
	data: z.object({ id: z.string().uuid() }).passthrough() }).passthrough()

function tables(agent: CompanyBrainAgent) {
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_linear_webhook_config (connection_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, secret_enc TEXT NOT NULL)`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_linear_inbox (delivery_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, data TEXT NOT NULL, received_at INTEGER NOT NULL, next_attempt INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0)`
	// Legacy rows have unknown generation. Nullable migration is deliberately
	// fail-closed; never infer their authority from today's connection.
	for (const table of ["config", "inbox"] as const) {
		const columns = table === "config" ? agent.sql<{ name: string }>`PRAGMA table_info(knowledge_linear_webhook_config)` : agent.sql<{ name: string }>`PRAGMA table_info(knowledge_linear_inbox)`
		if (!columns.some(c => c.name === "binding")) {
			if (table === "config") agent.sql`ALTER TABLE knowledge_linear_webhook_config ADD COLUMN binding TEXT`
			else agent.sql`ALTER TABLE knowledge_linear_inbox ADD COLUMN binding TEXT`
		}
	}
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_linear_source_generation (source_id TEXT PRIMARY KEY, owner TEXT NOT NULL, generation TEXT NOT NULL)`
	agent.sql`DELETE FROM knowledge_linear_webhook_config WHERE binding IS NULL`
	agent.sql`UPDATE knowledge_linear_inbox SET processed=1,data='' WHERE binding IS NULL`
}

type Binding = { sourceId: string; owner: string; generation: string }

async function authorizedBinding(agent: CompanyBrainAgent, connectionId: string): Promise<Binding | null> {
	ensureKnowledgeTables(agent)
	const live = await liveLinearIdentity(agent, connectionId)
	if (!live) return null
	// Respect the runtime's active source identity, not the first matching source.
	agent.sql`CREATE TABLE IF NOT EXISTS brain_knowledge_runtime (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
	const identity = agent.sql<{ value: string }>`SELECT value FROM brain_knowledge_runtime WHERE key=${`mcp:${connectionId}`}`[0]
	let sourceId = `mcp:${connectionId}`
	try { if (identity) sourceId = JSON.parse(identity.value) } catch { return null }
	const source = listSources(agent).find(s => s.id === sourceId && s.orgId === agent.name && s.connectionId === connectionId && s.provider === "linear" && s.state !== "revoked" && s.ownerUserId === live.owner && s.audience.kind === "users" && s.audience.userIds.length === 1 && s.audience.userIds[0] === live.owner)
	if (!source) return null
	const previous = agent.sql<{ owner: string; generation: string }>`SELECT owner,generation FROM knowledge_linear_source_generation WHERE source_id=${source.id}`[0]
	if (previous && (previous.owner !== live.owner || previous.generation !== live.generation)) {
		// Force runtime discovery to rotate the source identity on its next pass;
		// reconnect recovery must not silently rebind this source's old receipts.
		revokeSource(agent, source.id)
		return null
	}
	agent.sql`INSERT OR IGNORE INTO knowledge_linear_source_generation(source_id,owner,generation) VALUES(${source.id},${live.owner},${live.generation})`
	return { sourceId: source.id, ...live }
}

function invalidate(agent: CompanyBrainAgent, connectionId: string) {
	agent.sql`DELETE FROM knowledge_linear_webhook_config WHERE connection_id=${connectionId}`
	agent.sql`UPDATE knowledge_linear_inbox SET processed=1,data='' WHERE connection_id=${connectionId} AND processed=0`
}

/** An explicit owner setup, not automatic admin escalation or publication. */
export async function configureLinearWebhook(agent: CompanyBrainAgent, userId: string, connectionId: string,
	input: z.infer<typeof linearWebhookConfigSchema>): Promise<void> {
	const parsed = linearWebhookConfigSchema.parse(input), env = brainAgent(agent).env
	tables(agent)
	const binding = await authorizedBinding(agent, connectionId)
	if (!binding) { invalidate(agent, connectionId); throw new Error("Personal Linear owner and current discovered generation required") }
	if (binding.owner !== userId) throw new Error("Personal Linear owner required")
	const encrypted = await encryptToken(parsed.secret, env.ENCRYPTION_SECRET)
	if (JSON.stringify(await authorizedBinding(agent, connectionId)) !== JSON.stringify(binding)) { invalidate(agent, connectionId); throw new Error("Linear authority changed") }
	const encoded = JSON.stringify(binding)
	agent.sql`UPDATE knowledge_linear_inbox SET processed=1,data='' WHERE connection_id=${connectionId} AND binding != ${encoded}`
	agent.sql`INSERT INTO knowledge_linear_webhook_config(connection_id,organization_id,secret_enc,binding) VALUES(${connectionId},${parsed.organizationId},${encrypted},${encoded})
		ON CONFLICT(connection_id) DO UPDATE SET organization_id=excluded.organization_id,secret_enc=excluded.secret_enc,binding=excluded.binding`
	await agent.ensureKnowledgeSchedule()
}

export async function receiveLinearWebhook(agent: CompanyBrainAgent, connectionId: string,
	body: string, signature: string, deliveryId: string): Promise<boolean> {
	if (new TextEncoder().encode(body).length > 64 * 1024 || !/^[a-fA-F0-9]{64}$/.test(signature) || !/^[a-zA-Z0-9-]{1,200}$/.test(deliveryId)) return false
	tables(agent)
	const config = agent.sql<{ organization_id: string; secret_enc: string; binding: string }>`SELECT organization_id,secret_enc,binding FROM knowledge_linear_webhook_config WHERE connection_id=${connectionId}`[0]
	if (!config) return false
	if (JSON.stringify(await authorizedBinding(agent, connectionId)) !== config.binding) { invalidate(agent, connectionId); return false }
	const secret = await decryptToken(config.secret_enc, brainAgent(agent).env.ENCRYPTION_SECRET)
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
	const bytes = Uint8Array.from(signature.match(/../g)!, s => parseInt(s, 16))
	if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body))) return false
	let raw: unknown
	try { raw = JSON.parse(body) } catch { return false }
	const parsed = envelopeSchema.safeParse(raw)
	if (!parsed.success || parsed.data.organizationId !== config.organization_id || Math.abs(Date.now() - parsed.data.webhookTimestamp) > 5 * 60_000) return false
	// Explicitly supported entity only; comments and other resources are shown as
	// uncovered, not guessed to be issue updates.
	if (parsed.data.type !== "Issue") return true
	if (JSON.stringify(await authorizedBinding(agent, connectionId)) !== config.binding || agent.sql<{ binding: string; secret_enc: string }>`SELECT binding,secret_enc FROM knowledge_linear_webhook_config WHERE connection_id=${connectionId}`[0]?.secret_enc !== config.secret_enc) { invalidate(agent, connectionId); return false }
	if (!agent.sql`SELECT delivery_id FROM knowledge_linear_inbox WHERE delivery_id=${deliveryId}`.length) {
		const count = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_linear_inbox WHERE processed=0`[0]!.n
		if (count >= 1000) throw new Error("Knowledge inbox full")
		agent.sql`INSERT INTO knowledge_linear_inbox(delivery_id,connection_id,data,received_at,binding) VALUES(${deliveryId},${connectionId},${body},${Date.now()},${config.binding})`
	}
	await agent.ensureKnowledgeSchedule()
	return true
}

export async function drainLinearWebhookInbox(agent: CompanyBrainAgent): Promise<void> {
	tables(agent); ensureKnowledgeTables(agent)
	for (const row of agent.sql<{ delivery_id: string; connection_id: string; data: string; binding: string }>`SELECT delivery_id,connection_id,data,binding FROM knowledge_linear_inbox WHERE processed=0 AND next_attempt <= ${Date.now()} ORDER BY next_attempt,received_at LIMIT 3`) {
		try {
			const binding = await authorizedBinding(agent, row.connection_id)
			if (!binding || JSON.stringify(binding) !== row.binding) {
				// A newly configured generation must not be deleted by an old row.
				agent.sql`DELETE FROM knowledge_linear_webhook_config WHERE connection_id=${row.connection_id} AND binding=${row.binding}`
				agent.sql`UPDATE knowledge_linear_inbox SET processed=1,data='' WHERE delivery_id=${row.delivery_id}`
				continue
			}
			const source = listSources(agent).find(s => s.id === binding.sourceId)!
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
