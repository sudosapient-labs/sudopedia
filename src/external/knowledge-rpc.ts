import type { CompanyBrainAgent } from "../brain/turn/agent"
import type { KnowledgeInput, Principal } from "./contracts"
import { deadlineSignal, withAbort } from "./deadline"
import { ExternalError } from "./errors"

type KnowledgeTarget = Pick<CompanyBrainAgent, "queryExternalKnowledge" | "cancelExternalKnowledgeQuery">
/** One budget spans agent lookup, RPC dispatch, and both DO verification phases.
 * AbortSignal is not serialized through RPC; cancellation has an actor-bound ID. */
export async function queryKnowledgeRpc(getTarget: () => Promise<KnowledgeTarget>, input: KnowledgeInput | null,
	principal: Principal, requestSignal: AbortSignal, sourcePage?: number, requestedDeadline = Date.now() + 8000) {
	const deadline = Math.min(requestedDeadline, Date.now() + 8000), signal = deadlineSignal(deadline, requestSignal)
	try {
		signal.throwIfAborted()
		const target = await withAbort(getTarget(), signal), requestId = crypto.randomUUID()
		const cancel = () => { void target.cancelExternalKnowledgeQuery(principal, requestId).catch(() => {}) }
		signal.addEventListener("abort", cancel, { once: true })
		try {
			signal.throwIfAborted()
			return await withAbort(target.queryExternalKnowledge(principal, input, sourcePage, deadline, requestId), signal)
		} finally { signal.removeEventListener("abort", cancel) }
	} catch (error) {
		if (signal.aborted) throw new ExternalError("upstream_timeout", 504, "Knowledge query cancelled or deadline exceeded")
		throw error
	}
}
