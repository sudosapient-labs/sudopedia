import { afterEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import type { AppContext } from "../types"
import type { Principal, MemoryResult } from "./contracts"
import { sqliteFixture } from "../../test/external/sqlite"
import { authenticate, consumeQuota, mintCredential } from "./credentials"
import { personalStore, referenceId, type PersonalEntry } from "./personal"
import { execute, type ExternalDependencies } from "./service"
import { externalCredentialRoutes } from "../routes/external-credentials"
import { jsonBytes, MAX_BODY_BYTES } from "./limits"

const owner: Principal = { orgId: "org", userId: "a", credentialId: "bot", grants: ["memory.personal:read", "memory.personal:write", "memory.shared:read"] }
const entries = (n = 20): PersonalEntry[] => Array.from({ length: n }, (_, i) => ({ id: `provider-${i}`, memory: `Fictional fact ${i}`, updatedAt: "2026-10-01" }))
const fixtures: ReturnType<typeof sqliteFixture>[] = []
const fixture = () => { const f = sqliteFixture(); fixtures.push(f); return f }
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); vi.restoreAllMocks() })
function searchDeps(f: ReturnType<typeof fixture>, rows = entries(), principal = owner): ExternalDependencies {
	return { authenticate: async () => principal, quota: async () => {}, personalStore: personalStore(f.env),
		personalSearch: async () => ({ results: rows }), search: async () => ({ results: [] }),
		listSkills: async () => [], loadSkill: async () => { throw new Error("unused") } }
}
const search = (deps: ExternalDependencies, limit = 20) => execute(deps, "search", { query: "fictional", limit }) as Promise<{ results: MemoryResult[]; truncated: boolean }>
function fillReferences(f: ReturnType<typeof fixture>, n: number) {
	const insert = f.sqlite.prepare("INSERT INTO external_memory_reference(id,org_id,user_id,provider_id,fingerprint,created_at) VALUES (?,'org','a','fictional','fp',?)")
	for (let i = 0; i < n; i++) insert.run(`filler-${i}`, Date.now())
}

