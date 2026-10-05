// TEST-ONLY entrypoint. Never mounted/exported by src/worker.ts.
// Identities, source text and procedures here are fictional; no real providers.
import { DurableObject } from "cloudflare:workers"
import { Hono } from "hono"
import { sessionMiddleware, startSession } from "../../src/auth/session"
import { applyMigrations } from "../../src/db/migrate"
import { createExternalRoutes } from "../../src/routes/external"
import { externalCredentialRoutes } from "../../src/routes/external-credentials"
import { authenticate, consumeQuota } from "../../src/external/credentials"
import { sharedSearchRequest } from "../../src/external/dependencies"
import {
	createSkill,
	ensureSkillTables,
	listExternalOrgSkills,
	loadExternalOrgSkill,
} from "../../src/brain/skills/store"
import type { CompanyBrainAgent } from "../../src/brain/turn/agent"
import type { AppContext } from "../../src/types"
import { personalStore, sharedStore } from "../../src/external/personal"
import { privateChannelSearch } from "../../src/external/private-channels"
import { encryptToken } from "../../src/compat/lib/crypto"
import { fakeSlackFetch, setSlackFixture } from "./private-slack"
import { reconcilePersonalOperation } from "../../src/external/reconciliation"
import { publicError } from "../../src/external/errors"
import {
	fakePersonalProvider,
	fakePersonalSearch,
	fakeSharedProvider,
	fakeSharedSearch,
	personalRows,
	personalMutations,
} from "./personal-provider"

export class TestSkillAgent extends DurableObject {
	sql<T>(
		strings: TemplateStringsArray,
		...bindings: (string | number | null)[]
	): T[] {
		return this.ctx.storage.sql
			.exec(strings.join("?"), ...bindings)
			.toArray() as T[]
	}
	async seed() {
		const agent = this as unknown as CompanyBrainAgent
		ensureSkillTables(agent)
		this.ctx.storage.sql.exec("DELETE FROM brain_skill")
		const personal = createSkill(
			agent,
			{
				name: "Release review",
				description: "Private fake procedure",
				body: "PERSONAL_NOT_EXPOSED",
				scope: "personal",
				origin: "web",
			},
			"owner",
			false,
		)
		const org = createSkill(
			agent,
			{
				name: "Release review",
				description: "Review a fictional release",
				body: "# Release review\nCheck evidence with your own authorized live tools. Follow your own approvals.",
				scope: "org",
				origin: "web",
			},
			"owner",
			true,
		)
		const disabled = createSkill(
			agent,
			{
				name: "Retired procedure",
				description: "Disabled fake procedure",
				body: "DISABLED_NOT_EXPOSED",
				scope: "org",
				origin: "web",
			},
			"owner",
			true,
		)
		this.ctx.storage.sql.exec(
			"UPDATE brain_skill SET status = 'disabled' WHERE id = ?",
			disabled.id,
		)
		return { orgId: org.id, personalId: personal.id, disabledId: disabled.id }
	}
	async listExternalOrgSkills() {
		return listExternalOrgSkills(this as unknown as CompanyBrainAgent)
	}
	async loadExternalOrgSkill(id: string, expectedVersion?: number) {
		return loadExternalOrgSkill(
			this as unknown as CompanyBrainAgent,
			id,
			expectedVersion,
		)
	}
	async usage(id: string) {
		return this.ctx.storage.sql
			.exec("SELECT usage_count FROM brain_skill WHERE id = ?", id)
			.one().usage_count
	}
	async oversizedBody(id: string) {
		this.ctx.storage.sql.exec(
			"UPDATE brain_skill SET body = ? WHERE id = ?",
			"\u0001".repeat(16384),
			id,
		)
	}
}

