import { getAgentByName } from "agents"
import type { CompanyBrainAgent } from "../turn/agent"

/** A bounded bootstrap/repair sweep makes learning independent of user traffic.
 * Per-source cadence and actual work remain owned by Durable Object alarms. */
export async function kickKnowledgeSchedules(env: Env): Promise<void> {
	const key = "knowledge:org-sweep-cursor"
	const cursor = await env.BRAIN_KV?.get(key) ?? ""
	const { results } = await env.DB.prepare(`SELECT DISTINCT org_id FROM (
		SELECT org_id FROM mcp_connection UNION SELECT org_id FROM slack_workspace
	) WHERE org_id > ? ORDER BY org_id LIMIT 20`).bind(cursor).all<{ org_id: string }>()
	const pending = [...results]
	await Promise.all(Array.from({ length: 2 }, async () => {
		while (pending.length) {
			const row = pending.shift()!
			try {
				const agent = await getAgentByName(env.COMPANY_BRAIN_AGENT, row.org_id) as unknown as CompanyBrainAgent
				await agent.ensureKnowledgeSchedule(row.org_id)
			} catch { console.error("[knowledge] schedule bootstrap unavailable; retry on the next sweep") }
		}
	}))
	// A broken organization must not pin discovery ahead of all later orgs.
	// Every sweep wraps, providing bounded retries without a blocking page.
	await env.BRAIN_KV?.put(key, results.length === 20 ? results.at(-1)!.org_id : "")
}
