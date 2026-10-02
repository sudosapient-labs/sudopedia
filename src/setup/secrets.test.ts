import { afterEach, describe, expect, it, vi } from "vitest"
import { hydrateSecrets, providerForModelKey } from "./secrets"

describe("providerForModelKey", () => {
	it("tells providers apart by key prefix", () => {
		expect(providerForModelKey("sk-ant-api03-abc")).toBe("anthropic")
		expect(providerForModelKey("sk-proj-abc")).toBe("openai")
		expect(providerForModelKey("sk-abc")).toBe("openai")
		expect(providerForModelKey("AIzaSyAbc")).toBe("google")
		expect(providerForModelKey("xai-abc")).toBe("xai")
		expect(providerForModelKey("sk-or-abc")).toBe("openrouter")
		expect(providerForModelKey("something-else")).toBeNull()
	})
})

describe("model key hydration", () => {
	afterEach(() => vi.restoreAllMocks())

	it.each([
		"arbitrary-proxy-key",
		"sk-proxy",
		"sk-ant-proxy",
		"sk-or-proxy",
		"xai-proxy",
		"AIza-proxy",
	])(
		"does not assign a custom endpoint key to a native provider: %s",
		async (MODEL_API_KEY) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const env = {
				MODEL_API_KEY,
				MODEL_BASE_URL: "https://proxy.example.com/v1",
				ENCRYPTION_SECRET: "existing-secret",
				PUBLIC_URL: "https://brain.example.com",
			} as Env
			await hydrateSecrets(env)
			for (const key of [
				"ANTHROPIC_API_KEY",
				"OPENAI_API_KEY",
				"OPENROUTER_API_KEY",
				"XAI_API_KEY",
				"GOOGLE_GENERATIVE_AI_API_KEY",
			] as const) {
				expect(env[key]).toBeUndefined()
			}
			expect(warn).not.toHaveBeenCalled()
		},
	)

	it.each([
		["sk-ant-native", "ANTHROPIC_API_KEY"],
		["sk-native", "OPENAI_API_KEY"],
		["sk-or-native", "OPENROUTER_API_KEY"],
		["xai-native", "XAI_API_KEY"],
		["AIza-native", "GOOGLE_GENERATIVE_AI_API_KEY"],
	] as const)(
		"keeps detecting native keys: %s",
		async (MODEL_API_KEY, providerKey) => {
			const env = {
				MODEL_API_KEY,
				MODEL_BASE_URL: " ",
				ENCRYPTION_SECRET: "existing-secret",
				PUBLIC_URL: "https://brain.example.com",
			} as Env
			await hydrateSecrets(env)
			expect(env[providerKey]).toBe(MODEL_API_KEY)
		},
	)
})
