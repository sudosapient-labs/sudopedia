import { afterEach, describe, expect, it } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import { audienceSchema, commitKnowledge, ensureKnowledgeTables, getSource, intersectAudiences, listPendingEvents, listSources, pruneKnowledge, queryKnowledge, reasoningContext, revokeSource, stageEvents, upsertSource } from "./store"
import type { EvidenceEvent, FactProposal, KnowledgeAgent, KnowledgeSource } from "./types"

const source: KnowledgeSource = {
	id: "s", orgId: "org", connectionId: "private-connection", provider: "mcp", ownerUserId: null,
	audience: { kind: "users", userIds: ["a", "b"] }, state: "active", coverage: [], cursor: null,
	lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0,
	intervalMs: 1000, failures: 0, error: null,
}
const event = (eventId = "e1", objectId = "object-1", version = 1): EvidenceEvent => ({
	sourceId: "s", eventId, objectId, version, occurredAt: version * 1000, observedAt: version * 2000,
	deleted: false, url: "https://example.com/item?token=secret#secret", text: "Original explicit fact about object-2",
	audience: { kind: "users", userIds: ["a"] },
})
const proposal = (evidenceIds = ["e1"], value = "first"): FactProposal => ({ subject: "Same title", predicate: "objective", value, evidenceIds, confidence: "confirmed" })
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.sqlite.close() })
function setup() {
	const fixture = sqliteFixture()
	fixtures.push(fixture)
	const agent = {
		sql(strings: TemplateStringsArray, ...values: (string | number | null)[]) {
			const statement = fixture.sqlite.prepare(strings.join("?"))
			return statement.columns().length ? statement.all(...values) : (statement.run(...values), [])
		},
		ctx: { storage: { transactionSync<T>(fn: () => T): T {
			fixture.sqlite.exec("SAVEPOINT knowledge_test")
			try { const result = fn(); fixture.sqlite.exec("RELEASE knowledge_test"); return result }
			catch (error) { fixture.sqlite.exec("ROLLBACK TO knowledge_test"); fixture.sqlite.exec("RELEASE knowledge_test"); throw error }
		} } },
	} as unknown as KnowledgeAgent
	ensureKnowledgeTables(agent)
	ensureKnowledgeTables(agent)
	upsertSource(agent, source)
	return { agent, sqlite: fixture.sqlite }
}
function ingest(agent: KnowledgeAgent, e = event(), p = proposal()) {
	stageEvents(agent, source, [e])
	commitKnowledge(agent, "s", [e.eventId], [p], e.occurredAt)
}
function seedPayloadLimit(sqlite: ReturnType<typeof sqliteFixture>["sqlite"], pinned = false) {
	const payload = sqlite.prepare("INSERT INTO knowledge_event VALUES ('s', ?, ?, ?, ?, 0)")
	const head = sqlite.prepare("INSERT INTO knowledge_head VALUES ('s', ?, 1, 1000, ?, 0)")
	const receipt = sqlite.prepare("INSERT INTO knowledge_receipt VALUES ('s', ?)")
	const fact = sqlite.prepare("INSERT INTO knowledge_fact(source_id, object_id, predicate, data, created_at, current) VALUES ('s', ?, 'objective', ?, 0, 1)")
	sqlite.exec("BEGIN")
	for (let i = 0; i < 5000; i++) {
		const e = { ...event(`seed-${i}`, `seed-object-${i}`), url: "https://example.com/item", observedAt: i }
		payload.run(e.eventId, e.objectId, JSON.stringify(e), e.observedAt)
		head.run(e.objectId, e.eventId)
		receipt.run(e.eventId)
		if (pinned) {
			const result = fact.run(e.objectId, JSON.stringify({ ...proposal([e.eventId]), sourceId: "s", objectId: e.objectId, version: 1, occurredAt: e.occurredAt, observedAt: e.observedAt, audience: e.audience, evidence: [e] }))
			sqlite.prepare("INSERT INTO knowledge_dependency VALUES (?, 's', ?)").run(result.lastInsertRowid, e.objectId)
		}
	}
	sqlite.exec("COMMIT")
}
function crossSource(agent: KnowledgeAgent, overrides: Partial<KnowledgeSource> = {}, eventOverrides: Partial<EvidenceEvent> = {}) {
	const other: KnowledgeSource = { ...source, id: "issues", connectionId: "issues-connection", ...overrides }
	upsertSource(agent, other)
	const issue: EvidenceEvent = { ...event("issue-event", "ISSUE-42"), sourceId: other.id, url: "https://issues.example/ISSUE-42", text: "Deepak owns ISSUE-42; work is underway", ...eventOverrides }
	stageEvents(agent, other, [issue])
	commitKnowledge(agent, other.id, [issue.eventId], [{ ...proposal([issue.eventId], "work is underway"), subject: "Deepak / ISSUE-42", predicate: "state" }], 1000)
	return { other, issue: queryKnowledge(agent, [other.id], "").facts[0]!.evidence[0]! }
}

