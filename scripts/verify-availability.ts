import assert from "node:assert/strict"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

/** Local Worker/D1/session/SDK only; deterministic fictional provider. */
export async function verifyAvailability(origin: string, connect: (secret: string) => Promise<Client>) {
	const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
		const response = await fetch(origin + path, { method: "POST", signal: AbortSignal.timeout(15000),
			headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
		const text = await response.text()
		return { response, text, body: JSON.parse(text) as any }
	}
	await post("/fixture/change", { action: "quota_reset" })
	const session = await fetch(origin + "/fixture/session/delegate", { method: "POST" })
	const management = { Cookie: session.headers.get("set-cookie")!.split(";")[0]!, Origin: origin, "X-Sudopedia-CSRF": "1" }
	const minted = await post("/brain/external-credentials/", { kind: "personal", label: "Fictional availability bot", expiresInDays: 1,
		grants: ["memory.shared:read", "memory.personal:read", "memory.personal:write"], consent: true }, management)
	assert.equal(minted.response.status, 201)
	const auth = { Authorization: `Bearer ${minted.body.secret}` }, client = await connect(minted.body.secret)
	assert.equal((await post("/fixture/availability", {})).response.status, 200)
	const input = { query: "all personal", limit: 20 }
	const http = await post("/brain/external/v1/memory/search", input, auth)
	assert.equal(http.response.status, 200)
	const mcp = await client.callTool({ name: "sudopedia_search_memory", arguments: input })
	assert.deepEqual(mcp.structuredContent, http.body)
	assert(http.body.results.some((r: any) => r.scope === "shared"))
	assert(http.body.results.some((r: any) => r.scope === "personal" && !r.editable && !r.reference))
	assert(!JSON.stringify(http.body).includes("provider-"))
	console.log("PASS real-D1 reference capacity preserves personal/shared HTTP and MCP reads")

	let cursor: unknown, rows: any[] = []
	do {
		const fetched = cursor ? await post("/brain/external-credentials/list", { cursor }, management) : null
		const response = fetched?.response ?? await fetch(origin + "/brain/external-credentials/", { headers: management })
		assert.equal(response.status, 200)
		assert.equal(response.headers.get("cache-control"), "no-store")
		const text = fetched?.text ?? await response.text(); assert(Buffer.byteLength(text) <= 65536)
		assert(!text.match(/secret_hash|sd_ext_/))
		const page = JSON.parse(text); rows.push(...page.credentials); cursor = page.nextCursor
	} while (cursor)
	assert(rows.length >= 200)
	assert.equal(new Set(rows.map((r) => r.id)).size, rows.length)
	assert.equal(rows.filter((r) => r.label === "記".repeat(100)).length, 200)
	console.log("PASS real-D1 session management paginates Unicode active/history credentials within 64 KiB")
	return 2
}
