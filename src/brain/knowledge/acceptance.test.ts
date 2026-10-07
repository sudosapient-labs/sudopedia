// Fixture evidence and model proposals, not live provider/model certification.
import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import { execute, type ExternalDependencies } from "../../external/service"
import type { Principal } from "../../external/contracts"
import type { CompanyBrainAgent } from "../turn/agent"
import type { EvidenceEvent, KnowledgeSource } from "./types"
import { commitKnowledge, ensureKnowledgeTables, queryKnowledge, reasoningContext, stageEvents, upsertSource } from "./store"
const acl = vi.hoisted(() => ({ channels: true, sources: new Set<string>() }))
vi.mock("../turn/agent", () => ({ brainAgent: (a: unknown) => a }))
vi.mock("./access", () => ({ knowledgeAccess: async (_env: unknown, p: Principal) => ({
	source: async (s: KnowledgeSource) => acl.sources.has(s.id) && s.orgId === p.orgId,
	audience: async (a: any): Promise<boolean> => a.kind === "intersection"
		? (await Promise.all(a.audiences.map((x: any) => x.kind === "users" ? x.userIds.includes(p.userId) : acl.channels))).every(Boolean)
		: a.kind === "users" ? a.userIds.includes(p.userId) : acl.channels,
	incomplete: () => false,
}) }))
vi.mock("./verify", () => ({ evidenceVerifier: () => ({ verify: async () => true, incomplete: () => false, close: async () => {} }) }))
import { queryExternalKnowledge } from "./query"
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(f => f.sqlite.close()); acl.channels = true; acl.sources.clear() })
const principal: Principal = { credentialId: "sabari-bot", userId: "a", orgId: "org", kind: "employee", grants: ["memory.personal:read", "memory.private-channel:read"] }
function source(id: string, provider = id): KnowledgeSource {
	return { id, orgId: "org", connectionId: id, provider, ownerUserId: "a", audience: { kind: "users", userIds: ["a"] }, state: "partial", coverage: ["fixture_change_feed"], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60000, failures: 0, error: null }
}
function setup() {
	const f = sqliteFixture(); fixtures.push(f)
	const agent = { name: "org", env: f.env, sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
		const q = f.sqlite.prepare(strings.join("?")); return q.columns().length ? q.all(...values) : (q.run(...values), [])
	}, ctx: { storage: { transactionSync<T>(fn: () => T): T {
		f.sqlite.exec("SAVEPOINT acceptance")
		try { const r = fn(); f.sqlite.exec("RELEASE acceptance"); return r }
		catch (e) { f.sqlite.exec("ROLLBACK TO acceptance"); f.sqlite.exec("RELEASE acceptance"); throw e }
	} } } } as unknown as CompanyBrainAgent
	ensureKnowledgeTables(agent)
	const sources = [source("granola"), { ...source("slack"), audience: { kind: "slack_channel" as const, teamId: "T1", channelId: "C1" } }, source("linear")]
	for (const s of sources) { upsertSource(agent, s); acl.sources.add(s.id) }
	const deps: ExternalDependencies = { authenticate: async () => principal, quota: async () => {}, search: async () => ({}), listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }),
		knowledge: (input, p) => queryExternalKnowledge(agent, p, input) }
	return { agent, sources, deps }
}
function evidence(s: KnowledgeSource, id: string, objectId: string, version: number, text: string, url: string): EvidenceEvent {
	return { sourceId: s.id, eventId: id, objectId, version, occurredAt: version, observedAt: Date.now(), text, url, deleted: false, audience: s.audience }
}
describe("company brain acceptance through authenticated MCP service", () => {
	it("links explicit request evidence, records ownership, returns current progress, and supersedes review state", async () => {
		const { agent, sources: [granola, slack, linear], deps } = setup()
		const originalTime = Date.parse("2026-10-05T10:00:00Z")
		const request = evidence(granola!, "meeting", "meeting-1", originalTime, "Client requested a CSV export. The work item is issue-42.", "https://granola.ai/note/meeting-1")
		stageEvents(agent, granola!, [request]); commitKnowledge(agent, granola!.id, [request.eventId], [{ subject: "CSV export", predicate: "request", value: "Client requested CSV export", evidenceIds: [request.eventId], confidence: "confirmed" }], originalTime)
		const ownership = evidence(slack!, "ownership", "message-1", originalTime + 60000, "Deepak: I'll own issue-42 by the day after tomorrow. Client request: https://granola.ai/note/meeting-1", "https://app.slack.com/archives/C1/p1")
		stageEvents(agent, slack!, [ownership]); const meetingContext = reasoningContext(agent, slack!.id, [ownership])
		commitKnowledge(agent, slack!.id, [ownership.eventId], [{ subject: "CSV export", predicate: "commitment", value: "Deepak owns issue-42; commitment date 2026-10-07, resolved from the original message time", evidenceIds: [ownership.eventId, request.eventId], relatedObjectIds: [request.objectId], confidence: "confirmed" }], originalTime + 60000, meetingContext)
		const started = evidence(linear!, "started", "issue-42", originalTime + 120000, "issue-42 assigned to Deepak; recorded state In Progress; request https://granola.ai/note/meeting-1; ownership https://app.slack.com/archives/C1/p1", "https://linear.app/company/issue/ISSUE-42")
		stageEvents(agent, linear!, [started]); const context = reasoningContext(agent, linear!.id, [started])
		commitKnowledge(agent, linear!.id, [started.eventId], [{ subject: "CSV export", predicate: "recorded status", value: "The Linear issue assigned to Deepak moved to In Progress on 2026-10-05", evidenceIds: [started.eventId, ownership.eventId, request.eventId], relatedObjectIds: [ownership.objectId, request.objectId], confidence: "confirmed" }], originalTime + 120000, context)
		const first = await execute(deps, "knowledge", { query: "Did Deepak start the work?" }) as Awaited<ReturnType<typeof queryExternalKnowledge>>
		expect(first.facts.some(f => f.value.includes("In Progress") && f.evidence.some(e => e.url === started.url))).toBe(true)
		expect(first.interpretation).toContain("not proof of active work")
		expect(first.sources.every(s => s.lastProcessedAt !== null)).toBe(true)
		const review = { ...started, eventId: "review", version: originalTime + 86400000, occurredAt: originalTime + 86400000, text: "issue-42 assigned to Deepak; recorded state In Review" }
		stageEvents(agent, linear!, [review]); commitKnowledge(agent, linear!.id, [review.eventId], [{ subject: "CSV export", predicate: "recorded status", value: "The Linear issue assigned to Deepak moved to In Review", evidenceIds: [review.eventId], confidence: "confirmed" }], review.version)
		const next = await execute(deps, "knowledge", { query: "Did Deepak start the work?" }) as typeof first
		expect(next.facts.some(f => f.value.includes("In Review"))).toBe(true)
		expect(next.facts.some(f => f.value.includes("In Progress"))).toBe(false)
		expect(queryKnowledge(agent, [...acl.sources], "Deepak", 20, true).facts.some(f => !f.current && f.value.includes("In Progress"))).toBe(true)
	})
	it("does not disclose cross-source facts when a supporting private source is unauthorized", async () => {
		const { agent, sources: [granola, , linear], deps } = setup()
		const request = evidence(granola!, "request", "meeting-private", 1000, "Request for issue-private", "https://granola.ai/note/private")
		stageEvents(agent, granola!, [request]); commitKnowledge(agent, granola!.id, [request.eventId], [], 1000)
		const task = evidence(linear!, "task", "issue-private", 2000, "Deepak started; request https://granola.ai/note/private", "https://linear.app/company/issue/private")
		stageEvents(agent, linear!, [task]); const context = reasoningContext(agent, linear!.id, [task])
		commitKnowledge(agent, linear!.id, [task.eventId], [{ subject: "Deepak", predicate: "status", value: "Started private client work", evidenceIds: [task.eventId, request.eventId], confidence: "confirmed" }], 2000, context)
		acl.sources.delete(granola!.id)
		const result = await execute(deps, "knowledge", { query: "Deepak" }) as Awaited<ReturnType<typeof queryExternalKnowledge>>
		expect(result.facts).toEqual([])
		expect(JSON.stringify(result)).not.toContain("meeting-private")
	})
})
