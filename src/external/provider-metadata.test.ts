import { afterEach, describe, expect, it, vi } from "vitest"
import Supermemory from "supermemory"
import { sqliteFixture } from "../../test/external/sqlite"
import type { Principal } from "./contracts"
import { maintainPersonal, personalStore, type PersonalEntry } from "./personal"

const holder = vi.hoisted(() => ({ client: null as Supermemory | null }))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => holder.client }))
import { personalProvider } from "./dependencies"

const owner: Principal = { orgId: "org", userId: "a", credentialId: "fictional-bot", grants: ["memory.personal:write"] }
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); vi.restoreAllMocks() })
const signal = () => new AbortController().signal
function fixture(metadata: PersonalEntry["metadata"], permanent = false) {
	const f = sqliteFixture(); fixtures.push(f)
	const entry: PersonalEntry = { id: "old", memory: "Employee owns onboarding", updatedAt: "2026-10-01",
		isLatest: true, isForgotten: false, forgetAfter: permanent ? null : "2099-01-01T00:00:00Z", metadata }
	const requests: { path: string; method: string; body: any }[] = []
	holder.client = new Supermemory({ apiKey: "fictional-key", fetch: async (url, init) => {
		const path = new URL(String(url)).pathname, method = init?.method ?? "GET"
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		requests.push({ path, method, body })
		if (path === "/v3/container-tags/user_a") return Response.json({ containerTag: "user_a" })
		if (path === "/v4/search") return Response.json({ results: body.q === entry.memory ? [entry] : [], total: 0, timing: 1 })
		if (path === "/v4/memories/list") return Response.json({ memoryEntries: [entry], pagination: { totalPages: 1 } })
		if (path === "/v4/memories" && method === "PATCH") {
			// Independently mirrors the published PATCH value types, not the app validator.
			const valid = Object.values(body.metadata).every((value) =>
				typeof value === "string" || typeof value === "number" || typeof value === "boolean" ||
				(Array.isArray(value) && value.every((item) => typeof item === "string")))
			if (!valid) return Response.json({ error: "Invalid metadata" }, { status: 400 })
			return Response.json({ id: "new", parentMemoryId: "old", forgetAfter: body.forgetAfter })
		}
		if (path === "/v4/memories" && method === "POST")
			return Response.json({ memories: [{ id: "captured", forgetAfter: null }] }, { status: 201 })
		if (path === "/v4/memories" && method === "DELETE") return Response.json({ id: "old", forgotten: true })
		throw new Error("Unexpected fictional provider request")
	} })
	const store = personalStore(f.env), provider = personalProvider(f.env)
	const dispatch = vi.spyOn(store, "dispatch")
	const run = (operation: "capture" | "correct" | "retract" | "status", input: Parameters<typeof maintainPersonal>[4]) =>
		maintainPersonal(store, provider, owner, operation, input, signal())
	return { ...f, entry, requests, store, dispatch, run }
}

describe("provider metadata preflight with production SQL and installed SDK (fictional fetch)", () => {
	for (const operation of ["correct", "capture"] as const) {
		it.each([null, { nested: "fictional-sensitive-value" }, ["source", 42]])(
			`${operation} rejects incompatible metadata %j without dispatch, data loss or an owner lock`, async (value) => {
				const f = fixture({ confidence: value, sources: ["https://example.invalid/source"] })
				const before = JSON.stringify(f.entry), reference = await f.store.reference(owner, f.entry)
				const input = { idempotencyKey: crypto.randomUUID(), content: operation === "capture" ? f.entry.memory : "Employee now owns billing",
					...(operation === "correct" ? { reference } : {}) }
				await expect(f.run(operation, input)).rejects.toMatchObject({ code: "unsupported_metadata", status: 409 })
				expect(f.dispatch).not.toHaveBeenCalled()
				expect(f.requests.some((r) => r.path === "/v4/memories")).toBe(false)
				expect(JSON.stringify(f.entry)).toBe(before)
				expect(await f.run("status", input)).toMatchObject({ status: "rejected", searchable: false })
				expect(f.sqlite.prepare("SELECT phase,provider_action,state FROM external_memory_operation").get()).toEqual({
					phase: "preflight", provider_action: null, state: "rejected",
				})
				const requestCount = f.requests.length
				expect(await f.run(operation, input)).toMatchObject({ status: "rejected" })
				expect(f.requests).toHaveLength(requestCount)
				await expect(f.run(operation, { ...input, content: "Different payload" })).rejects.toMatchObject({ code: "idempotency_conflict" })
				expect(await f.run("capture", { idempotencyKey: crypto.randomUUID(), content: "An unrelated durable fact" })).toMatchObject({ status: "applied" })
				expect(f.dispatch).toHaveBeenCalledTimes(1)
			},
		)
	}
	it("retains every supported metadata value while refreshing provenance and explicit event dates", async () => {
		const metadata = { sources: ["https://example.invalid/source"], brain_tags: ["topic_onboarding"],
			event_date: "2026-10-01", confidence: 0, confirmed: false, note: "", empty: [], memory_scope: "dm" }
		const f = fixture(metadata), reference = await f.store.reference(owner, f.entry)
		expect(await f.run("correct", { idempotencyKey: crypto.randomUUID(), reference,
			content: "Employee now owns billing", eventDate: "2026-10-04" })).toMatchObject({ status: "applied" })
		expect(f.requests.find((r) => r.method === "PATCH")?.body.metadata).toMatchObject({
			...metadata, memory_scope: "personal", event_date: "2026-10-04", external_integration: owner.credentialId,
		})
		expect(f.entry.metadata).toEqual(metadata)
		expect(f.dispatch).toHaveBeenCalledTimes(1)
	})
	it.each([null, undefined])("accepts absent metadata %s without losing provenance", async (metadata) => {
		const f = fixture(metadata), reference = await f.store.reference(owner, f.entry)
		expect(await f.run("correct", { idempotencyKey: crypto.randomUUID(), reference, content: "Employee now owns billing" })).toMatchObject({ status: "applied" })
		expect(f.requests.find((r) => r.method === "PATCH")?.body.metadata).toMatchObject({ memory_scope: "personal", source_type: "external-primary-bot" })
	})
	it("leaves permanent exact-text no-ops usable even with metadata that cannot be PATCHed", async () => {
		const f = fixture({ confidence: null }, true)
		expect(await f.run("capture", { idempotencyKey: crypto.randomUUID(), content: f.entry.memory })).toMatchObject({ status: "applied" })
		expect(f.dispatch).not.toHaveBeenCalled()
		expect(f.requests.some((r) => r.path === "/v4/memories")).toBe(false)
	})
	it("still permits specific retraction of an entry with incompatible correction metadata", async () => {
		const f = fixture({ confidence: null }), reference = await f.store.reference(owner, f.entry)
		expect(await f.run("retract", { idempotencyKey: crypto.randomUUID(), reference })).toMatchObject({ status: "applied" })
		expect(f.requests.find((r) => r.method === "DELETE")?.body).not.toHaveProperty("metadata")
		expect(f.dispatch).toHaveBeenCalledTimes(1)
	})
})
