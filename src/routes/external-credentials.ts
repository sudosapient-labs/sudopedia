import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../types"
import { mintSchema } from "../external/contracts"
import {
	mintCredential,
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

export const externalCredentialRoutes = new Hono<AppContext>()
	.onError((error, c) => {
		const safe = publicError(error)
		return c.json(errorBody(safe), safe.status)
	})
	.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store")
		try {
			const user = c.get("user"),
				org = c.get("org"),
				role = c.get("memberRole")
			if (!user || !org)
				throw new ExternalError("unauthorized", 401, "Browser session required")
			if (role !== "owner" && role !== "admin")
				throw new ExternalError("forbidden", 403, "Owner/admin access required")
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
	.get("/", async (c) => {
		const listing = {
			credentials: await listCredentials(c.env, c.get("org")!.id),
			mcpUrl: `${canonicalOrigin(c.env)}/mcp`,
			maxLifetimeDays: boundedSetting(
				c.env.EXTERNAL_MAX_LIFETIME_DAYS,
				30,
				1,
				90,
			),
		}
		if (jsonBytes(listing) > MAX_BODY_BYTES) {
			throw new ExternalError(
				"output_limit",
				502,
				"Credential listing exceeds output limit",
			)
		}
		return c.json(listing)
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
		await revokeCredential(c.env, c.get("org")!.id, id)
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
