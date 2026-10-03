import { describe, expect, it, vi } from "vitest"
const client = vi.hoisted(() => ({
	post: vi.fn(),
	get: vi.fn(),
	patch: vi.fn(),
	add: vi.fn(),
	search: { memories: vi.fn() },
	memories: { forget: vi.fn(), updateMemory: vi.fn() },
}))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => client }))
import { personalProvider, externalDependencies } from "./dependencies"
import type { Principal } from "./contracts"
import { maintainPersonal, type Journal, type PersonalStore } from "./personal"

const owner: Principal = {
	orgId: "fictional-company",
	userId: "employee-a",
	credentialId: "integration-a",
	grants: ["memory.personal:write"],
}
describe("real provider adapter with mocked public API responses", () => {
	it.each(["lookup", "provision", "verify-provision", "search"])(
		"rejects a failed capture %s without locking future writes",
		async (stage) => {
			vi.resetAllMocks()
			client.get.mockResolvedValue({})
			client.patch.mockResolvedValue({})
			client.add.mockResolvedValue({ id: "bootstrap", status: "queued" })
			client.search.memories.mockResolvedValue({ results: [] })
			client.post.mockResolvedValue({ memories: [{ id: "created", forgetAfter: null }] })
			if (stage === "lookup")
				client.get.mockRejectedValueOnce(new Error("lookup failed"))
			if (stage === "provision") {
				client.get.mockRejectedValueOnce({ status: 404 })
				client.add.mockRejectedValueOnce(new Error("provision failed"))
			}
			if (stage === "verify-provision") {
				client.get.mockRejectedValueOnce({ status: 404 })
				client.get.mockRejectedValueOnce({ status: 404 })
			}
			if (stage === "search")
				client.search.memories.mockRejectedValueOnce(new Error("search failed"))
			const journals = new Map<string, Journal>()
			const store: PersonalStore = {
				dispatch: vi.fn(async () => {}),
				reference: async () => "unused",
				references: async () => [],
				lookup: async () => null,
				read: async (id) => journals.get(id) ?? null,
				claim: async (_owner, id, hash) => {
					if (
						[...journals.values()].some((r) =>
							["pending", "unknown"].includes(r.state),
						)
					)
						return false
					journals.set(id, {
						request_hash: hash,
						state: "pending",
						result: null,
					})
					return true
				},
				finish: async (id, result) => {
					Object.assign(journals.get(id)!, {
						state: result.status,
						result: JSON.stringify(result),
					})
				},
			}
			const provider = personalProvider({} as Env),
				signal = new AbortController().signal
			const input = {
				idempotencyKey: crypto.randomUUID(),
				content: "Durable preference",
			}
			await expect(
				maintainPersonal(store, provider, owner, "capture", input, signal),
			).rejects.toMatchObject({ status: 502 })
			expect(client.post).not.toHaveBeenCalled()
			expect(
				await maintainPersonal(store, provider, owner, "status", input, signal),
			).toMatchObject({ status: "rejected" })
			expect(
				await maintainPersonal(
					store,
					provider,
					owner,
					"capture",
					{ ...input, idempotencyKey: crypto.randomUUID() },
					signal,
				),
			).toMatchObject({ status: "applied" })
		},
	)
	it.each([undefined, "2026-10-03"])(
		"preserves correction metadata and handles eventDate %s",
		async (eventDate) => {
			vi.resetAllMocks()
			const current = {
				id: "old",
				memory: "Old responsibility",
				updatedAt: "2026-10-01",
				metadata: {
					brain_tags: ["topic_billing"],
					sources: ["https://fictional.invalid/source"],
					event_date: "2026-10-01",
					memory_scope: "dm",
					external_operation: "old-operation",
				},
			}
			client.memories.updateMemory.mockResolvedValue({
				id: "new",
				parentMemoryId: "old",
				forgetAfter: null,
			})
			const onDispatch = vi.fn()
			await personalProvider({} as Env).mutate(
				owner,
				"correct",
				{
					idempotencyKey: crypto.randomUUID(),
					content: "New responsibility",
					...(eventDate ? { eventDate } : {}),
				},
				"old",
				"new-operation",
				new AbortController().signal,
				{ current, onDispatch },
			)
			expect(client.memories.updateMemory).toHaveBeenCalledWith(
				expect.objectContaining({
					metadata: expect.objectContaining({
						brain_tags: current.metadata.brain_tags,
						sources: current.metadata.sources,
						event_date: eventDate ?? "2026-10-01",
						memory_scope: "personal",
						external_operation: "new-operation",
						external_integration: owner.credentialId,
					}),
				}),
				expect.anything(),
			)
			expect(onDispatch).toHaveBeenCalledTimes(1)
			expect(current.metadata.external_operation).toBe("old-operation")
		},
	)
	it.each(["capture", "correct", "retract"] as const)(
		"marks %s dispatched before an uncertain mutation failure",
		async (operation) => {
			vi.resetAllMocks()
			client.get.mockResolvedValue({})
			client.search.memories.mockResolvedValue({ results: [] })
			const onDispatch = vi.fn()
			const failure = async () => {
				expect(onDispatch).toHaveBeenCalledTimes(1)
				throw new Error("Uncertain mutation")
			}
			client.post.mockImplementation(failure)
			client.memories.updateMemory.mockImplementation(failure)
			client.memories.forget.mockImplementation(failure)
			await expect(
				personalProvider({} as Env).mutate(
					owner,
					operation,
					{
						idempotencyKey: crypto.randomUUID(),
						content: "New fact",
						reference: crypto.randomUUID(),
					},
					"old",
					"op",
					new AbortController().signal,
					{
						onDispatch,
						current: { id: "old", memory: "Old fact", updatedAt: "2026-10-01" },
					},
				),
			).rejects.toThrow("Uncertain mutation")
			expect(onDispatch).toHaveBeenCalledTimes(1)
		},
	)
	it("uses supported direct v4 CRUD, server-owned scope/provenance and zero SDK retries", async () => {
		vi.resetAllMocks()
		client.search.memories.mockResolvedValue({ results: [] })
		client.get.mockResolvedValue({ name: "Existing personal brain" })
		client.post.mockResolvedValue({ memories: [{ id: "created", forgetAfter: null }] })
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
			{ onDispatch: vi.fn() },
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
							forgetAfter: null,
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
			forgetAfter: null,
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
			{
				onDispatch: vi.fn(),
				current: { id: "old", memory: "Old fact", updatedAt: "2026-10-01" },
			},
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
			{ onDispatch: vi.fn() },
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
	it("does not recapture a permanent fact and bootstraps only a missing container without fact extraction", async () => {
		vi.resetAllMocks()
		const provider = personalProvider({} as Env),
			input = {
				idempotencyKey: crypto.randomUUID(),
				content: "Employee A prefers concise summaries.",
			},
			signal = new AbortController().signal
		client.search.memories.mockResolvedValue({
			results: [{ id: "same", memory: input.content }],
		})
		client.post.mockResolvedValue({ memoryEntries: [{ id: "same", memory: input.content,
			updatedAt: "2026-10-01", forgetAfter: null }], pagination: { totalPages: 1 } })
		client.get.mockResolvedValue({})
		const context = { onDispatch: vi.fn() }
		await provider.mutate(
			owner,
			"capture",
			input,
			undefined,
			"op",
			signal,
			context,
		)
		expect(context.onDispatch).not.toHaveBeenCalled()
		expect(client.post).not.toHaveBeenCalledWith("/v4/memories", expect.anything())
		client.search.memories.mockResolvedValue({ results: [] })
		client.get.mockRejectedValueOnce({ status: 404 })
		client.add.mockResolvedValue({ id: "bootstrap", status: "queued" })
		client.post.mockResolvedValue({ memories: [{ id: "created", forgetAfter: null }] })
		await provider.mutate(
			owner,
			"capture",
			input,
			undefined,
			"op",
			signal,
			context,
		)
		expect(context.onDispatch).toHaveBeenCalledTimes(1)
		expect(client.add).toHaveBeenCalledWith(
			expect.objectContaining({ taskType: "superrag", containerTag: "user_employee-a",
				customId: expect.stringMatching(/^sd_personal_bootstrap_[a-f0-9]{64}$/) }),
			expect.objectContaining({ maxRetries: 0 }),
		)
		expect(client.patch).not.toHaveBeenCalled()
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
	it.each([undefined, "preserve"] as const)("corrects an expiring fact with retention=%s", async (retention) => {
		vi.resetAllMocks()
		const horizon = new Date(Date.now() + 86400000).toISOString()
		client.memories.updateMemory.mockImplementation(async (body) => ({
			id: "new", parentMemoryId: "old", forgetAfter: "forgetAfter" in body ? body.forgetAfter : horizon,
		}))
		await personalProvider({} as Env).mutate(owner, "correct", {
			idempotencyKey: crypto.randomUUID(), content: "Durable changed preference", retention,
		}, "old", "op", new AbortController().signal, {
			current: { id: "old", memory: "Transient preference", updatedAt: "2026-10-01", forgetAfter: horizon },
			onDispatch: vi.fn(async () => {}),
		})
		const body = client.memories.updateMemory.mock.calls[0]![0]
		if (retention === "preserve") expect(body).not.toHaveProperty("forgetAfter")
		else expect(body.forgetAfter).toBeNull()
	})
	it("promotes an owner-verified expiring exact repeat while retaining metadata", async () => {
		vi.resetAllMocks()
		const current = { id: "old", memory: "Durable preference", updatedAt: "2026-10-01",
			forgetAfter: new Date(Date.now() + 86400000).toISOString(), metadata: { brain_tags: ["topic_preference"] } }
		client.get.mockResolvedValue({})
		client.search.memories.mockResolvedValue({ results: [current] })
		client.post.mockResolvedValue({ memoryEntries: [current], pagination: { totalPages: 1 } })
		client.memories.updateMemory.mockResolvedValue({ id: "new", parentMemoryId: "old", forgetAfter: null })
		const onDispatch = vi.fn(async () => {})
		await personalProvider({} as Env).mutate(owner, "capture", {
			idempotencyKey: crypto.randomUUID(), content: current.memory,
		}, undefined, "reinforcement-op", new AbortController().signal, { onDispatch })
		expect(client.memories.updateMemory).toHaveBeenCalledWith(expect.objectContaining({
			id: "old", forgetAfter: null, metadata: expect.objectContaining({
				brain_tags: current.metadata.brain_tags, external_operation: "reinforcement-op",
			}),
		}), expect.anything())
		expect(onDispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "correct", providerId: "old", fingerprint: expect.any(String) }))
		expect(client.post).not.toHaveBeenCalledWith("/v4/memories", expect.anything())
	})
	it.each(["capture", "correct", "retract"] as const)("never sends %s when durable dispatch persistence fails", async (operation) => {
		vi.resetAllMocks()
		client.get.mockResolvedValue({})
		client.search.memories.mockResolvedValue({ results: [] })
		await expect(personalProvider({} as Env).mutate(owner, operation, {
			idempotencyKey: crypto.randomUUID(), content: "Fact", reference: crypto.randomUUID(),
		}, "old", "op", new AbortController().signal, {
			current: { id: "old", memory: "Fact", updatedAt: "2026-10-01" },
			onDispatch: async () => { throw new Error("dispatch persistence unavailable") },
		})).rejects.toThrow("dispatch persistence unavailable")
		expect(client.memories.updateMemory).not.toHaveBeenCalled()
		expect(client.memories.forget).not.toHaveBeenCalled()
		expect(client.post).not.toHaveBeenCalled()
	})
})
