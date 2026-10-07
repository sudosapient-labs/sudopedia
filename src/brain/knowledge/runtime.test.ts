import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import { mcpConnection } from "../../db/schema/brain/mcp"
import type { CompanyBrainAgent } from "../turn/agent"
import type { KnowledgeSource } from "./types"
import { ensureKnowledgeTables, getSource, listPendingEvents, listSources, queryKnowledge, revokeSource, stageEvents, upsertSource } from "./store"

const mocks = vi.hoisted(() => ({ connections: [] as unknown[], workspaces: [] as unknown[] }))
vi.mock("@repo/db", () => ({ eq: vi.fn(), db: () => ({ select: () => ({ from: (table: unknown) => ({ where: async () => table === mcpConnection ? mocks.connections : mocks.workspaces }) }) }) }))
vi.mock("../turn/agent", () => ({ brainAgent: (agent: unknown) => agent }))
vi.mock("@/lib/crypto", () => ({ decryptToken: vi.fn(async () => "secret") }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: vi.fn() }))
vi.mock("../slack/client", () => ({ getSlackChannelHistoryPage: vi.fn() }))
vi.mock("./reasoning", () => ({ MAX_REASONING_EVENTS: 3, MAX_REASONING_CONTEXT: 2, reasonEvents: vi.fn(async () => []) }))
vi.mock("./adapters", async importOriginal => ({ ...await importOriginal<typeof import("./adapters")>(), openKnowledgeProvider: vi.fn(), inspectKnowledgeTools: vi.fn(), pollLinear: vi.fn(), pollSlack: vi.fn(), slackKnowledgeRequest: vi.fn(), slackKnowledgeToken: vi.fn(async () => "secret") }))
import { KnowledgeProviderError, inspectKnowledgeTools, openKnowledgeProvider, pollLinear, pollSlack, slackKnowledgeRequest } from "./adapters"
import { reasonEvents } from "./reasoning"
import { discoverKnowledgeSources, ensureKnowledgeSchedule, ingestSlackKnowledgeEvent, knowledgeRuntimeConfig, runKnowledgeTick } from "./runtime"

const now = 1_800_000_000_000
const fixtures: ReturnType<typeof sqliteFixture>[] = []
const issueTool = { name: "list_issues", inputSchema: { type: "object" as const, properties: { updatedAt: { type: "string" }, orderBy: { type: "string", enum: ["updatedAt"] }, cursor: { type: "string" }, limit: { type: "number" } } } }
const handle = { listTools: vi.fn(async () => [issueTool]), callTool: vi.fn(), close: vi.fn(async () => {}) }
function connection(id = "conn", userId: string | null = "a", serverSlug = "linear") { return { id, orgId: "org", userId, serverSlug, serverUrl: "https://mcp.linear.app/mcp", status: "active", updatedAt: new Date(now) } }
function source(id = "mcp:conn", ownerUserId: string | null = "a"): KnowledgeSource { return { id, orgId: "org", connectionId: id.replace(/^mcp:/, ""), provider: "linear", ownerUserId, audience: { kind: "users", userIds: ownerUserId ? [ownerUserId] : [] }, state: "partial", coverage: ["issues_updated_window"], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60_000, failures: 0, error: null } }
function event(s: KnowledgeSource) { return { sourceId: s.id, eventId: "e", objectId: "issue-id", version: now - 1, occurredAt: now - 1, observedAt: now, deleted: false, url: "https://linear.app/issue/id", text: "Explicit status", audience: s.audience } }
function setup(overrides: Record<string, unknown> = {}) {
	const fixture = sqliteFixture(); fixtures.push(fixture)
	const schedules: Array<{ id: string; callback: string; type: string; payload: unknown; cron?: string }> = []
	const shell = {
		env: { ...fixture.env, PUBLIC_URL: "https://example.invalid", ...overrides },
		sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
			const statement = fixture.sqlite.prepare(strings.join("?"))
			return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
		},
		ctx: { storage: { transactionSync<T>(fn: () => T): T {
			fixture.sqlite.exec("SAVEPOINT runtime_test")
			try { const result = fn(); fixture.sqlite.exec("RELEASE runtime_test"); return result }
			catch (error) { fixture.sqlite.exec("ROLLBACK TO runtime_test"); fixture.sqlite.exec("RELEASE runtime_test"); throw error }
		} } },
		getSchedules: () => schedules,
		cancelSchedule: vi.fn(async (id: string) => { const index = schedules.findIndex(s => s.id === id); if (index >= 0) schedules.splice(index, 1) }),
		schedule: vi.fn(async (_when: unknown, callback: string, payload: unknown) => { const schedule = { id: `s${schedules.length}`, type: "cron", cron: "* * * * *", callback, payload }; schedules.push(schedule); return schedule }),
	}
	const agent = shell as unknown as CompanyBrainAgent
	ensureKnowledgeTables(agent)
	return { agent, shell, schedules }
}
beforeEach(() => {
	vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks()
	mocks.connections = []; mocks.workspaces = []
	vi.mocked(openKnowledgeProvider).mockResolvedValue(handle)
	vi.mocked(inspectKnowledgeTools).mockResolvedValue([issueTool])
	vi.mocked(pollLinear).mockImplementation(async s => ({ events: [event(s)], cursor: "next-page", processedThrough: s.processedThrough ?? now - 100_000, complete: false }))
	vi.mocked(reasonEvents).mockResolvedValue([])
	vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channels: [], response_metadata: { next_cursor: "" } })
})
afterEach(() => { vi.useRealTimers(); for (const fixture of fixtures.splice(0)) fixture.sqlite.close() })

