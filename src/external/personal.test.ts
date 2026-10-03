import { describe, expect, it, vi } from "vitest"
import type { Principal } from "./contracts"
import { captureSchema, correctSchema } from "./contracts"
import {
	maintainPersonal,
	fingerprint,
	type PersonalStore,
	type PersonalProvider,
	type PersonalEntry,
	type Journal,
	type Reference,
} from "./personal"
import { execute, type ExternalDependencies } from "./service"

const a: Principal = {
	orgId: "fictional-org",
	userId: "a",
	credentialId: "bot-a",
	grants: [
		"memory.shared:read",
		"memory.personal:read",
		"memory.personal:write",
	],
}
const b = { ...a, userId: "b", credentialId: "bot-b" }
const key = () => crypto.randomUUID()
function fixture() {
	const journals = new Map<string, Journal & { owner: string }>()
	const refs = new Map<string, Reference & { owner: string }>()
	const entries: (PersonalEntry & { owner: string })[] = [
		{
			id: "a-fact",
			owner: "a",
			memory: "Employee A owns onboarding.",
			updatedAt: "2026-10-01",
		},
		{
			id: "b-fact",
			owner: "b",
			memory: "Employee B prefers afternoon reviews.",
			updatedAt: "2026-10-01",
		},
	]
	const store: PersonalStore = {
		dispatch: vi.fn(async () => {}),
		async reference(owner, entry) {
			const id = key()
			refs.set(id, {
				owner: owner.userId,
				provider_id: entry.id,
				fingerprint: await fingerprint(entry),
			})
			return id
		},
		async lookup(owner, id) {
			const row = refs.get(id)
			return row?.owner === owner.userId ? row : null
		},
		async read(id) {
			return journals.get(id) ?? null
		},
		async claim(owner, id, hash) {
			if (
				journals.has(id) ||
				[...journals.values()].some(
					(r) =>
						r.owner === owner.userId &&
						["pending", "unknown"].includes(r.state),
				)
			)
				return false
			journals.set(id, {
				owner: owner.userId,
				request_hash: hash,
				state: "pending",
				result: null,
			})
			return true
		},
		async finish(id, result) {
			const row = journals.get(id)!
			row.state = result.status
			row.result = JSON.stringify(result)
		},
	}
	const provider: PersonalProvider = {
		find: vi.fn(
			async (owner, id) =>
				entries.find((r) => r.owner === owner.userId && r.id === id) ?? null,
		),
		mutate: vi.fn(
			async (owner, operation, input, id, _operationId, _signal, context) => {
				await context.onDispatch({ action: operation, providerId: id })
				const old = entries.find((r) => r.owner === owner.userId && r.id === id)
				if (operation === "retract") old!.isForgotten = true
				else {
					if (old) old.isLatest = false
					entries.push({
						id: key(),
						owner: owner.userId,
						memory: (input as { content: string }).content,
						updatedAt: new Date().toISOString(),
					})
				}
				return { status: "applied" as const }
			},
		),
	}
	const run = (
		operation: "capture" | "correct" | "retract" | "status",
		input: any,
		owner = a,
		signal = new AbortController().signal,
	) => maintainPersonal(store, provider, owner, operation, input, signal)
	return { store, provider, entries, run }
}

