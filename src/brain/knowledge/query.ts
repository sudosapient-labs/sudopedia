import type { Principal, KnowledgeInput } from "../../external/contracts"
import { ExternalError } from "../../external/errors"
import { jsonBytes, MAX_RESULT_BYTES } from "../../external/limits"
import { brainAgent, type CompanyBrainAgent } from "../turn/agent"
import { knowledgeAccess } from "./access"
import { evidenceVerifier } from "./verify"
import { ensureKnowledgeTables, listSources, queryKnowledge } from "./store"

// Leave room for live Slack membership pagination within the permission budget.
const SOURCE_PAGE_SIZE = 5

export async function queryExternalKnowledge(agent: CompanyBrainAgent,
	principal: Principal, input: KnowledgeInput | null, sourcePage = 0) {
	if (agent.name !== principal.orgId) throw new ExternalError("forbidden", 403, "Workspace mismatch")
	ensureKnowledgeTables(agent)
	const access = await knowledgeAccess(brainAgent(agent).env, principal, AbortSignal.timeout(7000))
	const sources = listSources(agent).filter(s => s.state !== "revoked" && s.provider !== "slack_installation")
	const page = input?.sourcePage ?? sourcePage
	if (!Number.isInteger(page) || page < 0 || page > 1000) throw new ExternalError("invalid_input", 400, "Invalid source page")
	const selected = sources.slice(page * SOURCE_PAGE_SIZE, (page + 1) * SOURCE_PAGE_SIZE)
	const allowed = [] as typeof sources
	const visible = [] as typeof sources
	// Bound live checks, not just final response size. No rejected source labels
	// or counts are returned, because even their existence can be restricted.
	for (const source of selected) {
		if (await access.source(source, true)) visible.push(source)
		if (input && await access.source(source)) allowed.push(source)
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
	const verifier = evidenceVerifier(brainAgent(agent).env)
	try {
	for (const fact of result.facts) {
		let authorized = await access.audience(fact.audience)
		for (const evidence of fact.evidence) {
			const source = allowed.find(s => s.id === evidence.sourceId)
			if (!source || !await access.audience(evidence.audience) || !await verifier.verify(source, evidence, !fact.current)) { authorized = false; break }
		}
		// Verify complete retained evidence, then return bounded excerpts. One long
		// source body should not crowd every answer out of the response envelope.
		if (authorized) facts.push({ ...fact, evidence: fact.evidence.map(event => ({ ...event, text: event.text.slice(0, 512) })) })
	}
	} finally { await verifier.close() }
	const moreSources = sources.length > (page + 1) * SOURCE_PAGE_SIZE
	const output = { facts, sources: status, truncated: result.truncated || moreSources,
		nextSourcePage: moreSources ? page + 1 : null,
		accessCoverageIncomplete: access.incomplete() || verifier.incomplete(), asOf: now,
		interpretation: "Recorded source state is not proof of active work right now. Unsupported, partial, stale or failed sources limit coverage. Historical facts are not current truth. Missing evidence is not evidence of absence." }
	while (jsonBytes(output) > MAX_RESULT_BYTES && output.facts.length) { output.facts.pop(); output.truncated = true }
	while (jsonBytes(output) > MAX_RESULT_BYTES && output.sources.length) { output.sources.pop(); output.truncated = true }
	return output
}
