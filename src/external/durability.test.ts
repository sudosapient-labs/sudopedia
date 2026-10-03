import { afterEach, describe, expect, it, vi } from "vitest"
import { sqliteFixture } from "../../test/external/sqlite"
import { maintainPersonal, operationId, personalStore, fingerprint, type PersonalProvider } from "./personal"
import { reconcilePersonalOperation } from "./reconciliation"
import { mintCredential, revokeCredential, listCredentials } from "./credentials"
import type { Principal } from "./contracts"
import { spawnSync } from "node:child_process"

const a: Principal = { orgId: "org", userId: "a", credentialId: "a-bot", grants: ["memory.personal:write"] }
const fixtures: ReturnType<typeof sqliteFixture>[] = []
const fixture = () => { const f = sqliteFixture(); fixtures.push(f); return f }
afterEach(() => { for (const f of fixtures.splice(0)) f.sqlite.close(); vi.restoreAllMocks() })
const key = () => crypto.randomUUID()
const signal = () => new AbortController().signal
const intent = { operation: "capture" as const }

describe("production SQL durability and credential capacity", () => {
	it("bounds A independently, allows B and admin, and frees active capacity on revoke/expiry", async () => {
		const { env, sqlite } = fixture()
		const input = { kind: "personal" as const, label: "Fictional", grants: a.grants, expiresInDays: 1 }
		const minted = await Promise.all(Array.from({ length: 5 }, () => mintCredential(env, a, input)))
		await expect(mintCredential(env, a, input)).rejects.toMatchObject({ code: "credential_limit" })
		expect(await mintCredential(env, { orgId: "org", userId: "b" }, input)).toHaveProperty("secret")
		expect(await mintCredential(env, { orgId: "org", userId: "admin" }, {
			...input, kind: "organization", grants: ["memory.shared:read"],
		})).toHaveProperty("secret")
		await revokeCredential(env, "org", minted[0]!.id, "a", false)
		expect(await mintCredential(env, a, input)).toHaveProperty("id")
		sqlite.prepare("UPDATE external_credential SET expires_at=1 WHERE id=?").run(minted[1]!.id)
		expect(await mintCredential(env, a, input)).toHaveProperty("id")
	})
	it("supports more than 100 employees without spending organization-integration capacity", async () => {
		const { env, sqlite } = fixture()
		for (let n = 0; n < 101; n++) {
			const id = `fictional-${n}`
			sqlite.prepare("INSERT INTO user(id,email,name,created_at,updated_at) VALUES (?,?,?,1,1)").run(id, `${id}@example.invalid`, id)
			sqlite.prepare("INSERT INTO member(id,user_id,organization_id,role,created_at) VALUES (?,?,'org','member',1)").run(id, id)
			await mintCredential(env, { orgId: "org", userId: id }, {
				kind: "personal", label: "Fictional", grants: a.grants, expiresInDays: 1,
			})
		}
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM external_credential").get()?.n).toBe(101)
	})
	it("lists every active organization integration alongside an admin's personal credentials", async () => {
		const { env } = fixture(), admin = { orgId: "org", userId: "admin" }
		const input = { label: "Fictional", grants: ["memory.shared:read" as const], expiresInDays: 1 }
		for (let n = 0; n < 100; n++) await mintCredential(env, admin, { ...input, kind: "organization" })
		for (let n = 0; n < 5; n++) await mintCredential(env, admin, { ...input, kind: "personal" })
		await mintCredential(env, a, { ...input, kind: "personal" })
		const listed = await listCredentials(env, "org", "admin", true)
		expect(listed).toHaveLength(105)
		expect(listed.filter((row) => row.kind === "organization")).toHaveLength(100)
		expect(listed.filter((row) => row.kind === "personal").every((row) => row.issuerId === "admin")).toBe(true)
	})
	it("bounds rotation history without losing active credentials or B's history", async () => {
		const { env, sqlite } = fixture()
		const input = { kind: "personal" as const, label: "Fictional", grants: a.grants, expiresInDays: 1 }
		const b = await mintCredential(env, { ...a, userId: "b" }, input)
		for (let n = 0; n < 105; n++) {
			const c = await mintCredential(env, a, input)
			await revokeCredential(env, "org", c.id, "a", false)
		}
		const active = await mintCredential(env, a, input)
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM external_credential WHERE user_id='a'").get()?.n).toBe(100)
		expect((await listCredentials(env, "org", "a", false))[0]?.id).toBe(active.id)
		expect(sqlite.prepare("SELECT id FROM external_credential WHERE id=?").get(b.id)).toBeTruthy()
	})
	it("fences a paused preflight worker after expiry and allows a fresh owner write", async () => {
		const { env, sqlite } = fixture(), store = personalStore(env)
		let release!: () => void, ready!: () => void
		const gate = new Promise<void>((r) => { release = r })
		const entered = new Promise<void>((r) => { ready = r })
		let mutations = 0
		const provider: PersonalProvider = { find: async () => null,
			mutate: async (_o, _op, _i, _p, _id, _s, context) => {
				ready(); await gate
				await context.onDispatch({ action: "capture" }); mutations++
				return { status: "applied" }
			} }
		const input = { idempotencyKey: key(), content: "Fictional fact" }
		const old = maintainPersonal(store, provider, a, "capture", input, signal())
		const rejected = expect(old).rejects.toMatchObject({ code: "write_conflict" })
		await entered
		sqlite.exec("UPDATE external_memory_operation SET deadline_at=1")
		expect(await store.claim(a, await operationId(a, key()), "new-hash", intent)).toBe(true)
		release(); await rejected
		expect(mutations).toBe(0)
		expect((await maintainPersonal(store, provider, a, "status", input, signal())).status).toBe("rejected")
	})
	it("persists dispatch target/fingerprint and never releases dispatched or legacy locks by age", async () => {
		const { env, sqlite } = fixture(), store = personalStore(env), id = await operationId(a, key())
		await store.claim(a, id, "hash", { operation: "retract", providerId: "target", fingerprint: "snapshot" })
		await store.dispatch(id, { action: "retract", providerId: "target", fingerprint: "snapshot" })
		sqlite.exec("UPDATE external_memory_operation SET deadline_at=1")
		expect(await store.read(id)).toMatchObject({ state: "pending" })
		expect(await store.claim(a, key(), "other", intent)).toBe(false)
		expect(sqlite.prepare("SELECT operation,phase,provider_action,provider_id,target_fingerprint FROM external_memory_operation").get()).toMatchObject({
			operation: "retract", phase: "dispatched", provider_action: "retract", provider_id: "target", target_fingerprint: "snapshot",
		})
		const legacy = fixture(), legacyStore = personalStore(legacy.env)
		legacy.sqlite.exec("INSERT INTO external_memory_operation(id,org_id,user_id,request_hash,state,created_at) VALUES ('legacy','org','a','hash','pending',1)")
		expect(await legacyStore.read("legacy")).toMatchObject({ state: "pending" })
		expect(await legacyStore.claim(a, key(), "other", intent)).toBe(false)
	})
	it.each([false, true])("does not redispatch provider success after journal failure (persistent=%s)", async (persistent) => {
		const { env, sqlite } = fixture(), store = personalStore(env)
		const entry = { id: "target", memory: "Fictional fact", updatedAt: "2026-10-01" }
		const ref = await store.reference(a, entry)
		const finish = vi.spyOn(store, "finish")
		if (persistent) finish.mockRejectedValue(new Error("DB down"))
		else finish.mockRejectedValueOnce(new Error("DB down"))
		const mutation = vi.fn(async (_o, _op, _i, _p, _id, _s, context) => {
			await context.onDispatch({ action: "retract", providerId: entry.id, fingerprint: await fingerprint(entry) })
			return { status: "applied" as const }
		})
		const provider: PersonalProvider = { find: async () => entry, mutate: mutation }
		const input = { idempotencyKey: key(), reference: ref }
		await expect(maintainPersonal(store, provider, a, "retract", input, signal())).rejects.toMatchObject({
			code: persistent ? "journal_unavailable" : "upstream_failure",
		})
		const replacement = { ...a, credentialId: "replacement" }
		expect(await maintainPersonal(store, provider, replacement, "retract", input, signal())).toMatchObject({ status: persistent ? "pending" : "unknown" })
		expect(mutation).toHaveBeenCalledTimes(1)
		expect(sqlite.prepare("SELECT provider_id FROM external_memory_operation").get()?.provider_id).toBe(entry.id)
	})
	it("reconciles only the exact terminated, provider-verified snapshot and prevents late overwrite", async () => {
		const { env, sqlite } = fixture(), store = personalStore(env), id = await operationId(a, key())
		await store.claim(a, id, "hash", { operation: "retract", providerId: "target", fingerprint: "fp" })
		await store.dispatch(id, { action: "retract", providerId: "target", fingerprint: "fp" })
		const input = { id, orgId: "org", userId: "a", requestHash: "hash", phase: "dispatched" as const,
			providerAction: "retract" as const, providerId: "target", targetFingerprint: "fp",
			outcome: "applied" as const, originalRequestStopped: true, providerVerified: true }
		await expect(reconcilePersonalOperation(env, input)).rejects.toMatchObject({ status: 409 })
		sqlite.exec("UPDATE external_memory_operation SET deadline_at=1")
		await expect(reconcilePersonalOperation(env, { ...input, providerVerified: false })).rejects.toMatchObject({ status: 400 })
		await expect(reconcilePersonalOperation(env, { ...input, originalRequestStopped: false })).rejects.toMatchObject({ status: 400 })
		await expect(reconcilePersonalOperation(env, { ...input, userId: "b" })).rejects.toMatchObject({ status: 409 })
		await expect(reconcilePersonalOperation(env, { ...input, providerId: "other" })).rejects.toMatchObject({ status: 409 })
		await reconcilePersonalOperation(env, input)
		expect(await store.read(id)).toMatchObject({ state: "applied", result: '{"status":"applied","searchable":false}' })
		await expect(store.finish(id, { status: "unknown", idempotencyKey: key(), searchable: false })).rejects.toMatchObject({ status: 409 })
		expect(await store.claim(a, key(), "next", intent)).toBe(true)
	})
	it("keeps journal/reference capacity fail-closed", async () => {
		const { env, sqlite } = fixture(), store = personalStore(env)
		const insert = sqlite.prepare("INSERT INTO external_memory_operation(id,org_id,user_id,request_hash,state,created_at) VALUES (?,'org','a','hash','rejected',1)")
		for (let n = 0; n < 10000; n++) insert.run(`op-${n}`)
		expect(await store.claim(a, key(), "new", intent)).toBe(false)
		const ref = sqlite.prepare("INSERT INTO external_memory_reference(id,org_id,user_id,provider_id,fingerprint,created_at) VALUES (?,'org','a','p','fp',?)")
		for (let n = 0; n < 1000; n++) ref.run(`ref-${n}`, Date.now())
		await expect(store.reference(a, { id: "new", memory: "Fact", updatedAt: "2026-10-01" })).rejects.toMatchObject({ code: "reference_limit" })
	})
	it("generates reviewable operator SQL with safely quoted exact targets and no network dispatch", async () => {
		const { env, sqlite } = fixture(), store = personalStore(env)
		await store.claim(a, "operator-test", "hash", { operation: "retract", providerId: "target'quoted", fingerprint: "fp" })
		await store.dispatch("operator-test", { action: "retract", providerId: "target'quoted", fingerprint: "fp" })
		sqlite.exec("UPDATE external_memory_operation SET deadline_at=1")
		const output = spawnSync("bun", ["scripts/reconcile-personal.ts", "test/external/reconciliation.json"], { encoding: "utf8" })
		expect(output.status).toBe(0)
		expect(sqlite.prepare(output.stdout).get()).toEqual({ id: "operator-test" })
		expect((await store.read("operator-test"))?.state).toBe("applied")
		expect(sqlite.prepare(output.stdout).get()).toBeUndefined()
	})
	it("generates no operator SQL for invalid snapshots or missing evidence", async () => {
		const output = spawnSync("bun", ["scripts/reconcile-personal.ts", "drizzle/meta/_journal.json"], { encoding: "utf8" })
		expect(output.status).toBe(1)
		expect(output.stdout).toBe("")
		await expect(reconcilePersonalOperation({} as Env, {} as never)).rejects.toMatchObject({ status: 400 })
	})
})
