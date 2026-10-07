import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import type { CompanyBrainAgent } from "../turn/agent"
const mocks = vi.hoisted(() => ({ ingest: vi.fn() }))
vi.mock("./runtime", () => ({ ingestSlackKnowledgeEvent: mocks.ingest }))
vi.mock("../turn/agent", () => ({ brainAgent: (a: unknown) => a }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: vi.fn() }))
import { KnowledgeBudget, KnowledgeProviderError } from "./adapters"
import { receiveSlackKnowledge, drainSlackKnowledgeInbox } from "./inbox"
import { ensureKnowledgeTables } from "./store"
import type { KnowledgeSource } from "./types"
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(f => f.sqlite.close()); mocks.ingest.mockReset() })
function setup() {
	const f = sqliteFixture(); fixtures.push(f)
	f.sqlite.exec("INSERT INTO slack_workspace(team_id,org_id,bot_token_enc,created_at,updated_at) VALUES('T1','org','encrypted',1,1)")
	const agent = { env: f.env, name: "org", ensureKnowledgeSchedule: vi.fn(async () => {}),
		sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
			const statement = f.sqlite.prepare(strings.join("?"))
			return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
		} } as unknown as CompanyBrainAgent
	ensureKnowledgeTables(agent)
	const source: KnowledgeSource = { id: "slack:T1:C1", orgId: "org", connectionId: "slack:T1", provider: "slack", ownerUserId: null, audience: { kind: "slack_channel", teamId: "T1", channelId: "C1" }, state: "partial", coverage: [], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60000, failures: 0, error: null }
	agent.sql`INSERT INTO knowledge_source(id,data) VALUES(${source.id},${JSON.stringify(source)})`
	return { ...f, agent }
}
const delivery = (id: string, event: Record<string, unknown> = {}) => ({ type: "event_callback", team_id: "T1", event_id: id,
	event: { type: "message", channel: "C1", ts: "1700000000.000001", text: "A commitment", ...event } })
