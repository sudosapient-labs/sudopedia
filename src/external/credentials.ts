import { grantsSchema, type Grant, type Principal } from "./contracts"
import { ExternalError } from "./errors"
import { boundedSetting } from "./limits"

export const privilegedGrant = (grant: Grant) =>
	grant === "memory.shared:write" || grant === "skills.org:read"
export const maxLifetimeDays = () => 365

export async function hashSecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(secret),
	)
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("")
}

export type CredentialRow = {
	id: string
	org_id: string
	user_id: string
	secret_hash: string
	grants: string
	expires_at: number
	revoked_at: number | null
	deleted: number
	kind: string
	role: string
}

export function resolveCredential(
	row: CredentialRow | null,
	digest: string,
	now = Date.now(),
): Principal {
	const deny = () => {
		throw new ExternalError(
			"unauthorized",
			401,
			"Invalid or inactive credential",
		)
	}
	if (
		!row ||
		row.deleted !== 0 ||
		row.revoked_at !== null ||
		!Number.isFinite(row.expires_at) ||
		row.expires_at <= now ||
		![row.id, row.org_id, row.user_id, row.secret_hash].every(
			(value) => typeof value === "string" && value.length > 0,
		)
	)
		return deny()
	let difference = row.secret_hash.length ^ digest.length
	for (let i = 0; i < digest.length; i++)
		difference |= digest.charCodeAt(i) ^ (row.secret_hash.charCodeAt(i) || 0)
	if (difference) return deny()
	let parsed: unknown
	try {
		parsed = JSON.parse(row.grants)
	} catch {
		return deny()
	}
	const grants = grantsSchema.safeParse(parsed)
	if (!grants.success) return deny()
	// Legacy credentials cannot acquire additive grants by accident.
	if (row.kind !== "employee" && grants.data.some((g) =>
		g === "memory.shared:write" || g === "memory.private-channel:read")) return deny()
	if (row.kind === "personal" && grants.data.includes("skills.org:read"))
		return deny()
	if (
		row.kind === "organization" &&
		grants.data.some((g) => g.startsWith("memory.personal:"))
	)
		return deny()
	if (!["personal", "organization", "employee"].includes(row.kind)) return deny()
	if (
		row.kind === "organization" &&
		row.role !== "owner" &&
		row.role !== "admin"
	)
		return deny()
	return {
		credentialId: row.id,
		userId: row.user_id,
		orgId: row.org_id,
		grants: row.kind === "employee" && !["owner", "admin"].includes(row.role)
			? grants.data.filter((g) => !privilegedGrant(g)) : grants.data,
		...(row.kind === "employee" ? { kind: "employee" as const } : {}),
	}
}

export async function authenticate(
	env: Pick<Env, "DB">,
	request: Request,
): Promise<Principal> {
	const authorization = request.headers.get("authorization")
	const match = /^Bearer (sd_ext_([a-f0-9-]{36})_[a-f0-9]{64})$/.exec(
		authorization ?? "",
	)
	if (!match)
		throw new ExternalError("unauthorized", 401, "Bearer credential required")
	try {
		const row = await env.DB.prepare(
			`SELECT c.*, u.deleted, m.role FROM external_credential c
			JOIN user u ON u.id = c.user_id
			JOIN member m ON m.id = c.member_id AND m.user_id = c.user_id AND m.organization_id = c.org_id
			JOIN organization o ON o.id = c.org_id WHERE c.id = ?`,
		)
			.bind(match[2])
			.first<CredentialRow>()
		return resolveCredential(row, await hashSecret(match[1]!))
	} catch (error) {
		if (error instanceof ExternalError) throw error
		throw new ExternalError(
			"unavailable",
			503,
			"Credential verification unavailable",
		)
	}
}

export function requireGrant(principal: Principal, grant: Grant): void {
	if (!principal.grants.includes(grant))
		throw new ExternalError("forbidden", 403, "Required grant not present")
}