describe("durable knowledge", () => {
	it("taints uncited model output with every supplied private input and invalidates it on context edits", () => {
		const { agent } = setup()
		const { other, issue } = crossSource(agent, { audience: { kind: "users", userIds: ["a"] } }, { text: "Private price for ISSUE-42 is 700" })
		const anchor = { ...event(), audience: { kind: "users" as const, userIds: ["a", "b"] }, text: "Discuss ISSUE-42" }
		stageEvents(agent, source, [anchor])
		commitKnowledge(agent, source.id, [anchor.eventId], [proposal([anchor.eventId], "Price is 700")], 1000, [issue])
		expect(queryKnowledge(agent, [source.id], "700").facts).toEqual([])
		const result = queryKnowledge(agent, [source.id, other.id], "700").facts[0]!
		expect(result.audience).toEqual({ kind: "users", userIds: ["a"] })
		expect(result.evidence.some(e => e.sourceId === other.id)).toBe(true)
		stageEvents(agent, other, [{ ...issue, eventId: "private-edit", version: issue.version + 1, text: "Price changed" }])
		expect(queryKnowledge(agent, [source.id, other.id], "700").facts).toEqual([])
	})
	it("returns provenance, safe URLs, uncertainty and source-free public facts", () => {
		const { agent } = setup()
		ingest(agent, event(), { ...proposal(), confidence: "uncertain" })
		const fact = queryKnowledge(agent, ["s"], "first").facts[0]!
		expect(fact).toMatchObject({ objectId: "object-1", current: true, confidence: "uncertain", occurredAt: 1000, audience: { kind: "users", userIds: ["a"] } })
		expect(fact.evidence[0]!.url).toBe("https://example.com/item")
		expect(JSON.stringify(fact)).not.toContain("private-connection")
		expect(listPendingEvents(agent, "s")).toEqual([])
		expect(getSource(agent, "s")!.processedThrough).toBe(1000)
		expect(listSources(agent)).toHaveLength(1)
	})
	it("uses canonical object identity, not identical subject titles", () => {
		const { agent } = setup()
		ingest(agent)
		ingest(agent, event("e2", "object-2"), proposal(["e2"], "second"))
		expect(queryKnowledge(agent, ["s"], "").facts.map(f => f.objectId).sort()).toEqual(["object-1", "object-2"])
		expect(queryKnowledge(agent, ["s"], "", 1).truncated).toBe(true)
	})
	it("invalidates every dependent fact immediately on edit and delete, retaining history", () => {
		const { agent } = setup()
		ingest(agent, event("e2", "object-2"), proposal(["e2"], "second"))
		ingest(agent, event(), { ...proposal(["e1", "e2"]), relatedObjectIds: ["object-2"] })
		stageEvents(agent, source, [{ ...event("delete", "object-2", 2), deleted: true }])
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
		expect(queryKnowledge(agent, ["s"], "", 20, true).facts).toHaveLength(2)
		expect(queryKnowledge(agent, ["s"], "", 20, true).facts.every(f => !f.current)).toBe(true)
	})
	it("never permits replay or late events to replace newer state even after pruning", () => {
		const { agent } = setup()
		ingest(agent)
		ingest(agent, event("new", "object-1", 3), proposal(["new"], "newer"))
		pruneKnowledge(agent, 0)
		stageEvents(agent, source, [event(), event("late", "object-1", 2), { ...event("new", "object-1", 99), text: "replay changed" }])
		expect(listPendingEvents(agent, "s")).toEqual([])
		expect(queryKnowledge(agent, ["s"], "").facts[0]!.value).toBe("newer")
		stageEvents(agent, source, [{ ...event("delete", "object-1", 4), deleted: true }])
		commitKnowledge(agent, "s", ["delete"], [], 4000)
		pruneKnowledge(agent, 0)
		stageEvents(agent, source, [event("resurrect", "object-1", 3)])
		expect(listPendingEvents(agent, "s")).toEqual([])
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
	})
	it("fails closed on revocation and audience narrowing for both history and pending", () => {
		const { agent } = setup()
		ingest(agent)
		upsertSource(agent, { ...source, audience: { kind: "users", userIds: ["b"] } })
		expect(queryKnowledge(agent, ["s"], "", 20, true).facts).toEqual([])
		revokeSource(agent, "s")
		expect(listPendingEvents(agent, "s")).toEqual([])
		expect(() => upsertSource(agent, source)).toThrow("new identity")
		expect(() => stageEvents(agent, source, [event("e2")])).toThrow("unavailable")
	})
	it("rejects org/public trust, identity substitution, invalid references and unsafe URLs atomically", () => {
		const { agent } = setup()
		expect(() => upsertSource(agent, { ...source, orgId: "other" })).toThrow("identity")
		expect(() => stageEvents(agent, source, [event(), { ...event("bad"), sourceId: "other" }])).toThrow("mismatch")
		expect(listPendingEvents(agent, "s")).toEqual([])
		expect(() => stageEvents(agent, source, [{ ...event(), url: "javascript:alert(1)" }])).toThrow("Unsafe")
		expect(() => stageEvents(agent, source, [{ ...event(), audience: { kind: "org" } as never }])).toThrow()
		stageEvents(agent, source, [event()])
		expect(() => commitKnowledge(agent, "s", ["e1"], [proposal(), proposal(["e1", "invented"])], 1000)).toThrow("reference")
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
		expect(listPendingEvents(agent, "s")).toHaveLength(1)
		expect(getSource(agent, "s")!.processedThrough).toBeNull()
		expect(() => commitKnowledge(agent, "s", ["e1"], [{ ...proposal(), audience: source.audience } as FactProposal], 1000)).toThrow()
	})
	it("permits only explicit relationships and common audiences", () => {
		const { agent } = setup()
		stageEvents(agent, source, [event(), { ...event("e2", "object-2"), audience: { kind: "users", userIds: ["b"] } }])
		expect(() => commitKnowledge(agent, "s", ["e1", "e2"], [proposal(["e1", "e2"])], 1000)).toThrow("audience")
		expect(() => commitKnowledge(agent, "s", ["e1"], [{ ...proposal(), relatedObjectIds: ["Same title"] }], 1000)).toThrow("explicit")
	})
	it("ignores stale reasoning results and bounds input", () => {
		const { agent } = setup()
		stageEvents(agent, source, [event()])
		stageEvents(agent, source, [event("new", "object-1", 2)])
		commitKnowledge(agent, "s", ["e1"], [proposal()], 1000)
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
		expect(listPendingEvents(agent, "s").map(e => e.eventId)).toEqual(["new"])
		expect(() => stageEvents(agent, source, Array.from({ length: 101 }, () => event()))).toThrow()
		expect(() => stageEvents(agent, source, [{ ...event(), text: "x".repeat(32769) }])).toThrow()
	})
	it("unknown shared MCP ACL defaults must remain private", () => {
		const { agent } = setup()
		upsertSource(agent, { ...source, audience: { kind: "users", userIds: [] } })
		stageEvents(agent, source, [event()])
		expect(() => commitKnowledge(agent, "s", ["e1"], [proposal()], 1000)).toThrow("audience")
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
	})
	it("accepts retained current same-source context, but not stale context", () => {
		const { agent } = setup()
		ingest(agent, event("context", "object-2"), proposal(["context"], "context"))
		ingest(agent, event(), proposal(["e1", "context"]))
		expect(queryKnowledge(agent, ["s"], "first").facts[0]!.evidence).toHaveLength(2)
		stageEvents(agent, source, [event("changed", "object-2", 2), event("anchor", "object-1", 2)])
		expect(() => commitKnowledge(agent, "s", ["anchor"], [proposal(["anchor", "context"])], 2000)).toThrow("reference")
	})
	it("rolls back edit invalidation when a later staged event fails validation", () => {
		const { agent } = setup()
		ingest(agent)
		expect(() => stageEvents(agent, source, [event("new", "object-1", 2), { ...event("wrong"), sourceId: "wrong" }])).toThrow("mismatch")
		expect(queryKnowledge(agent, ["s"], "").facts[0]!.current).toBe(true)
		expect(listPendingEvents(agent, "s")).toEqual([])
	})
	it("bounds pending queues without losing the existing durable backlog", () => {
		const { agent } = setup()
		for (let page = 0; page < 10; page++) stageEvents(agent, source, Array.from({ length: 100 }, (_, i) => event(`event-${page * 100 + i}`, `obj-${page * 100 + i}`)))
		expect(() => stageEvents(agent, source, [event("overflow", "overflow")])).toThrow("Pending event budget")
		expect(listPendingEvents(agent, "s", 1000)).toHaveLength(100)
	})
	it("compacts processed live heads at the payload limit without losing ordering or receipts", () => {
		const { agent, sqlite } = setup()
		seedPayloadLimit(sqlite)
		stageEvents(agent, source, [event("next", "next")])
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_event").get()).toEqual({ n: 5000 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_head").get()).toEqual({ n: 5001 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_receipt").get()).toEqual({ n: 5001 })
		stageEvents(agent, source, [event("seed-0", "seed-object-0", 99), event("late", "seed-object-0", 0)])
		expect(listPendingEvents(agent, "s").map(e => e.eventId)).toEqual(["next"])
	})
	it("retains referenced payloads during retention pruning and reclaims unreferenced context", () => {
		const { agent, sqlite } = setup()
		ingest(agent)
		stageEvents(agent, source, [event("context-only", "context-only")])
		commitKnowledge(agent, "s", ["context-only"], [], 1000)
		pruneKnowledge(agent, 0)
		expect(sqlite.prepare("SELECT event_id FROM knowledge_event").all()).toEqual([{ event_id: "e1" }])
		expect(queryKnowledge(agent, ["s"], "").facts[0]!.evidence[0]!.eventId).toBe("e1")
		stageEvents(agent, source, [event("edit", "object-1", 2)])
		pruneKnowledge(agent, 0)
		expect(sqlite.prepare("SELECT event_id FROM knowledge_event").all()).toEqual([{ event_id: "edit" }])
	})
	it("reports pinned payload capacity without false processing, and retries the durable head", () => {
		const { agent, sqlite } = setup()
		seedPayloadLimit(sqlite, true)
		expect(() => stageEvents(agent, source, [event("next", "next")])).toThrow("Event payload capacity")
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact WHERE current = 1").get()).toEqual({ n: 5000 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_event").get()).toEqual({ n: 5000 })
		expect(sqlite.prepare("SELECT 1 FROM knowledge_receipt WHERE event_id = 'next'").get()).toBeUndefined()
		expect(getSource(agent, "s")!.processedThrough).toBeNull()
		expect(() => commitKnowledge(agent, "s", ["next"], [proposal(["next"])], 1000)).toThrow("Unknown batch")
		// Tombstones free invalidated history under pressure; the refused exact
		// head can then retry without being mistaken for an old/replayed event.
		stageEvents(agent, source, [{ ...event("delete", "seed-object-0", 2), deleted: true }])
		stageEvents(agent, source, [event("next", "next")])
		expect(listPendingEvents(agent, "s").map(e => e.eventId)).toEqual(["next"])
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact WHERE current = 1").get()).toEqual({ n: 4999 })
		expect(queryKnowledge(agent, ["s"], "", 1).facts[0]!.evidence).toHaveLength(1)
	})
	it("invalidates edits and acknowledges deletes even when the pending queue is full", () => {
		const { agent, sqlite } = setup()
		ingest(agent)
		for (let page = 0; page < 10; page++) stageEvents(agent, source, Array.from({ length: 100 }, (_, i) => event(`pending-${page * 100 + i}`, `pending-object-${page * 100 + i}`)))
		expect(() => stageEvents(agent, source, [event("edit", "object-1", 2)])).toThrow("Pending event budget")
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
		expect(sqlite.prepare("SELECT event_id FROM knowledge_head WHERE object_id = 'object-1'").get()).toEqual({ event_id: "edit" })
		expect(sqlite.prepare("SELECT 1 FROM knowledge_receipt WHERE event_id = 'edit'").get()).toBeUndefined()
		stageEvents(agent, source, [{ ...event("delete", "object-1", 3), deleted: true }])
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_event WHERE pending = 1").get()).toEqual({ n: 1000 })
		commitKnowledge(agent, "s", ["delete"], [], 3000)
		stageEvents(agent, source, [event("edit", "object-1", 2)])
		expect(sqlite.prepare("SELECT deleted FROM knowledge_head WHERE object_id = 'object-1'").get()).toEqual({ deleted: 1 })
	})
	it("prunes superseded facts at the fact limit but refuses excess current facts atomically", () => {
		const { agent, sqlite } = setup()
		ingest(agent)
		const data = sqlite.prepare("SELECT data FROM knowledge_fact").get() as { data: string }
		const insert = sqlite.prepare("INSERT INTO knowledge_fact(source_id, object_id, predicate, data, created_at, current) VALUES ('s', 'object-1', ?, ?, 0, 1)")
		for (let i = 1; i < 10000; i++) {
			const fact = { ...JSON.parse(data.data), predicate: `predicate-${i}` }
			const result = insert.run(fact.predicate, JSON.stringify(fact))
			sqlite.prepare("INSERT INTO knowledge_dependency VALUES (?, 's', 'object-1')").run(result.lastInsertRowid)
		}
		stageEvents(agent, source, [event("extra", "extra")])
		const watermark = getSource(agent, "s")!.processedThrough
		expect(() => commitKnowledge(agent, "s", ["extra"], [proposal(["extra"])], 9999)).toThrow("Current fact capacity")
		expect(listPendingEvents(agent, "s").map(e => e.eventId)).toEqual(["extra"])
		expect(getSource(agent, "s")!.processedThrough).toBe(watermark)
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact").get()).toEqual({ n: 10000 })
		// An edit invalidates the old predicates; new facts prune oldest history.
		commitKnowledge(agent, "s", ["e1"], [], 1000)
		stageEvents(agent, source, [event("edited", "object-1", 2)])
		commitKnowledge(agent, "s", ["edited"], Array.from({ length: 200 }, (_, i) => ({ ...proposal(["edited"]), predicate: `replacement-${i}` })), 2000)
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact").get()).toEqual({ n: 10000 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_fact WHERE current = 1").get()).toEqual({ n: 200 })
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM knowledge_dependency").get()).toEqual({ n: 10000 })
	})
	it("normalizes flat AND ACLs without turning channel+user into empty or union", () => {
		const channel = { kind: "slack_channel" as const, teamId: "T", channelId: "C" }
		const users = { kind: "users" as const, userIds: ["a"] }
		expect(intersectAudiences(users, { kind: "users", userIds: ["b"] })).toEqual({ kind: "users", userIds: [] })
		const compound = intersectAudiences(channel, users)
		expect(compound).toEqual({ kind: "intersection", audiences: [users, channel] })
		expect(intersectAudiences(compound, channel)).toEqual(compound)
		expect(audienceSchema.safeParse({ kind: "intersection", audiences: [compound] }).success).toBe(false)
		expect(audienceSchema.safeParse({ kind: "intersection", audiences: Array.from({ length: 33 }, () => channel) }).success).toBe(false)
		expect(audienceSchema.safeParse({ kind: "union", audiences: [users, channel] }).success).toBe(false)
	})
	it("commits explicit cross-source links only with supplied exact context and all-source query authorization", () => {
		const { agent } = setup()
		const { issue } = crossSource(agent)
		stageEvents(agent, source, [{ ...event(), text: "Deepak started the work on ISSUE-42" }])
		const linked = { ...proposal(["e1", "issue-event"], "started work"), subject: "Deepak / ISSUE-42", relatedObjectIds: ["ISSUE-42"] }
		expect(() => commitKnowledge(agent, "s", ["e1"], [linked], 1000)).toThrow("reference")
		expect(() => commitKnowledge(agent, "s", ["e1"], [linked], 1000, [])).toThrow("reference")
		expect(() => commitKnowledge(agent, "s", ["e1"], [linked], 1000, [{ ...issue, text: "fabricated" }])).toThrow("mismatch")
		commitKnowledge(agent, "s", ["e1"], [linked], 1000, [issue])
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
		const fact = queryKnowledge(agent, ["s", "issues"], "started").facts[0]!
		expect(fact.evidence.map(e => e.sourceId)).toEqual(["s", "issues"])
		expect(fact.relatedObjectIds).toEqual(["ISSUE-42"])
	})
	it("cascades supporting-source edits/deletion and revocation across anchored facts", () => {
		const { agent, sqlite } = setup()
		const { other, issue } = crossSource(agent)
		stageEvents(agent, source, [{ ...event(), text: "ISSUE-42 is related" }])
		commitKnowledge(agent, "s", ["e1"], [proposal(["e1", "issue-event"])], 1000, [issue])
		stageEvents(agent, other, [{ ...issue, eventId: "issue-edit", version: 2, deleted: true, observedAt: 4000 }])
		expect(queryKnowledge(agent, ["s", "issues"], "").facts).toEqual([])
		expect(queryKnowledge(agent, ["s", "issues"], "", 20, true).facts).toHaveLength(2)
		revokeSource(agent, "issues")
		expect(queryKnowledge(agent, ["s", "issues"], "", 20, true).facts).toEqual([])
		expect(sqlite.prepare("SELECT source_id, object_id FROM knowledge_dependency WHERE source_id = 'issues'").all()).toHaveLength(2)
	})
	it("revokes current cross-source dependents immediately, including history retrieval", () => {
		const { agent, sqlite } = setup()
		const { issue } = crossSource(agent)
		stageEvents(agent, source, [event()])
		commitKnowledge(agent, "s", ["e1"], [proposal(["e1", "issue-event"])], 1000, [issue])
		revokeSource(agent, "issues")
		expect(sqlite.prepare("SELECT current FROM knowledge_fact WHERE source_id = 's'").get()).toEqual({ current: 0 })
		expect(queryKnowledge(agent, ["s", "issues"], "", 20, true).facts).toEqual([])
	})
	it("narrows every supporting source ACL at commit and retrieval, with compound user/channel support", () => {
		const { agent } = setup()
		const { issue } = crossSource(agent, { audience: { kind: "users", userIds: ["a", "b"] } }, { audience: { kind: "users", userIds: ["a", "b"] } })
		const channel = { kind: "slack_channel" as const, teamId: "T", channelId: "C" }
		upsertSource(agent, { ...source, audience: channel })
		stageEvents(agent, { ...source, audience: channel }, [{ ...event(), audience: channel, text: "ISSUE-42 is started" }])
		commitKnowledge(agent, "s", ["e1"], [proposal(["e1", "issue-event"])], 1000, [issue])
		expect(queryKnowledge(agent, ["s", "issues"], "first").facts[0]!.audience.kind).toBe("intersection")
		upsertSource(agent, { ...getSource(agent, "issues")!, audience: { kind: "users", userIds: ["b"] } })
		const fact = queryKnowledge(agent, ["s", "issues"], "first").facts[0]!
		expect(fact.audience).toEqual({ kind: "intersection", audiences: [{ kind: "users", userIds: ["b"] }, channel] })
		expect(fact.evidence[1]!.audience).toEqual({ kind: "users", userIds: ["b"] })
		upsertSource(agent, { ...getSource(agent, "issues")!, audience: { kind: "users", userIds: ["c"] } })
		expect(queryKnowledge(agent, ["s", "issues"], "", 20, true).facts).toEqual([])
	})
	it("rejects ambiguous event IDs, same-title relationships and identifier substring collisions atomically", () => {
		const { agent } = setup()
		const { issue } = crossSource(agent)
		stageEvents(agent, source, [{ ...event(), text: "Same title" }])
		expect(() => commitKnowledge(agent, "s", ["e1"], [{ ...proposal(["e1", "issue-event"]), relatedObjectIds: ["ISSUE-42"] }], 1000, [issue])).toThrow("explicit")
		stageEvents(agent, source, [{ ...event("e2", "object-1", 2), text: "ISSUE-420" }])
		expect(() => commitKnowledge(agent, "s", ["e2"], [{ ...proposal(["e2", "issue-event"]), relatedObjectIds: ["ISSUE-42"] }], 1000, [issue])).toThrow("explicit")
		stageEvents(agent, source, [event("issue-event", "duplicate")])
		expect(() => commitKnowledge(agent, "s", ["issue-event"], [proposal(["issue-event"])], 1000)).toThrow("Ambiguous")
		expect(queryKnowledge(agent, ["s"], "").facts).toEqual([])
	})
	it("downgrades unlinked cross-source title correlation instead of confirming canonical identity", () => {
		const { agent } = setup()
		const { issue } = crossSource(agent, {}, { text: "Same title" })
		stageEvents(agent, source, [{ ...event(), text: "Same title" }])
		commitKnowledge(agent, "s", ["e1"], [proposal(["e1", "issue-event"])], 1000, [issue])
		expect(queryKnowledge(agent, ["s", "issues"], "first").facts[0]!.confidence).toBe("uncertain")
	})
	it("accepts an exact source URL link and rejects foreign-org or stale supplied context", () => {
		const { agent } = setup()
		const { other, issue } = crossSource(agent)
		stageEvents(agent, source, [{ ...event(), text: `See ${issue.url}` }])
		commitKnowledge(agent, "s", ["e1"], [{ ...proposal(["e1", "issue-event"]), relatedObjectIds: ["ISSUE-42"] }], 1000, [issue])
		stageEvents(agent, source, [event("new", "object-1", 2)])
		stageEvents(agent, other, [{ ...issue, eventId: "changed", version: 2 }])
		expect(() => commitKnowledge(agent, "s", ["new"], [proposal(["new", "issue-event"])], 2000, [issue])).toThrow("reference")
		const { issue: foreign } = crossSource(agent, { id: "foreign", orgId: "other-org" }, { eventId: "foreign-event" })
		expect(() => commitKnowledge(agent, "s", ["new"], [proposal(["new", "foreign-event"])], 2000, [foreign])).toThrow("reference")
	})
	it("bounds context and withholds unrelated private data while preserving original timestamps", () => {
		const { agent } = setup()
		const { issue } = crossSource(agent)
		crossSource(agent, { id: "private", audience: { kind: "users", userIds: ["b"] } }, { eventId: "private-event", audience: { kind: "users", userIds: ["b"] }, text: "Deepak confidential personal data" })
		stageEvents(agent, source, [{ ...event(), text: "Deepak on ISSUE-42" }])
		const batch = listPendingEvents(agent, "s")
		expect(reasoningContext(agent, "s", batch)).toEqual([issue])
		expect(reasoningContext(agent, "s", batch, 999)).toHaveLength(1)
		expect(reasoningContext(agent, "s", batch)[0]).toMatchObject({ occurredAt: 1000, observedAt: 2000 })
		upsertSource(agent, { ...getSource(agent, "issues")!, audience: { kind: "users", userIds: ["b"] } })
		expect(reasoningContext(agent, "s", batch)).toEqual([])
		stageEvents(agent, source, [{ ...event("deleted", "object-1", 2), deleted: true }])
		expect(reasoningContext(agent, "s", listPendingEvents(agent, "s"))).toEqual([])
	})
	it("restricts explicitly supplied context even for previously processed same-source events", () => {
		const { agent } = setup()
		ingest(agent, event("context", "object-2"), proposal(["context"]))
		stageEvents(agent, source, [event()])
		expect(() => commitKnowledge(agent, "s", ["e1"], [proposal(["e1", "context"])], 1000, [])).toThrow("reference")
	})
	it("returns at most 30 context events and stays below 128KB including thread context", () => {
		const { agent } = setup()
		const contextEvents = Array.from({ length: 35 }, (_, i) => ({ ...event(`ctx-${i}`, `ctx-object-${i}`), context: "thread", text: "Thread surrounding discussion" }))
		stageEvents(agent, source, contextEvents)
		commitKnowledge(agent, "s", contextEvents.map(e => e.eventId), [], 1000)
		stageEvents(agent, source, [{ ...event(), context: "thread", text: "Current discussion" }])
		const batch = listPendingEvents(agent, "s")
		expect(reasoningContext(agent, "s", batch, 999)).toHaveLength(30)
		const large = contextEvents.slice(0, 5).map(e => ({ ...e, eventId: `${e.eventId}-edit`, version: 2, observedAt: 4000, text: "x".repeat(32_000) }))
		stageEvents(agent, source, large)
		commitKnowledge(agent, "s", large.map(e => e.eventId), [], 1000)
		const context = reasoningContext(agent, "s", batch)
		expect(context.length).toBeLessThanOrEqual(30)
		expect(context.filter(e => e.text.length === 32_000)).toHaveLength(3)
		expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(128_000)
	})
	it("only includes channel+private context when explicitly identifier-linked, never by a shared title", () => {
		const { agent } = setup()
		const { issue } = crossSource(agent)
		const channel = { kind: "slack_channel" as const, teamId: "T", channelId: "C" }
		upsertSource(agent, { ...source, audience: channel })
		stageEvents(agent, source, [{ ...event(), audience: channel, text: "Deepak started the work" }])
		expect(reasoningContext(agent, "s", listPendingEvents(agent, "s"))).toEqual([])
		stageEvents(agent, source, [{ ...event("edit", "object-1", 2), audience: channel, text: "Deepak started ISSUE-42" }])
		expect(reasoningContext(agent, "s", listPendingEvents(agent, "s"))).toEqual([issue])
		upsertSource(agent, { ...getSource(agent, "issues")!, audience: channel })
		// Event audience is still users: it is not widened by source ACL changes.
		expect(reasoningContext(agent, "s", listPendingEvents(agent, "s"))[0]!.audience.kind).toBe("intersection")
	})
	it("retrieves natural questions generically and distinguishes original message time from edited state observation", () => {
		const { agent } = setup()
		ingest(agent, event(), { ...proposal(["e1"], "In Progress"), subject: "Deepak / Parser", predicate: "state" })
		ingest(agent, event("unrelated", "other"), { ...proposal(["unrelated"], "Cancelled"), subject: "Unrelated project", predicate: "state" })
		expect(queryKnowledge(agent, ["s"], "Did Deepak start the work?").facts.map(f => f.value)).toEqual(["In Progress"])
		ingest(agent, { ...event("edit", "object-1", 2), occurredAt: 1000, observedAt: 9000 }, { ...proposal(["edit"], "In Review"), subject: "Deepak / Parser", predicate: "state" })
		const current = queryKnowledge(agent, ["s"], "Did Deepak start the work?").facts[0]!
		expect(current).toMatchObject({ value: "In Review", occurredAt: 1000, observedAt: 9000 })
		expect(queryKnowledge(agent, ["s"], "Deepak?", 20, true).facts.map(f => f.value)).toEqual(["In Review", "In Progress"])
		ingest(agent, event("unicode", "unicode"), { ...proposal(["unicode"], "承認済み"), subject: "設計", predicate: "判断" })
		expect(queryKnowledge(agent, ["s"], "設計？").facts[0]!.value).toBe("承認済み")
	})
	it("globally caps scanned facts across sources and reports scan truncation", () => {
		const { agent, sqlite } = setup()
		const { other } = crossSource(agent)
		ingest(agent)
		const data = sqlite.prepare("SELECT data FROM knowledge_fact WHERE source_id = 's'").get() as { data: string }
		const insert = sqlite.prepare("INSERT INTO knowledge_fact(source_id,object_id,predicate,data,created_at,current) VALUES (?,?,?,?,0,1)")
		for (let i = 0; i < 1001; i++) insert.run(i % 2 ? "s" : other.id, `scan-${i}`, "objective", data.data)
		expect(queryKnowledge(agent, ["s", other.id], "no-match")).toEqual({ facts: [], truncated: true })
	})
})
