import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import type { CompanyBrainAgent } from "../turn/agent"
import type { Principal } from "../../external/contracts"
import { commitKnowledge, ensureKnowledgeTables, stageEvents, upsertSource } from "./store"
import type { KnowledgeSource } from "./types"
const mocks = vi.hoisted(() => ({ access: vi.fn(), verify: vi.fn(), makeVerifier: vi.fn(), source: vi.fn() }))
vi.mock("../turn/agent", () => ({ brainAgent: (agent: unknown) => agent }))
vi.mock("./access", () => ({ knowledgeAccess: mocks.access }))
vi.mock("./verify", () => ({ evidenceVerifier: mocks.makeVerifier }))
import { cancelExternalKnowledgeQuery, queryExternalKnowledge } from "./query"
const fixtures: ReturnType<typeof sqliteFixture>[] = []
const principal: Principal = { credentialId: "bot", orgId: "org", userId: "a", kind: "employee", grants: ["memory.personal:read"] }
const source: KnowledgeSource = { id: "s", orgId: "org", connectionId: "conn", provider: "linear", ownerUserId: "a", audience: { kind: "users", userIds: ["a"] }, state: "partial", coverage: [], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60000, failures: 0, error: null }
function setup() {
	const fixture = sqliteFixture(); fixtures.push(fixture)
	const agent = { name: "org", env: fixture.env,
		sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
			const statement = fixture.sqlite.prepare(strings.join("?"))
			return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
		}, ctx: { storage: { transactionSync: <T>(fn: () => T) => fn() } },
	} as unknown as CompanyBrainAgent
	ensureKnowledgeTables(agent); upsertSource(agent, source)
	stageEvents(agent, source, [{ sourceId: source.id, eventId: "e", objectId: "issue", version: 1000, occurredAt: 1000, observedAt: 1000, deleted: false, url: "https://linear.app/test", text: "Started", audience: source.audience }])
	commitKnowledge(agent, source.id, ["e"], [{ subject: "Issue", predicate: "status", value: "Started", evidenceIds: ["e"], confidence: "confirmed" }], 1000)
	return agent
}
beforeEach(() => {
	vi.resetAllMocks()
	mocks.source.mockResolvedValue(true)
	mocks.access.mockImplementation(async () => ({ source: mocks.source, audience: async () => true, incomplete: () => false }))
	mocks.verify.mockResolvedValue(true)
	mocks.makeVerifier.mockImplementation(() => ({ verify: mocks.verify, incomplete: () => false, close: async () => {} }))
})
afterEach(() => fixtures.splice(0).forEach(f => f.sqlite.close()))
describe("one absolute knowledge-query deadline", () => {
	it("does not reset the deadline between slow access and evidence phases", async () => {
		const agent = setup(), deadline = Date.now() + 100
		mocks.source.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 15)); return true })
		mocks.verify.mockImplementation(() => new Promise(() => {}))
		await expect(queryExternalKnowledge(agent, principal, { query: "Started", limit: 10, recall: "current", sourcePage: 0 }, 0, deadline)).rejects.toMatchObject({ status: 504 })
		expect(mocks.makeVerifier).toHaveBeenCalledWith(mocks.access.mock.calls[0]![0], deadline, mocks.access.mock.calls[0]![2])
		expect(mocks.access.mock.calls[0]![2].aborted).toBe(true)
	})
	it("stops subsequent work after caller cancellation, but not a different actor's cancellation", async () => {
		const agent = setup(), requestId = crypto.randomUUID()
		mocks.source.mockImplementation(() => new Promise(() => {}))
		const result = queryExternalKnowledge(agent, principal, null, 0, Date.now() + 1000, requestId)
		const rejected = expect(result).rejects.toMatchObject({ status: 504 })
		await Promise.resolve(); await Promise.resolve()
		cancelExternalKnowledgeQuery(agent, { ...principal, userId: "b" }, requestId)
		expect(mocks.access.mock.calls[0]![2].aborted).toBe(false)
		cancelExternalKnowledgeQuery(agent, principal, requestId)
		await rejected
		expect(mocks.makeVerifier).not.toHaveBeenCalled()
	})
	it("honors cancellation arriving before RPC registration and an already-expired deadline", async () => {
		const agent = setup(), requestId = crypto.randomUUID()
		cancelExternalKnowledgeQuery(agent, principal, requestId)
		await expect(queryExternalKnowledge(agent, principal, null, 0, Date.now() + 1000, requestId)).rejects.toMatchObject({ status: 504 })
		await expect(queryExternalKnowledge(agent, principal, null, 0, Date.now() - 1)).rejects.toMatchObject({ status: 504 })
		expect(mocks.access).not.toHaveBeenCalled()
	})
})
