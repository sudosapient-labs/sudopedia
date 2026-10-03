import assert from "node:assert/strict"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

// Also serves as a local primary-bot example: explicit tool calls, not automatic
// conversation observation. All identities/content/provider behavior are fictional.
export async function verifyPersonal(
	origin: string,
	connect: (secret: string) => Promise<Client>,
) {
	const post = async (
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	) => {
		const response = await fetch(origin + path, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000),
		}).catch((error) => {
			throw new Error(`Local personal fixture request failed: ${path}`, {
				cause: error,
			})
		})
		return { status: response.status, body: (await response.json()) as any }
	}
	const session = async (actor: string) => {
		const response = await fetch(`${origin}/fixture/session/${actor}`, {
			method: "POST",
		})
		return {
			Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
			Origin: origin,
			"X-Sudopedia-CSRF": "1",
		}
	}
	const aSession = await session("owner"),
		bSession = await session("member")
	console.log("Personal fixture sessions initialized")
	const mintBody = {
		kind: "personal",
		label: "Fictional primary bot",
		grants: [
			"memory.shared:read",
			"memory.personal:read",
			"memory.personal:write",
		],
		expiresInDays: 1,
		consent: true,
	}
	for (const bad of [
		{ ...mintBody, consent: false },
		{ ...mintBody, userId: "owner" },
		{ ...mintBody, orgId: "other" },
	])
		assert.equal(
			(await post("/brain/external-credentials/", bad, bSession)).status,
			400,
		)
	assert.equal(
		(
			await post(
				"/brain/external-credentials/",
				{ ...mintBody, grants: ["skills.org:read"] },
				bSession,
			)
		).status,
		403,
	)
	assert.equal(
		(
			await post(
				"/brain/external-credentials/",
				{ ...mintBody, kind: "organization", grants: ["memory.shared:read"] },
				bSession,
			)
		).status,
		403,
	)
	const a = await post("/brain/external-credentials/", mintBody, aSession)
	const b = await post("/brain/external-credentials/", mintBody, bSession)
	assert.equal(a.status, 201)
	assert.equal(b.status, 201)
	const aAuth = { Authorization: `Bearer ${a.body.secret}` },
		bAuth = { Authorization: `Bearer ${b.body.secret}` }
	const client = await connect(a.body.secret)
	const operation = (name: string, body: unknown, auth = aAuth) =>
		post(`/brain/external/v1/memory/${name}`, body, auth)
	const search = async (query: string, auth = aAuth) => {
		await post("/fixture/change", { action: "quota_reset" })
		const result = await operation("search", { query, limit: 20 }, auth)
		assert.equal(result.status, 200)
		return result.body.results as any[]
	}
	const aRows = await search("all personal"),
		bRows = await search("all personal", bAuth)
	assert(aRows.some((r) => r.scope === "shared" && !r.editable && !r.reference))
	assert(aRows.some((r) => r.text.includes("Employee A")))
	assert(
		!JSON.stringify(aRows).match(
			/Employee B|Private-channel|employee-a-preference/,
		),
	)
	assert(bRows.some((r) => r.text.includes("Employee B")))
	assert(!JSON.stringify(bRows).match(/Employee A|Private-channel/))
	assert.equal(
		(
			await operation(
				"correct",
				{
					idempotencyKey: crypto.randomUUID(),
					reference: aRows.find((r) => r.editable).reference,
					content: "Forbidden",
				},
				bAuth,
			)
		).status,
		404,
	)
	for (const ref of [
		crypto.randomUUID(),
		"fake-derived-memory",
		"private-channel-secret",
		"employee-b-preference",
	])
		assert(
			[400, 404].includes(
				(
					await operation("retract", {
						idempotencyKey: crypto.randomUUID(),
						reference: ref,
					})
				).status,
			),
		)
	assert.equal(
		(
			await operation("capture", {
				idempotencyKey: crypto.randomUUID(),
				content: "x",
				containerTag: "sm_org_shared",
			})
		).status,
		400,
	)
	assert.equal(
		(
			await operation("capture", {
				idempotencyKey: crypto.randomUUID(),
				content: "😀".repeat(2000),
			})
		).status,
		400,
	)
	console.log(
		"PASS fictional A/B shared-personal isolation, guessed/shared/private IDs, strict identity and write-size bounds",
	)

	// Employee: “I prefer concise weekly summaries.” Bot searches before capture.
	await search("weekly summaries")
	const capture = {
		idempotencyKey: crypto.randomUUID(),
		content: "The employee prefers concise weekly summaries.",
	}
	const saved = await client.callTool({
		name: "sudopedia_capture_memory",
		arguments: capture,
	})
	assert.deepEqual(
		saved.structuredContent,
		(await operation("capture", capture)).body,
	)
	assert.equal((saved.structuredContent as any).status, "applied")
	assert.equal(
		(await operation("capture", { ...capture, content: "Different fact" }))
			.status,
		409,
	)
	// Repeat with a different intent key: provider mock enforces exact-content dedup.
	assert.equal(
		(
			await operation("capture", {
				...capture,
				idempotencyKey: crypto.randomUUID(),
			})
		).status,
		200,
	)
	const remembered = (await search("weekly summaries")).filter(
		(r) => r.scope === "personal",
	)
	assert.equal(remembered.length, 1)
	assert.equal(remembered[0].text, capture.content)
	// Employee: “I now prefer detailed weekly summaries.” Bot supersedes, not adds.
	const correction = {
		idempotencyKey: crypto.randomUUID(),
		reference: remembered[0].reference,
		content: "The employee now prefers detailed weekly summaries.",
	}
	const changed = await client.callTool({
		name: "sudopedia_correct_memory",
		arguments: correction,
	})
	assert.deepEqual(
		changed.structuredContent,
		(await operation("correct", correction)).body,
	)
	const later = (await search("weekly summaries")).filter(
		(r) => r.scope === "personal",
	)
	assert.equal(later.length, 1)
	assert.equal(later[0].text, correction.content)
	assert.equal(
		(
			await operation("correct", {
				...correction,
				idempotencyKey: crypto.randomUUID(),
				content: "Stale update",
			})
		).status,
		409,
	)
	console.log(
		"PASS primary-bot loop: preference → search/capture → later recall → correction → changed recall; MCP/HTTP parity and retry dedup",
	)

	await post("/fixture/change", { action: "quota_reset" })
	const concurrent = await Promise.all(
		["brief", "extended"].map((style) =>
			operation("correct", {
				idempotencyKey: crypto.randomUUID(),
				reference: later[0].reference,
				content: `The employee prefers ${style} weekly summaries.`,
			}),
		),
	)
	assert.equal(concurrent.filter((r) => r.status === 200).length, 1)
	assert.equal(concurrent.filter((r) => r.status === 409).length, 1)
	const current = (await search("weekly summaries")).find((r) => r.editable)
	const retract = {
		idempotencyKey: crypto.randomUUID(),
		reference: current.reference,
	}
	const removed = await client.callTool({
		name: "sudopedia_retract_memory",
		arguments: retract,
	})
	assert.deepEqual(
		removed.structuredContent,
		(await operation("retract", retract)).body,
	)
	assert.equal(
		(await operation("status", { idempotencyKey: retract.idempotencyKey })).body
			.searchable,
		false,
	)
	assert.equal(
		(await search("weekly summaries")).filter((r) => r.scope === "personal")
			.length,
		0,
	)
	const stale = (await search("all personal")).find((r) =>
		r.text.includes("Employee A"),
	)
	await post("/fixture/change", {
		action: "stale_personal",
		id: "employee-a-preference",
	})
	assert.equal(
		(
			await operation("retract", {
				idempotencyKey: crypto.randomUUID(),
				reference: stale.reference,
			})
		).status,
		409,
	)
	console.log(
		"PASS concurrent gateway edits, provider-side stale snapshot, supersession and supported soft retraction",
	)

	const listing = (await fetch(origin + "/brain/external-credentials/", {
		headers: { Cookie: bSession.Cookie },
	}).then((r) => r.json())) as any
	assert(!JSON.stringify(listing).match(/secret_hash|sd_ext_/))
	assert(!listing.credentials.some((r: any) => r.id === a.body.id))
	await post(`/brain/external-credentials/${b.body.id}/revoke`, {}, aSession)
	assert.equal(
		(await operation("search", { query: "afternoon" }, bAuth)).status,
		200,
	) // admin cannot revoke/authorize another's personal credential
	const pendingInput = {
		idempotencyKey: crypto.randomUUID(),
		content: "pending fictional fact",
	}
	const pending = await operation("capture", pendingInput, bAuth)
	assert.equal(pending.body.status, "pending")
	assert.equal(pending.body.searchable, false)
	assert.deepEqual(
		(await operation("capture", pendingInput, bAuth)).body,
		pending.body,
	)
	assert.equal(
		(
			await operation(
				"capture",
				{
					idempotencyKey: crypto.randomUUID(),
					content: "Blocked by unresolved write",
				},
				bAuth,
			)
		).status,
		409,
	)
	const pendingStatus = await client.callTool({
		name: "sudopedia_memory_write_status",
		arguments: { idempotencyKey: capture.idempotencyKey },
	})
	assert.deepEqual(
		pendingStatus.structuredContent,
		(await operation("status", { idempotencyKey: capture.idempotencyKey }))
			.body,
	)
	await post("/fixture/change", { action: "deleted" })
	assert.equal(
		(await operation("status", { idempotencyKey: capture.idempotencyKey }))
			.status,
		401,
	)
	await post("/fixture/change", { action: "undelete" })
	await post("/fixture/change", { action: "quota_reset" })
	for (let i = 0; i < 4; i++)
		assert.equal((await operation("capture", capture)).status, 200)
	assert.equal(
		(
			await operation("capture", {
				idempotencyKey: crypto.randomUUID(),
				content: "Over write quota",
			})
		).status,
		429,
	)
	await post("/fixture/change", { action: "quota_reset" })
	console.log(
		"PASS personal deleted-user denial and combined durable write quota",
	)
	const failedInput = {
		idempotencyKey: crypto.randomUUID(),
		content: "provider failure",
	}
	const failed = await operation("capture", failedInput)
	assert.equal(failed.status, 502)
	assert(!JSON.stringify(failed.body).includes("SECRET"))
	assert.equal(
		(await operation("status", { idempotencyKey: failedInput.idempotencyKey }))
			.body.status,
		"unknown",
	)
	assert.equal((await operation("capture", failedInput)).body.status, "unknown")
	await post(`/brain/external-credentials/${a.body.id}/revoke`, {}, aSession)
	assert.equal(
		(await operation("status", { idempotencyKey: capture.idempotencyKey }))
			.status,
		401,
	)
	console.log(
		"PASS personal self-management, admin non-impersonation, pending/unknown honest receipts and revocation",
	)
	return 5
}