export async function mintCredential(
	env: Env,
	actor: { orgId: string; userId: string },
	input: {
		label: string
		grants: Grant[]
		expiresInDays: number
		kind?: "personal" | "organization" | "employee"
	},
) {
	const kind = input.kind ?? "organization"
	if (kind === "employee" && env.EXTERNAL_EMPLOYEE_CREATION_ENABLED !== "on")
		throw new ExternalError("not_configured", 503, "Employee connection creation is not enabled")
	if (!grantsSchema.safeParse(input.grants).success ||
		!["personal", "organization", "employee"].includes(kind) ||
		!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365)
		throw new ExternalError("invalid_input", 400, "Invalid credential policy")
	if (
		(kind !== "employee" && input.grants.some((g) =>
			g === "memory.shared:write" || g === "memory.private-channel:read")) ||
		(kind === "personal" && input.grants.includes("skills.org:read")) ||
		(kind === "organization" &&
			input.grants.some((g) => g.startsWith("memory.personal:")))
	)
		throw new ExternalError(
			"forbidden",
			403,
			"Grants are not allowed for this integration kind",
		)
	const member = await env.DB.prepare(
		`SELECT m.role FROM member m JOIN user u ON u.id = m.user_id
		WHERE m.user_id = ? AND m.organization_id = ? AND u.deleted = 0`,
	)
		.bind(actor.userId, actor.orgId)
		.first<{ role: string }>()
	if (
		!member ||
		((kind === "organization" || input.grants.some(privilegedGrant)) &&
			!["owner", "admin"].includes(member.role))
	)
		throw new ExternalError(
			"forbidden",
			403,
			"Organization integrations require owner/admin access",
		)
	const maxDays = maxLifetimeDays()
	if (input.expiresInDays > maxDays)
		throw new ExternalError(
			"invalid_input",
			400,
			`Maximum credential lifetime is ${maxDays} days`,
		)
	const id = crypto.randomUUID()
	const random = crypto.getRandomValues(new Uint8Array(32))
	const secret = `sd_ext_${id}_${Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")}`
	const now = Date.now()
	const expiresAt = now + input.expiresInDays * 86400000
	// Scope capacity/history to the actor's personal bucket, or the admin-only
	// organization bucket. Inactive credentials never spend active capacity.
	const activeLimit = kind !== "organization" ? 5 : 100
	const historyLimit = kind !== "organization" ? 100 : 200
	const bucket = kind === "organization" ? "kind = 'organization'" : "kind IN ('personal', 'employee')"
	await env.DB.prepare(
		`DELETE FROM external_credential WHERE org_id = ? AND ${bucket}
		AND (? = 'organization' OR user_id = ?) AND (expires_at < ? OR revoked_at < ?)`,
	)
		.bind(actor.orgId, kind, actor.userId, now - 30 * 86400000, now - 30 * 86400000)
		.run()
	await env.DB.prepare(
		`DELETE FROM external_credential WHERE id IN (
		SELECT id FROM external_credential WHERE org_id = ? AND ${bucket}
		AND (? = 'organization' OR user_id = ?) AND (expires_at <= ? OR revoked_at IS NOT NULL)
		ORDER BY created_at, id LIMIT MAX(0, (SELECT COUNT(*) FROM external_credential
		WHERE org_id = ? AND ${bucket} AND (? = 'organization' OR user_id = ?)) - ?))`,
	).bind(actor.orgId, kind, actor.userId, now,
		actor.orgId, kind, actor.userId, historyLimit - 1).run()
	const row = await env.DB.prepare(
		`INSERT INTO external_credential
		(id, org_id, user_id, member_id, label, secret_hash, grants, created_at, expires_at, kind)
		SELECT ?, ?, ?, m.id, ?, ?, ?, ?, ?, ? FROM member m JOIN user u ON u.id = m.user_id
		WHERE m.user_id = ? AND m.organization_id = ? AND (? = 0 OR m.role IN ('owner', 'admin')) AND u.deleted = 0
		AND (SELECT COUNT(*) FROM external_credential WHERE org_id = ? AND ${bucket}
		AND (? = 'organization' OR user_id = ?) AND revoked_at IS NULL AND expires_at > ?) < ?
		AND (SELECT COUNT(*) FROM external_credential WHERE org_id = ? AND ${bucket}
		AND (? = 'organization' OR user_id = ?)) < ?
		RETURNING id`,
	)
		.bind(
			id,
			actor.orgId,
			actor.userId,
			input.label,
			await hashSecret(secret),
			JSON.stringify(input.grants),
			now,
			expiresAt,
			kind,
			actor.userId,
			actor.orgId,
			Number(kind === "organization" || input.grants.some(privilegedGrant)),
			actor.orgId,
			kind, actor.userId, now, activeLimit,
			actor.orgId, kind, actor.userId, historyLimit,
		)
		.first()
	if (!row)
		throw new ExternalError(
			"credential_limit",
			429,
			kind !== "organization" ? "Employee credential limit reached (5 active)" :
				"Organization credential limit reached (100 active)",
		)
	return { id, secret, expiresAt }
}

