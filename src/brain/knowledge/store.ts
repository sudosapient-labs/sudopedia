import { z } from "zod"
import { redactKnowledgeSecrets } from "./secrets"
import type { Audience, SimpleAudience, EvidenceEvent, FactProposal, KnowledgeAgent, KnowledgeFact, KnowledgeQueryResult, KnowledgeSource } from "./types"
export type * from "./types"

const id = z.string().min(1).max(512)
const time = z.number().int().nonnegative().safe()
const simpleAudienceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("users"), userIds: z.array(id).max(256) }).strict(),
	z.object({ kind: z.literal("slack_channel"), teamId: id, channelId: id }).strict(),
])
export const audienceSchema = z.union([simpleAudienceSchema, z.object({ kind: z.literal("intersection"), audiences: z.array(simpleAudienceSchema).min(1).max(32) }).strict()])
export const evidenceSchema = z.object({
	sourceId: id, eventId: id, objectId: id, version: time, occurredAt: time,
	observedAt: time, deleted: z.boolean(), url: z.string().max(2048),
	text: z.string().max(32_768), audience: audienceSchema, context: z.string().max(8192).optional(),
	contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), contentVersion: time.optional(),
}).strict()
export const proposalSchema = z.object({
	subject: z.string().min(1).max(512), predicate: z.string().min(1).max(256),
	value: z.string().min(1).max(8192), evidenceIds: z.array(id).min(1).max(32),
	confidence: z.enum(["confirmed", "uncertain"]), relatedObjectIds: z.array(id).max(32).optional(),
}).strict()
const sourceSchema = z.object({
	id, orgId: id, connectionId: id, provider: id, ownerUserId: id.nullable(),
	audience: audienceSchema, state: z.enum(["active", "error", "revoked", "unsupported", "partial"]),
	coverage: z.array(id).max(100), cursor: z.string().max(8192).nullable(),
	lastCheckedAt: time.nullable(), lastProcessedAt: time.nullable(), processedThrough: time.nullable(),
	nextCheckAt: time, intervalMs: time.refine(v => v > 0), failures: time,
	error: z.string().max(2048).nullable(),
}).strict()
const MAX_BATCH = 100
const MAX_PENDING = 1000
const MAX_FACTS = 10_000
const MAX_EVENTS = 5000
const MAX_BYTES = 512_000

function bounded(value: unknown) {
	if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) throw new Error("Knowledge payload exceeds budget")
}

// Cloudflare forbids SQL BEGIN/SAVEPOINT. Use the DO storage transaction, not an
// async transaction: no model/network work is permitted inside these callbacks.
function atomic<T>(agent: KnowledgeAgent, fn: () => T): T {
	const storage = (agent as unknown as { ctx?: { storage?: { transactionSync<T>(fn: () => T): T } } }).ctx?.storage
	if (!storage) throw new Error("Knowledge writes require agent.ctx.storage.transactionSync")
	return storage.transactionSync(fn)
}

