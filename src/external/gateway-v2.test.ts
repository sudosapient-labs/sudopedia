import { afterEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { MIGRATIONS } from "../db/migrations.generated"
import { sqliteFixture } from "../../test/external/sqlite"
import { authenticate, mintCredential, listCredentials, revokeCredential, consumeQuota } from "./credentials"
import { GRANTS, mintSchema, type Principal } from "./contracts"
import { personalStore, sharedStore, maintainPersonal, operationId, referenceId, type PersonalProvider } from "./personal"
import { reconcilePersonalOperation } from "./reconciliation"
import { execute, type ExternalDependencies } from "./service"

const fixtures: ReturnType<typeof sqliteFixture>[] = []
function fixture() { const f = sqliteFixture(); fixtures.push(f); return f }
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); vi.restoreAllMocks() })
const key = () => crypto.randomUUID(), signal = () => new AbortController().signal
const admin: Principal = { orgId: "org", userId: "admin", credentialId: "admin-bot", grants: [...GRANTS], kind: "employee" }
const input = { kind: "employee" as const, label: "Fictional", grants: [...GRANTS], expiresInDays: 365 }
const request = (secret: string) => new Request("https://fictional.invalid", { headers: { Authorization: `Bearer ${secret}` } })
const provider: PersonalProvider = { find: async () => null,
	mutate: async (_o, operation, _i, id, _op, _s, context) => {
		await context.onDispatch({ action: operation, providerId: id }); return { status: "applied" }
	} }
function deps(f: ReturnType<typeof fixture>, actor = admin): ExternalDependencies {
	return { authenticate: async () => actor, quota: async () => {},
		personalStore: personalStore(f.env), sharedStore: sharedStore(f.env), personalProvider: provider, sharedProvider: provider,
		search: async () => ({ results: [] }), personalSearch: async () => ({ results: [] }),
		privateSearch: async () => ({ results: [] }),
		listSkills: async () => [], loadSkill: async () => ({ error: "not_found" }) }
}

describe("employee connection authorization and compatible lifetime", () => {
	it("gates new employee creation without disabling existing credential authentication", async () => {
		const f = fixture(), c = await mintCredential(f.env, admin, input)
		f.env.EXTERNAL_EMPLOYEE_CREATION_ENABLED = "off"
		await expect(mintCredential(f.env, admin, input)).rejects.toMatchObject({ status: 503 })
		expect((await authenticate(f.env, request(c.secret))).grants).toEqual([...GRANTS])
	})
	it("combines all six grants in one owner-bound credential and accepts exactly 365 days", async () => {
		const f = fixture(), start = Date.now(), c = await mintCredential(f.env, admin, input)
		expect(c.expiresAt - start).toBeGreaterThanOrEqual(365 * 86400000)
		expect(await authenticate(f.env, request(c.secret))).toEqual({ ...admin, credentialId: c.id })
		expect(mintSchema.safeParse({ ...input, consent: true }).success).toBe(true)
		expect(mintSchema.safeParse({ ...input, expiresInDays: 366, consent: true }).success).toBe(false)
		for (const days of [0, 366, 1.5, NaN])
			await expect(mintCredential(f.env, admin, { ...input, expiresInDays: days })).rejects.toMatchObject({ status: 400 })
		expect((await listCredentials(f.env, "org", "admin", true))[0]).toMatchObject({ kind: "employee", issuerId: "admin" })
		expect(f.sqlite.prepare("SELECT secret_hash FROM external_credential WHERE id=?").get(c.id)?.secret_hash).not.toContain(c.secret)
	})
	it.each(["memory.shared:write", "skills.org:read"] as const)("denies employee privileged grant %s independently of UI", async (grant) => {
		const f = fixture()
		await expect(mintCredential(f.env, { orgId: "org", userId: "a" }, { ...input, grants: [grant] }))
			.rejects.toMatchObject({ status: 403 })
	})
	it("demotion disables only privileged operations; rechecks revoke, deleted users and removed membership", async () => {
		const f = fixture(), c = await mintCredential(f.env, admin, input), d = deps(f)
		d.authenticate = () => authenticate(f.env, request(c.secret))
		f.sqlite.exec("UPDATE member SET role='member' WHERE user_id='admin'")
		expect((await d.authenticate()).grants).toEqual(GRANTS.filter((g) => g !== "memory.shared:write" && g !== "skills.org:read"))
		await expect(execute(d, "capture", { scope: "shared", idempotencyKey: key(), content: "Company policy" })).rejects.toMatchObject({ status: 403 })
		await expect(execute(d, "list", {})).rejects.toMatchObject({ status: 403 })
		expect(await execute(d, "capture", { idempotencyKey: key(), content: "Own fact" })).toMatchObject({ status: "applied" })
		f.sqlite.exec("UPDATE user SET deleted=1 WHERE id='admin'")
		await expect(d.authenticate()).rejects.toMatchObject({ status: 401 })
		f.sqlite.exec("UPDATE user SET deleted=0 WHERE id='admin'")
		await revokeCredential(f.env, "org", c.id, "admin", false)
		await expect(d.authenticate()).rejects.toMatchObject({ status: 401 })
		const other = await mintCredential(f.env, admin, { ...input, grants: ["memory.personal:write"] })
		f.sqlite.exec("DELETE FROM member WHERE user_id='admin'")
		await expect(authenticate(f.env, request(other.secret))).rejects.toMatchObject({ status: 401 })
	})
	it("never lets an admin manage another employee connection or impersonate their personal target", async () => {
		const f = fixture(), c = await mintCredential(f.env, { orgId: "org", userId: "a" }, { ...input, grants: ["memory.personal:write"] })
		expect(await listCredentials(f.env, "org", "admin", true)).toHaveLength(0)
		await revokeCredential(f.env, "org", c.id, "admin", true)
		expect((await authenticate(f.env, request(c.secret))).userId).toBe("a")
		for (const extra of [{ userId: "a" }, { orgId: "other" }, { containerTag: "user_a" }]) {
			expect(mintSchema.safeParse({ ...input, consent: true, ...extra }).success).toBe(false)
			await expect(execute(deps(f), "capture", { idempotencyKey: key(), content: "Fact", ...extra })).rejects.toMatchObject({ status: 400 })
		}
	})
	it("shares legacy-personal/new-employee capacity and preserves existing expiry/grants", async () => {
		const f = fixture(), legacy = await mintCredential(f.env, admin, { ...input, kind: "personal", grants: ["memory.personal:write"], expiresInDays: 1 })
		for (let i = 0; i < 4; i++) await mintCredential(f.env, admin, input)
		await expect(mintCredential(f.env, admin, input)).rejects.toMatchObject({ code: "credential_limit" })
		expect((await authenticate(f.env, request(legacy.secret))).grants).toEqual(["memory.personal:write"])
		expect(f.sqlite.prepare("SELECT expires_at FROM external_credential WHERE id=?").get(legacy.id)?.expires_at).toBe(legacy.expiresAt)
		await revokeCredential(f.env, "org", legacy.id, "admin", true)
		expect(await mintCredential(f.env, admin, input)).toHaveProperty("id")
	})
})

