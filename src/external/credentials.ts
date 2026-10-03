import { grantsSchema, type Grant, type Principal } from "./contracts"
import { ExternalError } from "./errors"
import { boundedSetting } from "./limits"

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
	return {
		credentialId: row.id,
		userId: row.user_id,
		orgId: row.org_id,
		grants: grants.data,
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
		const row =
			await env.DB.prepare(`SELECT c.*, u.deleted FROM external_credential c
			JOIN user u ON u.id = c.user_id
			JOIN member m ON m.id = c.member_id AND m.user_id = c.user_id AND m.organization_id = c.org_id
			JOIN organization o ON o.id = c.org_id WHERE c.id = ?`)
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
	input: { label: string; grants: Grant[]; expiresInDays: number },
) {
	const maxDays = boundedSetting(env.EXTERNAL_MAX_LIFETIME_DAYS, 30, 1, 90)
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
	// Bounded history: inactive credentials/counters are removed after 30 days.
	await env.DB.prepare(
		"DELETE FROM external_credential WHERE org_id = ? AND (expires_at < ? OR revoked_at < ?)",
	)
		.bind(actor.orgId, now - 30 * 86400000, now - 30 * 86400000)
		.run()
	const row = await env.DB.prepare(`INSERT INTO external_credential
		(id, org_id, user_id, member_id, label, secret_hash, grants, created_at, expires_at)
		SELECT ?, ?, ?, m.id, ?, ?, ?, ?, ? FROM member m JOIN user u ON u.id = m.user_id
		WHERE m.user_id = ? AND m.organization_id = ? AND m.role IN ('owner', 'admin') AND u.deleted = 0
		AND (SELECT COUNT(*) FROM external_credential WHERE org_id = ?) < 100
		RETURNING id`)
		.bind(
			id,
			actor.orgId,
			actor.userId,
			input.label,
			await hashSecret(secret),
			JSON.stringify(input.grants),
			now,
			expiresAt,
			actor.userId,
			actor.orgId,
			actor.orgId,
		)
		.first()
	if (!row)
		throw new ExternalError(
			"credential_limit",
			429,
			"Organization credential limit reached (100)",
		)
	return { id, secret, expiresAt }
}

export async function listCredentials(env: Env, orgId: string) {
	const result =
		await env.DB.prepare(`SELECT id, label, user_id AS issuerId, grants, created_at AS createdAt,
		expires_at AS expiresAt, revoked_at AS revokedAt FROM external_credential WHERE org_id = ? ORDER BY created_at DESC LIMIT 100`)
			.bind(orgId)
			.all<{
				id: string
				label: string
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
): Promise<void> {
	await env.DB.prepare(
		"UPDATE external_credential SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND org_id = ?",
	)
		.bind(Date.now(), id, orgId)
		.run()
}

export async function consumeQuota(
	env: Env,
	principal: Principal,
	operation: string,
): Promise<void> {
	const limit = boundedSetting(
		operation === "search"
			? env.EXTERNAL_SEARCH_DAILY_QUOTA
			: env.EXTERNAL_READ_DAILY_QUOTA,
		operation === "search" ? 100 : 1000,
		1,
		10000,
	)
	const window = Math.floor(Date.now() / 86400000)
	const row =
		await env.DB.prepare(`INSERT INTO external_quota (key, credential_id, window, count) VALUES (?, ?, ?, 1)
		ON CONFLICT(key) DO UPDATE SET window = excluded.window,
		count = CASE WHEN external_quota.window = excluded.window THEN MIN(external_quota.count + 1, 10001) ELSE 1 END
		RETURNING count`)
			.bind(
				`${principal.credentialId}:${operation}`,
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