export function ensureKnowledgeTables(agent: KnowledgeAgent): void {
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_source (id TEXT PRIMARY KEY, data TEXT NOT NULL)`
	// Heads and receipts intentionally outlive payload retention: resurrection and
	// duplicate replay must remain impossible even after history is pruned.
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_head (source_id TEXT NOT NULL, object_id TEXT NOT NULL, version INTEGER NOT NULL, occurred_at INTEGER NOT NULL, event_id TEXT NOT NULL, deleted INTEGER NOT NULL, PRIMARY KEY(source_id, object_id))`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_receipt (source_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(source_id, event_id))`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_event (source_id TEXT NOT NULL, event_id TEXT NOT NULL, object_id TEXT NOT NULL, data TEXT NOT NULL, observed_at INTEGER NOT NULL, pending INTEGER NOT NULL, PRIMARY KEY(source_id, event_id))`
	agent.sql`CREATE INDEX IF NOT EXISTS knowledge_pending ON knowledge_event(source_id, pending, observed_at)`
	agent.sql`CREATE INDEX IF NOT EXISTS knowledge_event_reference ON knowledge_event(event_id)`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_fact (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, object_id TEXT NOT NULL, predicate TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, current INTEGER NOT NULL, invalidated_at INTEGER)`
	agent.sql`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_current ON knowledge_fact(source_id, object_id, predicate) WHERE current = 1`
	agent.sql`CREATE TABLE IF NOT EXISTS knowledge_dependency (fact_id INTEGER NOT NULL, source_id TEXT NOT NULL, object_id TEXT NOT NULL, PRIMARY KEY(fact_id, source_id, object_id))`
	agent.sql`CREATE INDEX IF NOT EXISTS knowledge_dependents ON knowledge_dependency(source_id, object_id)`
}

export function getSource(agent: KnowledgeAgent, sourceId: string): KnowledgeSource | undefined {
	const row = agent.sql<{ data: string }>`SELECT data FROM knowledge_source WHERE id = ${sourceId}`[0]
	return row ? JSON.parse(row.data) : undefined
}
export function listSources(agent: KnowledgeAgent): KnowledgeSource[] {
	return agent.sql<{ data: string }>`SELECT data FROM knowledge_source ORDER BY id`.map(row => JSON.parse(row.data))
}
export function upsertSource(agent: KnowledgeAgent, input: KnowledgeSource): void {
	const source = sourceSchema.parse(input)
	atomic(agent, () => {
		const old = getSource(agent, source.id)
		if (old && ["orgId", "connectionId", "provider", "ownerUserId"].some(key => old[key as keyof KnowledgeSource] !== source[key as keyof KnowledgeSource])) throw new Error("Source identity cannot change")
		if (old?.state === "revoked" && source.state !== "revoked") throw new Error("Revoked source requires a new identity")
		if (old?.processedThrough != null) source.processedThrough = Math.max(old.processedThrough, source.processedThrough ?? 0)
		agent.sql`INSERT INTO knowledge_source(id, data) VALUES (${source.id}, ${JSON.stringify(source)}) ON CONFLICT(id) DO UPDATE SET data = excluded.data`
	})
}
export function revokeSource(agent: KnowledgeAgent, sourceId: string): void {
	atomic(agent, () => {
		const source = getSource(agent, sourceId)
		if (!source) throw new Error("Unknown source")
		source.state = "revoked"
		source.audience = { kind: "users", userIds: [] }
		agent.sql`UPDATE knowledge_source SET data = ${JSON.stringify(source)} WHERE id = ${sourceId}`
		agent.sql`UPDATE knowledge_fact SET current = 0, invalidated_at = ${Date.now()} WHERE current = 1 AND (source_id = ${sourceId} OR id IN (SELECT fact_id FROM knowledge_dependency WHERE source_id = ${sourceId}))`
		agent.sql`UPDATE knowledge_event SET pending = 0 WHERE source_id = ${sourceId}`
	})
}

/** Flat conjunction only. An overflow fails closed instead of dropping ACLs. */
export function intersectAudiences(a: Audience, b: Audience): Audience {
	const parts = [...(a.kind === "intersection" ? a.audiences : [a]), ...(b.kind === "intersection" ? b.audiences : [b])]
	let users: string[] | undefined
	const channels = new Map<string, SimpleAudience>()
	for (const part of parts) {
		if (part.kind === "users") users = users === undefined ? [...new Set(part.userIds)] : users.filter(user => part.userIds.includes(user))
		else channels.set(JSON.stringify([part.teamId, part.channelId]), part)
	}
	if (users?.length === 0) return { kind: "users", userIds: [] }
	const audiences: SimpleAudience[] = [...(users === undefined ? [] : [{ kind: "users" as const, userIds: users }]), ...channels.values()]
	if (!audiences.length || audiences.length > 32) return { kind: "users", userIds: [] }
	return audiences.length === 1 ? audiences[0]! : { kind: "intersection", audiences }
}
const intersect = intersectAudiences
/** Nonempty ACL, not an actor authorization check. Callers must enforce every conjunct. */
export function visible(a: Audience): boolean {
	if (a.kind !== "intersection") return a.kind === "slack_channel" || a.userIds.length > 0
	if (!a.audiences.length || a.audiences.length > 32) return false
	const normalized = a.audiences.slice(1).reduce<Audience>(intersectAudiences, a.audiences[0]!)
	return normalized.kind === "intersection" ? normalized.audiences.every(visible) : visible(normalized)
}
function safeUrl(raw: string): string {
	if (!raw) return ""
	const url = new URL(raw)
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsafe evidence URL")
	// Never expose signed URLs or credential-bearing query strings/fragments.
	url.search = ""
	url.hash = ""
	return url.toString()
}
function liveSource(agent: KnowledgeAgent, sourceId: string): KnowledgeSource {
	const source = getSource(agent, sourceId)
	if (!source || source.state === "revoked" || source.state === "unsupported") throw new Error("Source unavailable")
	return source
}
type Head = { version: number; occurred_at: number; event_id: string; deleted: number }
function head(agent: KnowledgeAgent, sourceId: string, objectId: string): Head | undefined {
	return agent.sql<Head>`SELECT version, occurred_at, event_id, deleted FROM knowledge_head WHERE source_id = ${sourceId} AND object_id = ${objectId}`[0]
}
function isHead(agent: KnowledgeAgent, event: EvidenceEvent) {
	const current = head(agent, event.sourceId, event.objectId)
	return current?.event_id === event.eventId && current.version === event.version && current.occurred_at === event.occurredAt && current.deleted === Number(event.deleted)
}

function pruneFactHistory(agent: KnowledgeAgent, count: number): void {
	agent.sql`DELETE FROM knowledge_fact WHERE id IN (SELECT id FROM knowledge_fact WHERE current = 0 ORDER BY created_at, id LIMIT ${count})`
	agent.sql`DELETE FROM knowledge_dependency WHERE fact_id NOT IN (SELECT id FROM knowledge_fact)`
}
function compactEvents(agent: KnowledgeAgent, reserve = 0): boolean {
	const excess = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_event`[0]!.n + reserve - MAX_EVENTS
	if (excess <= 0) return true
	// Even live heads may shed processed payloads, but retained fact provenance
	// remains available. Permanent ordering heads/receipts are never compacted.
	agent.sql`DELETE FROM knowledge_event WHERE (source_id, event_id) IN (
		SELECT source_id, event_id FROM knowledge_event WHERE pending = 0
		AND (source_id, event_id) NOT IN (
			SELECT json_extract(e.value, '$.sourceId'), json_extract(e.value, '$.eventId')
			FROM knowledge_fact f, json_each(f.data, '$.evidence') e
		) ORDER BY observed_at, source_id, event_id LIMIT ${excess}
	)`
	return agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_event`[0]!.n + reserve <= MAX_EVENTS
}

export function stageEvents(agent: KnowledgeAgent, suppliedSource: KnowledgeSource, inputs: EvidenceEvent[]): void {
	bounded(inputs)
	const events = z.array(evidenceSchema).max(MAX_BATCH).parse(inputs).map(event => ({ ...event, url: safeUrl(event.url),
		text: redactKnowledgeSecrets(event.text), ...(event.context ? { context: redactKnowledgeSecrets(event.context) } : {}) }))
	// Validate the whole batch before committing any safety invalidations.
	if (events.some(event => event.sourceId !== suppliedSource.id)) throw new Error("Event source mismatch")
	let capacityError: string | undefined
	atomic(agent, () => {
		const source = liveSource(agent, suppliedSource.id)
		if (source.orgId !== suppliedSource.orgId || source.connectionId !== suppliedSource.connectionId || source.provider !== suppliedSource.provider || source.ownerUserId !== suppliedSource.ownerUserId) throw new Error("Source identity mismatch")
		for (const event of events) {
			if (event.sourceId !== source.id) throw new Error("Event source mismatch")
			if (agent.sql`SELECT 1 FROM knowledge_receipt WHERE source_id = ${source.id} AND event_id = ${event.eventId}`.length) continue
			const old = head(agent, source.id, event.objectId)
			// A version is authoritative; same-version conflicts fail closed by
			// preserving the first event. Observed time is never object ordering.
			if (old && (event.version < old.version || (event.version === old.version && event.eventId !== old.event_id))) {
				agent.sql`INSERT INTO knowledge_receipt VALUES (${source.id}, ${event.eventId})`
				continue
			}
			event.audience = intersect(source.audience, event.audience)
			agent.sql`UPDATE knowledge_fact SET current = 0, invalidated_at = ${event.observedAt} WHERE current = 1 AND id IN (SELECT fact_id FROM knowledge_dependency WHERE source_id = ${source.id} AND object_id = ${event.objectId})`
			agent.sql`UPDATE knowledge_event SET pending = 0 WHERE source_id = ${source.id} AND object_id = ${event.objectId}`
			agent.sql`INSERT INTO knowledge_head VALUES (${source.id}, ${event.objectId}, ${event.version}, ${event.occurredAt}, ${event.eventId}, ${Number(event.deleted)}) ON CONFLICT(source_id, object_id) DO UPDATE SET version = excluded.version, occurred_at = excluded.occurred_at, event_id = excluded.event_id, deleted = excluded.deleted`
			// Deletes require no model: persist the tombstone/receipt even with a
			// full pending queue or exclusively current, provenance-pinned payloads.
			if (!event.deleted) {
				const pending = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_event WHERE source_id = ${source.id} AND pending = 1`[0]!.n
				let room = compactEvents(agent, 1)
				if (!room) {
					pruneFactHistory(agent, MAX_FACTS)
					room = compactEvents(agent, 1)
				}
				if (pending >= MAX_PENDING || !room) {
					capacityError = pending >= MAX_PENDING ? "Pending event budget exceeded" : "Event payload capacity exceeded: current provenance or pending evidence requires retention"
					// No receipt means this exact head can retry. The invalidation
					// and head must survive; never mark refused evidence processed.
					continue
				}
				agent.sql`INSERT INTO knowledge_event VALUES (${source.id}, ${event.eventId}, ${event.objectId}, ${JSON.stringify(event)}, ${event.observedAt}, 1)`
			}
			agent.sql`INSERT INTO knowledge_receipt VALUES (${source.id}, ${event.eventId})`
		}
	})
	if (capacityError) throw new Error(capacityError)
}