const app = new Hono<AppContext>({ strict: false })
let migrated: Promise<unknown> | undefined
let providerCalls = 0
let lastProviderRequest: unknown
let journalFailures = 0
app.use("*", async (c, next) => {
	await (migrated ??= applyMigrations(c.env))
	await next()
})
app.use("*", sessionMiddleware)
app.post("/fixture/seed", async (c) => {
	await c.env.DB.batch([
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO organization (id, name, slug, created_at) VALUES ('org', 'Fictional Company', 'fictional', 1)",
		),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO user (id, email, name, created_at, updated_at) VALUES ('owner', 'owner@example.invalid', 'Fixture Owner', 1, 1)",
		),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO user (id, email, name, created_at, updated_at) VALUES ('member', 'member@example.invalid', 'Fixture Member', 1, 1)",
		),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO user (id, email, name, created_at, updated_at) VALUES ('delegate', 'delegate@example.invalid', 'Fixture Admin', 1, 1)",
		),
		c.env.DB.prepare("INSERT OR IGNORE INTO user(id,email,name,created_at,updated_at) VALUES ('gateway-admin','gateway-admin@example.invalid','Fixture V2 Admin',1,1)"),
		c.env.DB.prepare("INSERT OR IGNORE INTO member(id,user_id,organization_id,role,created_at) VALUES ('m-gateway-admin','gateway-admin','org','admin',1)"),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO member (id, user_id, organization_id, role, created_at) VALUES ('m-owner', 'owner', 'org', 'owner', 1)",
		),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO member (id, user_id, organization_id, role, created_at) VALUES ('m-member', 'member', 'org', 'member', 1)",
		),
		c.env.DB.prepare(
			"INSERT OR IGNORE INTO member (id, user_id, organization_id, role, created_at) VALUES ('m-delegate', 'delegate', 'org', 'admin', 1)",
		),
	])
	const agent = c.env.COMPANY_BRAIN_AGENT.get(
		c.env.COMPANY_BRAIN_AGENT.idFromName("org"),
	) as unknown as TestSkillAgent
	return c.json(await agent.seed())
})
app.post("/fixture/session/:actor", async (c) => {
	await startSession(c, c.req.param("actor"), "org")
	return c.json({ ok: true })
})
app.post("/fixture/change", async (c) => {
	const { action, id, grants } = await c.req.json()
	if (action === "demote_owner" || action === "restore_owner")
		await c.env.DB.prepare("UPDATE member SET role=? WHERE user_id='owner'").bind(action === "demote_owner" ? "member" : "owner").run()
	if (action === "demote_gateway_admin" || action === "restore_gateway_admin")
		await c.env.DB.prepare("UPDATE member SET role=? WHERE user_id='gateway-admin'").bind(action === "demote_gateway_admin" ? "member" : "admin").run()
	if (action === "slack_seed") {
		await c.env.DB.prepare(`INSERT OR REPLACE INTO slack_workspace(team_id,org_id,bot_token_enc,bot_user_id,scopes,created_at,updated_at)
			VALUES ('T1','org',?,'UBOT','groups:read,users:read,team:read',1,1)`).bind(await encryptToken("fictional-slack-token", c.env.ENCRYPTION_SECRET)).run()
		await c.env.DB.prepare(`INSERT OR REPLACE INTO slack_workspace_member(team_id,slack_user_id,org_id,user_id,created_at,updated_at)
			VALUES ('T1','UOWNER','org','gateway-admin',1,1)`).run()
		setSlackFixture(true)
	}
	if (action === "slack_leave") setSlackFixture(false)
	if (action === "slack_error") setSlackFixture(true, true)
	if (action === "expire_preflight")
		await c.env.DB.prepare("UPDATE external_memory_operation SET deadline_at=1 WHERE id=?").bind(id).run()
	if (action === "claim_preflight")
		await personalStore(c.env).claim({ orgId: "org", userId: "delegate", credentialId: "fixture", grants: [] },
			id, "fixture-hash", { operation: "capture" })
	if (action === "journal_failure") journalFailures = 1
	if (action === "stale_personal") {
		const row = personalRows.find((r) => r.id === id)
		if (row) {
			row.memory += " Changed outside the gateway."
			row.updatedAt = new Date().toISOString()
		}
	}
	if (action === "expire")
		await c.env.DB.prepare(
			"UPDATE external_credential SET expires_at = 1 WHERE id = ?",
		)
			.bind(id)
			.run()
	if (action === "grants")
		await c.env.DB.prepare(
			"UPDATE external_credential SET grants = ? WHERE id = ?",
		)
			.bind(JSON.stringify(grants), id)
			.run()
	if (action === "deleted")
		await c.env.DB.prepare(
			"UPDATE user SET deleted = 1 WHERE id = 'owner'",
		).run()
	if (action === "undelete")
		await c.env.DB.prepare(
			"UPDATE user SET deleted = 0 WHERE id = 'owner'",
		).run()
	if (action === "remove_member")
		await c.env.DB.prepare("DELETE FROM member WHERE id = 'm-delegate'").run()
	if (action === "restore_member")
		await c.env.DB.prepare(
			"INSERT INTO member (id, user_id, organization_id, role, created_at) VALUES ('m-delegate-new', 'delegate', 'org', 'admin', 1)",
		).run()
	if (action === "quota_reset")
		await c.env.DB.prepare("DELETE FROM external_quota").run()
	if (action === "oversized_skill")
		await (
			c.env.COMPANY_BRAIN_AGENT.get(
				c.env.COMPANY_BRAIN_AGENT.idFromName("org"),
			) as unknown as TestSkillAgent
		).oversizedBody(id)
	return c.json({ ok: true })
})
app.get("/fixture/journal/:id", async (c) => c.json(await c.env.DB.prepare(
	"SELECT * FROM external_memory_operation WHERE id=?",
).bind(c.req.param("id")).first()))
app.post("/fixture/reconcile", async (c) => {
	try {
		await reconcilePersonalOperation(c.env, await c.req.json())
		return c.json({ ok: true })
	} catch (error) {
		const safe = publicError(error)
		return c.json({ error: safe.code }, safe.status)
	}
})
app.post("/fixture/rate-limit", async (c) => {
	const key = crypto.randomUUID()
	let rejected = 0
	for (let i = 0; i < 61; i++)
		if (!(await c.env.EXTERNAL_RATE_LIMITER.limit({ key })).success) rejected++
	return c.json({ rejected })
})
app.post("/fixture/availability", async (c) => {
	// Test-only capacity setup in two statements; never uses provider data/writes.
	await c.env.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<1000)
		INSERT OR IGNORE INTO external_memory_reference(id,org_id,user_id,provider_id,fingerprint,created_at)
		SELECT 'capacity-' || n,'org','delegate','fictional','fp',? FROM nums
		LIMIT MAX(0,1000-(SELECT COUNT(*) FROM external_memory_reference WHERE org_id='org' AND user_id='delegate'))`).bind(Date.now()).run()
	await c.env.DB.prepare(`WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<200)
		INSERT INTO external_credential(id,org_id,user_id,member_id,label,secret_hash,grants,created_at,expires_at,revoked_at,kind)
		SELECT printf('00000000-0000-4000-8000-%012d',n),'org','delegate',
		(SELECT id FROM member WHERE user_id='delegate' AND organization_id='org'),?,
		'fictional-unused-hash','["memory.shared:read"]',1,?,CASE WHEN n<=100 THEN NULL ELSE 1 END,'organization' FROM nums`)
		.bind("記".repeat(100), Date.now() + 86400000).run()
	return c.json({ ok: true })
})
app.get("/fixture/stats/:id", async (c) => {
	const agent = c.env.COMPANY_BRAIN_AGENT.get(
		c.env.COMPANY_BRAIN_AGENT.idFromName("org"),
	) as unknown as TestSkillAgent
	return c.json({
		personalMutations,
		providerCalls,
		lastProviderRequest,
		usage: await agent.usage(c.req.param("id")),
	})
})
app.route("/brain/external-credentials", externalCredentialRoutes)
app.get("/auth/session", (c) =>
	c.json({
		user: c.get("user"),
		org: c.get("org"),
		role: c.get("memberRole"),
		setupComplete: true,
	}),
)
const routes = createExternalRoutes((env, request) => ({
	authenticate: () => authenticate(env, request),
	quota: (principal, operation) => consumeQuota(env, principal, operation),
	personalStore: {
		...personalStore(env),
		async finish(id, result) {
			if (journalFailures > 0) { journalFailures--; throw new Error("Fictional journal failure") }
			await personalStore(env).finish(id, result)
		},
	},
	personalProvider: fakePersonalProvider,
	sharedStore: sharedStore(env),
	sharedProvider: fakeSharedProvider,
	privateSearch: (input, principal, signal) => privateChannelSearch(env, input, principal, signal, {
		slackFetch: fakeSlackFetch,
		search: async (containerTag) => {
			if (containerTag !== "slack_channel_CPRIVATE") throw new Error("Unauthorized fixture container")
			return { results: [{ id: "fixture-private", memory: "Fictional ingested channel fact", similarity: 1, metadata: { memory_scope: "private_channel" } }] }
		},
	}),
	personalSearch: (input, owner) => fakePersonalSearch(input, owner),
	search: async (input, signal) => {
		providerCalls++
		lastProviderRequest = sharedSearchRequest(input)
		if (input.query.includes("vacation") || input.query.includes("shared journey")) {
			const principal = await authenticate(env, request)
			return { results: [...(await fakeSharedSearch(input, principal)).results,
				...(input.recall === "historical" ? [{ id: "old-source", chunk: "Historical vacation policy: 20 days." }] : [])] }
		}
		if (
			(lastProviderRequest as { containerTag: string }).containerTag !==
			"sm_org_shared"
		)
			throw new Error("Private scope attempted")
		if (input.query === "provider failure")
			throw new Error("upstream SECRET_DO_NOT_LEAK")
		if (input.query === "large unicode")
			return {
				results: Array.from({ length: 20 }, (_, i) => ({
					id: `fake-${i}`,
					memory: "😀".repeat(3000),
					metadata: null,
				})),
			}
		return {
			results: [
				{
					id: "fake-derived-memory",
					memory: "Fictional release Aurora uses a staged review.",
					similarity: 0.87,
					updatedAt: "2026-10-01T12:00:00Z",
					metadata: {
						brain_tags: ["project_aurora"],
						sources: ["https://example.invalid/releases/aurora"],
						ingestion_date: "2026-10-01",
					},
				},
			],
		}
	},
	listSkills: async (orgId) =>
		(
			env.COMPANY_BRAIN_AGENT.get(
				env.COMPANY_BRAIN_AGENT.idFromName(orgId),
			) as unknown as TestSkillAgent
		).listExternalOrgSkills(),
	loadSkill: async (orgId, id, version) =>
		(
			env.COMPANY_BRAIN_AGENT.get(
				env.COMPANY_BRAIN_AGENT.idFromName(orgId),
			) as unknown as TestSkillAgent
		).loadExternalOrgSkill(id, version),
}))
app.all("/mcp", (c) => routes.fetch(c.req.raw, c.env, c.executionCtx))
app.all("/brain/external/*", (c) =>
	routes.fetch(c.req.raw, c.env, c.executionCtx),
)
app.all("/brain/*", (c) =>
	c.json({ error: "Not implemented by UI fixture" }, 404),
)
app.notFound((c) =>
	c.env.ASSETS
		? c.env.ASSETS.fetch(c.req.raw)
		: c.json({ error: "not_found" }, 404),
)
export default app
