import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import { mcpConnection } from "../../db/schema/brain/mcp"
import type { CompanyBrainAgent } from "../turn/agent"
import type { KnowledgeSource } from "./types"
import { commitKnowledge, ensureKnowledgeTables, getSource, listPendingEvents, queryKnowledge, revokeSource, stageEvents, upsertSource } from "./store"

const mocks = vi.hoisted(() => ({ workspaces: [] as unknown[] }))
vi.mock("@repo/db", () => ({ eq: vi.fn(), db: () => ({ select: () => ({ from: (table: unknown) => ({ where: async () => table === mcpConnection ? [] : mocks.workspaces }) }) }) }))
vi.mock("../turn/agent", () => ({ brainAgent: (agent: unknown) => agent }))
vi.mock("@/lib/crypto", () => ({ decryptToken: vi.fn(async () => "secret") }))
vi.mock("../slack/client", () => ({ getSlackThreadHistoryPage: vi.fn(), getSlackChannelHistoryPage: vi.fn() }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: vi.fn() }))
vi.mock("./reasoning", () => ({ reasonEvents: vi.fn() }))
vi.mock("./adapters", async importOriginal => ({ ...await importOriginal<typeof import("./adapters")>(), slackKnowledgeRequest: vi.fn(), slackKnowledgeToken: vi.fn(async () => "secret") }))
import { getSlackThreadHistoryPage } from "../slack/client"
import { KnowledgeBudget, KnowledgeProviderError, slackEvidence, slackKnowledgeRequest } from "./adapters"
import { discoverKnowledgeSources } from "./runtime"
import { reconcileSlackThreads, rememberSlackThreads } from "./threads"

const now = 1_800_000_000_000
const root = "1700000000.000001"
const fixtures: ReturnType<typeof sqliteFixture>[] = []
function source(id = "slack:T:C"): KnowledgeSource {
	return { id, orgId: "org", connectionId: "slack:T", provider: "slack", ownerUserId: null, audience: { kind: "slack_channel", teamId: "T", channelId: "C" }, state: "partial", coverage: ["no_thread_reconciliation"], cursor: "history-cursor", lastCheckedAt: now - 1000, lastProcessedAt: now - 2000, processedThrough: now - 3000, nextCheckAt: now + 1000, intervalMs: 60_000, failures: 0, error: null }
}
function setup() {
	const fixture = sqliteFixture(); fixtures.push(fixture)
	fixture.sqlite.exec("INSERT INTO slack_workspace(team_id,org_id,bot_token_enc,created_at,updated_at) VALUES ('T','org','encrypted',1,1)")
	const agent = {
		env: fixture.env,
		sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
			const statement = fixture.sqlite.prepare(strings.join("?"))
			return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
		},
		ctx: { storage: { transactionSync<T>(fn: () => T): T {
			fixture.sqlite.exec("SAVEPOINT threads_test")
			try { const result = fn(); fixture.sqlite.exec("RELEASE threads_test"); return result }
			catch (error) { fixture.sqlite.exec("ROLLBACK TO threads_test"); fixture.sqlite.exec("RELEASE threads_test"); throw error }
		} } },
	} as unknown as CompanyBrainAgent
	ensureKnowledgeTables(agent)
	const s = source(); upsertSource(agent, s)
	rememberSlackThreads(agent, s, [], [root])
	return { agent, s, ...fixture }
}
function reconcile(agent: CompanyBrainAgent, remaining = 10) { return reconcileSlackThreads(agent, (agent as unknown as { env: Env }).env, "org", new KnowledgeBudget(remaining, Date.now() + 25_000)) }
function reply(ts = "1799999999.000001") { return { ts, thread_ts: root, user: "U", text: "ISSUE-42 explicitly updated" } }
beforeEach(() => {
	vi.useFakeTimers(); vi.setSystemTime(now); vi.resetAllMocks()
	mocks.workspaces = []
	vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channel: { is_member: true } })
	vi.mocked(getSlackThreadHistoryPage).mockResolvedValue({ ok: true, items: [reply()], complete: true })
})
afterEach(() => { vi.useRealTimers(); for (const fixture of fixtures.splice(0)) fixture.sqlite.close() })