export function listPendingEvents(agent: KnowledgeAgent, sourceId: string, limit = MAX_BATCH): EvidenceEvent[] {
	const source = getSource(agent, sourceId)
	if (!source || source.state === "revoked" || source.state === "unsupported") return []
	return agent.sql<{ data: string }>`SELECT data FROM knowledge_event WHERE source_id = ${sourceId} AND pending = 1 ORDER BY observed_at, event_id LIMIT ${cap(limit, MAX_BATCH)}`.map(row => {
		const event: EvidenceEvent = JSON.parse(row.data)
		return { ...event, audience: intersect(source.audience, event.audience) }
	})
}
function cap(n: number, max: number) { return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : max }

function tokens(text: string): string[] {
	return [...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 256)
}
function sharedAudience(a: Audience, b: Audience): boolean {
	const left = a.kind === "intersection" ? a.audiences : [a]
	const right = b.kind === "intersection" ? b.audiences : [b]
	// A users/channel conjunction is not proof of channel membership.
	return left.some(x => right.some(y => x.kind === "users" && y.kind === "users"
		? x.userIds.some(user => y.userIds.includes(user))
		: x.kind === "slack_channel" && y.kind === "slack_channel" && x.teamId === y.teamId && x.channelId === y.channelId)) && visible(intersect(a, b))
}

