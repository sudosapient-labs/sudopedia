import { Hono } from "hono"
import type { AppContext } from "../types"
import { externalDependencies } from "../external/dependencies"
import { errorBody, publicError, ExternalError } from "../external/errors"
import { checkRequest } from "../external/security"
import { readBody, readJson, MAX_BODY_BYTES } from "../external/limits"
import { handleMcp } from "../external/mcp"
import { execute, type ExternalDependencies } from "../external/service"
import type { Principal } from "../external/contracts"

export type DependencyFactory = (
	env: Env,
	request: Request,
) => ExternalDependencies

/** Factory injection is used only by the separately bundled local fixture Worker. */
export function createExternalRoutes(
	factory: DependencyFactory = externalDependencies,
) {
	const routes = new Hono<AppContext>()
	routes.onError((error, c) => {
		const safe = publicError(error)
		if (safe.status === 429) c.header("Retry-After", "60")
		if (safe.status === 401) c.header("WWW-Authenticate", "Bearer")
		return c.json(errorBody(safe), safe.status)
	})
	routes.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store")
		c.header("X-Content-Type-Options", "nosniff")
		const started = Date.now()
		const requestId = crypto.randomUUID()
		let principal: Principal | undefined
		let status = 200
		try {
			checkRequest(c.env, c.req.raw)
			principal = await factory(c.env, c.req.raw).authenticate()
			if (
				!(
					await c.env.EXTERNAL_RATE_LIMITER.limit({
						key: principal.credentialId,
					})
				).success
			)
				throw new ExternalError("rate_limited", 429, "Request rate exceeded")
			await next()
			status = c.res.status
		} catch (error) {
			const safe = publicError(error)
			status = safe.status
			if (safe.status === 401) c.header("WWW-Authenticate", "Bearer")
			if (safe.status === 429) c.header("Retry-After", "60")
			return c.json(errorBody(safe), safe.status)
		} finally {
			// Transport-level denials/SDK validation failures may not enter the service.
			console.log(
				JSON.stringify({
					externalTransport: {
						requestId,
						credentialId: principal?.credentialId,
						actor: principal?.userId,
						org: principal?.orgId,
						grants: principal?.grants,
						operation: "transport",
						status,
						durationMs: Date.now() - started,
					},
				}),
			)
		}
	})
	routes.post("/brain/external/v1/memory/search", async (c) =>
		c.json(
			await execute(
				factory(c.env, c.req.raw),
				"search",
				await readJson(c.req.raw),
				c.req.raw.signal,
			),
		),
	)
	routes.get("/brain/external/v1/skills", async (c) =>
		c.json(await execute(factory(c.env, c.req.raw), "list", {})),
	)
	routes.post("/brain/external/v1/knowledge/query", async (c) =>
		c.json(await execute(factory(c.env, c.req.raw), "knowledge", await readJson(c.req.raw), c.req.raw.signal)),
	)
	routes.get("/brain/external/v1/knowledge/sources", async (c) =>
		c.json(await execute(factory(c.env, c.req.raw), "sources", { sourcePage: Number(c.req.query("sourcePage") ?? 0) }, c.req.raw.signal)),
	)
	for (const operation of [
		"capture",
		"correct",
		"retract",
		"status",
	] as const) {
		routes.post(`/brain/external/v1/memory/${operation}`, async (c) =>
			c.json(
				await execute(
					factory(c.env, c.req.raw),
					operation,
					await readJson(c.req.raw),
					c.req.raw.signal,
				),
			),
		)
	}
	routes.post("/brain/external/v1/skills/load", async (c) =>
		c.json(
			await execute(
				factory(c.env, c.req.raw),
				"load",
				await readJson(c.req.raw),
			),
		),
	)
	routes.all("/mcp", async (c) => {
		if (c.req.method !== "POST")
			return new Response(null, {
				status: 405,
				headers: { Allow: "POST", "Cache-Control": "no-store" },
			})
		// Cap the streamed body before giving the untouched JSON to the SDK parser.
		const bytes = await readBody(c.req.raw)
		// SDK v1 accepts legacy batches. Reject them at the HTTP policy boundary
		// to prevent one authenticated request from fanning out provider calls.
		try {
			if (Array.isArray(JSON.parse(new TextDecoder().decode(bytes)))) {
				throw new ExternalError(
					"invalid_input",
					400,
					"Batch requests are not supported",
				)
			}
		} catch (error) {
			if (error instanceof ExternalError) throw error
			// Leave malformed JSON/protocol messages to the SDK's protocol parser.
		}
		const request = new Request(c.req.raw, { body: bytes })
		const response = await handleMcp(request, factory(c.env, c.req.raw))
		const body = await response.arrayBuffer()
		if (body.byteLength > MAX_BODY_BYTES)
			throw new ExternalError(
				"output_limit",
				502,
				"Result exceeds output limit",
			)
		return new Response(body, response)
	})
	routes.all("*", (c) =>
		c.json(
			{ error: { code: "not_found", message: "External endpoint not found" } },
			404,
		),
	)
	return routes
}
