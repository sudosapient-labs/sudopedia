import { afterEach, describe, expect, it, vi } from "vitest"
import Supermemory from "supermemory"
import { sqliteFixture } from "../../test/external/sqlite"
import { privateChannelSearch } from "./private-channels"
import { execute, type ExternalDependencies } from "./service"
import type { Principal } from "./contracts"

const holder = vi.hoisted(() => ({ client: null as Supermemory | null }))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => holder.client }))
vi.mock("@/lib/crypto", () => ({ decryptToken: async () => "fictional-token" }))
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); vi.restoreAllMocks() })
const actor: Principal = { orgId: "org", userId: "a", credentialId: "bot", kind: "employee",
	grants: ["memory.private-channel:read"] }
const valid = { id: "private", memory: "Fictional ingested fact", similarity: 1,
	metadata: { memory_scope: "private_channel" }, updatedAt: "2026-10-05" }

function fixture(channels = 1, memberPage = (_channel: string) => 1) {
	const f = sqliteFixture(); fixtures.push(f)
	f.sqlite.exec(`INSERT INTO slack_workspace(team_id,org_id,bot_token_enc,bot_user_id,scopes,created_at,updated_at)
		VALUES ('T1','org','encrypted','UBOT','groups:read,users:read,team:read',1,1);
		INSERT INTO slack_workspace_member(team_id,slack_user_id,org_id,user_id,created_at,updated_at)
		VALUES ('T1','U1','org','a',1,1);`)
	const slackFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		init?.signal?.throwIfAborted()
		const url = new URL(String(input)), method = url.pathname.split("/").at(-1)
		if (method === "auth.test") return Response.json({ ok: true, team_id: "T1", user_id: "UBOT" })
		if (method === "users.info") return Response.json({ ok: true, user: { id: "U1", team_id: "T1", deleted: false, is_bot: false } })
		if (method === "conversations.list") return Response.json({ ok: true,
			channels: Array.from({ length: channels }, (_, i) => ({ id: `C${i + 1}`, is_private: true, is_archived: false })) })
		const page = Number(url.searchParams.get("cursor") ?? 1)
		return Response.json(page === memberPage(url.searchParams.get("channel")!) ? { ok: true, members: ["U1"] } :
			{ ok: true, members: ["UBOT"], response_metadata: { next_cursor: String(page + 1) } })
	})
	const deps: ExternalDependencies = { authenticate: async () => actor, quota: async () => {}, search: async () => ({ results: [] }),
		privateSearch: (input, p, signal) => privateChannelSearch(f.env, input, p, signal, { slackFetch }),
		listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }) }
	const run = () => execute(deps, "search", { query: "fact", scope: "private_channel", limit: 5 }) as Promise<any>
	return { ...f, run, slackFetch }
}
function provider(fetcher: typeof fetch) {
	holder.client = new Supermemory({ apiKey: "fictional", fetch: fetcher })
}
function wire(body: unknown) {
	const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		expect(new URL(String(url)).pathname).toBe("/v4/search")
		expect(JSON.parse(String(init?.body))).toMatchObject({ searchMode: "memories", containerTag: expect.stringMatching(/^slack_channel_C\d+$/) })
		return Response.json(body)
	})
	provider(fetcher)
	return fetcher
}

describe("private recall through production SQL and SDK wire (fictional providers)", () => {
	it.each([
		["null row", { results: [null] }],
		["mixed valid/invalid rows", { results: [valid, { ...valid, memory: 123 }] }],
		["missing results", {}],
		["non-array results", { results: {} }],
		["missing memory", { results: [{ id: "bad", similarity: 1 }] }],
		["historical chunk", { results: [{ id: "bad", chunk: "Historical source", similarity: 1 }] }],
		["memory with chunk", { results: [{ ...valid, chunk: "Historical source" }] }],
		["invalid ID", { results: [{ ...valid, id: 123 }] }],
		["empty ID", { results: [{ ...valid, id: "" }] }],
		["oversized ID", { results: [{ ...valid, id: "x".repeat(201) }] }],
		["invalid similarity", { results: [{ ...valid, similarity: "1" }] }],
		["missing similarity", { results: [{ id: "bad", memory: "Fact" }] }],
		["nonfinite similarity", { results: [{ ...valid, similarity: Infinity }] }],
		["invalid metadata", { results: [{ ...valid, metadata: [] }] }],
		["invalid date shape", { results: [{ ...valid, updatedAt: 123 }] }],
		["too many rows", { results: Array.from({ length: 6 }, () => valid) }],
	])("fails closed on %s, without retries or leaking provider content", async (_name, body) => {
		const f = fixture(), fetcher = wire(body)
		const error = await f.run().catch((error: unknown) => error)
		expect(error).toMatchObject({ code: "private_access_unverified", status: 503 })
		expect(String(error)).not.toContain(valid.memory)
		expect(fetcher).toHaveBeenCalledTimes(1)
	})
	it("preserves legitimate empty and valid results, with no edit references", async () => {
		const f = fixture()
		wire({ results: [] }); expect(await f.run()).toMatchObject({ results: [], truncated: false })
		wire({ results: [valid] })
		const result = await f.run()
		expect(result.results).toMatchObject([{ text: valid.memory, scope: "private_channel", editable: false, score: 1 }])
		expect(result.results[0]).not.toHaveProperty("reference")
		wire({ results: [{ ...valid, metadata: null }] }); expect((await f.run()).results).toHaveLength(1)
	})
	it("aborts an outstanding SDK sibling when another channel has malformed rows", async () => {
		const f = fixture(2)
		let started!: () => void, aborted = false
		const siblingStarted = new Promise<void>((resolve) => { started = resolve })
		provider(async (_url, init) => {
			const tag = JSON.parse(String(init?.body)).containerTag
			if (tag === "slack_channel_C1") {
				await siblingStarted
				return Response.json({ results: [null] })
			}
			return new Promise<Response>((_resolve, reject) => {
				init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason) }, { once: true })
				started()
			})
		})
		await expect(f.run()).rejects.toMatchObject({ code: "private_access_unverified" })
		expect(aborted).toBe(true)
	})
	it("never returns a valid sibling's results when another channel is malformed", async () => {
		const f = fixture(2)
		provider(async (_url, init) => Response.json({ results: JSON.parse(String(init?.body)).containerTag === "slack_channel_C1" ? [valid] : [null] }))
		await expect(f.run()).rejects.toMatchObject({ code: "private_access_unverified" })
	})
	it("allows exactly 40 private outbound calls including reserved SDK searches", async () => {
		const f = fixture(18, (channel) => channel === "C1" ? 2 : 1), fetcher = wire({ results: [] })
		expect(await f.run()).toMatchObject({ results: [], truncated: false })
		expect(f.slackFetch.mock.calls.length + fetcher.mock.calls.length).toBe(40)
		expect(fetcher).toHaveBeenCalledTimes(18)
	})
	it.each([[19, 1], [20, 2]])("denies %i-channel/%i-page coverage before dispatching any provider searches", async (channels, pages) => {
		const f = fixture(channels, () => pages), fetcher = wire({ results: [] })
		await expect(f.run()).rejects.toMatchObject({ code: "private_access_incomplete", status: 503 })
		expect(fetcher).not.toHaveBeenCalled()
		expect(f.slackFetch.mock.calls.length).toBeLessThanOrEqual(40)
	})
})