/** Bounded, retained/current/processed context. Cross-source candidates are
 * same-org and audience-compatible, or explicitly identifier-linked. */
export function reasoningContext(agent: KnowledgeAgent, sourceId: string, events: EvidenceEvent[], limit = 30): EvidenceEvent[] {
	const source = liveSource(agent, sourceId)
	const batch = z.array(evidenceSchema).max(MAX_BATCH).parse(events).map(event => {
		if (event.sourceId !== sourceId) throw new Error("Event source mismatch")
		const row = uniqueEvent(agent, event.eventId)
		if (!row) throw new Error("Invalid batch evidence reference")
		const raw: EvidenceEvent = JSON.parse(row.data)
		if (!isHead(agent, raw)) throw new Error("Invalid batch evidence reference")
		const stored = { ...raw, audience: intersect(raw.audience, source.audience) }
		if (JSON.stringify(evidenceSchema.parse(stored)) !== JSON.stringify(event)) throw new Error("Batch evidence mismatch")
		return stored
	}).filter(event => !event.deleted)
	if (!batch.length) return []
	const batchTokens = new Map(batch.map(event => [event, tokens(event.text)]))
	const rows = agent.sql<{ data: string }>`SELECT data FROM knowledge_event WHERE pending = 0 ORDER BY observed_at DESC LIMIT 1000`
	const candidates: { event: EvidenceEvent; score: number; distance: number }[] = []
	for (const row of rows) {
		const raw: EvidenceEvent = JSON.parse(row.data)
		if (batch.some(event => event.sourceId === raw.sourceId && event.eventId === raw.eventId)) continue
		const candidateSource = getSource(agent, raw.sourceId)
		if (!candidateSource || candidateSource.orgId !== source.orgId || ["revoked", "unsupported"].includes(candidateSource.state) || raw.deleted || !isHead(agent, raw)) continue
		const event = { ...raw, audience: intersect(raw.audience, candidateSource.audience) }
		if (!visible(event.audience)) continue
		let score = 0
		let distance = Number.MAX_SAFE_INTEGER
		const eventTokens = new Set(tokens(event.text))
		for (const anchor of batch) {
			const linked = explicitlyLinked(anchor, event) || explicitlyLinked(event, anchor)
			const same = anchor.sourceId === event.sourceId
			const thread = same && ((anchor.context && anchor.context === event.context) || anchor.objectId === event.objectId)
			const common = batchTokens.get(anchor)!.filter(token => eventTokens.has(token)).length
			if (same ? !(thread || linked || common) : !(linked || (common && sharedAudience(anchor.audience, event.audience)))) continue
			if (!visible(intersect(anchor.audience, event.audience))) continue
			score = Math.max(score, linked ? 1000 : thread ? 500 : common)
			distance = Math.min(distance, Math.abs(anchor.occurredAt - event.occurredAt))
		}
		if (score) {
			uniqueEvent(agent, event.eventId) // Do not hand ambiguous IDs to the model.
			candidates.push({ event, score, distance })
		}
	}
	candidates.sort((a, b) => b.score - a.score || a.distance - b.distance || b.event.observedAt - a.event.observedAt)
	const result: EvidenceEvent[] = []
	let bytes = 2
	for (const { event } of candidates) {
		const size = new TextEncoder().encode(JSON.stringify(event)).length + 1
		if (bytes + size > 128_000) continue
		result.push(event)
		bytes += size
		if (result.length >= cap(limit, 30)) break
	}
	return result
}

