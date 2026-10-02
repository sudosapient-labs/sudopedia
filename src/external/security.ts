import { ExternalError } from "./errors"

export function isExternalPath(path: string): boolean {
	return /^(?:\/mcp(?:\/|$)|\/brain\/external(?:\/|$|-credentials(?:\/|$)))/.test(
		path,
	)
}

export function canonicalOrigin(env: Pick<Env, "EXTERNAL_PUBLIC_URL">): string {
	try {
		const url = new URL(env.EXTERNAL_PUBLIC_URL ?? "")
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			(url.protocol !== "https:" &&
				!(
					url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
				))
		)
			throw new Error()
		return url.origin
	} catch {
		throw new ExternalError(
			"not_configured",
			503,
			"Set EXTERNAL_PUBLIC_URL to the canonical deployment origin",
		)
	}
}

export function checkRequest(
	env: Env,
	request: Request,
	mutation = false,
): string {
	const origin = canonicalOrigin(env)
	const url = new URL(request.url)
	// Do not trust forwarded headers, URL credentials, queries, or arbitrary hosts.
	if (url.origin !== origin || url.username || url.password)
		throw new ExternalError("forbidden", 403, "Invalid endpoint origin")
	if (url.search)
		throw new ExternalError(
			"invalid_input",
			400,
			"URL parameters are not accepted",
		)
	const supplied = request.headers.get("origin")
	if (
		(supplied !== null && supplied !== origin) ||
		(mutation &&
			(supplied !== origin || request.headers.get("x-sudopedia-csrf") !== "1"))
	)
		throw new ExternalError("forbidden", 403, "Origin or CSRF check failed")
	return origin
}
