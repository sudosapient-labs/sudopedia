import { afterEach, describe, expect, it, vi } from "vitest"
import Supermemory from "supermemory"
import { sqliteFixture } from "../../test/external/sqlite"
import { sharedStore, type PersonalEntry } from "./personal"
import { execute, type ExternalDependencies } from "./service"
import type { Principal } from "./contracts"
const holder = vi.hoisted(() => ({ client: null as Supermemory | null }))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => holder.client }))
import { sharedProvider, sharedSearchRequest } from "./dependencies"

const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); vi.restoreAllMocks() })
const admin: Principal = { orgId: "org", userId: "admin", credentialId: "admin-bot", kind: "employee",
	grants: ["memory.shared:read", "memory.shared:write"] }
function fixture(metadata: PersonalEntry["metadata"] = { memory_scope: "shared" }) {
	const f = sqliteFixture(); fixtures.push(f)
	const rows: PersonalEntry[] = [{ id: "old", memory: "Employees receive 20 vacation days.", updatedAt: "2026-10-01", forgetAfter: null, metadata }]
	const requests: { method: string; path: string; body: any }[] = []
	holder.client = new Supermemory({ apiKey: "fictional", fetch: async (url, init) => {
		const method = init?.method ?? "GET", path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined
		requests.push({ method, path, body })
		if (path === "/v3/container-tags/sm_org_shared") return Response.json({ containerTag: "sm_org_shared" })
		if (path === "/v4/search") {
			expect(body.containerTag).toBe("sm_org_shared")
			return Response.json({ results: [...rows.filter((r) => !r.isForgotten && r.isLatest !== false),
				...(body.searchMode === "hybrid" ? [{ id: "source", chunk: "Employees receive 20 vacation days." }] : [])], total: 1, timing: 1 })
		}
		if (path === "/v4/memories/list") {
			expect(body.containerTags).toEqual(["sm_org_shared"])
			return Response.json({ memoryEntries: rows, pagination: { totalPages: 1 } })
		}
		if (path === "/v4/memories" && method === "PATCH") {
			const current = rows.find((r) => r.id === body.id)!; current.isLatest = false
			const next = { id: crypto.randomUUID(), memory: body.newContent, updatedAt: new Date().toISOString(), metadata: body.metadata, forgetAfter: body.forgetAfter }
			rows.push(next); return Response.json({ ...next, parentMemoryId: current.id })
		}
		if (path === "/v4/memories" && method === "DELETE") {
			rows.find((r) => r.id === body.id)!.isForgotten = true
			return Response.json({ id: body.id, forgotten: true })
		}
		if (path === "/v4/memories" && method === "POST") return Response.json({ memories: [{ id: "captured", forgetAfter: null }] })
		throw new Error("Unexpected fictional SDK request")
	} })
	const store = sharedStore(f.env)
	const deps: ExternalDependencies = { authenticate: async () => admin, quota: async () => {},
		search: (input, signal) => holder.client!.search.memories(sharedSearchRequest(input), { signal, maxRetries: 0 }),
		sharedStore: store, sharedProvider: sharedProvider(f.env), listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }) }
	const run = (op: Parameters<typeof execute>[1], input: unknown) => execute(deps, op, input) as Promise<any>
	return { ...f, rows, requests, store, run, deps }
}

describe("shared current-fact journey through production SQL and SDK wire (fictional provider)", () => {
	it("corrects and retracts current knowledge without treating unchanged historical chunks as current truth", async () => {
		const f = fixture({ memory_scope: "shared", sources: ["https://fictional.invalid/policy"], brain_tags: ["topic_vacation"], event_date: "2026-10-01" })
		const search = () => f.run("search", { query: "vacation", scope: "shared" })
		const first = await search()
		expect(first.results[0]).toMatchObject({ recall: "current", editable: true })
		const key = crypto.randomUUID()
		expect(await f.run("correct", { scope: "shared", idempotencyKey: key, reference: first.results[0].reference, content: "Employees receive 25 vacation days." }))
			.toMatchObject({ status: "applied", scope: "shared" })
		const next = await search()
		expect(next.results.map((r: any) => r.text)).toEqual(["Employees receive 25 vacation days."])
		expect(f.requests.find((r) => r.method === "PATCH")?.body).toMatchObject({ containerTag: "sm_org_shared", forgetAfter: null,
			metadata: { ...f.rows[0]!.metadata, external_actor: "admin", external_org: "org" } })
		await expect(f.run("retract", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference: first.results[0].reference })).rejects.toMatchObject({ code: "stale_reference" })
		expect(await f.run("retract", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference: next.results[0].reference })).toMatchObject({ status: "applied", searchable: false })
		expect((await search()).results).toHaveLength(0)
		const historical = await f.run("search", { query: "vacation", scope: "shared", recall: "historical" })
		expect(historical.results).toMatchObject([{ text: "Employees receive 20 vacation days.", recall: "historical", editable: false }])
		expect(historical.results[0]).not.toHaveProperty("reference")
	})
	it.each([null, { nested: "secret" }, ["source", 2]])("rejects incompatible shared metadata %j before dispatch without locking later writes", async (value) => {
		const f = fixture({ memory_scope: "shared", confidence: value }), reference = await f.store.reference(admin, f.rows[0]!)
		const dispatch = vi.spyOn(f.store, "dispatch")
		await expect(f.run("correct", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference, content: "25 days" })).rejects.toMatchObject({ code: "unsupported_metadata" })
		expect(dispatch).not.toHaveBeenCalled()
		expect(f.requests.some((r) => r.path === "/v4/memories")).toBe(false)
		expect(await f.run("capture", { scope: "shared", idempotencyKey: crypto.randomUUID(), content: f.rows[0]!.memory })).toMatchObject({ status: "applied" })
		expect(dispatch).not.toHaveBeenCalled() // permanent repeat does not PATCH metadata
		expect(await f.run("retract", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference })).toMatchObject({ status: "applied" })
	})
	it.each([{ memory_scope: "personal" }, { memory_scope: "shared", external_org: "other" }])("fails closed on scope/org-mistagged verified targets %j", async (metadata) => {
		const f = fixture(metadata), reference = await f.store.reference(admin, f.rows[0]!)
		expect((await f.run("search", { query: "vacation", scope: "shared" })).results).toHaveLength(0)
		await expect(f.run("retract", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference })).rejects.toMatchObject({ code: "stale_reference" })
		expect(f.requests.some((r) => r.path === "/v4/memories")).toBe(false)
	})
	it("preserves legacy shared hybrid recall unless current recall is explicitly requested", async () => {
		const f = fixture(); f.deps.authenticate = async () => ({ ...admin, kind: undefined, grants: ["memory.shared:read"] })
		expect((await f.run("search", { query: "vacation" })).results).toHaveLength(2)
		expect((await f.run("search", { query: "vacation", recall: "current" })).results).toHaveLength(1)
	})
})
