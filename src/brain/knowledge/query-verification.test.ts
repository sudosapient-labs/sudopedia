// Real access/store/query/verifier/budgets; only the provider transport is mocked.
import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import type { CompanyBrainAgent } from "../turn/agent"
import { commitKnowledge, ensureKnowledgeTables, stageEvents, upsertSource } from "./store"
import type { KnowledgeSource } from "./types"
const mocks = vi.hoisted(() => ({ connect: vi.fn(), list: vi.fn(), call: vi.fn() }))
vi.mock("../turn/agent", () => ({ brainAgent: (agent: unknown) => agent }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: mocks.connect }))
vi.mock("../tools/mcp/store", () => ({ getConnectionById: async () => ({ id: "conn", orgId: "org", userId: "a", runtime: "embedded", status: "active", serverUrl: "https://mcp.linear.app/mcp" }) }))
import { queryExternalKnowledge } from "./query"
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(f => f.sqlite.close()); vi.clearAllMocks() })
describe("production disclosure budgets", () => {
	it("returns facts from a default 25-issue page without bypassing real owner access or evidence checks", async () => {
		const fixture = sqliteFixture(); fixtures.push(fixture)
		fixture.sqlite.exec("INSERT INTO mcp_connection(id,org_id,user_id,server_slug,runtime,auth_type,status,created_at,updated_at) VALUES('conn','org','a','linear','remote_mcp','none','active',1,1)")
		const agent = { name: "org", env: { ...fixture.env, PUBLIC_URL: "https://example.invalid" },
			sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
				const statement = fixture.sqlite.prepare(strings.join("?"))
				return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
			}, ctx: { storage: { transactionSync: <T>(fn: () => T) => fn() } },
		} as unknown as CompanyBrainAgent
		const source: KnowledgeSource = { id: "s", orgId: "org", connectionId: "conn", provider: "linear", ownerUserId: "a", audience: { kind: "users", userIds: ["a"] }, state: "partial", coverage: [], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60000, failures: 0, error: null }
		ensureKnowledgeTables(agent); upsertSource(agent, source)
		const events = Array.from({ length: 25 }, (_, index) => ({ sourceId: "s", eventId: `e${index}`, objectId: `issue${index}`, version: 1000, occurredAt: 1000, observedAt: 1000, deleted: false, url: `https://linear.app/issue/${index}`, text: `Recorded progress ${index}`, audience: source.audience }))
		stageEvents(agent, source, events)
		commitKnowledge(agent, "s", events.map(e => e.eventId), [{ subject: "Issue", predicate: "status", value: "Started", evidenceIds: [events[0]!.eventId], confidence: "confirmed" }], 1000)
		mocks.list.mockResolvedValue([{ name: "get_issue", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }])
		mocks.call.mockImplementation(async (_name, input) => ({ structuredContent: { id: input.id, updatedAt: new Date(1000).toISOString() } }))
		mocks.connect.mockResolvedValue({ listTools: mocks.list, callTool: mocks.call, close: async () => {} })
		const principal = { credentialId: "bot", orgId: "org", userId: "a", kind: "employee" as const, grants: ["memory.personal:read" as const] }
		const result = await queryExternalKnowledge(agent, principal, { query: "Started", limit: 10, recall: "current", sourcePage: 0 })
		expect(result.facts).toHaveLength(1)
		expect(result.facts[0]!.evidence).toHaveLength(25)
		expect(result.accessCoverageIncomplete).toBe(false)
		expect(mocks.call).toHaveBeenCalledTimes(25); expect(mocks.list).toHaveBeenCalledOnce()
		const denied = await queryExternalKnowledge(agent, { ...principal, userId: "b" }, { query: "Started", limit: 10, recall: "current", sourcePage: 0 })
		expect(denied.facts).toEqual([])
	})
})
