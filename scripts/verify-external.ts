import assert from "node:assert/strict"
import { unstable_dev } from "wrangler"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { verifyPersonal } from "./verify-personal.ts"
import { verifyDurability } from "./verify-durability.ts"
import { verifyAvailability } from "./verify-availability.ts"
import { verifyGatewayV2 } from "./verify-gateway-v2.ts"

// Isolated, ephemeral local workerd + D1 + SQLite DO. No remote bindings/providers.
const worker = await unstable_dev("test/external/worker.ts", {
	config: "test/external/wrangler.jsonc",
	ip: "127.0.0.1",
	port: 8799,
	local: true,
	persist: false,
	logLevel: "error",
	experimental: {
		disableExperimentalWarning: true,
		disableDevRegistry: true,
		watch: false,
	},
})
console.log("Local fixture Worker started")
const origin = `http://127.0.0.1:${worker.port}`
const clients: Client[] = []
let checks = 0
function passed(message: string) {
	checks++
	console.log(`PASS ${message}`)
}
async function json(path: string, init: RequestInit = {}) {
	const response = await fetch(origin + path, {
		...init,
		signal: AbortSignal.timeout(15000),
	}).catch((error) => {
		throw new Error(`Local fixture request failed: ${path}`, { cause: error })
	})
	return { response, body: (await response.json()) as any }
}
async function post(
	path: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return json(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	})
}
async function connect(secret: string) {
	const client = new Client({
		name: "sudopedia-local-verifier",
		version: "1.0.0",
	})
	clients.push(client)
	await client.connect(
		new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
			requestInit: { headers: { Authorization: `Bearer ${secret}` } },
		}),
	)
	return client
}
try {
	const { body: skills } = await post("/fixture/seed", {})
	const session = await post("/fixture/session/owner", {})
	const cookie = session.response.headers.get("set-cookie")!.split(";")[0]!
	const management = {
		Cookie: cookie,
		Origin: origin,
		"X-Sudopedia-CSRF": "1",
	}
	checks += await verifyPersonal(origin, connect)
	checks += await verifyDurability(origin)
	checks += await verifyGatewayV2(origin, connect)
	await post("/fixture/change", { action: "quota_reset" })
	const mint = async (grants: string[]) => {
		const result = await post(
			"/brain/external-credentials/",
			{
				label: "Fictional SDK integration",
				grants,
				expiresInDays: 7,
				consent: true,
			},
			management,
		)
		assert.equal(result.response.status, 201)
		assert.equal(result.response.headers.get("cache-control"), "no-store")
		return result.body as { id: string; secret: string }
	}
	const credential = await mint(["memory.shared:read", "skills.org:read"])
	const auth = { Authorization: `Bearer ${credential.secret}` }
	const client = await connect(credential.secret)
	const tools = await client.listTools()
	assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
		"sudopedia_capture_memory",
		"sudopedia_correct_memory",
		"sudopedia_list_skills",
		"sudopedia_load_skill",
		"sudopedia_memory_write_status",
		"sudopedia_retract_memory",
		"sudopedia_search_memory",
	])
	passed(
		"SDK initialize/version negotiation and discovery of seven tools in workerd",
	)
	const listed = await client.callTool({
		name: "sudopedia_list_skills",
		arguments: {},
	})
	const httpList = await json("/brain/external/v1/skills", { headers: auth })
	assert.deepEqual(listed.structuredContent, httpList.body)
	assert.equal(httpList.body.skills.length, 1)
	assert.equal(httpList.body.skills[0].id, skills.orgId)
	assert(!JSON.stringify(listed).match(/PERSONAL|DISABLED|body|system:/))
	passed(
		"HTTP/MCP skill-index parity, org-only projection, personal-name collision and no bodies",
	)
	const search = await client.callTool({
		name: "sudopedia_search_memory",
		arguments: { query: "Aurora release", topicTags: ["project_aurora"] },
	})
	const httpSearch = await post(
		"/brain/external/v1/memory/search",
		{ query: "Aurora release", topicTags: ["project_aurora"] },
		auth,
	)
	assert.deepEqual(search.structuredContent, httpSearch.body)
	assert.equal(httpSearch.body.results[0].id.kind, "memory")
	const stats = async () => (await json(`/fixture/stats/${skills.orgId}`)).body
	assert.equal(
		(await stats()).lastProviderRequest.containerTag,
		"sm_org_shared",
	)
	assert.deepEqual((await stats()).lastProviderRequest.filters, {
		OR: [
			{
				key: "brain_tags",
				value: "project_aurora",
				filterType: "array_contains",
				negate: false,
			},
		],
	})
	passed(
		"Shared-only fake memory retrieval, canonical topic filter and HTTP/MCP parity",
	)
	const load = await client.callTool({
		name: "sudopedia_load_skill",
		arguments: { id: skills.orgId, expectedVersion: 1 },
	})
	const httpLoad = await post(
		"/brain/external/v1/skills/load",
		{ id: skills.orgId, expectedVersion: 1 },
		auth,
	)
	assert.deepEqual(load.structuredContent, httpLoad.body)
	assert(
		(load.content as { text: string }[])[0]!.text.includes("# Release review"),
	)
	assert.equal((await stats()).usage, 2)
	for (const id of [
		skills.personalId,
		skills.disabledId,
		crypto.randomUUID(),
	]) {
		const result = await post("/brain/external/v1/skills/load", { id }, auth)
		assert.equal(result.response.status, 404)
		assert.equal(result.body.error.message, "Skill not found")
	}
	assert.equal(
		(
			await post(
				"/brain/external/v1/skills/load",
				{ id: skills.orgId, expectedVersion: 2 },
				auth,
			)
		).response.status,
		409,
	)
	assert.equal((await stats()).usage, 2)
	passed(
		"Skill load parity, private/disabled/guessed IDs, version conflict and successful-only accounting",
	)
	await post("/fixture/change", {
		action: "oversized_skill",
		id: skills.orgId,
	})
	assert.equal(
		(await post("/brain/external/v1/skills/load", { id: skills.orgId }, auth))
			.response.status,
		502,
	)
	assert.equal((await stats()).usage, 2)
	const boundedSearch = await client.callTool({
		name: "sudopedia_search_memory",
		arguments: { query: "large unicode", limit: 20 },
	})
	assert.equal((boundedSearch.structuredContent as any).truncated, true)
	assert.equal(
		(boundedSearch.structuredContent as any).results[0].textTruncated,
		true,
	)
	assert(Buffer.byteLength(JSON.stringify(boundedSearch)) < 65536)
	passed(
		"Readable skill Markdown, Unicode snippet/output caps and oversized-load accounting",
	)
	const before = (await stats()).providerCalls
	for (const field of [
		"orgId",
		"userId",
		"slackUserId",
		"admin",
		"containerTag",
		"containerTagsOverride",
		"filters",
	])
		assert.equal(
			(
				await post(
					"/brain/external/v1/memory/search",
					{ query: "Aurora", [field]: "private" },
					auth,
				)
			).response.status,
			400,
		)
	const forged = await client.callTool({
		name: "sudopedia_search_memory",
		arguments: { query: "Aurora", containerTag: "user_owner" },
	})
	assert.equal(forged.isError, true)
	assert.equal((await stats()).providerCalls, before)
	passed("Forged private scope rejected by both adapters before provider calls")
	const batched = await post(
		"/mcp",
		[
			{
				jsonrpc: "2.0",
				id: 81,
				method: "tools/call",
				params: {
					name: "sudopedia_search_memory",
					arguments: { query: "Aurora" },
				},
			},
			{
				jsonrpc: "2.0",
				id: 82,
				method: "tools/call",
				params: {
					name: "sudopedia_search_memory",
					arguments: { query: "Aurora" },
				},
			},
		],
		{ ...auth, Accept: "application/json, text/event-stream" },
	)
	assert.equal(batched.response.status, 400)
	assert.equal((await stats()).providerCalls, before)
	const skillOnly = await mint(["skills.org:read"])
	const other = await connect(skillOnly.secret)
	assert.equal(
		(
			await other.callTool({
				name: "sudopedia_search_memory",
				arguments: { query: "Aurora" },
			})
		).isError,
		true,
	)
	assert.equal(
		(
			await client.callTool({
				name: "sudopedia_search_memory",
				arguments: { query: "Aurora" },
			})
		).isError,
		undefined,
	)
	await post("/fixture/change", {
		action: "grants",
		id: credential.id,
		grants: ["skills.org:read"],
	})
	assert.equal(
		(
			await client.callTool({
				name: "sudopedia_search_memory",
				arguments: { query: "Aurora" },
			})
		).isError,
		true,
	)
	assert.equal(
		(await other.callTool({ name: "sudopedia_list_skills", arguments: {} }))
			.isError,
		undefined,
	)
	passed(
		"Cross-token isolation and live grant enforcement after SDK initialization",
	)
	await post("/fixture/change", { action: "deleted" })
	assert.equal(
		(await json("/brain/external/v1/skills", { headers: auth })).response
			.status,
		401,
	)
	await post("/fixture/change", { action: "undelete" })
	const delegatedSession = await post("/fixture/session/delegate", {})
	const delegated = await post(
		"/brain/external-credentials/",
		{
			label: "Fictional admin",
			grants: ["memory.shared:read"],
			expiresInDays: 1,
			consent: true,
		},
		{
			...management,
			Cookie: delegatedSession.response.headers
				.get("set-cookie")!
				.split(";")[0]!,
		},
	)
	assert.equal(delegated.response.status, 201)
	const delegatedAuth = { Authorization: `Bearer ${delegated.body.secret}` }
	assert.equal(
		(
			await post(
				"/brain/external/v1/memory/search",
				{ query: "Aurora" },
				delegatedAuth,
			)
		).response.status,
		200,
	)
	assert.equal(
		(await stats()).lastProviderRequest.containerTag,
		"sm_org_shared",
	)
	await post("/fixture/change", { action: "remove_member" })
	assert.equal(
		(
			await post(
				"/brain/external/v1/memory/search",
				{ query: "Aurora" },
				delegatedAuth,
			)
		).response.status,
		401,
	)
	await post("/fixture/change", { action: "restore_member" })
	assert.equal(
		(
			await post(
				"/brain/external/v1/memory/search",
				{ query: "Aurora" },
				delegatedAuth,
			)
		).response.status,
		401,
	)
	const expired = await mint(["memory.shared:read"])
	await post("/fixture/change", { action: "expire", id: expired.id })
	for (const header of [
		{},
		{ Authorization: "Bearer malformed" },
		{ Authorization: `Bearer ${expired.secret}` },
	])
		assert.equal(
			(
				await post(
					"/brain/external/v1/memory/search",
					{ query: "Aurora" },
					header,
				)
			).response.status,
			401,
		)
	passed(
		"Missing/malformed/expired credentials, deleted users and removed members fail closed",
	)
	const managementList = await json("/brain/external-credentials/", {
		headers: { Cookie: cookie },
	})
	assert(
		!JSON.stringify(managementList.body).match(
			/sd_ext_|secret_hash|secretHash/,
		),
	)
	const memberSession = await post("/fixture/session/member", {})
	assert.equal(
		(
			await json("/brain/external-credentials/", {
				headers: {
					Cookie: memberSession.response.headers
						.get("set-cookie")!
						.split(";")[0]!,
				},
			})
		).response.status,
		200,
	)
	assert.equal(
		(await json("/brain/external-credentials/", { headers: auth })).response
			.status,
		401,
	)
	for (const headers of [
		{ Cookie: cookie },
		{ ...management, Origin: "https://evil.example" },
		{ Cookie: cookie, Origin: origin },
	])
		assert.equal(
			(
				await post(
					`/brain/external-credentials/${credential.id}/revoke`,
					{},
					headers,
				)
			).response.status,
			403,
		)
	passed(
		"Session-only management, member personal listing, hash/secret omission and Origin+CSRF protection",
	)
	for (const method of ["GET", "DELETE", "PUT"])
		assert.equal(
			(await fetch(origin + "/mcp", { method, headers: auth })).status,
			405,
		)
	const rpcHeaders = { ...auth, Accept: "application/json, text/event-stream" }
	assert.equal(
		(
			await post(
				"/mcp",
				{ jsonrpc: "2.0", id: 11, method: "unknown" },
				rpcHeaders,
			)
		).body.error.code,
		-32601,
	)
	assert.equal(
		(await client.callTool({ name: "unknown", arguments: {} })).isError,
		true,
	)
	assert.equal(
		(
			await post(
				"/mcp",
				{ jsonrpc: "2.0", id: 12, method: "tools/list" },
				{ ...rpcHeaders, "MCP-Protocol-Version": "unsupported" },
			)
		).response.status,
		400,
	)
	assert.equal(
		(await post("/mcp", { jsonrpc: "2.0", id: 13, method: "tools/list" }, auth))
			.response.status,
		406,
	)
	assert.equal(
		(
			await fetch(origin + "/brain/external/v1/skills", {
				headers: { ...auth, Origin: "null" },
			})
		).status,
		403,
	)
	assert.equal(
		(
			await fetch(origin + "/brain/external/v1/skills?token=forbidden", {
				headers: auth,
			})
		).status,
		400,
	)
	assert.equal(
		(
			await fetch(origin + "/brain/external/v1/memory/search", {
				method: "POST",
				headers: { ...auth, "Content-Type": "application/json" },
				body: "😀".repeat(17000),
			})
		).status,
		413,
	)
	passed(
		"Unsupported tools/methods/version, required headers, Origin, URL tokens and 64-KiB request cap",
	)
	await post("/fixture/change", { action: "quota_reset" })
	const costToken = await mint(["memory.shared:read"])
	const costAuth = { Authorization: `Bearer ${costToken.secret}` }
	const failure = await post(
		"/brain/external/v1/memory/search",
		{ query: "provider failure" },
		costAuth,
	)
	assert.equal(failure.response.status, 502)
	assert(!JSON.stringify(failure.body).includes("SECRET"))
	for (let i = 0; i < 3; i++)
		assert.equal(
			(
				await post(
					"/brain/external/v1/memory/search",
					{ query: "Aurora" },
					costAuth,
				)
			).response.status,
			200,
		)
	const counted = (await stats()).providerCalls
	assert.equal(
		(
			await post(
				"/brain/external/v1/memory/search",
				{ query: "Aurora" },
				costAuth,
			)
		).response.status,
		429,
	)
	assert.equal((await stats()).providerCalls, counted)
	passed(
		"Sanitized upstream failure and durable daily quota before provider calls",
	)
	assert.equal((await post("/fixture/rate-limit", {})).body.rejected, 1)
	passed(
		"Supported Worker rate limiter enforces the configured 60-request burst bound",
	)
	assert.equal(
		(
			await post(
				`/brain/external-credentials/${credential.id}/revoke`,
				{},
				management,
			)
		).response.status,
		200,
	)
	await assert.rejects(
		client.callTool({ name: "sudopedia_list_skills", arguments: {} }),
	)
	assert.equal(
		(await json("/brain/external/v1/skills", { headers: auth })).response
			.status,
		401,
	)
	assert.equal(
		(await other.callTool({ name: "sudopedia_list_skills", arguments: {} }))
			.isError,
		undefined,
	)
	passed(
		"Revocation denies the next SDK/HTTP call without disrupting another integration",
	)
	checks += await verifyAvailability(origin, connect)
	console.log(
		`${checks} workerd verification groups passed; fake providers only.`,
	)
} finally {
	await Promise.all(clients.map((client) => client.close().catch(() => {})))
	await worker.stop()
}
