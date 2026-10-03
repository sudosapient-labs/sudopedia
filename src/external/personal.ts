import type { Principal, WriteInput, RetractInput } from "./contracts"
import { hashSecret } from "./credentials"
import { ExternalError } from "./errors"

export type PersonalEntry = {
	id: string
	memory: string
	updatedAt: string
	isLatest?: boolean
	isForgotten?: boolean
	forgetAfter?: string | null
	metadata?: Record<string, string | number | boolean | string[]> | null
}
export type WriteResult = {
	status: "applied" | "pending" | "unknown" | "rejected"
	idempotencyKey: string
	searchable: boolean
}
export type PersonalProvider = {
	// Always a scoped, bounded latest-entry lookup. No unscoped get-by-ID.
	find: (
		owner: Principal,
		id: string,
		signal: AbortSignal,
	) => Promise<PersonalEntry | null>
	mutate: (
		owner: Principal,
		operation: "capture" | "correct" | "retract",
		input: WriteInput | RetractInput,
		providerId: string | undefined,
		operationId: string,
		signal: AbortSignal,
		context: {
			current?: PersonalEntry
			// Call immediately before dispatching a memory mutation, not preflight reads.
			onDispatch: () => void
		},
	) => Promise<{ status: "applied" | "pending" }>
}
export type Reference = { provider_id: string; fingerprint: string }
export type Journal = {
	request_hash: string
	state: string
	result: string | null
}
export type PersonalStore = {
	reference: (owner: Principal, entry: PersonalEntry) => Promise<string>
	lookup: (owner: Principal, reference: string) => Promise<Reference | null>
	read: (id: string) => Promise<Journal | null>
	claim: (owner: Principal, id: string, hash: string) => Promise<boolean>
	finish: (id: string, result: WriteResult) => Promise<void>
}
export const fingerprint = (entry: PersonalEntry) =>
	hashSecret(JSON.stringify([entry.id, entry.memory, entry.updatedAt]))
export const operationId = (owner: Principal, key: string) =>
	hashSecret(JSON.stringify([owner.orgId, owner.userId, key]))

export function personalStore(env: Pick<Env, "DB">): PersonalStore {
	return {
		async reference(owner, entry) {
			const fp = await fingerprint(entry)
			const digest = await hashSecret(
				JSON.stringify([owner.orgId, owner.userId, fp]),
			)
			const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
			await env.DB.prepare(
				"DELETE FROM external_memory_reference WHERE org_id = ? AND user_id = ? AND created_at < ?",
			)
				.bind(owner.orgId, owner.userId, Date.now() - 86400000)
				.run()
			await env.DB.prepare(
				`INSERT OR IGNORE INTO external_memory_reference
				(id, org_id, user_id, provider_id, fingerprint, created_at)
				SELECT ?, ?, ?, ?, ?, ? WHERE
				(SELECT COUNT(*) FROM external_memory_reference WHERE org_id = ? AND user_id = ?) < 1000`,
			)
				.bind(
					id,
					owner.orgId,
					owner.userId,
					entry.id,
					fp,
					Date.now(),
					owner.orgId,
					owner.userId,
				)
				.run()
			if (!(await this.lookup(owner, id)))
				throw new ExternalError(
					"reference_limit",
					429,
					"Personal reference limit reached",
				)
			return id
		},
		lookup: (owner, ref) =>
			env.DB.prepare(
				`SELECT provider_id, fingerprint FROM external_memory_reference
			WHERE id = ? AND org_id = ? AND user_id = ? AND created_at >= ?`,
			)
				.bind(ref, owner.orgId, owner.userId, Date.now() - 86400000)
				.first<Reference>(),
		read: (id) =>
			env.DB.prepare(
				"SELECT request_hash, state, result FROM external_memory_operation WHERE id = ?",
			)
				.bind(id)
				.first<Journal>(),
		async claim(owner, id, hash) {
			const row = await env.DB.prepare(
				`INSERT OR IGNORE INTO external_memory_operation
				(id, org_id, user_id, request_hash, state, created_at)
				SELECT ?, ?, ?, ?, 'pending', ? WHERE
				NOT EXISTS (SELECT 1 FROM external_memory_operation WHERE org_id = ? AND user_id = ? AND state IN ('pending', 'unknown'))
				AND (SELECT COUNT(*) FROM external_memory_operation WHERE org_id = ? AND user_id = ?) < 10000 RETURNING id`,
			)
				.bind(
					id,
					owner.orgId,
					owner.userId,
					hash,
					Date.now(),
					owner.orgId,
					owner.userId,
					owner.orgId,
					owner.userId,
				)
				.first()
			return Boolean(row)
		},
		async finish(id, result) {
			await env.DB.prepare(
				"UPDATE external_memory_operation SET state = ?, result = ? WHERE id = ?",
			)
				.bind(result.status, JSON.stringify(result), id)
				.run()
		},
	}
}

