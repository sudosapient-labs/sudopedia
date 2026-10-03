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
app.post("/fixture/rate-limit", async (c) => {
	const key = crypto.randomUUID()
	let rejected = 0
	for (let i = 0; i < 61; i++)
		if (!(await c.env.EXTERNAL_RATE_LIMITER.limit({ key })).success) rejected++
	return c.json({ rejected })
})
app.get("/fixture/stats/:id", async (c) => {
	const agent = c.env.COMPANY_BRAIN_AGENT.get(
		c.env.COMPANY_BRAIN_AGENT.idFromName("org"),
	) as unknown as TestSkillAgent
	return c.json({
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
	search: async (input) => {
		providerCalls++
		lastProviderRequest = sharedSearchRequest(input)
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