describe("durable signed Slack inbox", () => {
	it("shares the tick deadline and honors provider Retry-After", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("limited"))
		await drainSlackKnowledgeInbox(agent, new KnowledgeBudget(0, Date.now() + 1000))
		await drainSlackKnowledgeInbox(agent, new KnowledgeBudget(2, Date.now() + 1000))
		await drainSlackKnowledgeInbox(agent, new KnowledgeBudget(4, Date.now() - 1))
		expect(mocks.ingest).not.toHaveBeenCalled()
		mocks.ingest.mockRejectedValueOnce(new KnowledgeProviderError("rate_limited", 7_200_000))
		const now = Date.now()
		await drainSlackKnowledgeInbox(agent, new KnowledgeBudget(4, now + 1000))
		expect(sqlite.prepare("SELECT next_attempt FROM knowledge_slack_inbox").get()).toMatchObject({ next_attempt: expect.any(Number) })
		expect((sqlite.prepare("SELECT next_attempt FROM knowledge_slack_inbox").get() as { next_attempt: number }).next_attempt).toBeGreaterThanOrEqual(now + 7_200_000)
		sqlite.prepare("UPDATE knowledge_slack_inbox SET received_at=?").run(now - 2 * 86_400_000)
		await receiveSlackKnowledge(agent, delivery("new"))
		expect(sqlite.prepare("SELECT processed,disposition FROM knowledge_slack_inbox WHERE event_id='limited'").get()).toMatchObject({ processed: 0, disposition: "retry" })
	})
	it("acknowledges durable persistence without provider or reasoning calls, and deduplicates retries", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("e1")); await receiveSlackKnowledge(agent, delivery("e1"))
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_inbox").get()).toMatchObject({ n: 1 })
		expect(mocks.ingest).not.toHaveBeenCalled()
	})
	it("does not invent a source for a different installation", async () => {
		const { agent } = setup()
		expect(await receiveSlackKnowledge(agent, { ...delivery("e1"), team_id: "T2" })).toBe(false)
	})
	it("backs off unknown-source events so they cannot block later deliveries", async () => {
		const { agent, sqlite } = setup()
		for (const id of ["a", "b", "c", "d"]) await receiveSlackKnowledge(agent, delivery(id, { channel: id === "d" ? "C1" : "C2" }))
		mocks.ingest.mockImplementation(async (_agent, payload) => payload.event_id === "d")
		await drainSlackKnowledgeInbox(agent); await drainSlackKnowledgeInbox(agent)
		expect(sqlite.prepare("SELECT processed FROM knowledge_slack_inbox WHERE event_id='d'").get()).toMatchObject({ processed: 1 })
		expect(sqlite.prepare("SELECT attempts,next_attempt FROM knowledge_slack_inbox WHERE event_id='a'").get()).toMatchObject({ attempts: 1 })
	})
	it("retains failed changes and compacts successfully staged deliveries", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("edit", { subtype: "message_changed", message: { ts: "1700000000.000001", text: "New commitment" } }))
		mocks.ingest.mockRejectedValueOnce(new Error("provider secret"))
		await drainSlackKnowledgeInbox(agent)
		expect(sqlite.prepare("SELECT processed,attempts FROM knowledge_slack_inbox").get()).toMatchObject({ processed: 0, attempts: 1 })
		sqlite.exec("UPDATE knowledge_slack_inbox SET next_attempt=0")
		mocks.ingest.mockResolvedValue(true); await drainSlackKnowledgeInbox(agent)
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_slack_inbox").get()).toMatchObject({ processed: 1, data: "" })
	})
	it("terminally rejects non-content notices without poisoning the queue", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("notice", { subtype: "channel_join" }))
		await drainSlackKnowledgeInbox(agent)
		expect(sqlite.prepare("SELECT processed FROM knowledge_slack_inbox").get()).toMatchObject({ processed: 1 })
	})
	it("reclaims all 1000 revoked deliveries before admitting fresh work and scrubs bodies", async () => {
		const { agent, sqlite } = setup()
		for (let i = 0; i < 1000; i++) await receiveSlackKnowledge(agent, delivery(`revoked-${i}`))
		const row = sqlite.prepare("SELECT data FROM knowledge_source").get() as { data: string }
		sqlite.prepare("UPDATE knowledge_source SET data=?").run(JSON.stringify({ ...JSON.parse(row.data), state: "revoked", audience: { kind: "users", userIds: [] } }))
		await receiveSlackKnowledge(agent, delivery("fresh", { channel: "C2" }))
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE processed=0").get()).toMatchObject({ n: 1 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE processed=1 AND data!=''").get()).toMatchObject({ n: 0 })
		expect(mocks.ingest).not.toHaveBeenCalled()
	})
	it("expires a full unresolved quarantine, marks coverage and admits new work", async () => {
		const { agent, sqlite } = setup()
		const row = sqlite.prepare("SELECT data FROM knowledge_source").get() as { data: string }
		const install = { ...JSON.parse(row.data), id: "slack-install:T1", provider: "slack_installation", audience: { kind: "users", userIds: [] } }
		agent.sql`INSERT INTO knowledge_source(id,data) VALUES(${install.id},${JSON.stringify(install)})`
		for (let i = 0; i < 1000; i++) await receiveSlackKnowledge(agent, delivery(`unknown-${i}`, { channel: "C2" }))
		sqlite.prepare("UPDATE knowledge_slack_inbox SET received_at=?").run(Date.now() - 86_400_001)
		await receiveSlackKnowledge(agent, delivery("fresh"))
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE processed=0").get()).toMatchObject({ n: 1 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_inbox WHERE disposition='quarantine_expired' AND data=''").get()).toMatchObject({ n: 1000 })
		expect(JSON.parse((sqlite.prepare("SELECT data FROM knowledge_source WHERE id='slack-install:T1'").get() as { data: string }).data).coverage).toContain("webhook_quarantine_expired_reconciliation_required")
	})
	it("keeps legitimate unknown channels until later discovery", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("unknown", { channel: "C2" }))
		await drainSlackKnowledgeInbox(agent)
		expect(mocks.ingest).not.toHaveBeenCalled()
		const row = sqlite.prepare("SELECT data FROM knowledge_source").get() as { data: string }
		const discovered = { ...JSON.parse(row.data), id: "slack:T1:C2", audience: { kind: "slack_channel", teamId: "T1", channelId: "C2" } }
		agent.sql`INSERT INTO knowledge_source(id,data) VALUES(${discovered.id},${JSON.stringify(discovered)})`
		sqlite.exec("UPDATE knowledge_slack_inbox SET next_attempt=0")
		mocks.ingest.mockResolvedValue(true)
		await drainSlackKnowledgeInbox(agent)
		expect(mocks.ingest).toHaveBeenCalledOnce()
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_slack_inbox").get()).toMatchObject({ processed: 1, data: "" })
	})
	it("scrubs deliveries if workspace removal precedes discovery", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("removed"))
		sqlite.exec("DELETE FROM slack_workspace")
		await drainSlackKnowledgeInbox(agent)
		expect(mocks.ingest).not.toHaveBeenCalled()
		expect(sqlite.prepare("SELECT processed,data FROM knowledge_slack_inbox").get()).toMatchObject({ processed: 1, data: "" })
	})
})
