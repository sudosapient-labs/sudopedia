import { Hono } from "hono"
import { getAgentByName } from "agents"
import { isCompanyBrainOrg } from "@repo/lib/features"
import type { CompanyBrainAgent } from "../brain/turn/agent"
import type { AppContext } from "../types"
import { linearWebhookConfigSchema } from "../brain/knowledge/linear-webhook"
import { readBody, readJson } from "../external/limits"

export const brainKnowledgeRoutes = new Hono<AppContext>().get("/sources", async (c) => {
	const org = c.get("org"), user = c.get("user")
	if (!org || !user) return c.json({ error: "unauthorized" }, 401)
	if (!isCompanyBrainOrg(org)) return c.json({ error: "forbidden" }, 403)
	const sourcePage = Number(c.req.query("sourcePage") ?? 0)
	if (!Number.isInteger(sourcePage) || sourcePage < 0 || sourcePage > 1000) return c.json({ error: "invalid source page" }, 400)
	const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id) as unknown as CompanyBrainAgent
	c.header("Cache-Control", "no-store")
	return c.json(await agent.queryExternalKnowledge({ credentialId: "session", orgId: org.id,
		userId: user.id, kind: "employee", grants: ["memory.personal:read", "memory.private-channel:read"] }, null, sourcePage))
})

brainKnowledgeRoutes.post("/linear/:connectionId/webhook-config", async (c) => {
	const org = c.get("org"), user = c.get("user")
	if (!org || !user) return c.json({ error: "unauthorized" }, 401)
	const parsed = linearWebhookConfigSchema.safeParse(await readJson(c.req.raw))
	if (!parsed.success) return c.json({ error: "invalid configuration" }, 400)
	const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, org.id) as unknown as CompanyBrainAgent
	try { await agent.configureLinearWebhook(user.id, c.req.param("connectionId"), parsed.data) }
	catch { return c.json({ error: "configuration denied or unavailable" }, 403) }
	return c.json({ configured: true, coverage: "Issue create/update/remove only; configure this URL in Linear with the same signing secret", path: `/brain/knowledge/hooks/linear/${c.req.param("connectionId")}` })
})

brainKnowledgeRoutes.post("/hooks/linear/:connectionId", async (c) => {
	const connectionId = c.req.param("connectionId")
	const connection = await c.env.DB.prepare("SELECT org_id FROM mcp_connection WHERE id=? AND server_slug='linear' AND status='active' LIMIT 1")
		.bind(connectionId).first<{ org_id: string }>()
	if (!connection) return c.json({ error: "invalid delivery" }, 401)
	const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readBody(c.req.raw))
	const agent = await getAgentByName(c.env.COMPANY_BRAIN_AGENT, connection.org_id) as unknown as CompanyBrainAgent
	try {
		const valid = await agent.receiveLinearWebhook(connectionId, body, c.req.header("Linear-Signature") ?? "", c.req.header("Linear-Delivery") ?? "")
		return valid ? c.json({ ok: true }) : c.json({ error: "invalid delivery" }, 401)
	} catch { return c.json({ error: "knowledge inbox unavailable" }, 503) }
})
