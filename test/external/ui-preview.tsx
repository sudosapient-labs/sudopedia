// Native collaborative-browser component harness. Fictional auth/fetch ONLY.
// Build with scripts/build-external-ui-fixture.ts; inject into a blank test page.
import { createRoot, type Root } from "react-dom/client"
import ExternalAccess from "../../web/components/settings/external-access"

const fixture = globalThis as typeof globalThis & {
	__externalUiAuth: {
		user: { id: string }
		org: { id: string }
		isAdmin: boolean
	}
	__remountExternalUi: (admin?: boolean) => void
	__externalUiRequests: { method: string; body?: unknown }[]
}
fixture.__externalUiAuth = {
	user: { id: "fictional-a" },
	org: { id: "fictional-org" },
	isAdmin: false,
}
fixture.__externalUiRequests = []
const credentials: Array<{
	id: string
	label: string
	kind: string
	grants: string[]
	expiresAt: number
	revokedAt: number | null
}> = []
let nextCredentialId = 0
fixture.fetch = async (input, init) => {
	const path = String(input)
	const body = init?.body ? JSON.parse(String(init.body)) : undefined
	fixture.__externalUiRequests.push({ method: init?.method ?? "GET", body })
	if (init?.method === "POST" && path.endsWith("/revoke")) {
		const credential = credentials.find((c) => path.includes(c.id))
		if (credential) credential.revokedAt = Date.now()
		return Response.json({ ok: true })
	}
	if (init?.method === "POST" && !path.endsWith("/list")) {
		if (!body.consent)
			return Response.json(
				{ error: { message: "Consent required" } },
				{ status: 400 },
			)
		const id = `00000000-0000-4000-8000-${String(++nextCredentialId).padStart(12, "0")}`
		credentials.push({
			id,
			label: body.label,
			kind: body.kind,
			grants: body.grants,
			expiresAt: Date.now() + 86400000,
			revokedAt: null,
		})
		return Response.json(
			{
				id,
				secret: `sd_ext_${id}_${"a".repeat(64)}`,
				expiresAt: Date.now() + 86400000,
			},
			{ status: 201 },
		)
	}
	const start = body?.cursor ? credentials.findIndex((c) => c.id === body.cursor.id) + 1 : 0
	const page = credentials.slice(start, start + 2)
	return Response.json({
		credentials: page,
		nextCursor: start + page.length < credentials.length ? { id: page.at(-1)!.id, asOf: Date.now(), version: "a".repeat(64) } : null,
		mcpUrl: "https://fictional.invalid/mcp",
		maxLifetimeDays: 30,
	})
}
document.body.innerHTML = '<main id="external-ui-fixture"></main>'
let root: Root | undefined
fixture.__remountExternalUi = (admin = false) => {
	root?.unmount()
	fixture.__externalUiAuth.isAdmin = admin
	root = createRoot(document.getElementById("external-ui-fixture")!)
	root.render(<ExternalAccess />)
}
fixture.__remountExternalUi()
