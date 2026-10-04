import { Hono, type Context } from "hono"
import { z } from "zod"
import type { AppContext } from "../types"
import { mintSchema } from "../external/contracts"
import {
	mintCredential,
	hashSecret,
	listCredentials,
	revokeCredential,
} from "../external/credentials"
import { ExternalError, errorBody, publicError } from "../external/errors"
import {
	boundedSetting,
	readJson,
	jsonBytes,
	MAX_BODY_BYTES,
} from "../external/limits"
import { canonicalOrigin, checkRequest } from "../external/security"
import { parseInput } from "../external/service"

const cursorSchema = z.strictObject({
	id: z.string().uuid(),
	asOf: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	version: z.string().regex(/^[a-f0-9]{64}$/),
})
const pageSchema = z.strictObject({ cursor: cursorSchema })
async function credentialPage(c: Context<AppContext>, cursor?: z.infer<typeof cursorSchema>) {
	const now = Date.now(), asOf = cursor?.asOf ?? now
	if (asOf > now || now - asOf > 15 * 60 * 1000)
		throw new ExternalError("invalid_cursor", 409, "Credential page expired; reload credentials")
	// Every page is authorized against the current session, organization and role.
	const rows = await listCredentials(c.env, c.get("org")!.id, c.get("user")!.id,
		["owner", "admin"].includes(c.get("memberRole") ?? ""), asOf)
	// Changed ordering/history must trigger reload, not silently skip active rows.
	const version = await hashSecret(JSON.stringify(rows))
	if (cursor && cursor.version !== version)
		throw new ExternalError("invalid_cursor", 409, "Credential page changed; reload credentials")
	const anchor = cursor ? rows.findIndex((r) => r.id === cursor.id) : -1
	if (cursor && anchor < 0)
		throw new ExternalError("invalid_cursor", 409, "Credential page changed; reload credentials")
	const remaining = rows.slice(anchor + 1)
	const listing = {
		credentials: [] as typeof rows,
		nextCursor: null as z.infer<typeof cursorSchema> | null,
		mcpUrl: `${canonicalOrigin(c.env)}/mcp`,
		maxLifetimeDays: boundedSetting(c.env.EXTERNAL_MAX_LIFETIME_DAYS, 30, 1, 90),
	}
	for (const row of remaining.slice(0, 50)) {
		const candidate = { ...listing, credentials: [...listing.credentials, row], nextCursor: { id: row.id, asOf, version } }
		if (jsonBytes(candidate) > MAX_BODY_BYTES) break
		listing.credentials.push(row)
	}
	if (remaining.length && !listing.credentials.length)
		throw new ExternalError("output_limit", 502, "Credential exceeds output limit")
	if (listing.credentials.length < remaining.length)
		listing.nextCursor = { id: listing.credentials.at(-1)!.id, asOf, version }
	return c.json(listing)
}

export const externalCredentialRoutes = new Hono<AppContext>()
	.onError((error, c) => {
		const safe = publicError(error)
		return c.json(errorBody(safe), safe.status)
	})
	.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store")
		try {
			const user = c.get("user"),
				org = c.get("org")
			if (!user || !org)
				throw new ExternalError("unauthorized", 401, "Browser session required")
			// Session middleware revalidates membership; personal management is self-service.
			checkRequest(c.env, c.req.raw, c.req.method !== "GET")
			if (
				c.req.method !== "GET" &&
				!(
					await c.env.EXTERNAL_MANAGEMENT_RATE_LIMITER.limit({
						key: `${org.id}:${user.id}`,
					})
				).success
			)
				throw new ExternalError("rate_limited", 429, "Management rate exceeded")
			await next()
		} catch (error) {
			const safe = publicError(error)
			return c.json(errorBody(safe), safe.status)
		}
	})
	.get("/", (c) => credentialPage(c))
	// Body-only pagination keeps credentials/cursors out of URLs and retains CSRF checks.
	.post("/list", async (c) => {
		const input = parseInput(pageSchema, await readJson(c.req.raw))
		return credentialPage(c, input.cursor)
	})
	.post("/", async (c) => {
		const input = parseInput(mintSchema, await readJson(c.req.raw))
		const result = await mintCredential(
			c.env,
			{ orgId: c.get("org")!.id, userId: c.get("user")!.id },
			input,
		)
		console.log(
			JSON.stringify({
				externalCredential: {
					operation: "mint",
					credentialId: result.id,
					actor: c.get("user")!.id,
					org: c.get("org")!.id,
					grants: input.grants,
				},
			}),
		)
		return c.json(result, 201)
	})
	.post("/:id/revoke", async (c) => {
		const id = parseInput(z.string().uuid(), c.req.param("id"))
		parseInput(z.strictObject({}), await readJson(c.req.raw))
		await revokeCredential(
			c.env,
			c.get("org")!.id,
			id,
			c.get("user")!.id,
			["owner", "admin"].includes(c.get("memberRole") ?? ""),
		)
		console.log(
			JSON.stringify({
				externalCredential: {
					operation: "revoke",
					credentialId: id,
					actor: c.get("user")!.id,
					org: c.get("org")!.id,
				},
			}),
		)
		return c.json({ ok: true })
	})