function uniqueEvent(agent: KnowledgeAgent, eventId: string): { data: string; pending: number } | undefined {
	const rows = agent.sql<{ data: string; pending: number }>`SELECT data, pending FROM knowledge_event WHERE event_id = ${eventId} LIMIT 2`
	if (rows.length > 1) throw new Error("Ambiguous evidence reference")
	return rows[0]
}
function currentEvidence(agent: KnowledgeAgent, event: EvidenceEvent, orgId: string): EvidenceEvent {
	const source = liveSource(agent, event.sourceId)
	if (source.orgId !== orgId || event.deleted || !isHead(agent, event)) throw new Error("Invalid evidence reference")
	return { ...event, audience: intersect(source.audience, event.audience) }
}
function mentions(text: string, identifier: string): boolean {
	if (!identifier) return false
	let start = text.indexOf(identifier)
	while (start !== -1) {
		const before = text[start - 1] ?? ""
		const after = text[start + identifier.length] ?? ""
		if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true
		start = text.indexOf(identifier, start + 1)
	}
	return false
}
function explicitlyLinked(a: EvidenceEvent, b: EvidenceEvent): boolean {
	return (a.sourceId !== b.sourceId || a.objectId !== b.objectId) && (mentions(a.text, b.objectId) || mentions(a.text, b.url))
}

