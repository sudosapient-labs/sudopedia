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
	// List responses permit arbitrary JSON; mutation metadata has a narrower contract.
	metadata?: Record<string, unknown> | null
}
export type WriteResult = {
	scope?: "shared"
	status: "applied" | "pending" | "unknown" | "rejected"
	idempotencyKey: string
	searchable: boolean
}
export type Mutation = "capture" | "correct" | "retract"
export type Dispatch = {
	action: Mutation
	providerId?: string
	fingerprint?: string
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
			onDispatch: (dispatch: Dispatch) => Promise<void>
		},
	) => Promise<{ status: "applied" | "pending" }>
}
export type Reference = { provider_id: string; fingerprint: string }
export type Journal = {
	request_hash: string
	state: string
	result: string | null
}
export type Intent = {
	operation: Mutation
	providerId?: string
	fingerprint?: string
}
export type PersonalStore = {
	scope?: "shared"
	reference: (owner: Principal, entry: PersonalEntry) => Promise<string>
	// Aligned with entries; null means bounded edit capacity, not a read failure.
	references: (owner: Principal, entries: PersonalEntry[], signal?: AbortSignal) => Promise<(string | null)[]>
	lookup: (owner: Principal, reference: string) => Promise<Reference | null>
	read: (id: string) => Promise<Journal | null>
	claim: (owner: Principal, id: string, hash: string, intent: Intent) => Promise<boolean>
	dispatch: (id: string, dispatch: Dispatch) => Promise<void>
	finish: (id: string, result: WriteResult) => Promise<void>
}
// A preflight worker cannot dispatch after this deadline, including after a crash
// or a delayed DB response. The atomic dispatch transition fences expired claims.
export const PREFLIGHT_MS = 8000
export const fingerprint = (entry: PersonalEntry) =>
	hashSecret(JSON.stringify([entry.id, entry.memory, entry.updatedAt]))
