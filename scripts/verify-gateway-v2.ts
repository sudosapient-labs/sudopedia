import assert from "node:assert/strict"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

/** Explicit scripted calls, real local Worker/D1/SDK, fictional providers only. */
export async function verifyGatewayV2(origin: string, connect: (secret: string) => Promise<Client>) {
	const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
		const response = await fetch(origin + path, { method: "POST", signal: AbortSignal.timeout(15000),
			headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
		return { response, body: await response.json() as any }
	}
	await post("/fixture/change", { action: "quota_reset" })
	const session = await post("/fixture/session/gateway-admin", {})
	const management = { Cookie: session.response.headers.get("set-cookie")!.split(";")[0]!, Origin: origin, "X-Sudopedia-CSRF": "1" }
	const input = { kind: "employee", label: "Fictional mixed bot", expiresInDays: 365, consent: true,
		grants: ["memory.shared:read", "memory.personal:read", "memory.personal:write", "memory.shared:write", "skills.org:read", "memory.private-channel:read"] }
	assert.equal((await post("/brain/external-credentials/", { ...input, expiresInDays: 366 }, management)).response.status, 400)
	const minted = await post("/brain/external-credentials/", input, management); assert.equal(minted.response.status, 201)
	const auth = { Authorization: `Bearer ${minted.body.secret}` }, client = await connect(minted.body.secret)
	const operation = (name: string, input: unknown) => post(`/brain/external/v1/memory/${name}`, input, auth)
	assert.equal((await fetch(origin + "/brain/external/v1/skills", { headers: auth })).status, 200)
	console.log("PASS mixed employee connection, admin skill read, 365 acceptance and 366 rejection")

	const query = { query: "vacation shared journey", scope: "shared", limit: 20 }
	assert.equal((await operation("search", query)).body.results.length, 0)
	const key = crypto.randomUUID(), capture = { scope: "shared", idempotencyKey: key, content: "Shared journey vacation policy: employees receive 20 days." }
	assert.equal((await operation("capture", capture)).body.status, "applied")
	const receipt = await client.callTool({ name: "sudopedia_capture_memory", arguments: capture })
	assert.equal((receipt.structuredContent as any).scope, "shared")
	const first = await operation("search", query)
	const recalled = await client.callTool({ name: "sudopedia_search_memory", arguments: query })
	assert.deepEqual(recalled.structuredContent, first.body)
	const reference = first.body.results[0].reference; assert(reference)
	assert.equal((await operation("correct", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference,
		content: "Shared journey vacation policy: employees receive 25 days." })).body.status, "applied")
	const corrected = await operation("search", query)
	assert(corrected.body.results.every((r: any) => r.text.includes("25 days") && r.recall === "current"))
	await post("/fixture/change", { action: "quota_reset" })
	assert.equal((await operation("retract", { scope: "shared", idempotencyKey: crypto.randomUUID(), reference: corrected.body.results[0].reference })).body.status, "applied")
	assert.equal((await operation("search", query)).body.results.length, 0)
	assert.equal((await operation("search", { ...query, recall: "historical" })).body.results[0].recall, "historical")
	console.log("PASS explicit shared search/capture/recall/correct/recall/retract, scoped HTTP/MCP retries and historical distinction")

	await post("/fixture/change", { action: "quota_reset" })
	await post("/fixture/change", { action: "demote_gateway_admin" })
	assert.equal((await operation("capture", { scope: "shared", idempotencyKey: crypto.randomUUID(), content: "Must deny" })).response.status, 403)
	assert.equal((await fetch(origin + "/brain/external/v1/skills", { headers: auth })).status, 403)
	const personal = await operation("capture", { idempotencyKey: crypto.randomUUID(), content: "Fictional own preference after demotion." })
	assert.equal(personal.response.status, 200, JSON.stringify(personal.body))
	assert.equal(personal.body.status, "applied")
	await post("/fixture/change", { action: "restore_gateway_admin" })
	console.log("PASS live demotion denies shared writes/skills while preserving default personal writes on the same connection")

	await post("/fixture/change", { action: "quota_reset" })
	await post("/fixture/change", { action: "slack_seed" })
	const privateQuery = { query: "ingested", scope: "private_channel" }
	const privateResult = await operation("search", privateQuery)
	assert.equal(privateResult.response.status, 200)
	assert.equal(privateResult.body.results[0].scope, "private_channel")
	assert.equal(privateResult.body.results[0].editable, false)
	await post("/fixture/change", { action: "slack_leave" })
	assert.equal((await operation("search", privateQuery)).body.results.length, 0)
	await post("/fixture/change", { action: "slack_error" })
	const failed = await operation("search", privateQuery)
	assert.equal(failed.response.status, 503)
	assert(!JSON.stringify(failed.body).includes("SECRET"))
	assert.equal((await operation("search", { ...privateQuery, channelId: "CGUESSED" })).response.status, 400)
	console.log("PASS strict private verifier in real Worker: current employee membership, bot-only denial, sanitized Slack error and guessed-channel rejection")
	return 4
}
