import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import type { CompanyBrainAgent } from "../turn/agent"
import { configureLinearWebhook, receiveLinearWebhook, drainLinearWebhookInbox } from "./linear-webhook"
import { commitKnowledge, ensureKnowledgeTables, listPendingEvents, queryKnowledge, revokeSource, stageEvents, upsertSource } from "./store"
import type { KnowledgeSource } from "./types"
vi.mock("@/lib/crypto", () => ({ encryptToken: async (t: string) => `enc:${t}`, decryptToken: async (t: string) => t.slice(4) }))
vi.mock("../turn/agent", () => ({ brainAgent: (a: unknown) => a }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: vi.fn() }))
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(f => f.sqlite.close()) })
const organizationId = "10000000-0000-4000-8000-000000000001", issueId = "20000000-0000-4000-8000-000000000001"
const secret = "fictional-linear-secret"
const source: KnowledgeSource = { id: "mcp:linear", orgId: "org", connectionId: "linear", provider: "linear", ownerUserId: "a", audience: { kind: "users", userIds: ["a"] }, state: "partial", coverage: ["no_deletion_feed"], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60000, failures: 0, error: null }
function setup() {
	const f = sqliteFixture(); fixtures.push(f)
	f.sqlite.exec(`INSERT INTO mcp_connection(id,org_id,user_id,server_slug,runtime,auth_type,status,created_at,updated_at)
		VALUES('linear','org','a','linear','remote_mcp','oauth','active',1,1)`)
	const agent = { name: "org", env: { ...f.env, ENCRYPTION_SECRET: "fixture" }, ensureKnowledgeSchedule: vi.fn(async () => {}),
		sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
			const statement = f.sqlite.prepare(strings.join("?"))
			return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
		}, ctx: { storage: { transactionSync<T>(fn: () => T): T {
			f.sqlite.exec("SAVEPOINT webhook_test")
			try { const r = fn(); f.sqlite.exec("RELEASE webhook_test"); return r }
			catch (e) { f.sqlite.exec("ROLLBACK TO webhook_test"); f.sqlite.exec("RELEASE webhook_test"); throw e }
		} } } } as unknown as CompanyBrainAgent
	ensureKnowledgeTables(agent); upsertSource(agent, source)
	return { ...f, agent }
}
function event(action = "update", time = Date.now()) {
	return { action, type: "Issue", organizationId, webhookTimestamp: time, data: { id: issueId, updatedAt: new Date(time).toISOString(), title: "Request", state: { name: "In Progress" } } }
}
async function signed(value: unknown) {
	const body = JSON.stringify(value), key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
	const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, "0")).join("")
	return { body, signature }
}
describe("personal Linear signed webhooks", () => {
	it("requires an explicit connection owner and never broadens the source audience", async () => {
		const { agent, sqlite } = setup()
		await expect(configureLinearWebhook(agent, "b", "linear", { organizationId, secret, consent: true })).rejects.toThrow()
		await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		expect(sqlite.prepare("SELECT secret_enc FROM knowledge_linear_webhook_config").get()).toMatchObject({ secret_enc: `enc:${secret}` })
		expect(queryKnowledge(agent, [source.id], "").facts).toEqual([])
	})
	it("rejects tampering, unsigned, foreign-workspace and stale deliveries", async () => {
		const { agent } = setup(); await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		const value = await signed(event())
		expect(await receiveLinearWebhook(agent, "linear", value.body + " ", value.signature, "delivery")).toBe(false)
		expect(await receiveLinearWebhook(agent, "linear", value.body, "", "delivery")).toBe(false)
		for (const bad of [{ ...event(), organizationId: issueId }, event("update", Date.now() - 6 * 60_000)]) {
			const input = await signed(bad)
			expect(await receiveLinearWebhook(agent, "linear", input.body, input.signature, "delivery")).toBe(false)
		}
	})
	it("durably deduplicates deliveries then stages changes for shared reasoning", async () => {
		const { agent, sqlite } = setup(); await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		const input = await signed(event())
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "delivery-1")
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "delivery-1")
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_linear_inbox").get()).toMatchObject({ n: 1 })
		expect(listPendingEvents(agent, source.id)).toEqual([])
		await drainLinearWebhookInbox(agent)
		expect(listPendingEvents(agent, source.id)).toHaveLength(1)
		expect(listPendingEvents(agent, source.id)[0]).toMatchObject({ objectId: issueId, audience: { kind: "users", userIds: ["a"] } })
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "delivery-1")
		await drainLinearWebhookInbox(agent)
		expect(listPendingEvents(agent, source.id)).toHaveLength(1)
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_linear_inbox").get()).toMatchObject({ processed: 1, data: "" })
	})
	it("a signed remove invalidates current state before any model call", async () => {
		const { agent } = setup(); const time = Date.now() - 1000
		stageEvents(agent, source, [{ sourceId: source.id, eventId: "prior", objectId: issueId, version: time, occurredAt: time, observedAt: time, deleted: false, url: "https://linear.app/test", text: "Recorded In Progress", audience: source.audience }])
		commitKnowledge(agent, source.id, ["prior"], [{ subject: "Issue", predicate: "status", value: "In Progress", evidenceIds: ["prior"], confidence: "confirmed" }], time)
		await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		const input = await signed(event("remove")); await receiveLinearWebhook(agent, "linear", input.body, input.signature, "remove-1")
		await drainLinearWebhookInbox(agent)
		expect(queryKnowledge(agent, [source.id], "").facts).toEqual([])
		expect(queryKnowledge(agent, [source.id], "", 20, true).facts).toHaveLength(1)
	})
	it("never drains owner A's queued delivery into owner B's discovered audience", async () => {
		const { agent, sqlite } = setup()
		await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		const input = await signed(event())
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "old-owner")
		sqlite.exec("UPDATE mcp_connection SET user_id='b',updated_at=2 WHERE id='linear'")
		revokeSource(agent, source.id)
		const fresh = { ...source, id: "mcp:linear:new", ownerUserId: "b", audience: { kind: "users" as const, userIds: ["b"] } }
		upsertSource(agent, fresh)
		agent.sql`INSERT INTO brain_knowledge_runtime(key,value) VALUES(${"mcp:linear"},${JSON.stringify(fresh.id)})`
		await configureLinearWebhook(agent, "b", "linear", { organizationId, secret, consent: true })
		await drainLinearWebhookInbox(agent)
		expect(listPendingEvents(agent, fresh.id)).toEqual([])
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_linear_inbox").get()).toMatchObject({ processed: 1, data: "" })
	})
	it("rejects stale signing configuration after reconnect, even before discovery changes source ID", async () => {
		const { agent, sqlite } = setup()
		await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		const input = await signed(event())
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "old-generation")
		sqlite.exec("UPDATE mcp_connection SET access_token='new-credential',updated_at=2 WHERE id='linear'")
		expect(await receiveLinearWebhook(agent, "linear", input.body, input.signature, "stale-signing")).toBe(false)
		await expect(configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })).rejects.toThrow()
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_linear_webhook_config").get()).toMatchObject({ n: 0 })
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_linear_inbox").get()).toMatchObject({ processed: 1, data: "" })
		// Discovery rotates the revoked generation; only a newly configured
		// signing binding may admit content under the fresh source identity.
		const fresh = { ...source, id: "mcp:linear:reconnected" }
		upsertSource(agent, fresh)
		agent.sql`INSERT INTO brain_knowledge_runtime(key,value) VALUES(${"mcp:linear"},${JSON.stringify(fresh.id)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
		await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "fresh-generation")
		await drainLinearWebhookInbox(agent)
		expect(listPendingEvents(agent, fresh.id)).toHaveLength(1)
	})
	it.each(["UPDATE mcp_connection SET status='revoked'", "DELETE FROM member WHERE user_id='a'"])("checks live authority before discovery: %s", async mutation => {
		const { agent, sqlite } = setup()
		await configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })
		const input = await signed(event())
		await receiveLinearWebhook(agent, "linear", input.body, input.signature, "queued")
		sqlite.exec(mutation)
		await drainLinearWebhookInbox(agent)
		expect(listPendingEvents(agent, source.id)).toEqual([])
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_linear_inbox").get()).toMatchObject({ processed: 1, data: "" })
		expect(await receiveLinearWebhook(agent, "linear", input.body, input.signature, "after-revocation")).toBe(false)
		await expect(configureLinearWebhook(agent, "a", "linear", { organizationId, secret, consent: true })).rejects.toThrow()
	})
	it("migrates legacy config and deliveries without guessing owner or generation", async () => {
		const { agent, sqlite } = setup()
		sqlite.exec(`CREATE TABLE knowledge_linear_webhook_config(connection_id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,secret_enc TEXT NOT NULL);
			CREATE TABLE knowledge_linear_inbox(delivery_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,data TEXT NOT NULL,received_at INTEGER NOT NULL,next_attempt INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0)`)
		sqlite.prepare("INSERT INTO knowledge_linear_webhook_config VALUES(?,?,?)").run("linear", organizationId, `enc:${secret}`)
		sqlite.prepare("INSERT INTO knowledge_linear_inbox(delivery_id,connection_id,data,received_at) VALUES(?,?,?,?)").run("legacy", "linear", JSON.stringify(event()), Date.now())
		await drainLinearWebhookInbox(agent)
		expect(listPendingEvents(agent, source.id)).toEqual([])
		expect(sqlite.prepare("SELECT processed,data,binding FROM knowledge_linear_inbox").get()).toMatchObject({ processed: 1, data: "", binding: null })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_linear_webhook_config").get()).toMatchObject({ n: 0 })
	})
})
