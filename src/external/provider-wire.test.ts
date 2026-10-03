import { describe, expect, it, vi } from "vitest"
import Supermemory from "supermemory"
const holder = vi.hoisted(() => ({ client: null as Supermemory | null }))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => holder.client }))
import { personalProvider, PERSONAL_BOOTSTRAP } from "./dependencies"
import type { Principal } from "./contracts"

const owner: Principal = { orgId: "fictional", userId: "new-employee", credentialId: "fictional-bot", grants: ["memory.personal:write"] }
describe("actual SDK wire contracts against fictional fetch responses", () => {
	it("creates a missing namespace through SuperRAG before direct durable CRUD, never settings PATCH", async () => {
		let exists = false
		const requests: Array<{ method: string; path: string; body: any }> = []
		holder.client = new Supermemory({ apiKey: "fictional-test-key", fetch: async (url, init) => {
			const method = init?.method ?? "GET", path = new URL(String(url)).pathname
			const body = init?.body ? JSON.parse(String(init.body)) : undefined
			requests.push({ method, path, body })
			if (method === "GET") return exists ? Response.json({ containerTag: "user_new-employee" }) :
				Response.json({ error: "Container tag not found" }, { status: 404 })
			if (path === "/v3/documents" && method === "POST") {
				expect(body).toMatchObject({ content: PERSONAL_BOOTSTRAP, taskType: "superrag", containerTag: "user_new-employee" })
				expect(body.content).not.toContain("concise summaries")
				exists = true
				return Response.json({ id: "bootstrap", status: "queued" })
			}
			if (path === "/v4/search") return Response.json({ results: [], total: 0, timing: 1 })
			if (path === "/v4/memories" && method === "POST")
				return Response.json({ documentId: "source", memories: [{ id: "fact", memory: body.memories[0].content, forgetAfter: null }] }, { status: 201 })
			throw new Error("Unexpected fictional wire request")
		} })
		const dispatch = vi.fn(async () => {})
		expect(await personalProvider({} as Env).mutate(owner, "capture", {
			idempotencyKey: crypto.randomUUID(), content: "Employee prefers concise summaries.",
		}, undefined, "op", new AbortController().signal, { onDispatch: dispatch })).toEqual({ status: "applied" })
		expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
			"GET /v3/container-tags/user_new-employee", "POST /v3/documents",
			"GET /v3/container-tags/user_new-employee", "POST /v4/search", "POST /v4/memories",
		])
		expect(requests.at(-1)?.body.memories[0].forgetAfter).toBeNull()
		expect(dispatch).toHaveBeenCalledTimes(1)
	})
	it("sends explicit expiry clearing and identifiable retraction through the SDK", async () => {
		const requests: any[] = []
		holder.client = new Supermemory({ apiKey: "fictional-test-key", fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body))
			requests.push(body)
			return init?.method === "PATCH" ? Response.json({ id: "new", parentMemoryId: "old", forgetAfter: body.forgetAfter }) :
				Response.json({ id: "old", forgotten: true })
		} })
		const context = { onDispatch: vi.fn(async () => {}), current: {
			id: "old", memory: "Old fact", updatedAt: "2026-10-01", forgetAfter: "2099-01-01T00:00:00Z",
			metadata: { sources: ["https://fictional.invalid/source"], event_date: "2026-10-01" },
		} }
		const provider = personalProvider({} as Env)
		await provider.mutate(owner, "correct", { idempotencyKey: crypto.randomUUID(), content: "New fact" },
			"old", "correction-id", new AbortController().signal, context)
		await provider.mutate(owner, "retract", { idempotencyKey: crypto.randomUUID(), reference: crypto.randomUUID() },
			"old", "retraction-id", new AbortController().signal, context)
		expect(requests[0]).toMatchObject({ forgetAfter: null, metadata: context.current.metadata })
		expect(requests[1]).toMatchObject({ id: "old", containerTag: "user_new-employee", reason: "Employee retraction; external_operation=retraction-id" })
	})
})
