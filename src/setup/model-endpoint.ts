type ModelEndpointEnv = Pick<
	Env,
	"MODEL_BASE_URL" | "MODEL_API_KEY" | "MODEL_ID"
>

export function hasCustomModelEndpoint(env: ModelEndpointEnv): boolean {
	return Boolean(env.MODEL_BASE_URL?.trim())
}

/** Safe to show on /setup: never include the URL or key in an error. */
export function customModelEndpointError(env: ModelEndpointEnv): string | null {
	if (!hasCustomModelEndpoint(env)) return null
	try {
		const url = new URL(env.MODEL_BASE_URL!.trim())
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return "MODEL_BASE_URL must be an HTTP(S) API base URL without credentials, a query string or a fragment."
		}
	} catch {
		return "MODEL_BASE_URL must be an absolute HTTP(S) API base URL."
	}
	if (!env.MODEL_API_KEY?.trim()) {
		return "MODEL_API_KEY is required when MODEL_BASE_URL is set."
	}
	return null
}

export function customModelEndpoint(env: ModelEndpointEnv): {
	baseURL: string
	apiKey: string
	modelId?: string
} | null {
	if (!hasCustomModelEndpoint(env)) return null
	const error = customModelEndpointError(env)
	if (error) throw new Error(error)
	return {
		baseURL: env.MODEL_BASE_URL!.trim().replace(/\/+$/, ""),
		apiKey: env.MODEL_API_KEY!.trim(),
		modelId: env.MODEL_ID?.trim() || undefined,
	}
}