describe("shared mutation domains and retry/reference isolation", () => {
	it("defaults to personal and separates shared/personal operation, receipt and reference identities", async () => {
		const f = fixture(), d = deps(f), idempotencyKey = key(), entry = { id: "same-provider-id", memory: "Fact", updatedAt: "2026-10-01" }
		const personal = await d.personalStore!.reference(admin, entry), shared = await d.sharedStore!.reference(admin, entry)
		expect(personal).not.toBe(shared)
		expect(personal).toBe(await referenceId(admin, entry))
		expect(await d.personalStore!.lookup(admin, shared)).toBeNull()
		expect(await d.sharedStore!.lookup(admin, personal)).toBeNull()
		expect(await d.sharedStore!.lookup({ ...admin, userId: "a" }, shared)).toBeNull()
		expect(await d.sharedStore!.lookup({ ...admin, orgId: "other" }, shared)).toBeNull()
		expect(await execute(d, "capture", { idempotencyKey, content: "Default personal" })).toMatchObject({ status: "applied" })
		expect(await execute(d, "capture", { scope: "personal", idempotencyKey, content: "Default personal" })).toMatchObject({ status: "applied" })
		expect(await execute(d, "capture", { scope: "shared", idempotencyKey, content: "Explicit company fact" })).toMatchObject({ status: "applied", scope: "shared" })
		expect(await operationId(admin, idempotencyKey)).not.toBe(await operationId(admin, idempotencyKey, "shared"))
		await expect(execute(d, "capture", { scope: "shared", idempotencyKey, content: "Changed payload" })).rejects.toMatchObject({ code: "idempotency_conflict" })
		await expect(execute(d, "correct", { scope: "shared", idempotencyKey: key(), reference: personal, content: "Wrong target" })).rejects.toMatchObject({ status: 404 })
		expect(f.sqlite.prepare("SELECT COUNT(*) n FROM external_memory_operation").get()?.n).toBe(1)
		expect(f.sqlite.prepare("SELECT COUNT(*) n FROM external_shared_operation").get()?.n).toBe(1)
	})
	it("serializes shared writes from different admins organization-wide, while personal remains independent", async () => {
		const f = fixture(); f.sqlite.exec("UPDATE member SET role='admin' WHERE user_id='a'")
		const store = sharedStore(f.env), b = { ...admin, userId: "a" }
		let release!: () => void, entered!: () => void
		const gate = new Promise<void>((r) => { release = r }), ready = new Promise<void>((r) => { entered = r })
		const slow: PersonalProvider = { ...provider, mutate: async (...args) => { entered(); await gate; return provider.mutate(...args) } }
		const first = maintainPersonal(store, slow, admin, "capture", { idempotencyKey: key(), scope: "shared", content: "First company fact" }, signal())
		await ready
		await expect(maintainPersonal(store, provider, b, "capture", { idempotencyKey: key(), scope: "shared", content: "Other admin" }, signal())).rejects.toMatchObject({ code: "write_conflict" })
		expect(await maintainPersonal(personalStore(f.env), provider, b, "capture", { idempotencyKey: key(), content: "Own fact" }, signal())).toMatchObject({ status: "applied" })
		release(); expect(await first).toMatchObject({ status: "applied" })
	})
	it.each([false, true])("retains ambiguous shared evidence after issuer deletion and provider/journal failure (persistent=%s)", async (persistent) => {
		const f = fixture(), store = sharedStore(f.env), idempotencyKey = key(), id = await operationId(admin, idempotencyKey, "shared")
		const finish = vi.spyOn(store, "finish")
		if (persistent) finish.mockRejectedValue(new Error("DB down"))
		else finish.mockRejectedValueOnce(new Error("DB down"))
		await expect(maintainPersonal(store, provider, admin, "capture", { scope: "shared", idempotencyKey, content: "Fact" }, signal()))
			.rejects.toMatchObject({ code: persistent ? "journal_unavailable" : "upstream_failure" })
		f.sqlite.exec("DELETE FROM user WHERE id='admin'")
		const row = f.sqlite.prepare("SELECT * FROM external_shared_operation WHERE id=?").get(id)!
		expect(row).toMatchObject({ user_id: "admin", phase: "dispatched", provider_action: "capture", state: persistent ? "pending" : "unknown" })
		expect(await store.claim({ ...admin, userId: "a" }, key(), "hash", { operation: "capture" })).toBe(false)
		f.sqlite.exec("UPDATE external_shared_operation SET deadline_at=1")
		const snapshot = { scope: "shared" as const, id, orgId: "org", userId: "admin", requestHash: String(row.request_hash),
			phase: "dispatched" as const, providerAction: "capture" as const, providerId: null, targetFingerprint: null,
			outcome: "applied" as const, originalRequestStopped: true, providerVerified: true }
		await expect(reconcilePersonalOperation(f.env, { ...snapshot, userId: "a" })).rejects.toMatchObject({ status: 409 })
		await reconcilePersonalOperation(f.env, snapshot)
		expect(await store.claim({ ...admin, userId: "a" }, key(), "hash", { operation: "capture" })).toBe(true)
	})
	it("keeps mixed-scope selected-only references and auth/quota inside Free D1's budget", async () => {
		const f = fixture(), d = deps(f), c = await mintCredential(f.env, admin, input)
		d.authenticate = () => authenticate(f.env, request(c.secret)); d.quota = (p, op) => consumeQuota(f.env, p, op)
		const rows = Array.from({ length: 10 }, (_, i) => ({ id: `fake-${i}`, memory: "Fact", updatedAt: "2026-10-01" }))
		d.search = async () => ({ results: rows }); d.personalSearch = async () => ({ results: rows })
		f.resetQueryBudget(50)
		const result = await execute(d, "search", { query: "Fact", limit: 20 }) as any
		expect(result.results).toHaveLength(20)
		expect(result.results.every((r: any) => r.editable)).toBe(true)
		expect(f.queryCount()).toBe(26)
	})
})

describe("schema upgrade compatibility", () => {
	it("appends v2 tables to an already upgraded 0000–0004 database without changing legacy rows", () => {
		const sqlite = new DatabaseSync(":memory:")
		try {
			for (const m of MIGRATIONS.slice(0, 5)) for (const sql of m.statements) sqlite.exec(sql)
			sqlite.exec("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Fictional','fictional',1); INSERT INTO user(id,email,name,created_at,updated_at) VALUES ('a','a@example.invalid','A',1,1)")
			sqlite.exec("INSERT INTO external_memory_operation(id,org_id,user_id,request_hash,state,created_at) VALUES ('old','org','a','hash','pending',1)")
			const before = sqlite.prepare("SELECT * FROM external_memory_operation").get()
			for (const m of MIGRATIONS.slice(5)) for (const sql of m.statements) sqlite.exec(sql)
			expect(sqlite.prepare("SELECT * FROM external_memory_operation").get()).toEqual(before)
			expect(sqlite.prepare("PRAGMA foreign_key_list(external_shared_operation)").all()).toHaveLength(1)
		} finally { sqlite.close() }
	})
})