describe("personal search availability with production SQL", () => {
	it("fits 20 editable results plus live authentication/quota inside the Free D1 50-statement budget", async () => {
		const f = fixture(), deps = searchDeps(f)
		const credential = await mintCredential(f.env, owner, { kind: "personal", label: "Fictional", grants: owner.grants, expiresInDays: 1 })
		const request = new Request("https://fictional.invalid", { headers: { Authorization: `Bearer ${credential.secret}` } })
		deps.authenticate = () => authenticate(f.env, request)
		deps.quota = (principal, operation) => consumeQuota(f.env, principal, operation)
		f.resetQueryBudget(50)
		const result = await search(deps)
		expect(result.results).toHaveLength(20)
		expect(result.results.every((r) => r.editable && r.reference && !r.id.value.startsWith("provider-"))).toBe(true)
		expect(f.queryCount()).toBe(24) // authentication + quota + sweep + 20 inserts + verification
	})
	it("read-only search never persists references, even at capacity", async () => {
		const f = fixture(); fillReferences(f, 1000)
		const deps = searchDeps(f, entries(), { ...owner, grants: ["memory.personal:read", "memory.shared:read"] })
		deps.search = async () => ({ results: [{ id: "shared", memory: "Shared fact", similarity: 1 }] })
		f.resetQueryBudget(0)
		const result = await search(deps)
		expect(result.results).toHaveLength(20)
		expect(result.results.some((r) => r.scope === "shared")).toBe(true)
		expect(result.results.every((r) => !r.editable && !r.reference)).toBe(true)
		expect(f.queryCount()).toBe(0)
		expect(JSON.stringify(result)).not.toContain("provider-")
	})
	it("retains shared/personal reads at capacity and keeps existing owner references editable", async () => {
		const f = fixture(), deps = searchDeps(f, entries(2)), store = deps.personalStore!
		const ref = await store.reference(owner, entries(1)[0]!)
		fillReferences(f, 999)
		deps.search = async () => ({ results: [{ id: "shared", memory: "Shared fact" }] })
		const result = await search(deps)
		expect(result.results).toHaveLength(3)
		expect(result.results.find((r) => r.reference === ref)).toMatchObject({ editable: true })
		expect(result.results.filter((r) => !r.reference)).toHaveLength(2)
		expect(result.results.find((r) => r.text === "Fictional fact 1")).toMatchObject({ editable: false })
		expect(await store.lookup({ ...owner, userId: "b" }, ref)).toBeNull()
		expect(await store.lookup({ ...owner, orgId: "another-org" }, ref)).toBeNull()
	})
	it("does not allocate references for personal results discarded by global ranking", async () => {
		const f = fixture(), deps = searchDeps(f)
		deps.search = async () => ({ results: entries().map((r) => ({ ...r, similarity: 1 })) })
		f.resetQueryBudget(0)
		expect((await search(deps)).results.every((r) => r.scope === "shared")).toBe(true)
		expect(f.queryCount()).toBe(0)
	})
	it("reserves output bytes before allocating references", async () => {
		const f = fixture(), deps = searchDeps(f, entries().map((r) => ({ ...r, memory: "😀".repeat(1024) })))
		const result = await search(deps)
		expect(result.truncated).toBe(true)
		expect(jsonBytes(result)).toBeLessThanOrEqual(28 * 1024)
		expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM external_memory_reference").get()?.n).toBe(result.results.length)
	})
	it("keeps capacity atomic across concurrent searches and reuses references without extending TTL", async () => {
		const f = fixture(), store = personalStore(f.env); fillReferences(f, 990)
		const batches = [entries(), entries().map((r) => ({ ...r, id: `other-${r.id}` }))]
		const results = await Promise.all(batches.map((rows) => store.references(owner, rows)))
		expect(results.flat().filter(Boolean)).toHaveLength(10)
		expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM external_memory_reference").get()?.n).toBe(1000)
		const index = results[0]!.findIndex(Boolean)
		const ref = results[0]![index]!
		const created = f.sqlite.prepare("SELECT created_at FROM external_memory_reference WHERE id=?").get(ref)?.created_at
		expect((await store.references(owner, [batches[0]![index]!]))[0]).toBe(ref)
		expect(f.sqlite.prepare("SELECT created_at FROM external_memory_reference WHERE id=?").get(ref)?.created_at).toBe(created)
		f.sqlite.prepare("UPDATE external_memory_reference SET created_at=1 WHERE id=?").run(ref)
		expect(await store.lookup(owner, ref)).toBeNull()
		expect((await store.references(owner, [batches[0]![index]!]))[0]).toBe(ref)
		expect(await store.lookup(owner, ref)).not.toBeNull()
	})
	it("does not disguise database failure as capacity and keeps read IDs owner scoped", async () => {
		const f = fixture(), deps = searchDeps(f)
		vi.spyOn(deps.personalStore!, "references").mockRejectedValue(new Error("DB unavailable"))
		await expect(search(deps)).rejects.toMatchObject({ code: "upstream_failure", status: 502 })
		expect(await referenceId(owner, entries()[0]!)).not.toBe(await referenceId({ ...owner, userId: "b" }, entries()[0]!))
	})
	it("stops allocating references between statements when the search is cancelled", async () => {
		const f = fixture(), store = personalStore(f.env), controller = new AbortController()
		const prepare = f.env.DB.prepare.bind(f.env.DB)
		vi.spyOn(f.env.DB, "prepare").mockImplementation((sql) => {
			const statement = prepare(sql)
			const run = statement.run.bind(statement)
			vi.spyOn(statement, "run").mockImplementation(async () => {
				const result = await run()
				if (sql.includes("INSERT")) controller.abort()
				return result
			})
			return statement
		})
		f.resetQueryBudget()
		await expect(store.references(owner, entries(), controller.signal)).rejects.toMatchObject({ name: "AbortError" })
		expect(f.queryCount()).toBe(2) // sweep and first insert only
	})
})

