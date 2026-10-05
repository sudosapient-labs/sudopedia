import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../test/external/sqlite"
import { livePrivateChannels, privateChannelSearch } from "./private-channels"
import { execute, type ExternalDependencies } from "./service"
import type { Principal } from "./contracts"
const provider = vi.hoisted(() => ({ search: { memories: vi.fn() } }))
vi.mock("agents", () => ({ getAgentByName: vi.fn() }))
vi.mock("../memory/client", () => ({ memoryClient: () => provider }))
vi.mock("@/lib/crypto", () => ({ decryptToken: async () => "fictional-token" }))

const identity = { teamId: "T1", slackUserId: "U1", botUserId: "UBOT", scopes: "groups:read,users:read,team:read" }
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const signal = () => new AbortController().signal
function slack(handler?: (method: string, url: URL, init: RequestInit | undefined) => unknown) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input)), method = url.pathname.split("/").at(-1)!
		init?.signal?.throwIfAborted()
		const overridden = await handler?.(method, url, init)
		if (overridden instanceof Response) return overridden
		return Response.json(overridden ?? (method === "auth.test" ? { ok: true, team_id: "T1", user_id: "UBOT" } :
			method === "users.info" ? { ok: true, user: { id: "U1", team_id: "T1", deleted: false, is_bot: false } } :
			method === "conversations.list" ? { ok: true, channels: [{ id: "C1", is_private: true, is_archived: false }] } :
			{ ok: true, members: ["U1", "UBOT"] }))
	}) as typeof fetch & ReturnType<typeof vi.fn>
}
function fixture() {
	const f = sqliteFixture(); fixtures.push(f)
	f.sqlite.exec(`INSERT INTO slack_workspace(team_id,org_id,bot_token_enc,bot_user_id,scopes,created_at,updated_at)
		VALUES ('T1','org','encrypted','UBOT','groups:read,users:read,team:read',1,1);
		INSERT INTO slack_workspace_member(team_id,slack_user_id,org_id,user_id,created_at,updated_at)
		VALUES ('T1','U1','org','a',1,1);`)
	provider.search.memories.mockReset().mockResolvedValue({ results: [{ id: "private", memory: "Ingested private fact", similarity: 1,
		metadata: { memory_scope: "private_channel" } }] })
	return f
}
const actor: Principal = { orgId: "org", userId: "a", credentialId: "bot", kind: "employee", grants: ["memory.private-channel:read"] }

