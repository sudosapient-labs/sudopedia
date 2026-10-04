import { ExternalError } from "./errors"
import { z } from "zod"

const identifier = z.string().min(1).max(256)
export const reconciliationSchema = z.strictObject({
	id: identifier,
	orgId: identifier,
	userId: identifier,
	requestHash: identifier,
	phase: z.enum(["preflight", "dispatched"]),
	providerAction: z.enum(["capture", "correct", "retract"]).nullable(),
	providerId: identifier.nullable(),
	targetFingerprint: identifier.nullable(),
	outcome: z.enum(["applied", "rejected"]),
	originalRequestStopped: z.boolean(),
	providerVerified: z.boolean(),
})
type Reconciliation = z.infer<typeof reconciliationSchema>

/** Operator-only CAS; intentionally NOT exposed through HTTP/MCP/admin settings.
 * Provider verification and termination of the original worker are mandatory
 * out-of-band steps. This helper never redispatches or interprets missing search
 * results as proof of rejection. Only non-content identifiers are persisted.
 */
export function reconciliationStatement(value: Reconciliation, now = Date.now()) {
	const parsed = reconciliationSchema.safeParse(value)
	if (!parsed.success) throw new ExternalError("invalid_input", 400, "Invalid reconciliation snapshot")
	const input = parsed.data
	if (!input.originalRequestStopped ||
		(input.phase === "dispatched" && !input.providerVerified) ||
		(input.phase === "dispatched" && (!input.providerAction ||
			(input.providerAction !== "capture" && (!input.providerId || !input.targetFingerprint)))) ||
		(input.phase === "preflight" && input.outcome !== "rejected"))
		throw new ExternalError("invalid_input", 400, "Reconciliation evidence required")
	return {
		sql: `UPDATE external_memory_operation SET state = ?, result = ?, reconciled_at = ?
		WHERE id = ? AND org_id = ? AND user_id = ? AND request_hash = ?
		AND phase = ? AND provider_action IS ? AND provider_id IS ? AND target_fingerprint IS ?
		AND state IN ('pending', 'unknown') AND reconciled_at IS NULL
		AND deadline_at <= ? RETURNING id`,
		bindings: [input.outcome,
		JSON.stringify({ status: input.outcome, searchable:
			input.outcome === "applied" && input.providerAction !== "retract" }),
		now, input.id, input.orgId, input.userId, input.requestHash, input.phase,
		input.providerAction, input.providerId, input.targetFingerprint, now],
	}
}

export async function reconcilePersonalOperation(env: Pick<Env, "DB">, input: Reconciliation) {
	const statement = reconciliationStatement(input)
	const row = await env.DB.prepare(statement.sql).bind(...statement.bindings).first()
	if (!row) throw new ExternalError("write_conflict", 409,
		"Reconciliation snapshot changed, is in flight, or is already finalized")
}