function management(f: ReturnType<typeof fixture>) {
	let actor = "admin", role: "admin" | "member" = "admin", org = "org"
	const app = new Hono<AppContext>({ strict: false }).use("*", async (c, next) => {
		c.set("user", { id: actor, name: actor, email: `${actor}@example.invalid`, createdAt: new Date(), updatedAt: new Date() })
		c.set("org", { id: org, name: org, slug: org, createdAt: new Date() }); c.set("memberRole", role)
		await next()
	}).route("/brain/external-credentials", externalCredentialRoutes)
	f.env.EXTERNAL_PUBLIC_URL = "https://fictional.invalid"
	f.env.EXTERNAL_MANAGEMENT_RATE_LIMITER = { limit: async () => ({ success: true }) } as Env["EXTERNAL_MANAGEMENT_RATE_LIMITER"]
	const request = (cursor?: unknown, extra: Record<string, string> = {}, path = cursor ? "/list" : "/") => app.request(`https://fictional.invalid/brain/external-credentials${path}`,
		cursor ? { method: "POST", headers: { Origin: "https://fictional.invalid", "X-Sudopedia-CSRF": "1", "Content-Type": "application/json", ...extra }, body: JSON.stringify({ cursor }) } : {}, f.env)
	return { request, setActor(user: string, nextRole: typeof role, nextOrg = "org") { actor = user; role = nextRole; org = nextOrg } }
}
function seedCredentials(f: ReturnType<typeof fixture>) {
	const insert = f.sqlite.prepare(`INSERT INTO external_credential(id,org_id,user_id,member_id,label,secret_hash,grants,created_at,expires_at,revoked_at,kind)
		VALUES (?,'org',?,?,?,'hash','["memory.shared:read"]',1,?,?,?)`)
	const ids: string[] = []
	for (let i = 0; i < 200; i++) {
		const id = crypto.randomUUID(); ids.push(id)
		insert.run(id, "admin", "madmin", "記".repeat(100), Date.now() + 86400000, i < 100 ? null : 1, "organization")
	}
	for (const user of ["admin", "a", "b"]) insert.run(crypto.randomUUID(), user, user === "admin" ? "madmin" : `m${user}`, `${user} personal`, Date.now() + 86400000, null, "personal")
	return ids
}
describe("bounded management pages mounted on production routes (fictional session context)", () => {
	it("lists all 100 active and 100 historical Unicode-labeled credentials without exceeding 64 KiB", async () => {
		const f = fixture(), ids = seedCredentials(f), { request } = management(f)
		const rows: { id: string; kind: string; issuerId: string; revokedAt: number | null }[] = []
		let cursor: unknown
		do {
			const response = await request(cursor)
			expect(response.status).toBe(200)
			expect(response.headers.get("cache-control")).toBe("no-store")
			const text = await response.text(); expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES)
			expect(text).not.toMatch(/secret_hash|sd_ext_/)
			const page = JSON.parse(text); expect(page.credentials.length).toBeLessThanOrEqual(50)
			rows.push(...page.credentials); cursor = page.nextCursor
		} while (cursor)
		expect(rows).toHaveLength(201)
		expect(new Set(rows.map((r) => r.id)).size).toBe(201)
		expect(rows.filter((r) => r.kind === "organization").map((r) => r.id).sort()).toEqual(ids.sort())
		expect(rows.slice(0, 101).every((r) => !r.revokedAt)).toBe(true)
		expect(rows.filter((r) => r.kind === "personal").every((r) => r.issuerId === "admin")).toBe(true)
	})
	it("rechecks actor/org/role for copied pages and offers only the employee's own personal credentials", async () => {
		const f = fixture(); seedCredentials(f); const m = management(f)
		const { nextCursor } = await (await m.request()).json() as { nextCursor: unknown }
		m.setActor("a", "member")
		expect((await m.request(nextCursor)).status).toBe(409)
		const personal = await (await m.request()).json() as { credentials: { issuerId: string; kind: string }[] }
		expect(personal.credentials).toHaveLength(1)
		expect(personal.credentials[0]).toMatchObject({ issuerId: "a", kind: "personal" })
		m.setActor("admin", "member"); expect((await m.request(nextCursor)).status).toBe(409)
		m.setActor("admin", "admin", "other-org"); expect((await m.request(nextCursor)).status).toBe(409)
	})
	it("keeps pagination body-only, strict, CSRF protected and expires or rejects stale anchors", async () => {
		const f = fixture(); seedCredentials(f); const { request } = management(f)
		const { nextCursor } = await (await request()).json() as { nextCursor: { id: string; asOf: number; version: string } }
		expect((await request(nextCursor, { Origin: "https://evil.invalid" })).status).toBe(403)
		expect((await request(nextCursor, { "X-Sudopedia-CSRF": "" })).status).toBe(403)
		expect((await request(nextCursor, {}, "/list?token=secret")).status).toBe(400)
		expect((await request({ ...nextCursor, userId: "b" })).status).toBe(400)
		expect((await request({ ...nextCursor, asOf: 1 })).status).toBe(409)
		f.sqlite.prepare("DELETE FROM external_credential WHERE id=?").run(nextCursor.id)
		expect((await request(nextCursor)).status).toBe(409)
	})
	it("requires reload when a concurrent revocation changes ordering instead of skipping active rows", async () => {
		const f = fixture(); seedCredentials(f); const { request } = management(f)
		const { nextCursor } = await (await request()).json() as { nextCursor: { id: string } }
		f.sqlite.prepare("UPDATE external_credential SET revoked_at=1 WHERE id=?").run(nextCursor.id)
		expect((await request(nextCursor)).status).toBe(409)
		expect((await request()).status).toBe(200)
	})
})
