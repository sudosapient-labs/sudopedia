import type { Principal, KnowledgeInput } from "../../external/contracts"
import { ExternalError } from "../../external/errors"
import { jsonBytes, MAX_RESULT_BYTES } from "../../external/limits"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { knowledgeAccess } from "./access"
import { evidenceVerifier } from "./verify"
import { ensureKnowledgeTables, listSources, queryKnowledge } from "./store"
import { deadlineSignal, withAbort } from "../../external/deadline"

// Leave room for live Slack membership pagination within the permission budget.
const SOURCE_PAGE_SIZE = 5
type QueryLease = { controller: AbortController; actor: string; deadline: number }
const leases = new WeakMap<CompanyBrainAgent, Map<string, QueryLease>>()
function queryLeases(agent: CompanyBrainAgent) {
	let rows = leases.get(agent)
	if (!rows) { rows = new Map(); leases.set(agent, rows) }
	for (const [id, row] of rows) if (row.deadline <= Date.now()) { row.controller.abort(); rows.delete(id) }
	return rows
}
const actorKey = (principal: Principal) => JSON.stringify([principal.orgId, principal.userId, principal.credentialId])
export function cancelExternalKnowledgeQuery(agent: CompanyBrainAgent, principal: Principal, requestId: string) {
	if (agent.name !== principal.orgId || !/^[a-f0-9-]{36}$/.test(requestId)) return
	const rows = queryLeases(agent), prior = rows.get(requestId)
	if (prior && prior.actor !== actorKey(principal)) return
	if (!prior && rows.size >= 64) return
	const row = prior ?? { controller: new AbortController(), actor: actorKey(principal), deadline: Date.now() + 8000 }
	row.controller.abort(new DOMException("Query cancelled", "AbortError")); rows.set(requestId, row)
}

export async function queryExternalKnowledge(agent: CompanyBrainAgent,
	principal: Principal, input: KnowledgeInput | null, sourcePage = 0, requestedDeadline = Date.now() + 8000, requestId = crypto.randomUUID()) {
	if (agent.name !== principal.orgId) throw new ExternalError("forbidden", 403, "Workspace mismatch")
	if (!Number.isFinite(requestedDeadline) || !/^[a-f0-9-]{36}$/.test(requestId)) throw new ExternalError("invalid_input", 400, "Invalid query deadline")
	const deadline = Math.min(requestedDeadline, Date.now() + 8000), rows = queryLeases(agent)
	if (rows.size >= 64 && !rows.has(requestId)) throw new ExternalError("unavailable", 503, "Knowledge query capacity reached")
	const lease = rows.get(requestId) ?? { controller: new AbortController(), actor: actorKey(principal), deadline }
	if (lease.actor !== actorKey(principal)) throw new ExternalError("forbidden", 403, "Query identity mismatch")
	lease.deadline = deadline; rows.set(requestId, lease)
	const signal = deadlineSignal(deadline, lease.controller.signal)
	try {
	signal.throwIfAborted()
	ensureKnowledgeTables(agent)
	const access = await withAbort(knowledgeAccess(brainAgent(agent).env, principal, signal), signal)
	const sources = listSources(agent).filter(s => s.state !== "revoked" && s.provider !== "slack_installation")
	const page = input?.sourcePage ?? sourcePage
	if (!Number.isInteger(page) || page < 0 || page > 1000) throw new ExternalError("invalid_input", 400, "Invalid source page")
	const selected = sources.slice(page * SOURCE_PAGE_SIZE, (page + 1) * SOURCE_PAGE_SIZE)
	const allowed = [] as typeof sources
	const visible = [] as typeof sources
	// Bound live checks, not just final response size. No rejected source labels
	// or counts are returned, because even their existence can be restricted.
	for (const source of selected) {
		signal.throwIfAborted()
		if (await withAbort(access.source(source, true), signal)) visible.push(source)
		if (input && await withAbort(access.source(source), signal)) allowed.push(source)
	}
	const now = Date.now()
	const status = visible.map((source) => ({
		id: source.id, provider: source.provider, state: source.state, coverage: source.coverage,
		lastCheckedAt: source.lastCheckedAt, lastProcessedAt: source.lastProcessedAt,
		processedThrough: source.processedThrough, nextCheckAt: source.nextCheckAt,
		delayMs: source.processedThrough === null ? null : Math.max(0, now - source.processedThrough),
		stale: source.state !== "active" || source.lastProcessedAt === null ||
			source.processedThrough === null || now - source.processedThrough > source.intervalMs * 2,
		error: source.error,
	}))
	const result = input ? queryKnowledge(agent, allowed.map((s) => s.id), input.query, input.limit, input.recall === "historical") : { facts: [], truncated: false }
	// Store restricts every evidence dependency to the allowed source set. This
	// second check protects per-event audiences narrower than their source.
	const facts = [] as typeof result.facts
	signal.throwIfAborted()
	const verifier = evidenceVerifier(brainAgent(agent).env, deadline, signal)
	try {
	for (const fact of result.facts) {
		signal.throwIfAborted()
		let authorized = await withAbort(access.audience(fact.audience), signal)
		if (!authorized) continue
		for (const evidence of fact.evidence) {
			const source = allowed.find(s => s.id === evidence.sourceId)
			if (!source || !await withAbort(access.audience(evidence.audience), signal) || !await withAbort(verifier.verify(source, evidence, !fact.current), signal)) { authorized = false; break }
		}
		// Verify complete retained evidence, then return bounded excerpts. One long
		// source body should not crowd every answer out of the response envelope.
		if (authorized) facts.push({ ...fact, evidence: fact.evidence.map(event => ({ ...event, contentFingerprint: undefined, text: event.text.slice(0, 512) })) })
	}
	} finally { await withAbort(verifier.close(), signal).catch(() => {}) }
	signal.throwIfAborted()
	const moreSources = sources.length > (page + 1) * SOURCE_PAGE_SIZE
	const output = { facts, sources: status, truncated: result.truncated || moreSources,
		nextSourcePage: moreSources ? page + 1 : null,
		accessCoverageIncomplete: access.incomplete() || verifier.incomplete(), asOf: now,
		interpretation: "Recorded source state is not proof of active work right now. Unsupported, partial, stale or failed sources limit coverage. Historical facts are not current truth. Missing evidence is not evidence of absence." }
	while (jsonBytes(output) > MAX_RESULT_BYTES && output.facts.length) { output.facts.pop(); output.truncated = true }
	while (jsonBytes(output) > MAX_RESULT_BYTES && output.sources.length) { output.sources.pop(); output.truncated = true }
	return output
	} catch (error) {
		if (signal.aborted) throw new ExternalError("upstream_timeout", 504, "Knowledge query cancelled or deadline exceeded")
		throw error
	} finally { rows.delete(requestId) }
}
