import { describe, expect, it, vi } from "vitest"
import { queryKnowledgeRpc } from "./knowledge-rpc"
import type { Principal } from "./contracts"
import type { CompanyBrainAgent } from "../brain/turn/agent"
const principal: Principal = { credentialId: "bot", orgId: "org", userId: "a", kind: "employee", grants: ["memory.personal:read"] }
const target = () => ({ queryExternalKnowledge: vi.fn<CompanyBrainAgent["queryExternalKnowledge"]>(async () => ({ facts: [], sources: [], truncated: false, nextSourcePage: null, accessCoverageIncomplete: false, asOf: Date.now(), interpretation: "Recorded state" })), cancelExternalKnowledgeQuery: vi.fn<CompanyBrainAgent["cancelExternalKnowledgeQuery"]>(async () => {}) })
describe("knowledge RPC deadline and cancellation", () => {
	it("passes the original absolute deadline and removes cancellation listeners after success", async () => {
		const remote = target(), controller = new AbortController(), deadline = Date.now() + 1000
		await expect(queryKnowledgeRpc(async () => remote, null, principal, controller.signal, 2, deadline)).resolves.toMatchObject({ facts: [] })
		expect(remote.queryExternalKnowledge).toHaveBeenCalledWith(principal, null, 2, deadline, expect.any(String))
		controller.abort(); expect(remote.cancelExternalKnowledgeQuery).not.toHaveBeenCalled()
	})
	it("bounds a non-cancellable agent lookup and never dispatches after its deadline", async () => {
		const remote = target()
		await expect(queryKnowledgeRpc(() => new Promise(() => {}), null, principal, new AbortController().signal, 0, Date.now() + 20)).rejects.toMatchObject({ status: 504 })
		expect(remote.queryExternalKnowledge).not.toHaveBeenCalled()
	})
	it("cancels already dispatched DO work using the same actor and request identity", async () => {
		const remote = target(), controller = new AbortController()
		remote.queryExternalKnowledge.mockImplementation(() => new Promise(() => {}))
		const result = queryKnowledgeRpc(async () => remote, null, principal, controller.signal)
		const rejected = expect(result).rejects.toMatchObject({ status: 504 })
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
		controller.abort()
		await rejected
		const requestId = remote.queryExternalKnowledge.mock.calls[0]![4]
		expect(remote.cancelExternalKnowledgeQuery).toHaveBeenCalledExactlyOnceWith(principal, requestId)
	})
})
