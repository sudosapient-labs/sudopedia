import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"

/** Real local D1/Worker, fictional provider and operator evidence only. */
export async function verifyDurability(origin: string) {
	const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
		const response = await fetch(origin + path, { method: "POST",
			headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000) })
		return { status: response.status, body: await response.json() as any }
	}
	const session = await fetch(origin + "/fixture/session/delegate", { method: "POST" })
	const minted = await post("/brain/external-credentials/", {
		kind: "personal", label: "Fictional durability bot", expiresInDays: 1, consent: true,
		grants: ["memory.personal:read", "memory.personal:write"],
	}, { Cookie: session.headers.get("set-cookie")!.split(";")[0]!, Origin: origin, "X-Sudopedia-CSRF": "1" })
	assert.equal(minted.status, 201)
	const auth = { Authorization: `Bearer ${minted.body.secret}` }
	const operation = (name: string, input: unknown) => post(`/brain/external/v1/memory/${name}`, input, auth)
	const id = (key: string) => createHash("sha256").update(JSON.stringify(["org", "delegate", key])).digest("hex")
	const journal = async (key: string) => fetch(origin + `/fixture/journal/${id(key)}`).then((r) => r.json()) as Promise<any>
	const change = (action: string, key?: string) => post("/fixture/change", { action, id: key ? id(key) : undefined })

	const abandoned = randomUUID()
	await change("claim_preflight", abandoned)
	await change("expire_preflight", abandoned)
	assert.equal((await operation("status", { idempotencyKey: abandoned })).body.status, "rejected")
	const captureKey = randomUUID()
	assert.equal((await operation("capture", { idempotencyKey: captureKey, content: "Fictional durable recovery preference." })).body.status, "applied")
	assert.equal((await journal(captureKey)).phase, "dispatched")
	console.log("PASS real-D1 preflight crash recovery and durable dispatch phase")

	const search = await operation("search", { query: "recovery preference", limit: 20 })
	const reference = search.body.results.find((r: any) => r.editable).reference
	const retractKey = randomUUID()
	await change("journal_failure")
	const failed = await operation("retract", { idempotencyKey: retractKey, reference })
	assert.equal(failed.status, 502)
	const receipt = await operation("status", { idempotencyKey: retractKey })
	assert.equal(receipt.body.status, "unknown")
	const row = await journal(retractKey)
	assert.equal(row.operation, "retract")
	assert.equal(row.provider_action, "retract")
	assert(row.provider_id && row.target_fingerprint)
	assert.equal((await operation("capture", { idempotencyKey: randomUUID(), content: "Must remain blocked" })).status, 409)
	console.log("PASS real-D1 provider success/journal failure keeps an identifiable owner lock")

	await change("expire_preflight", retractKey) // Only fixture-clock manipulation; no production lock expiry.
	const reconciliation = { id: row.id, orgId: row.org_id, userId: row.user_id, requestHash: row.request_hash,
		phase: row.phase, providerAction: row.provider_action, providerId: row.provider_id,
		targetFingerprint: row.target_fingerprint, outcome: "applied", originalRequestStopped: true, providerVerified: true }
	assert.equal((await post("/fixture/reconcile", { ...reconciliation, providerVerified: false })).status, 400)
	assert.equal((await post("/fixture/reconcile", { ...reconciliation, providerId: "wrong" })).status, 409)
	assert.equal((await post("/fixture/reconcile", reconciliation)).status, 200)
	assert.equal((await operation("status", { idempotencyKey: retractKey })).body.status, "applied")
	assert.equal((await operation("status", { idempotencyKey: retractKey })).body.searchable, false)
	await change("quota_reset")
	assert.equal((await operation("capture", { idempotencyKey: randomUUID(), content: "Fictional writes resumed after reconciliation." })).body.status, "applied")
	console.log("PASS real-D1 exact-snapshot operator reconciliation, no blind redispatch")
	return 3
}