describe("proactive ingestion runtime", () => {
	it("keeps a partially committed 25-event page checkpoint across a failed chunk and retries without refetching", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(pollLinear).mockImplementationOnce(async s => ({ events: Array.from({ length: 25 }, (_, i) => ({ ...event(s), eventId: `retry-${i}`, objectId: `object-${i}` })), cursor: "checkpoint", processedThrough: now, complete: false }))
		vi.mocked(reasonEvents).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("crash during third chunk"))
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(19)
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: null, processedThrough: null })
		vi.setSystemTime(now + 120_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: "checkpoint", processedThrough: now })
		expect(pollLinear).toHaveBeenCalledTimes(1)
		expect(vi.mocked(reasonEvents).mock.calls.every(call => call[1].length <= 3 && call[2]!.length <= 2)).toBe(true)
	})
	it("drains a default 25-event page in <=3 event / <=2 context chunks before promoting its checkpoint", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(pollLinear).mockImplementationOnce(async s => ({ events: Array.from({ length: 25 }, (_, i) => ({ ...event(s), eventId: `page-${i}`, objectId: `object-${i}` })), cursor: "page-complete", processedThrough: now, complete: false }))
		vi.mocked(reasonEvents).mockImplementation(async (_env, batch, context) => {
			expect(batch.length).toBeLessThanOrEqual(3)
			expect(context!.length).toBeLessThanOrEqual(2)
			expect(getSource(agent, "mcp:conn")!.cursor).toBeNull()
			expect(getSource(agent, "mcp:conn")!.processedThrough).toBeNull()
			return [{ subject: "Issue", predicate: "state", value: "Explicit status", evidenceIds: [batch[0]!.eventId], confidence: "confirmed" }]
		})
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(reasonEvents).toHaveBeenCalledTimes(9)
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: "page-complete", processedThrough: now })
		const facts = queryKnowledge(agent, ["mcp:conn"], "").facts
		expect(facts).toHaveLength(9)
		expect(facts.every(f => new Set(f.evidence.map(e => e.objectId)).size <= 5)).toBe(true)
	})
	it("retries all pending inputs after an uncited edit during model reasoning", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(pollLinear).mockImplementationOnce(async s => ({ events: [event(s), { ...event(s), eventId: "private", objectId: "private-object" }], cursor: "checkpoint", processedThrough: now, complete: false }))
		vi.mocked(reasonEvents).mockImplementationOnce(async () => {
			stageEvents(agent, source(), [{ ...event(source()), eventId: "private-edit", objectId: "private-object", version: now + 1 }])
			return [{ subject: "Issue", predicate: "state", value: "tainted", evidenceIds: ["e"], confidence: "confirmed" }]
		})
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(queryKnowledge(agent, ["mcp:conn"], "").facts).toEqual([])
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: null, processedThrough: null })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(2)
		vi.setSystemTime(now + 120_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(pollLinear).toHaveBeenCalledTimes(1)
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
		expect(getSource(agent, "mcp:conn")!.cursor).toBe("checkpoint")
	})
	it("registers all actual same-provider connection rows with fail-closed audiences", async () => {
		const { agent } = setup()
		mocks.connections = [connection("one", "a"), connection("two", "b"), connection("shared", null), connection("custom", "a", "custom")]
		await discoverKnowledgeSources(agent, "org")
		expect(listSources(agent)).toHaveLength(4)
		expect(getSource(agent, "mcp:one")!.audience).toEqual({ kind: "users", userIds: ["a"] })
		expect(getSource(agent, "mcp:two")!.audience).toEqual({ kind: "users", userIds: ["b"] })
		expect(getSource(agent, "mcp:shared")!.audience).toEqual({ kind: "users", userIds: [] })
		await discoverKnowledgeSources(agent, "org")
		expect(getSource(agent, "mcp:custom")!.state).toBe("unsupported")
		expect(handle.callTool).not.toHaveBeenCalled()
	})
	it("arms a single durable recurring callback and repairs duplicate schedules", async () => {
		const { agent, shell, schedules } = setup()
		await ensureKnowledgeSchedule(agent, "org")
		await ensureKnowledgeSchedule(agent, "org")
		expect(shell.schedule).toHaveBeenCalledExactlyOnceWith("* * * * *", "runKnowledgeTick", { orgId: "org" })
		schedules.push({ id: "duplicate", type: "delayed", callback: "runKnowledgeTick", payload: { orgId: "org" } })
		await ensureKnowledgeSchedule(agent, "org")
		expect(schedules).toHaveLength(1)
		expect(shell.cancelSchedule).toHaveBeenCalledWith("duplicate")
	})
	it("does not advance cursor or lastProcessedAt on reasoning failure; retries pending first", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(reasonEvents).mockRejectedValueOnce(new Error("secret raw provider error"))
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: null, lastProcessedAt: null, processedThrough: null, error: "provider_failed" })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(1)
		vi.setSystemTime(now + 120_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(pollLinear).toHaveBeenCalledTimes(1)
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
		expect(getSource(agent, "mcp:conn")!.lastProcessedAt).toBe(now + 120_000)
		expect(getSource(agent, "mcp:conn")!.cursor).toBe("next-page")
	})
	it("advances committed cursors, skips model calls on replay and empty fetches", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: "next-page", lastProcessedAt: now })
		vi.setSystemTime(now + 60_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(reasonEvents).toHaveBeenCalledTimes(1)
		expect(getSource(agent, "mcp:conn")!.lastProcessedAt).toBe(now)
		vi.mocked(pollLinear).mockResolvedValueOnce({ events: [], cursor: null, complete: true, processedThrough: now + 120_000 })
		vi.setSystemTime(now + 120_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(getSource(agent, "mcp:conn")).toMatchObject({ cursor: null, lastProcessedAt: now, processedThrough: now + 120_000, intervalMs: 120_000 })
	})
	it("does not reason or publish shared credential content with unknown ACLs", async () => {
		const { agent } = setup(); mocks.connections = [connection("conn", null)]; upsertSource(agent, source("mcp:conn", null))
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(reasonEvents).not.toHaveBeenCalled()
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
	})
	it("does not promote a staged page checkpoint until all smaller retry chunks commit", async () => {
		const { agent, shell } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(pollLinear).mockImplementationOnce(async s => ({ events: [event(s), { ...event(s), eventId: "e2", objectId: "other" }], cursor: "checkpoint", complete: false, processedThrough: now - 100_000 }))
		vi.mocked(reasonEvents).mockRejectedValueOnce(new Error("model failed"))
		await runKnowledgeTick(agent, { orgId: "org" })
		Object.assign(shell.env, { KNOWLEDGE_PAGE_SIZE: 1 })
		vi.setSystemTime(now + 120_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(1)
		expect(getSource(agent, "mcp:conn")!.cursor).toBeNull()
		vi.setSystemTime(now + 180_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
		expect(getSource(agent, "mcp:conn")!.cursor).toBe("checkpoint")
		expect(pollLinear).toHaveBeenCalledTimes(1)
	})
	it("does not admit provider work after its operation budget is exhausted", async () => {
		const { agent } = setup({ KNOWLEDGE_MAX_SUBREQUESTS: 4 }); mocks.connections = [connection()]; upsertSource(agent, source())
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(openKnowledgeProvider).not.toHaveBeenCalled()
		expect(pollLinear).not.toHaveBeenCalled()
	})
	it("keeps revocation terminal when it interleaves with reasoning", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(reasonEvents).mockImplementationOnce(async () => { revokeSource(agent, "mcp:conn"); return [] })
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(getSource(agent, "mcp:conn")).toMatchObject({ state: "revoked", audience: { kind: "users", userIds: [] }, cursor: null })
		expect(listPendingEvents(agent, "mcp:conn")).toHaveLength(0)
	})
	it("rotates overdue work fairly under source/page/event limits", async () => {
		const { agent } = setup({ KNOWLEDGE_MAX_SOURCES: 2, KNOWLEDGE_MAX_PAGES: 2, KNOWLEDGE_MAX_EVENTS: 2 })
		mocks.connections = ["1", "2", "3", "4"].map(id => connection(id))
		for (const row of mocks.connections as Array<{ id: string }>) upsertSource(agent, source(`mcp:${row.id}`))
		await runKnowledgeTick(agent, { orgId: "org" })
		vi.setSystemTime(now + 60_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(vi.mocked(pollLinear).mock.calls.map(call => call[0].id)).toEqual(["mcp:1", "mcp:2", "mcp:3", "mcp:4"])
	})
	it("honors Retry-After and does not persist raw provider messages", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		vi.mocked(pollLinear).mockRejectedValueOnce(new KnowledgeProviderError("rate_limited", 3_600_000))
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(getSource(agent, "mcp:conn")).toMatchObject({ nextCheckAt: now + 3_600_000, error: "rate_limited", failures: 1 })
		vi.setSystemTime(now + 120_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(pollLinear).toHaveBeenCalledTimes(1)
	})
	it("revokes removed rows and creates a fresh identity on reconnection", async () => {
		const { agent } = setup(); mocks.connections = [connection()]; upsertSource(agent, source())
		mocks.connections = []; await discoverKnowledgeSources(agent, "org")
		expect(getSource(agent, "mcp:conn")!.state).toBe("revoked")
		mocks.connections = [connection()]; await discoverKnowledgeSources(agent, "org")
		expect(getSource(agent, "mcp:conn")!.state).toBe("revoked")
		const fresh = listSources(agent).find(s => s.state !== "revoked")!
		expect(fresh.id).not.toBe("mcp:conn")
		expect(fresh.cursor).toBeNull()
	})
	it("discovers joined Slack channels page by page, then stages old-thread edit/delete webhooks", async () => {
		const { agent } = setup(); mocks.workspaces = [{ teamId: "T", orgId: "org", botTokenEnc: "encrypted" }]
		vi.mocked(slackKnowledgeRequest).mockResolvedValueOnce({ channels: [{ id: "C" }], response_metadata: { next_cursor: "next" } })
		await discoverKnowledgeSources(agent, "org")
		expect(getSource(agent, "slack:T:C")!.audience).toEqual({ kind: "slack_channel", teamId: "T", channelId: "C" })
		vi.setSystemTime(now + 60_000)
		vi.mocked(slackKnowledgeRequest).mockResolvedValueOnce({ channels: [{ id: "D" }], response_metadata: { next_cursor: "" } })
		await discoverKnowledgeSources(agent, "org")
		expect(slackKnowledgeRequest).toHaveBeenLastCalledWith("secret", "users.conversations", expect.objectContaining({ cursor: "next" }), expect.anything())
		expect(getSource(agent, "slack:T:C")!.state).not.toBe("revoked")
		vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channel: { is_member: true } })
		const payload = { team_id: "T", event_id: "Ev1", event: { type: "message", channel: "C", ts: "1800000000.000001", thread_ts: "1700000000.000001", text: "Reply" } }
		expect(await ingestSlackKnowledgeEvent(agent, payload)).toBe(true)
		expect(listPendingEvents(agent, "slack:T:C")[0]!.text).toContain("thread 1700000000.000001")
		expect(await ingestSlackKnowledgeEvent(agent, { ...payload, event_id: "Ev2", event: { type: "message", channel: "C", subtype: "message_deleted", deleted_ts: payload.event.ts, event_ts: "1800000001.000001" } })).toBe(true)
		// Tombstones are durable and require no pending model work.
		expect(listPendingEvents(agent, "slack:T:C")).toHaveLength(0)
		expect(agent.sql<{ deleted: number }>`SELECT deleted FROM knowledge_head WHERE source_id='slack:T:C' AND object_id=${payload.event.ts}`[0]!.deleted).toBe(1)
		expect(await ingestSlackKnowledgeEvent(agent, { ...payload, event: { ...payload.event, channel: "UNKNOWN" } })).toBe(false)
	})
	it("checks current bot membership before Slack polling and fails closed", async () => {
		const { agent } = setup(); mocks.workspaces = [{ teamId: "T", orgId: "org", botTokenEnc: "encrypted" }]
		vi.mocked(slackKnowledgeRequest).mockResolvedValueOnce({ channels: [{ id: "C" }], response_metadata: { next_cursor: "" } })
		await discoverKnowledgeSources(agent, "org")
		vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channel: { is_member: false } })
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(pollSlack).not.toHaveBeenCalled()
		expect(getSource(agent, "slack:T:C")!.state).toBe("revoked")
	})
	it("shares Slack Retry-After cooldown across channels in one installation", async () => {
		const { agent } = setup(); mocks.workspaces = [{ teamId: "T", orgId: "org", botTokenEnc: "encrypted" }]
		vi.mocked(slackKnowledgeRequest).mockResolvedValueOnce({ channels: [{ id: "C" }, { id: "D" }], response_metadata: { next_cursor: "" } })
		await discoverKnowledgeSources(agent, "org")
		vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channel: { is_member: true } })
		vi.mocked(pollSlack).mockRejectedValue(new KnowledgeProviderError("rate_limited", 3_600_000))
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(pollSlack).toHaveBeenCalledTimes(1)
		vi.setSystemTime(now + 60_000)
		await runKnowledgeTick(agent, { orgId: "org" })
		expect(pollSlack).toHaveBeenCalledTimes(1)
	})
	it("clamps optional runtime configuration", () => {
		const config = knowledgeRuntimeConfig({ KNOWLEDGE_MAX_SOURCES: "999", KNOWLEDGE_MAX_EVENTS: "999999", KNOWLEDGE_MIN_INTERVAL_MS: "1", KNOWLEDGE_RETENTION_MS: "bad" } as unknown as Env)
		expect(config).toMatchObject({ maxSources: 20, maxEvents: 500, minIntervalMs: 60_000, retentionMs: 90 * 86_400_000 })
	})
})
