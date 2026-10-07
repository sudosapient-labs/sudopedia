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
	return { ...f, agent }
}
const delivery = (id: string, event: Record<string, unknown> = {}) => ({ type: "event_callback", team_id: "T1", event_id: id,
	event: { type: "message", channel: "C1", ts: "1700000000.000001", text: "A commitment", ...event } })
describe("durable signed Slack inbox", () => {
	it("shares the tick deadline and honors provider Retry-After", async () => {
		const { agent, sqlite } = setup()
		await receiveSlackKnowledge(agent, delivery("limited"))
		await drainSlackKnowledgeInbox(agent, new KnowledgeBudget(0, Date.now() + 1000))
		expect(mocks.ingest).not.toHaveBeenCalled()
		mocks.ingest.mockRejectedValueOnce(new KnowledgeProviderError("rate_limited", 7_200_000))
		const now = Date.now()
		await drainSlackKnowledgeInbox(agent, new KnowledgeBudget(4, now + 1000))
		expect(sqlite.prepare("SELECT next_attempt FROM knowledge_slack_inbox").get()).toMatchObject({ next_attempt: expect.any(Number) })
		expect((sqlite.prepare("SELECT next_attempt FROM knowledge_slack_inbox").get() as { next_attempt: number }).next_attempt).toBeGreaterThanOrEqual(now + 7_200_000)
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
		for (const id of ["a", "b", "c", "d"]) await receiveSlackKnowledge(agent, delivery(id))
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
		await receiveSlackKnowledge(agent, delivery("notice", { ts: undefined, subtype: "channel_join" }))
		await drainSlackKnowledgeInbox(agent)
		expect(sqlite.prepare("SELECT processed FROM knowledge_slack_inbox").get()).toMatchObject({ processed: 1 })
	})
})