export async function listCredentials(
	env: Env,
	orgId: string,
	userId: string,
	admin: boolean,
	asOf = Date.now(),
) {
	const result = await env.DB.prepare(
		`SELECT id, label, kind, user_id AS issuerId, grants, created_at AS createdAt,
		expires_at AS expiresAt, revoked_at AS revokedAt FROM external_credential WHERE org_id = ?
		AND ((kind IN ('personal', 'employee') AND user_id = ?) OR (kind = 'organization' AND ? = 1))
		ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, (kind IN ('personal', 'employee')) DESC, created_at DESC, id DESC LIMIT 300`,
	)
		.bind(orgId, userId, Number(admin), asOf)
		.all<{
			id: string
			label: string
			kind: "personal" | "organization" | "employee"
			issuerId: string
			grants: string
			createdAt: number
			expiresAt: number
			revokedAt: number | null
		}>()
	return result.results.map((row) => ({
		...row,
		grants: grantsSchema.parse(JSON.parse(row.grants)),
	}))
}

export async function revokeCredential(
	env: Env,
	orgId: string,
	id: string,
	userId: string,
	admin: boolean,
): Promise<void> {
	await env.DB.prepare(
		"UPDATE external_credential SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND org_id = ? AND ((kind IN ('personal', 'employee') AND user_id = ?) OR (kind = 'organization' AND ? = 1))",
	)
		.bind(Date.now(), id, orgId, userId, Number(admin))
		.run()
}

export async function consumeQuota(
	env: Env,
	principal: Principal,
	operation: string,
): Promise<void> {
	const limit = boundedSetting(
		["capture", "correct", "retract"].includes(operation)
			? env.EXTERNAL_WRITE_DAILY_QUOTA
			: operation === "search"
				? env.EXTERNAL_SEARCH_DAILY_QUOTA
				: env.EXTERNAL_READ_DAILY_QUOTA,
		["capture", "correct", "retract"].includes(operation)
			? 50
			: operation === "search"
				? 100
				: 1000,
		1,
		10000,
	)
	const window = Math.floor(Date.now() / 86400000)
	// All write methods share one cost budget, not three independently spendable budgets.
	const quotaOperation = ["capture", "correct", "retract"].includes(operation)
		? "write"
		: operation
	const row = await env.DB.prepare(
		`INSERT INTO external_quota (key, credential_id, window, count) VALUES (?, ?, ?, 1)
		ON CONFLICT(key) DO UPDATE SET window = excluded.window,
		count = CASE WHEN external_quota.window = excluded.window THEN MIN(external_quota.count + 1, 10001) ELSE 1 END
		RETURNING count`,
	)
		.bind(
			`${principal.credentialId}:${quotaOperation}`,
			principal.credentialId,
			window,
		)
		.first<{ count: number }>()
	if (!row || row.count > limit)
		throw new ExternalError(
			"rate_limited",
			429,
			"Daily operation quota exceeded",
		)
}