/** Durable at-most-once dispatch. An uncertain network outcome is NOT a failed write. */
export async function maintainPersonal(
	store: PersonalStore,
	provider: PersonalProvider,
	owner: Principal,
	operation: "capture" | "correct" | "retract" | "status",
	input: WriteInput | RetractInput | { idempotencyKey: string },
	signal: AbortSignal,
): Promise<WriteResult> {
	const id = await operationId(owner, input.idempotencyKey)
	const { idempotencyKey: _key, ...intent } = input
	const hash = await hashSecret(JSON.stringify([operation, intent]))
	const prior = await store.read(id)
	const replay = (row: Journal): WriteResult => {
		if (operation !== "status" && row.request_hash !== hash)
			throw new ExternalError(
				"idempotency_conflict",
				409,
				"Idempotency key already used for different input",
			)
		return row.result
			? { ...JSON.parse(row.result), idempotencyKey: input.idempotencyKey }
			: {
					status: "pending",
					idempotencyKey: input.idempotencyKey,
					searchable: false,
				}
	}
	if (prior) return replay(prior)
	if (operation === "status")
		throw new ExternalError("not_found", 404, "Write not found")
	let reference: Reference | null = null
	if (operation !== "capture") {
		reference = await store.lookup(owner, (input as RetractInput).reference)
		if (!reference)
			throw new ExternalError(
				"not_found",
				404,
				"Personal memory reference unavailable; search again",
			)
	}
	if (!(await store.claim(owner, id, hash))) {
		const raced = await store.read(id)
		if (raced) return replay(raced)
		throw new ExternalError(
			"write_conflict",
			409,
			"Another personal write is unresolved or journal capacity reached",
		)
	}
	let dispatched = false
	let current: PersonalEntry | undefined
	try {
		if (reference) {
			current =
				(await provider.find(owner, reference.provider_id, signal)) ?? undefined
			if (
				!current ||
				current.isLatest === false ||
				current.isForgotten ||
				(current.forgetAfter &&
					Date.parse(current.forgetAfter) <= Date.now()) ||
				(await fingerprint(current)) !== reference.fingerprint
			)
				throw new ExternalError(
					"stale_reference",
					409,
					"Personal memory changed or is unavailable; search again",
				)
		}
		signal.throwIfAborted()
		const response = await provider.mutate(
			owner,
			operation,
			input as WriteInput | RetractInput,
			reference?.provider_id,
			id,
			signal,
			{
				current,
				onDispatch: () => {
					signal.throwIfAborted()
					dispatched = true
				},
			},
		)
		const result: WriteResult = {
			status: response.status,
			idempotencyKey: input.idempotencyKey,
			searchable: response.status === "applied" && operation !== "retract",
		}
		await store.finish(id, result)
		return result
	} catch (error) {
		// No automatic redispatch after timeout, provider failure, malformed response,
		// or a crash between provider success and journal commit.
		await store.finish(id, {
			status: dispatched ? "unknown" : "rejected",
			idempotencyKey: input.idempotencyKey,
			searchable: false,
		})
		if (error instanceof ExternalError) throw error
		throw new ExternalError(
			signal.aborted ? "upstream_timeout" : "upstream_failure",
			signal.aborted ? 504 : 502,
			dispatched
				? "Write outcome unknown; check status and do not submit a new key"
				: "Personal memory verification unavailable",
		)
	}
}
