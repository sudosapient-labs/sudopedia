import { Hono } from "hono"
import { authRoutes } from "./auth/routes"
import { sessionMiddleware } from "./auth/session"
import { brainRoutes } from "./routes"
import { slackRoutes } from "./routes/slack"
import { configureFromEnv } from "./config"
import { ensureMigrated } from "./db/migrate"
import { setupRoutes } from "./setup/routes"
import { hydrateSecrets, rememberPublicUrl } from "./setup/secrets"
import type { AppContext } from "./types"
import { createExternalRoutes } from "./routes/external"
import { externalCredentialRoutes } from "./routes/external-credentials"
import { isExternalPath } from "./external/security"

export { Sandbox } from "@cloudflare/sandbox"
export { CompanyBrainAgent } from "./brain/turn/agent"

/**
 * The origin a visitor used. Behind a tunnel or proxy the worker sees plain
 * HTTP, so trust the forwarded scheme; Slack rejects http:// redirect URLs.
 */
function publicOrigin(request: Request): string {
	const url = new URL(request.url)
	const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]
	if (forwarded === "https") url.protocol = "https:"
	return url.origin
}

// The UI calls collection routes with a trailing slash (/brain/settings/).
const app = new Hono<AppContext>({ strict: false })

app.use("*", async (c, next) => {
	await hydrateSecrets(c.env)
	// External URLs are explicit; these callers must not alter remembered
	// Slack/OAuth URLs, even when their Host/Origin check will reject the request.
	if (!isExternalPath(c.req.path)) {
		await rememberPublicUrl(c.env, publicOrigin(c.req.raw))
	}
	configureFromEnv(c.env)
	await ensureMigrated(c.env)
	c.set("trackedEvents", new Set<string>())
	await next()
})
app.use("*", sessionMiddleware)

app.route("/setup", setupRoutes)
app.route("/auth", authRoutes)
const externalRoutes = createExternalRoutes()
app.all("/mcp", c => externalRoutes.fetch(c.req.raw, c.env, c.executionCtx))
app.all("/mcp/*", c => externalRoutes.fetch(c.req.raw, c.env, c.executionCtx))
app.all("/brain/external/*", c => externalRoutes.fetch(c.req.raw, c.env, c.executionCtx))
app.route("/brain/external-credentials", externalCredentialRoutes)
// The app UI calls the API under /brain, as it did against the hosted API.
app.route("/brain", brainRoutes)
// Slack's event and interaction URLs in the app manifest predate that prefix.
app.route("/slack", slackRoutes)

app.get("/health", (c) => c.json({ ok: true }))

// Everything else is the app UI; the asset handler serves index.html for
// client-side routes, so only paths above ever reach this worker.
app.notFound((c) =>
	c.env.ASSETS.fetch(c.req.raw),
)

export default {
	fetch: app.fetch,
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
		await hydrateSecrets(env)
		configureFromEnv(env)
		await ensureMigrated(env)
		const { kickKnowledgeSchedules } = await import("./brain/knowledge/kick")
		ctx.waitUntil(kickKnowledgeSchedules(env))
	},
}
