import { describe, expect, it, vi } from "vitest"
const client = vi.hoisted(() => ({
	post: vi.fn(),
	get: vi.fn(),
	patch: vi.fn(),
	search: { memories: vi.fn() },
	memories: { forget: vi.fn(), updateMemory: vi.fn() },
}))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => client }))
import { personalProvider, externalDependencies } from "./dependencies"
import type { Principal } from "./contracts"

const owner: Principal = {
	orgId: "fictional-company",
	userId: "employee-a",
	credentialId: "integration-a",
	grants: ["memory.personal:write"],
}
describe("real provider adapter with mocked public API responses", () => {
	it("uses supported direct v4 CRUD, server-owned scope/provenance and zero SDK retries", async () => {
		vi.resetAllMocks()
		client.search.memories.mockResolvedValue({ results: [] })
		client.get.mockResolvedValue({ name: "Existing personal brain" })
		client.post.mockResolvedValue({ memories: [{ id: "created" }] })
		const provider = personalProvider({} as Env),
			signal = new AbortController().signal
		await provider.mutate(
			owner,
			"capture",
			{
				idempotencyKey: crypto.randomUUID(),
				content: "Employee A prefers concise weekly summaries.",
				eventDate: "2026-10-03",
			},
			undefined,
			"operation-hash",
			signal,
		)
		expect(client.post).toHaveBeenCalledWith(
			"/v4/memories",
			expect.objectContaining({
				signal,
				timeout: 8000,
				maxRetries: 0,
				body: {
					containerTag: "user_employee-a",
					memories: [
						{
							content: "Employee A prefers concise weekly summaries.",
							isStatic: false,
							metadata: expect.objectContaining({
								memory_scope: "personal",
								source_type: "external-primary-bot",
								external_integration: "integration-a",
								external_operation: "operation-hash",
								event_date: "2026-10-03",
							}),
						},
					],
				},
			}),
		)
		expect(client.patch).not.toHaveBeenCalled()
		client.memories.updateMemory.mockResolvedValue({
			id: "new-version",
			parentMemoryId: "old",
		})
		await provider.mutate(
			owner,
			"correct",
			{
				idempotencyKey: crypto.randomUUID(),
				content: "Employee A now owns billing.",
			},
			"old",
			"operation-2",
			signal,
		)
		expect(client.memories.updateMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "old",
				containerTag: "user_employee-a",
				newContent: "Employee A now owns billing.",
			}),
			expect.objectContaining({ signal, maxRetries: 0 }),
		)
		client.memories.forget.mockResolvedValue({
			id: "new-version",
			forgotten: true,
		})
		await provider.mutate(
			owner,
			"retract",
			{ idempotencyKey: crypto.randomUUID(), reference: crypto.randomUUID() },
			"new-version",
			"operation-3",
			signal,
		)
		expect(client.memories.forget).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "new-version",
				containerTag: "user_employee-a",
			}),
			expect.objectContaining({ signal, maxRetries: 0 }),
		)
	})
	it("verifies latest-entry ownership with bounded scoped provider calls, never an unscoped ID fetch", async () => {
		vi.resetAllMocks()
		client.post.mockResolvedValue({
			memoryEntries: [],
			pagination: { totalPages: 500 },
		})
		expect(
			await personalProvider({} as Env).find(
				owner,
				"guessed-b-id",
				new AbortController().signal,
			),
		).toBeNull()
		expect(client.post).toHaveBeenCalledTimes(3)
		for (const [, options] of client.post.mock.calls)
			expect(options.body.containerTags).toEqual(["user_employee-a"])
		expect(client.get).not.toHaveBeenCalled()
	})
	it("does not recapture identical live content and provisions only a missing personal container", async () => {
		vi.resetAllMocks()
		const provider = personalProvider({} as Env),
			input = {
				idempotencyKey: crypto.randomUUID(),
				content: "Employee A prefers concise summaries.",
			},
			signal = new AbortController().signal
		client.search.memories.mockResolvedValue({
			results: [{ memory: input.content }],
		})
		await provider.mutate(owner, "capture", input, undefined, "op", signal)
		expect(client.post).not.toHaveBeenCalled()
		client.search.memories.mockResolvedValue({ results: [] })
		client.get.mockRejectedValue({ status: 404 })
		client.patch.mockResolvedValue({})
		client.post.mockResolvedValue({ memories: [{ id: "created" }] })
		await provider.mutate(owner, "capture", input, undefined, "op", signal)
		expect(client.patch).toHaveBeenCalledWith(
			"/v3/container-tags/user_employee-a",
			expect.objectContaining({ maxRetries: 0 }),
		)
	})
	it("keeps shared search requests unchanged while personal reads use only owner memories", async () => {
		vi.resetAllMocks()
		client.search.memories.mockResolvedValue({ results: [] })
		const deps = externalDependencies(
				{} as Env,
				new Request("https://fictional.invalid/mcp"),
			),
			signal = new AbortController().signal
		await deps.search({ query: "fictional", limit: 5 }, signal)
		await deps.personalSearch!({ query: "fictional", limit: 5 }, owner, signal)
		expect(client.search.memories.mock.calls[0]![0]).toMatchObject({
			containerTag: "sm_org_shared",
			searchMode: "hybrid",
		})
		expect(client.search.memories.mock.calls[1]![0]).toMatchObject({
			containerTag: "user_employee-a",
			searchMode: "memories",
			include: { forgottenMemories: false },
		})
	})
})