describe("strict live private-channel evidence", () => {
	it("requires live employee membership on every call; bot-only access and admin role do not authorize", async () => {
		let members = ["U1", "UBOT"]
		const fetcher = slack((m) => m === "conversations.members" ? { ok: true, members } : undefined)
		expect(await livePrivateChannels("token", identity, signal(), fetcher)).toEqual(["C1"])
		members = ["UBOT"]
		expect(await livePrivateChannels("token", identity, signal(), fetcher)).toEqual([])
		expect(fetcher.mock.calls.filter(([url]: any[]) => String(url).includes("conversations.members"))).toHaveLength(2)
		await expect(livePrivateChannels("token", { ...identity, slackUserId: "UBOT" }, signal(), fetcher)).rejects.toMatchObject({ code: "private_access_unverified" })
	})
	it("paginates discovery and membership, including empty pages with cursors", async () => {
		const fetcher = slack((m, u) => {
			if (m === "conversations.list") return { ok: true, channels: u.searchParams.has("cursor") ?
				[{ id: "C1", is_private: true, is_archived: false }] : [], response_metadata: { next_cursor: u.searchParams.has("cursor") ? "" : "next" } }
			if (m === "conversations.members") return { ok: true, members: u.searchParams.has("cursor") ? ["U1"] : ["UBOT"],
				response_metadata: { next_cursor: u.searchParams.has("cursor") ? "" : "next" } }
		})
		expect(await livePrivateChannels("token", identity, signal(), fetcher)).toEqual(["C1"])
		expect(fetcher.mock.calls).toHaveLength(6)
	})
	it.each(["auth.test", "users.info", "conversations.list", "conversations.members"])("fails closed and sanitizes %s errors, never returning partial results", async (method) => {
		for (const response of [Response.json({ ok: false, error: "secret-sensitive-channel" }), new Response("bad JSON"), new Response("secret", { status: 429 })]) {
			const fetcher = slack((m) => m === method ? response : undefined)
			await expect(livePrivateChannels("secret-token", identity, signal(), fetcher)).rejects.toMatchObject({ code: "private_access_unverified", status: 503 })
		}
	})
	it.each([
		{ method: "auth.test", data: { ok: true, team_id: "T2", user_id: "UBOT" } },
		{ method: "auth.test", data: { ok: true, team_id: "T1", user_id: "UOTHERBOT" } },
		{ method: "users.info", data: { ok: true, user: { id: "U1", team_id: "T2", is_bot: false, deleted: false } } },
		{ method: "users.info", data: { ok: true, user: { id: "U1", team_id: "T1", is_bot: true, deleted: false } } },
		{ method: "users.info", data: { ok: true, user: { id: "U1", team_id: "T1", is_bot: false, deleted: true } } },
	])("rejects foreign workspace, wrong token or inactive/bot identity %j", async ({ method, data }) => {
		await expect(livePrivateChannels("token", identity, signal(), slack((m) => m === method ? data : undefined))).rejects.toMatchObject({ status: 503 })
	})
	it("rejects missing scopes, malformed identities and oversized responses", async () => {
		for (const bad of [{ ...identity, scopes: "users:read" }, { ...identity, teamId: "bad" }, { ...identity, slackUserId: "" }])
			await expect(livePrivateChannels("token", bad, signal(), slack())).rejects.toMatchObject({ status: 503 })
		await expect(livePrivateChannels("token", identity, signal(), slack(() => new Response("x".repeat(256 * 1024 + 1)))))
			.rejects.toMatchObject({ status: 503 })
	})
	it.each(["channel-pages", "channel-cap", "member-pages", "repeated-cursor"])("reports incomplete %s coverage, never a complete empty search", async (reason) => {
		const fetcher = slack((m, u) => {
			if (m === "conversations.list" && reason === "channel-pages") return { ok: true, channels: [], response_metadata: { next_cursor: `page-${u.searchParams.get("cursor") ?? "0"}` } }
			if (m === "conversations.list" && reason === "channel-cap") return { ok: true, channels: Array.from({ length: 21 }, (_, i) => ({ id: `C${i}`, is_private: true, is_archived: false })) }
			if (m === "conversations.members") return { ok: true, members: ["UBOT"], response_metadata: { next_cursor: reason === "repeated-cursor" ? "same" : `next-${u.searchParams.get("cursor") ?? "0"}` } }
		})
		await expect(livePrivateChannels("token", identity, signal(), fetcher)).rejects.toMatchObject({ code: "private_access_incomplete" })
	})
	it("propagates cancellation to live calls and never continues with cached evidence", async () => {
		const controller = new AbortController()
		const fetcher = slack((m, _u, init) => {
			if (m === "conversations.members") {
				controller.abort(); init?.signal?.throwIfAborted()
			}
		})
		await expect(livePrivateChannels("token", identity, controller.signal, fetcher)).rejects.toMatchObject({ status: 503 })
		const before = fetcher.mock.calls.length
		await expect(livePrivateChannels("token", identity, controller.signal, fetcher)).rejects.toMatchObject({ status: 503 })
		expect(fetcher.mock.calls).toHaveLength(before)
	})
	it("bounds membership concurrency to two", async () => {
		let active = 0, peak = 0
		const fetcher = slack(async (m, _u, init) => {
			if (m === "conversations.list") return { ok: true, channels: ["C1", "C2", "C3"].map((id) => ({ id, is_private: true, is_archived: false })) }
			if (m === "conversations.members") {
				active++; peak = Math.max(peak, active)
				await new Promise<void>((r) => setTimeout(r, 5)); init?.signal?.throwIfAborted(); active--
			}
		})
		expect(await livePrivateChannels("token", identity, signal(), fetcher)).toEqual(["C1", "C2", "C3"])
		expect(peak).toBe(2)
	})
	it("cancels an outstanding sibling when another channel's verification fails", async () => {
		let cancelled = false
		const fetcher = slack(async (m, u, init) => {
			if (m === "conversations.list") return { ok: true, channels: ["C1", "C2"].map((id) => ({ id, is_private: true, is_archived: false })) }
			if (m === "conversations.members" && u.searchParams.get("channel") === "C1") {
				await new Promise<void>((r) => setTimeout(r, 5)); return { ok: false, error: "denied" }
			}
			if (m === "conversations.members") await new Promise((_resolve, reject) => {
				init!.signal!.addEventListener("abort", () => { cancelled = true; reject(init!.signal!.reason) }, { once: true })
			})
		})
		await expect(livePrivateChannels("token", identity, signal(), fetcher)).rejects.toMatchObject({ status: 503 })
		expect(cancelled).toBe(true)
	})
	it("ends stalled Slack verification at its eight-second deadline", async () => {
		vi.useFakeTimers()
		const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const timer = new AbortController(); setTimeout(() => timer.abort(), ms); return timer.signal
		})
		const fetcher = slack(async (_m, _u, init) => {
			await new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }))
		})
		const call = livePrivateChannels("token", identity, signal(), fetcher)
		const assertion = expect(call).rejects.toMatchObject({ code: "private_access_unverified" })
		// Only replace native timer scheduling; verify production requests 8000 ms.
		expect(timeout).toHaveBeenCalledWith(8000)
		await vi.advanceTimersByTimeAsync(8000); await assertion
	})
})