describe("personal memory maintenance", () => {
	it("captures, corrects responsibility by versioning, then retracts the latest version", async () => {
		const f = fixture()
		const reference = await f.store.reference(a, f.entries[0]!)
		const result = await f.run("correct", {
			idempotencyKey: key(),
			reference,
			content: "Employee A now owns billing rather than onboarding.",
		})
		expect(result).toMatchObject({ status: "applied", searchable: true })
		expect(f.entries[0]?.isLatest).toBe(false)
		const latest = f.entries.at(-1)!
		expect(latest.memory).toContain("billing")
		const newReference = await f.store.reference(a, latest)
		expect(
			await f.run("retract", {
				idempotencyKey: key(),
				reference: newReference,
			}),
		).toMatchObject({ status: "applied", searchable: false })
		expect(latest.isForgotten).toBe(true)
	})
	it("does not authorize guessed IDs, cross-user references or other organizations", async () => {
		const f = fixture(),
			reference = await f.store.reference(a, f.entries[0]!)
		await expect(
			f.run(
				"correct",
				{ idempotencyKey: key(), reference, content: "stolen" },
				b,
			),
		).rejects.toMatchObject({ status: 404 })
		await expect(
			f.run("retract", { idempotencyKey: key(), reference: key() }),
		).rejects.toMatchObject({ status: 404 })
		// Real repository additionally binds org_id; test scope verification refuses a provider row missing from owner's container.
		f.provider.find = vi.fn(async () => null)
		await expect(
			f.run("retract", { idempotencyKey: key(), reference }),
		).rejects.toMatchObject({ status: 409 })
		expect(f.provider.mutate).not.toHaveBeenCalled()
	})
	it("replays one durable receipt, conflicts on changed input, and does not leak to B's status", async () => {
		const f = fixture(),
			input = {
				idempotencyKey: key(),
				content: "Employee A prefers concise weekly summaries.",
			}
		const result = await f.run("capture", input)
		expect(await f.run("capture", input)).toEqual(result)
		expect(
			await f.run("status", { idempotencyKey: input.idempotencyKey }),
		).toEqual(result)
		await expect(
			f.run("capture", { ...input, content: "Changed" }),
		).rejects.toMatchObject({ code: "idempotency_conflict" })
		await expect(
			f.run("status", { idempotencyKey: input.idempotencyKey }, b),
		).rejects.toMatchObject({ status: 404 })
		expect(f.provider.mutate).toHaveBeenCalledTimes(1)
	})
	it("serializes two concurrent updates and rejects old/forgotten/stale snapshots", async () => {
		const f = fixture(),
			reference = await f.store.reference(a, f.entries[0]!)
		const results = await Promise.allSettled(
			["billing", "support"].map((content) =>
				f.run("correct", { idempotencyKey: key(), reference, content }),
			),
		)
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
		expect(f.provider.mutate).toHaveBeenCalledTimes(1)
		await expect(
			f.run("retract", { idempotencyKey: key(), reference }),
		).rejects.toMatchObject({ status: 409 })
		const latest = f.entries.at(-1)!,
			latestRef = await f.store.reference(a, latest)
		latest.memory += " Externally changed."
		await expect(
			f.run("retract", { idempotencyKey: key(), reference: latestRef }),
		).rejects.toMatchObject({ code: "stale_reference" })
	})
	it("never retries uncertain provider failures; keeps owner reads possible and writes blocked", async () => {
		const f = fixture(),
			input = { idempotencyKey: key(), content: "Durable fact" }
		f.provider.mutate = vi.fn(
			async (_p, _op, _input, _id, _operationId, _signal, context) => {
				await context.onDispatch({ action: "capture" })
				throw new Error("secret/content must not leak")
			},
		)
		await expect(f.run("capture", input)).rejects.toMatchObject({
			status: 502,
			message:
				"Write outcome unknown; check status and do not submit a new key",
		})
		expect(await f.run("capture", input)).toMatchObject({
			status: "unknown",
			searchable: false,
		})
		await expect(
			f.run("capture", { ...input, idempotencyKey: key() }),
		).rejects.toMatchObject({ status: 409 })
		expect(f.provider.mutate).toHaveBeenCalledTimes(1)
	})
	it("reports pending asynchronous mock responses without claiming searchability or redispatch", async () => {
		const f = fixture(),
			input = { idempotencyKey: key(), content: "Preference" }
		f.provider.mutate = vi.fn(
			async (_p, _op, _input, _id, _operationId, _signal, context) => {
				await context.onDispatch({ action: "capture" })
				return { status: "pending" as const }
			},
		)
		expect(await f.run("capture", input)).toMatchObject({
			status: "pending",
			searchable: false,
		})
		expect(await f.run("capture", input)).toMatchObject({
			status: "pending",
			searchable: false,
		})
		expect(f.provider.mutate).toHaveBeenCalledTimes(1)
	})
	it("propagates cancellation/deadlines and journals an ambiguous timeout accurately", async () => {
		const f = fixture(),
			abort = new AbortController(),
			input = { idempotencyKey: key(), content: "Preference" }
		f.provider.mutate = vi.fn(
			async (_p, _op, _input, _id, _operationId, signal, context) => {
				await context.onDispatch({ action: "capture" })
				abort.abort()
				signal.throwIfAborted()
				return { status: "applied" as const }
			},
		)
		await expect(
			f.run("capture", input, a, abort.signal),
		).rejects.toMatchObject({ status: 504 })
		expect(
			await f.run("status", { idempotencyKey: input.idempotencyKey }),
		).toMatchObject({ status: "unknown" })
	})
	it("rejects preflight failures without blocking later owner writes", async () => {
		const f = fixture(),
			input = { idempotencyKey: key(), content: "Preference" },
			mutate = f.provider.mutate
		f.provider.mutate = vi.fn(async () => {
			throw new Error("Preflight read failed")
		})
		await expect(f.run("capture", input)).rejects.toMatchObject({ status: 502 })
		expect(
			await f.run("status", { idempotencyKey: input.idempotencyKey }),
		).toMatchObject({
			status: "rejected",
			searchable: false,
		})
		f.provider.mutate = mutate
		expect(
			await f.run("capture", { ...input, idempotencyKey: key() }),
		).toMatchObject({
			status: "applied",
		})
	})
	it("passes the verified correction snapshot to the adapter", async () => {
		const f = fixture(),
			entry = f.entries[0]!
		entry.metadata = { brain_tags: ["topic_billing"], event_date: "2026-10-01" }
		const reference = await f.store.reference(a, entry)
		await f.run("correct", {
			idempotencyKey: key(),
			reference,
			content: "New responsibility",
		})
		expect(f.provider.mutate).toHaveBeenCalledWith(
			a,
			"correct",
			expect.anything(),
			entry.id,
			expect.any(String),
			expect.anything(),
			expect.objectContaining({
				current: entry,
				onDispatch: expect.any(Function),
			}),
		)
	})
	it("rejects cancellation during preflight before marking a memory dispatch", async () => {
		const f = fixture(),
			abort = new AbortController(),
			input = { idempotencyKey: key(), content: "Preference" },
			mutation = vi.fn()
		f.provider.mutate = async (
			_p,
			_op,
			_input,
			_id,
			_operationId,
			_signal,
			context,
		) => {
			abort.abort()
			await context.onDispatch({ action: "capture" })
			mutation()
			return { status: "applied" }
		}
		await expect(
			f.run("capture", input, a, abort.signal),
		).rejects.toMatchObject({
			status: 504,
		})
		expect(mutation).not.toHaveBeenCalled()
		expect(
			await f.run("status", { idempotencyKey: input.idempotencyKey }),
		).toMatchObject({
			status: "rejected",
		})
	})
	it("applies grant checks, quotas, strict payloads, global read limit and content-free audits", async () => {
		const f = fixture()
		let principal = a
		const deps: ExternalDependencies = {
			authenticate: async () => principal,
			quota: vi.fn(async () => {}),
			search: async () => ({
				results: [
					{
						id: "shared",
						memory: "Shared fictional knowledge.",
						similarity: 0.9,
					},
				],
			}),
			personalSearch: async (_input, owner) => ({
				results: f.entries
					.filter((r) => r.owner === owner.userId)
					.map((r) => ({ ...r, similarity: 0.8 })),
			}),
			personalStore: f.store,
			personalProvider: f.provider,
			listSkills: async () => [],
			loadSkill: async () => ({ error: "not_found" }),
			audit: vi.fn(),
		}
		const result = (await execute(deps, "search", {
			query: "ownership",
			limit: 1,
		})) as any
		expect(result.results).toHaveLength(1)
		expect(result.results[0]).toMatchObject({
			scope: "shared",
			editable: false,
		})
		principal = { ...a, grants: ["memory.shared:read"] }
		await expect(
			execute(deps, "capture", {
				idempotencyKey: key(),
				content: "private fact",
			}),
		).rejects.toMatchObject({ status: 403 })
		principal = { ...a, grants: ["memory.personal:write"] }
		await expect(
			execute(deps, "search", { query: "knowledge" }),
		).rejects.toMatchObject({ status: 403 })
		await execute(deps, "capture", {
			idempotencyKey: key(),
			content: "private fact",
		})
		expect(JSON.stringify((deps.audit as any).mock.calls)).not.toContain(
			"private fact",
		)
		deps.quota = async () => {
			throw new (await import("./errors")).ExternalError(
				"rate_limited",
				429,
				"Quota",
			)
		}
		await expect(
			execute(deps, "retract", { idempotencyKey: key(), reference: key() }),
		).rejects.toMatchObject({ status: 429 })
	})
	it("rejects scope overrides and oversized Unicode content without truncating a saved fact", () => {
		for (const extra of [
			{ userId: "b" },
			{ orgId: "other" },
			{ containerTag: "sm_org_shared" },
			{ filters: {} },
			{ sourceUrls: ["https://fabricated.invalid"] },
		])
			expect(
				captureSchema.safeParse({
					idempotencyKey: key(),
					content: "Fact",
					...extra,
				}).success,
			).toBe(false)
		expect(
			captureSchema.safeParse({
				idempotencyKey: key(),
				content: "😀".repeat(1025),
			}).success,
		).toBe(false)
		expect(
			correctSchema.safeParse({
				idempotencyKey: key(),
				reference: "provider-id",
				content: "Fact",
			}).success,
		).toBe(false)
	})
})