describe("known Slack thread reconciliation", () => {
	it("remembers explicit roots and reply contexts, deduplicating and rejecting unrelated contexts", () => {
		const { agent, s, sqlite } = setup()
		const event = slackEvidence(s, reply(), now)!
		rememberSlackThreads(agent, s, [event, { ...event, context: "1700000002.000001" }, { ...event, sourceId: "other", context: "slack-thread:1700000003.000001" }], [root, "invalid", "1".repeat(33) + ".1", "1700000001.000001"])
		expect(sqlite.prepare("SELECT thread_ts FROM knowledge_slack_thread ORDER BY thread_ts").all()).toEqual([{ thread_ts: root }, { thread_ts: "1700000001.000001" }])
	})
	it("recovers old replies without advancing processing or channel-history checkpoints; replay deduplicates", async () => {
		const { agent, s, sqlite } = setup()
		await reconcile(agent)
		expect(getSlackThreadHistoryPage).toHaveBeenCalledWith("secret", "C", root, expect.objectContaining({ limit: 15, cursor: undefined, signal: expect.any(AbortSignal) }))
		expect(listPendingEvents(agent, s.id)).toHaveLength(1)
		expect(getSource(agent, s.id)).toMatchObject({ cursor: s.cursor, lastProcessedAt: s.lastProcessedAt, processedThrough: s.processedThrough, coverage: expect.arrayContaining(["known_thread_reconciliation", "unknown_roots_outside_backfill_uncovered", "missed_deletions_unverified"]) })
		expect(getSource(agent, s.id)!.coverage).not.toContain("no_thread_reconciliation")
		expect(sqlite.prepare("SELECT cursor,seen,next_check FROM knowledge_slack_thread").get()).toEqual({ cursor: null, seen: "[]", next_check: now + 1_800_000 })
		vi.setSystemTime(now + 1_800_000); await reconcile(agent)
		expect(listPendingEvents(agent, s.id)).toHaveLength(1)
	})
	it("pages one thread per call and fairly rotates before continuing an older thread", async () => {
		const { agent, s } = setup()
		rememberSlackThreads(agent, s, [], ["1700000001.000001"])
		vi.mocked(getSlackThreadHistoryPage).mockResolvedValueOnce({ ok: true, items: [], complete: false, nextCursor: "A" })
		await reconcile(agent)
		vi.setSystemTime(now + 60_000); await reconcile(agent); await reconcile(agent)
		expect(vi.mocked(getSlackThreadHistoryPage).mock.calls.map(c => [c[2], c[3]?.cursor])).toEqual([[root, undefined], ["1700000001.000001", undefined], [root, "A"]])
	})
	it("preserves reconciliation coverage through discovery and its hourly refresh", async () => {
		const { agent, s } = setup()
		await reconcile(agent)
		mocks.workspaces = [{ teamId: "T", orgId: "org", botTokenEnc: "encrypted" }]
		vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channels: [{ id: "C" }], response_metadata: { next_cursor: "" } })
		await discoverKnowledgeSources(agent, "org")
		vi.setSystemTime(now + 3_600_000); await discoverKnowledgeSources(agent, "org")
		expect(getSource(agent, s.id)!.coverage).toContain("known_thread_reconciliation")
		expect(getSource(agent, s.id)!.coverage).not.toContain("no_thread_reconciliation")
	})
	it("caps the registry and does not register revoked sources", () => {
		const { agent, s, sqlite } = setup()
		rememberSlackThreads(agent, s, [], Array.from({ length: 1001 }, (_, i) => `${1700000001 + i}.000001`))
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_thread").get()).toEqual({ n: 1000 })
		expect(getSource(agent, s.id)!.coverage).toContain("thread_registry_capacity_exceeded")
		revokeSource(agent, s.id)
		rememberSlackThreads(agent, getSource(agent, s.id)!, [], ["1900000000.000001"])
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_thread").get()).toEqual({ n: 1000 })
	})
	it.each(["replies", "membership"])("honors %s rate limits without staging or advancing progress", async where => {
		const { agent, s, sqlite } = setup()
		const sibling = source("slack:T:D")
		upsertSource(agent, sibling); rememberSlackThreads(agent, sibling, [], [root])
		if (where === "replies") vi.mocked(getSlackThreadHistoryPage).mockResolvedValue({ ok: false, error: "ratelimited", retryAfterSeconds: 3600 })
		else vi.mocked(slackKnowledgeRequest).mockRejectedValue(new KnowledgeProviderError("rate_limited", 3_600_000))
		await reconcile(agent)
		expect(sqlite.prepare("SELECT next_check,error,cursor FROM knowledge_slack_thread WHERE source_id=?").get(s.id)).toEqual({ next_check: now + 3_600_000, error: "rate_limited", cursor: null })
		expect(sqlite.prepare("SELECT value FROM brain_knowledge_runtime WHERE key='cooldown:slack:T'").get()).toEqual({ value: String(now + 3_600_000) })
		expect(listPendingEvents(agent, s.id)).toEqual([])
		expect(getSource(agent, s.id)!.lastProcessedAt).toBe(s.lastProcessedAt)
		vi.setSystemTime(now + 60_000); await reconcile(agent)
		expect(slackKnowledgeRequest).toHaveBeenCalledTimes(1)
	})
	it("honors an existing installation cooldown set by channel polling", async () => {
		const { agent, sqlite } = setup()
		sqlite.prepare("INSERT INTO brain_knowledge_runtime(key,value) VALUES ('cooldown:slack:T',?)").run(String(now + 120_000))
		await reconcile(agent)
		expect(slackKnowledgeRequest).not.toHaveBeenCalled()
		vi.setSystemTime(now + 120_000); await reconcile(agent)
		expect(getSlackThreadHistoryPage).toHaveBeenCalledTimes(1)
	})
	it.each(["membership", "token", "reply", "workspace"])("revokes the source and cross-source dependencies on verified %s access loss", async where => {
		const { agent, s, sqlite } = setup()
		const evidence = slackEvidence(s, reply(), now)!
		stageEvents(agent, s, [evidence]); commitKnowledge(agent, s.id, [evidence.eventId], [{ subject: "ISSUE-42", predicate: "status", value: "updated", evidenceIds: [evidence.eventId], confidence: "confirmed" }], now)
		const support = queryKnowledge(agent, [s.id], "").facts[0]!.evidence[0]!
		const other = { ...source("linear"), provider: "linear", audience: { kind: "users" as const, userIds: ["a"] } }
		upsertSource(agent, other)
		const anchored = { ...evidence, sourceId: other.id, eventId: "linear-event", objectId: "ISSUE-42", audience: other.audience }
		stageEvents(agent, other, [anchored]); commitKnowledge(agent, other.id, [anchored.eventId], [{ subject: "ISSUE-42", predicate: "status", value: "updated", evidenceIds: [anchored.eventId, support.eventId], confidence: "confirmed" }], now, [support])
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact WHERE current=1").get()).toEqual({ n: 2 })
		if (where === "membership") vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channel: { is_member: false } })
		if (where === "token") vi.mocked(slackKnowledgeRequest).mockRejectedValue(new KnowledgeProviderError("revoked"))
		if (where === "reply") vi.mocked(getSlackThreadHistoryPage).mockResolvedValue({ ok: false, error: "not_in_channel" })
		if (where === "workspace") sqlite.exec("DELETE FROM slack_workspace")
		await reconcile(agent)
		expect(getSource(agent, s.id)).toMatchObject({ state: "revoked", audience: { kind: "users", userIds: [] } })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact WHERE current=1").get()).toEqual({ n: 0 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_thread").get()).toEqual({ n: 0 })
		expect(queryKnowledge(agent, [s.id, other.id], "", 20, true).facts).toEqual([])
		if (where !== "reply") expect(getSlackThreadHistoryPage).not.toHaveBeenCalled()
	})
	it("fails closed on unverifiable membership without declaring verified revocation", async () => {
		const { agent, s } = setup()
		vi.mocked(slackKnowledgeRequest).mockResolvedValue({ channel: {} })
		await reconcile(agent)
		expect(getSlackThreadHistoryPage).not.toHaveBeenCalled()
		expect(getSource(agent, s.id)).toMatchObject({ state: "partial", error: "thread_invalid_response" })
	})
	it("rejects multi-page cursor cycles before staging, resets bounded progress and retries", async () => {
		const { agent, s, sqlite } = setup()
		for (const [index, nextCursor] of ["A", "B", "A"].entries()) {
			vi.mocked(getSlackThreadHistoryPage).mockResolvedValueOnce({ ok: true, items: [reply(index === 2 ? "1799999998.000001" : undefined)], complete: false, nextCursor })
			await reconcile(agent); vi.setSystemTime(Date.now() + 60_000)
		}
		expect(sqlite.prepare("SELECT cursor,seen,error FROM knowledge_slack_thread").get()).toEqual({ cursor: null, seen: "[]", error: "invalid_response" })
		expect(listPendingEvents(agent, s.id)).toHaveLength(1)
		await reconcile(agent)
		expect(vi.mocked(getSlackThreadHistoryPage).mock.calls[3]![3]?.cursor).toBeUndefined()
	})
	it.each(["missing", "oversized", "pages", "items"])("bounds invalid %s pagination responses", async kind => {
		const { agent, s, sqlite } = setup()
		if (kind === "pages") sqlite.prepare("UPDATE knowledge_slack_thread SET seen=?").run(JSON.stringify(Array.from({ length: 512 }, (_, i) => i)))
		vi.mocked(getSlackThreadHistoryPage).mockResolvedValue({ ok: true, items: kind === "items" ? Array.from({ length: 16 }, () => reply()) : [reply()], complete: false, nextCursor: kind === "missing" ? undefined : kind === "oversized" ? "x".repeat(2049) : "next" })
		await reconcile(agent)
		expect(listPendingEvents(agent, s.id)).toEqual([])
		expect(sqlite.prepare("SELECT cursor,seen,error FROM knowledge_slack_thread").get()).toEqual({ cursor: null, seen: "[]", error: "invalid_response" })
	})
	it("admits no work below budget and does not delete another organization's registry", async () => {
		const { agent, sqlite, env } = setup()
		await reconcile(agent, 3)
		expect(slackKnowledgeRequest).not.toHaveBeenCalled()
		await reconcileSlackThreads(agent, env, "other", new KnowledgeBudget(10, now + 25_000))
		expect(slackKnowledgeRequest).not.toHaveBeenCalled()
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_thread").get()).toEqual({ n: 1 })
	})
	it("keeps revocation terminal when it interleaves with a replies request", async () => {
		const { agent, s, sqlite } = setup()
		vi.mocked(getSlackThreadHistoryPage).mockImplementationOnce(async () => { revokeSource(agent, s.id); return { ok: true, items: [reply()], complete: true } })
		await reconcile(agent)
		expect(getSource(agent, s.id)!.state).toBe("revoked")
		expect(listPendingEvents(agent, s.id)).toEqual([])
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_slack_thread").get()).toEqual({ n: 0 })
	})
})
