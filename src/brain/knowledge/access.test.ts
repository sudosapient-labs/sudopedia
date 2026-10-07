import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../../test/external/sqlite"
import { knowledgeAccess } from "./access"
import type { Principal } from "../../external/contracts"
import type { KnowledgeSource } from "./types"
vi.mock("@/lib/crypto", () => ({ decryptToken: async () => "fictional-token" }))
const fixtures: ReturnType<typeof sqliteFixture>[] = []
afterEach(() => { fixtures.splice(0).forEach(f => f.sqlite.close()); vi.restoreAllMocks() })
const principal: Principal = { credentialId: "bot", userId: "a", orgId: "org", kind: "employee", grants: ["memory.personal:read", "memory.private-channel:read"] }
const source: KnowledgeSource = { id: "s", orgId: "org", connectionId: "personal", provider: "linear", ownerUserId: "a", audience: { kind: "users", userIds: ["a"] }, state: "partial", coverage: [], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 1000, failures: 0, error: null }
function setup() {
	const f = sqliteFixture(); fixtures.push(f)
	f.sqlite.exec(`INSERT INTO mcp_connection(id,org_id,user_id,server_slug,runtime,auth_type,status,created_at,updated_at)
		VALUES('personal','org','a','linear','remote_mcp','none','active',1,1);
		INSERT INTO slack_workspace(team_id,org_id,bot_token_enc,bot_user_id,scopes,created_at,updated_at)
		VALUES('T1','org','encrypted','UBOT','groups:read,users:read,team:read',1,1);
		INSERT INTO slack_workspace_member(team_id,slack_user_id,org_id,user_id,created_at,updated_at)
		VALUES('T1','U1','org','a',1,1);`)
	return f
}
function slack(members = ["U1", "UBOT"], failure = "") {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = new URL(String(input)), method = url.pathname.split("/").at(-1)
		if (method === failure) return Response.json({ ok: false, error: "token-secret" })
		return Response.json(method === "auth.test" ? { ok: true, team_id: "T1", user_id: "UBOT" } :
			method === "users.info" ? { ok: true, user: { id: "U1", team_id: "T1", is_bot: false, deleted: false } } :
			method === "conversations.info" ? { ok: true, channel: { id: "C1", is_member: true, is_archived: false } } : { ok: true, members })
	}) as typeof fetch
}
describe("proactive evidence access", () => {
	it("personal source is owner-only with a live connection and read grant", async () => {
		const f = setup(), access = await knowledgeAccess(f.env, principal, AbortSignal.timeout(1000))
		expect(await access.source(source)).toBe(true)
		expect(await access.source({ ...source, orgId: "other" })).toBe(false)
		expect(await (await knowledgeAccess(f.env, { ...principal, userId: "b" }, AbortSignal.timeout(1000))).source(source)).toBe(false)
		f.sqlite.exec("UPDATE mcp_connection SET status='error' WHERE id='personal'")
		expect(await access.source(source)).toBe(false)
		expect(await access.source(source, true)).toBe(true)
	})
	it("organization credential and admin status do not grant private-source access", async () => {
		const f = setup()
		const access = await knowledgeAccess(f.env, { ...principal, kind: undefined }, AbortSignal.timeout(1000), slack())
		expect(await access.audience({ kind: "users", userIds: ["a"] })).toBe(false)
		expect(await access.audience({ kind: "slack_channel", teamId: "T1", channelId: "C1" })).toBe(false)
		const admin = await knowledgeAccess(f.env, { ...principal, userId: "admin" }, AbortSignal.timeout(1000), slack())
		expect(await admin.audience({ kind: "slack_channel", teamId: "T1", channelId: "C1" })).toBe(false)
	})
	it("rechecks Slack membership on each request and rejects removed employees", async () => {
		const f = setup(), acl = { kind: "slack_channel" as const, teamId: "T1", channelId: "C1" }
		expect(await (await knowledgeAccess(f.env, principal, AbortSignal.timeout(1000), slack())).audience(acl)).toBe(true)
		expect(await (await knowledgeAccess(f.env, principal, AbortSignal.timeout(1000), slack(["UBOT"]))).audience(acl)).toBe(false)
		f.sqlite.exec("DELETE FROM member WHERE user_id='a'")
		expect(await (await knowledgeAccess(f.env, principal, AbortSignal.timeout(1000), slack())).audience(acl)).toBe(false)
	})
	it.each(["auth.test", "users.info", "conversations.info", "conversations.members"])("fails closed on %s errors and reports incomplete coverage", async (method) => {
		const f = setup(), access = await knowledgeAccess(f.env, principal, AbortSignal.timeout(1000), slack(undefined, method))
		expect(await access.audience({ kind: "slack_channel", teamId: "T1", channelId: "C1" })).toBe(false)
		expect(access.incomplete()).toBe(true)
	})
})
