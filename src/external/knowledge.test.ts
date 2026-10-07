import { describe, expect, it, vi } from "vitest"
import { execute, type ExternalDependencies } from "./service"
import type { Principal } from "./contracts"

function fixture(grants: Principal["grants"] = ["memory.personal:read"]) {
	const principal: Principal = { credentialId: "credential", userId: "employee", orgId: "company", kind: "employee", grants }
	const deps: ExternalDependencies = { authenticate: async () => principal, quota: vi.fn(async () => {}),
		search: vi.fn(async () => ({})), listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }),
		knowledge: vi.fn(async () => ({ facts: [], sources: [{ state: "partial", lastProcessedAt: null }], interpretation: "Recorded state, not active work" })) }
	return { principal, deps }
}

describe("background knowledge MCP operations", () => {
	it("uses authenticated identity, read grant, quota and current recall default", async () => {
		const { principal, deps } = fixture()
		expect(await execute(deps, "knowledge", { query: "Did Deepak start the work?" })).toMatchObject({ sources: [{ state: "partial" }] })
		expect(deps.knowledge).toHaveBeenCalledWith({ query: "Did Deepak start the work?", limit: 10, recall: "current", sourcePage: 0 }, principal, expect.any(AbortSignal))
		expect(deps.quota).toHaveBeenCalledWith(principal, "knowledge")
	})
	it("never accepts caller-selected source, audience or identity", async () => {
		const { deps } = fixture()
		for (const forged of [{ orgId: "other" }, { sourceIds: ["restricted"] }, { audience: ["everyone"] }, { userId: "other" }])
			await expect(execute(deps, "knowledge", { query: "status", ...forged })).rejects.toMatchObject({ status: 400 })
		expect(deps.knowledge).not.toHaveBeenCalled()
	})
	it("rejects skill-only and write-only credentials", async () => {
		for (const grants of [["skills.org:read"], ["memory.personal:write"]] as Principal["grants"][]) {
			const { deps } = fixture(grants)
			await expect(execute(deps, "knowledge", { query: "status" })).rejects.toMatchObject({ status: 403 })
			await expect(execute(deps, "sources", {})).rejects.toMatchObject({ status: 403 })
			expect(deps.knowledge).not.toHaveBeenCalled()
		}
	})
	it("source status is read-only and fails honestly when unavailable", async () => {
		const { deps, principal } = fixture()
		await execute(deps, "sources", {})
		expect(deps.knowledge).toHaveBeenCalledWith(null, principal, expect.any(AbortSignal), 0)
		delete deps.knowledge
		await expect(execute(deps, "knowledge", { query: "status" })).rejects.toMatchObject({ status: 503 })
	})
})