export async function referenceId(owner: Principal, entry: PersonalEntry, scope?: "shared") {
	const fp = await fingerprint(entry)
	const digest = await hashSecret(JSON.stringify(scope
		? [scope, owner.orgId, owner.userId, fp] : [owner.orgId, owner.userId, fp]))
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
export const operationId = (owner: Principal, key: string, scope?: "shared") =>
	hashSecret(JSON.stringify(scope
		? [scope, owner.orgId, owner.userId, key] : [owner.orgId, owner.userId, key]))

export function personalStore(env: Pick<Env, "DB">): PersonalStore {
	return memoryStore(env)
}
export function sharedStore(env: Pick<Env, "DB">): PersonalStore {
	return memoryStore(env, "shared")
}
// Scope adapters are selected by the server. References stay actor-bound;
// coordination is employee-wide for personal, organization-wide for shared.
function memoryStore(env: Pick<Env, "DB">, scope?: "shared"): PersonalStore {
	const label = scope ? "Shared" : "Personal"
	const referenceTable = scope ? "external_shared_reference" : "external_memory_reference"
	const operationTable = scope ? "external_shared_operation" : "external_memory_operation"
	const domain = scope ? "org_id = ?" : "org_id = ? AND user_id = ?"
	const domainBindings = (owner: Principal) => scope ? [owner.orgId] : [owner.orgId, owner.userId]
	return {
		...(scope ? { scope } : {}),
		async reference(owner, entry) {
			const [id] = await this.references(owner, [entry])
			if (!id)
				throw new ExternalError("reference_limit", 429, `${label} reference limit reached`)
			return id
		},
		async references(owner, entries, signal) {
			if (!entries.length) return []
			if (entries.length > 20)
				throw new ExternalError("invalid_input", 400, `Too many ${label.toLowerCase()} references`)
			const now = Date.now()
			const snapshots = await Promise.all(entries.map(async (entry) => ({
				entry, id: await referenceId(owner, entry, scope), fp: await fingerprint(entry),
			})))
			// One sweep and one verification per search, not three statements per row.
			// Each insertion's capacity check remains atomic under concurrent requests.
			signal?.throwIfAborted()
			await env.DB.prepare(
				`DELETE FROM ${referenceTable} WHERE org_id = ? AND user_id = ? AND created_at < ?`,
			)
				.bind(owner.orgId, owner.userId, now - 86400000)
				.run()
			for (const { entry, id, fp } of snapshots) {
				signal?.throwIfAborted()
				await env.DB.prepare(
					`INSERT OR IGNORE INTO ${referenceTable}
					(id, org_id, user_id, provider_id, fingerprint, created_at)
					SELECT ?, ?, ?, ?, ?, ? WHERE
					(SELECT COUNT(*) FROM ${referenceTable} WHERE org_id = ? AND user_id = ?) < 1000`,
				)
					.bind(id, owner.orgId, owner.userId, entry.id, fp, now, owner.orgId, owner.userId)
					.run()
			}
			signal?.throwIfAborted()
			const rows = await env.DB.prepare(
				`SELECT id FROM ${referenceTable} WHERE org_id = ? AND user_id = ?
				AND created_at >= ? AND id IN (${snapshots.map(() => "?").join(",")})`,
			).bind(owner.orgId, owner.userId, now - 86400000, ...snapshots.map((s) => s.id)).all<{ id: string }>()
			const present = new Set(rows.results.map((r) => r.id))
			return snapshots.map((s) => present.has(s.id) ? s.id : null)
		},
		lookup: (owner, ref) =>
			env.DB.prepare(
				`SELECT provider_id, fingerprint FROM ${referenceTable}
			WHERE id = ? AND org_id = ? AND user_id = ? AND created_at >= ?`,
			)
				.bind(ref, owner.orgId, owner.userId, Date.now() - 86400000)
				.first<Reference>(),
		async read(id) {
			await env.DB.prepare(
				`UPDATE ${operationTable} SET state = 'rejected', result =
				'{"status":"rejected","searchable":false}'
				WHERE id = ? AND state = 'pending' AND phase = 'preflight' AND deadline_at <= ?`,
			).bind(id, Date.now()).run()
			return env.DB.prepare(
				`SELECT request_hash, state, result FROM ${operationTable} WHERE id = ?`,
			)
				.bind(id)
				.first<Journal>()
		},
		async claim(owner, id, hash, intent) {
			const now = Date.now()
			await env.DB.prepare(
				`UPDATE ${operationTable} SET state = 'rejected', result =
				'{"status":"rejected","searchable":false}'
				WHERE ${domain} AND state = 'pending'
				AND phase = 'preflight' AND deadline_at <= ?`,
			).bind(...domainBindings(owner), now).run()
			const row = await env.DB.prepare(
				`INSERT OR IGNORE INTO ${operationTable}
					(id, org_id, user_id, request_hash, state, created_at,
					operation, phase, provider_id, target_fingerprint, deadline_at)
					SELECT ?, ?, ?, ?, 'pending', ?, ?, 'preflight', ?, ?, ? WHERE
				NOT EXISTS (SELECT 1 FROM ${operationTable} WHERE ${domain} AND state IN ('pending', 'unknown'))
				AND (SELECT COUNT(*) FROM ${operationTable} WHERE ${domain}) < 10000 RETURNING id`,
			)
				.bind(
					id,
					owner.orgId,
					owner.userId,
					hash,
						now,
						intent.operation,
						intent.providerId ?? null,
						intent.fingerprint ?? null,
						now + PREFLIGHT_MS,
					...domainBindings(owner),
					...domainBindings(owner),
				)
				.first()
			return Boolean(row)
		},
		async dispatch(id, dispatch) {
			const now = Date.now()
			const row = await env.DB.prepare(
				`UPDATE ${operationTable} SET phase = 'dispatched',
				provider_action = ?, provider_id = ?, target_fingerprint = ?, dispatched_at = ?
				WHERE id = ? AND state = 'pending' AND phase = 'preflight'
				AND deadline_at > ? RETURNING id`,
			).bind(dispatch.action, dispatch.providerId ?? null,
				dispatch.fingerprint ?? null, now, id, now).first()
			if (!row) throw new ExternalError("write_conflict", 409,
				`${label} write preflight expired; check status before a new intent`)
		},
		async finish(id, result) {
			const row = await env.DB.prepare(
					`UPDATE ${operationTable} SET state = ?, result = ? WHERE id = ? AND state IN ('pending', 'unknown') AND reconciled_at IS NULL RETURNING id`,
			)
				.bind(result.status, JSON.stringify(result), id)
					.first()
			if (!row) {
				const prior = await this.read(id)
				if (result.status === "rejected" && prior?.state === "rejected") return
				throw new ExternalError("write_conflict", 409, "Write receipt already finalized; check status")
			}
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
	const label = store.scope ? "Shared" : "Personal"
	const id = await operationId(owner, input.idempotencyKey, store.scope)
	// Omitted and explicit personal scope preserve the legacy request identity.
	const { idempotencyKey: _key, scope: _scope, ...intent } = input as WriteInput
	const hash = await hashSecret(JSON.stringify(store.scope
		? [store.scope, operation, intent] : [operation, intent]))
	const prior = await store.read(id)
	const replay = (row: Journal): WriteResult => {
		if (operation !== "status" && row.request_hash !== hash)
			throw new ExternalError(
				"idempotency_conflict",
				409,
				"Idempotency key already used for different input",
			)
		const result = row.result
			? { ...JSON.parse(row.result), idempotencyKey: input.idempotencyKey }
			: {
					status: "pending",
					idempotencyKey: input.idempotencyKey,
					searchable: false,
				}
		return { ...result, ...(store.scope ? { scope: store.scope } : {}) }
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
				`${label} memory reference unavailable; search again`,
			)
	}
	if (!(await store.claim(owner, id, hash, {
		operation,
		providerId: reference?.provider_id,
		fingerprint: reference?.fingerprint,
	}))) {
		const raced = await store.read(id)
		if (raced) return replay(raced)
		throw new ExternalError(
			"write_conflict",
			409,
			`Another ${label.toLowerCase()} write is unresolved or journal capacity reached`,
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
					`${label} memory changed or is unavailable; search again`,
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
				onDispatch: async (dispatch) => {
					signal.throwIfAborted()
					await store.dispatch(id, dispatch)
					signal.throwIfAborted()
					dispatched = true
				},
			},
		)
		const result: WriteResult = {
			...(store.scope ? { scope: store.scope } : {}),
			status: response.status,
			idempotencyKey: input.idempotencyKey,
			searchable: response.status === "applied" && operation !== "retract",
		}
		await store.finish(id, result)
		return result
	} catch (error) {
		// No automatic redispatch after timeout, provider failure, malformed response,
		// or a crash between provider success and journal commit.
		try {
			await store.finish(id, {
				status: dispatched ? "unknown" : "rejected",
				idempotencyKey: input.idempotencyKey,
				searchable: false,
			})
		} catch {
			// A failed journal write leaves the durable phase intact. Never disguise
			// potentially applied mutations as ordinary failures or redispatch them.
			throw new ExternalError("journal_unavailable", 503,
				"Write receipt unavailable; check status and do not submit a new key")
		}
		if (error instanceof ExternalError) throw error
		throw new ExternalError(
			signal.aborted ? "upstream_timeout" : "upstream_failure",
			signal.aborted ? 504 : 502,
			dispatched
				? "Write outcome unknown; check status and do not submit a new key"
				: `${label} memory verification unavailable`,
		)
	}
}