type ReasoningSnapshot = { batch: EvidenceEvent[]; context: EvidenceEvent[]; sources: string[] }
function sourceSnapshot(source: KnowledgeSource): string {
	return JSON.stringify([source.id, source.orgId, source.connectionId, source.provider, source.ownerUserId, source.state, source.audience])
}
/** Capture before the model await, including uncited inputs and source policy. */
export function captureReasoningSnapshot(agent: KnowledgeAgent, batch: EvidenceEvent[], context: EvidenceEvent[]): ReasoningSnapshot {
	return JSON.parse(JSON.stringify({ batch, context, sources: [...new Set([...batch, ...context].map(event => event.sourceId))].map(id => sourceSnapshot(liveSource(agent, id))) }))
}

export function commitKnowledge(agent: KnowledgeAgent, sourceId: string, inputIds: string[], inputs: FactProposal[], processedThrough: number, permittedContext?: EvidenceEvent[], expected?: ReasoningSnapshot, advanceWatermark = true): void {
	bounded(inputs)
	const context = permittedContext === undefined ? undefined : z.array(evidenceSchema).max(30).parse(permittedContext)
	if (context && new TextEncoder().encode(JSON.stringify(context)).length > 128_000) throw new Error("Context payload exceeds budget")
	const ids = z.array(id).max(MAX_BATCH).parse(inputIds)
	const proposals = z.array(proposalSchema).max(200).parse(inputs).map(p => ({ ...p,
		subject: redactKnowledgeSecrets(p.subject), predicate: redactKnowledgeSecrets(p.predicate), value: redactKnowledgeSecrets(p.value) }))
	time.parse(processedThrough)
	atomic(agent, () => {
		const source = liveSource(agent, sourceId)
		if (expected) {
			if (JSON.stringify(expected.batch.map(event => event.eventId)) !== JSON.stringify(ids) || JSON.stringify(expected.context) !== JSON.stringify(context ?? [])) throw new Error("Reasoning snapshot mismatch")
			const sources = [...new Set([...expected.batch, ...expected.context].map(event => event.sourceId))].map(id => sourceSnapshot(liveSource(agent, id)))
			if (JSON.stringify(sources) !== JSON.stringify(expected.sources)) throw new Error("Source snapshot changed")
		}
		const permitted = new Map<string, EvidenceEvent>()
		for (const supplied of context ?? []) {
			const row = uniqueEvent(agent, supplied.eventId)
			if (!row || row.pending) throw new Error("Invalid context evidence reference")
			const stored = currentEvidence(agent, JSON.parse(row.data), source.orgId)
			if (JSON.stringify(evidenceSchema.parse(stored)) !== JSON.stringify(supplied)) throw new Error("Context evidence mismatch")
			permitted.set(stored.eventId, stored)
		}
		const batch = new Map<string, EvidenceEvent>()
		let replayed = 0
		for (const eventId of ids) {
			const row = agent.sql<{ data: string; pending: number }>`SELECT data, pending FROM knowledge_event WHERE source_id = ${sourceId} AND event_id = ${eventId}`[0]
			if (!row) {
				if (!expected && agent.sql`SELECT 1 FROM knowledge_receipt WHERE source_id = ${sourceId} AND event_id = ${eventId}`.length) { replayed++; continue }
				throw new Error("Unknown batch event")
			}
			const event: EvidenceEvent = JSON.parse(row.data)
			if (!isHead(agent, event) || event.deleted) throw new Error("Stale batch evidence reference")
			const stored = currentEvidence(agent, event, source.orgId)
			if (expected && JSON.stringify(evidenceSchema.parse(stored)) !== JSON.stringify(expected.batch.find(input => input.eventId === eventId))) throw new Error("Batch evidence mismatch")
			if (!row.pending) { replayed++; continue }
			batch.set(eventId, stored)
		}
		// Fully committed, unchanged replay is harmless; mixed pending/processed
		// inputs are stale inference, never a smaller permission-broadened batch.
		if (replayed && batch.size) throw new Error("Batch pending state changed")
		if (!batch.size) return
		// Model-selected citations cannot prove which inputs influenced its output.
		// Taint every output with ALL supplied inputs and their invalidation dependencies.
		const reasoningInputs = [...batch.values(), ...permitted.values()]
		const reasoningAudience = reasoningInputs.reduce((acl, event) => intersect(acl, event.audience), source.audience)
		let committedBytes = 0
		for (const proposal of proposals) {
			// First evidence identifies the canonical object, never the subject label.
			if (!ids.includes(proposal.evidenceIds[0]!)) throw new Error("Anchor must reference the batch")
			const anchor = batch.get(proposal.evidenceIds[0]!)
			if (!anchor || anchor.deleted) continue // stale/replayed model result
			const evidence: EvidenceEvent[] = []
			for (const eventId of [...new Set(proposal.evidenceIds)]) {
				const row = uniqueEvent(agent, eventId)
				let event = batch.get(eventId) ?? permitted.get(eventId)
				if (!event && context === undefined && row && !row.pending) {
					const stored: EvidenceEvent = JSON.parse(row.data)
					if (stored.sourceId === sourceId) event = stored
				}
				if (!row || !event) throw new Error("Invalid evidence reference")
				evidence.push(currentEvidence(agent, event, source.orgId))
			}
			const audience = evidence.reduce((a, e) => intersect(a, e.audience), reasoningAudience)
			if (!visible(audience)) throw new Error("No common permitted audience")
			for (const objectId of proposal.relatedObjectIds ?? []) {
				const targets = evidence.filter(event => event.objectId === objectId)
				if (new Set(targets.map(event => JSON.stringify([event.sourceId, event.objectId]))).size !== 1 || !targets.some(target => evidence.some(other => explicitlyLinked(other, target)))) throw new Error("Relationship requires explicit identifier evidence")
			}
			// Shared titles/names are never a code-verified cross-source identity.
			// Independent contextual claims can still be useful, but only uncertain.
			const linked = new Set([evidence[0]!])
			for (let pass = 0; pass < evidence.length; pass++) {
				const previousSize = linked.size
				for (const event of evidence) if (!linked.has(event) && [...linked].some(other => explicitlyLinked(other, event) || explicitlyLinked(event, other))) linked.add(event)
				if (linked.size === previousSize) break
			}
			const confidence = evidence.some(event => event.sourceId !== sourceId && !linked.has(event)) ? "uncertain" : proposal.confidence
			agent.sql`UPDATE knowledge_fact SET current = 0, invalidated_at = ${anchor.observedAt} WHERE source_id = ${sourceId} AND object_id = ${anchor.objectId} AND predicate = ${proposal.predicate} AND current = 1`
			const allEvidence = [...new Map([...evidence, ...reasoningInputs].map(event => [event.eventId, event])).values()]
			const data = { ...proposal, confidence, sourceId, objectId: anchor.objectId, version: anchor.version, occurredAt: anchor.occurredAt, observedAt: anchor.observedAt, audience, evidence: allEvidence }
			const serialized = JSON.stringify(data)
			const bytes = new TextEncoder().encode(serialized).length
			committedBytes += bytes
			if (bytes > 128_000 || committedBytes > MAX_BYTES) throw new Error("Fact evidence payload exceeds budget")
			const factId = agent.sql<{ id: number }>`INSERT INTO knowledge_fact(source_id, object_id, predicate, data, created_at, current) VALUES (${sourceId}, ${anchor.objectId}, ${proposal.predicate}, ${serialized}, ${Date.now()}, 1) RETURNING id`[0]!.id
			for (const event of [...evidence, ...reasoningInputs]) agent.sql`INSERT OR IGNORE INTO knowledge_dependency VALUES (${factId}, ${event.sourceId}, ${event.objectId})`
		}
		for (const eventId of ids) agent.sql`UPDATE knowledge_event SET pending = 0 WHERE source_id = ${sourceId} AND event_id = ${eventId}`
		const count = agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_fact`[0]!.n
		if (count > MAX_FACTS) pruneFactHistory(agent, count - MAX_FACTS)
		if (agent.sql<{ n: number }>`SELECT COUNT(*) AS n FROM knowledge_fact`[0]!.n > MAX_FACTS) throw new Error("Current fact capacity exceeded; batch remains pending")
		if (advanceWatermark) source.processedThrough = Math.max(source.processedThrough ?? 0, processedThrough)
		source.lastProcessedAt = Date.now()
		agent.sql`UPDATE knowledge_source SET data = ${JSON.stringify(source)} WHERE id = ${sourceId}`
	})
}

/** Source IDs must be authorized by the caller. Returned ACLs must additionally
 * be enforced for the requesting user/channel; this API has no actor argument. */
export function queryKnowledge(agent: KnowledgeAgent, sourceIds: string[], query: string, limit = 20, history = false): KnowledgeQueryResult {
	z.array(id).max(100).parse(sourceIds)
	z.string().max(2048).parse(query)
	const facts: { fact: KnowledgeFact; score: number }[] = []
	const take = cap(limit, 100)
	const terms = tokens(query)
	const authorized = new Set(sourceIds)
	let scanned = 0
	let scanExceeded = false
	for (const sourceId of new Set(sourceIds)) {
		const source = getSource(agent, sourceId)
		if (!source || source.state === "revoked" || source.state === "unsupported") continue
		const rows = agent.sql<{ id: number; data: string; current: number; invalidated_at: number | null }>`SELECT id, data, current, invalidated_at FROM knowledge_fact WHERE source_id = ${sourceId} AND (${Number(history)} = 1 OR current = 1) ORDER BY id DESC LIMIT ${1001 - scanned}`
		for (const row of rows) {
			if (scanned === 1000) { scanExceeded = true; break }
			scanned++
			const data = JSON.parse(row.data) as Omit<KnowledgeFact, "id" | "current" | "invalidatedAt">
			let audience = intersect(source.audience, data.audience)
			const evidence: EvidenceEvent[] = []
			for (const event of data.evidence) {
				const support = authorized.has(event.sourceId) ? getSource(agent, event.sourceId) : undefined
				if (!support || support.orgId !== source.orgId || ["revoked", "unsupported"].includes(support.state)) break
				const narrowed = { ...event, audience: intersect(event.audience, support.audience) }
				audience = intersect(audience, narrowed.audience)
				evidence.push(narrowed)
			}
			if (evidence.length !== data.evidence.length || !visible(audience)) continue
			const label = tokens(`${data.subject} ${data.objectId}`)
			const content = tokens(`${data.predicate} ${data.value}`)
			const provenance = terms.length ? new Set(evidence.flatMap(event => tokens(event.text))) : new Set<string>()
			const score = terms.reduce((sum, term) => sum + (label.includes(term) ? 3 : content.includes(term) ? 1 : provenance.has(term) ? 0.25 : 0), 0)
			if (terms.length && !score) continue
			facts.push({ fact: { ...data, audience, evidence, id: row.id, current: Boolean(row.current), invalidatedAt: row.invalidated_at }, score })
		}
		if (scanExceeded) break
	}
	// observedAt is state observation time; occurredAt stays the original message
	// timestamp even when a later version is an edit to that original message.
	facts.sort((a, b) => b.score - a.score || b.fact.observedAt - a.fact.observedAt || b.fact.occurredAt - a.fact.occurredAt || b.fact.id - a.fact.id)
	return { facts: facts.slice(0, take).map(({ fact }) => fact), truncated: scanExceeded || facts.length > take }
}

export function pruneKnowledge(agent: KnowledgeAgent, retentionMs: number): void {
	time.parse(retentionMs)
	const cutoff = Date.now() - retentionMs
	atomic(agent, () => {
		agent.sql`DELETE FROM knowledge_fact WHERE current = 0 AND created_at < ${cutoff}`
		agent.sql`DELETE FROM knowledge_dependency WHERE fact_id NOT IN (SELECT id FROM knowledge_fact)`
		// Preserve exact retained provenance/context references as well as the
		// immutable evidence embedded in facts. Heads/receipts never expire.
		agent.sql`DELETE FROM knowledge_event WHERE pending = 0 AND observed_at < ${cutoff}
			AND (source_id, event_id) NOT IN (
				SELECT json_extract(e.value, '$.sourceId'), json_extract(e.value, '$.eventId')
				FROM knowledge_fact f, json_each(f.data, '$.evidence') e
			)`
	})
}