describe("server-derived private search and scope permissions", () => {
	it("reads only ingested permitted channel containers, stays read-only and denies after live membership removal", async () => {
		const f = fixture(); let members = ["U1", "UBOT"]
		vi.stubGlobal("fetch", slack((m) => m === "conversations.members" ? { ok: true, members } : undefined))
		const deps: ExternalDependencies = { authenticate: async () => actor, quota: async () => {}, search: async () => ({ results: [] }),
			privateSearch: (input, p, signal) => privateChannelSearch(f.env, input, p, signal),
			listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }) }
		const result = await execute(deps, "search", { query: "fact", scope: "private_channel" }) as any
		expect(result.results).toMatchObject([{ scope: "private_channel", editable: false, text: "Ingested private fact" }])
		expect(result.results[0]).not.toHaveProperty("reference")
		expect(provider.search.memories.mock.calls[0]![0]).toMatchObject({ containerTag: "slack_channel_C1", searchMode: "memories" })
		members = ["UBOT"]
		expect((await execute(deps, "search", { query: "fact" }) as any).results).toHaveLength(0)
		expect(provider.search.memories).toHaveBeenCalledTimes(1)
		for (const extra of [{ channelId: "CSECRET" }, { slackUserId: "U2" }, { teamId: "T2" }, { filters: {} }, { orgId: "other" }])
			await expect(execute(deps, "search", { query: "fact", ...extra })).rejects.toMatchObject({ status: 400 })
		await expect(execute({ ...deps, authenticate: async () => ({ ...actor, grants: ["memory.shared:read"] }) }, "search", { query: "fact", scope: "private_channel" }))
			.rejects.toMatchObject({ status: 403 })
	})
	it.each(["missing", "other-org", "other-workspace", "inactive", "deleted", "removed-member", "ambiguous"])("denies %s identity mappings before provider access", async (reason) => {
		const f = fixture(), fetcher = slack(); vi.stubGlobal("fetch", fetcher)
		if (reason === "missing") f.sqlite.exec("DELETE FROM slack_workspace_member")
		if (reason === "other-org") f.sqlite.exec("INSERT INTO organization(id,name,slug,created_at) VALUES ('other','Other','other',1); UPDATE slack_workspace_member SET org_id='other'")
		if (reason === "other-workspace") f.sqlite.exec("INSERT INTO slack_workspace(team_id,org_id,bot_token_enc,created_at,updated_at) VALUES ('T2','org','encrypted',1,1); UPDATE slack_workspace_member SET team_id='T2'")
		if (reason === "inactive") f.sqlite.exec("UPDATE slack_workspace_member SET status='inactive'")
		if (reason === "deleted") f.sqlite.exec("UPDATE user SET deleted=1 WHERE id='a'")
		if (reason === "removed-member") f.sqlite.exec("DELETE FROM member WHERE user_id='a'")
		if (reason === "ambiguous") f.sqlite.exec("INSERT INTO slack_workspace_member(team_id,slack_user_id,org_id,user_id,created_at,updated_at) VALUES ('T1','U2','org','a',1,1)")
		await expect(privateChannelSearch(f.env, { query: "fact", limit: 5 }, actor, signal())).rejects.toMatchObject({ status: 503 })
		expect(provider.search.memories).not.toHaveBeenCalled()
	})
	it("bounds channel-search concurrency and global Unicode output; provider errors never become an empty result", async () => {
		const f = fixture(); let active = 0, peak = 0
		vi.stubGlobal("fetch", slack((m) => m === "conversations.list" ? { ok: true,
			channels: ["C1", "C2", "C3"].map((id) => ({ id, is_private: true, is_archived: false })) } : undefined))
		provider.search.memories.mockImplementation(async (request) => {
			active++; peak = Math.max(peak, active)
			await new Promise<void>((r) => setTimeout(r, 5)); active--
			return { results: Array.from({ length: 20 }, (_, i) => ({ id: `${request.containerTag}-${i}`, memory: "😀".repeat(3000), similarity: 1 })) }
		})
		const deps: ExternalDependencies = { authenticate: async () => actor, quota: async () => {}, search: async () => ({ results: [] }),
			privateSearch: (input, p, signal) => privateChannelSearch(f.env, input, p, signal),
			listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }) }
		const result = await execute(deps, "search", { query: "fact", limit: 20 }) as any
		expect(peak).toBe(2); expect(result.truncated).toBe(true)
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(28 * 1024)
		provider.search.memories.mockRejectedValue(new Error("SECRET_PROVIDER_ERROR"))
		await expect(execute(deps, "search", { query: "fact" })).rejects.toMatchObject({ code: "private_access_unverified" })
	})
})
