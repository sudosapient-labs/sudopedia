import { describe, expect, it } from "vitest"
import {
	customModelEndpoint,
	customModelEndpointError,
	hasCustomModelEndpoint,
} from "./model-endpoint"

describe("custom model endpoint configuration", () => {
	it("leaves provider detection in place when no base URL is set", () => {
		for (const MODEL_BASE_URL of [undefined, "", "   "]) {
			const env = { MODEL_BASE_URL, MODEL_API_KEY: "sk-abc" }
			expect(hasCustomModelEndpoint(env)).toBe(false)
			expect(customModelEndpoint(env)).toBeNull()
			expect(customModelEndpointError(env)).toBeNull()
		}
	})

	it("accepts arbitrary keys, trims values and normalizes trailing slashes", () => {
		expect(
			customModelEndpoint({
				MODEL_BASE_URL: " https://proxy.example.com/api/v1/// ",
				MODEL_API_KEY: " arbitrary-proxy-key ",
				MODEL_ID: " vendor/custom-alias ",
			}),
		).toEqual({
			baseURL: "https://proxy.example.com/api/v1",
			apiKey: "arbitrary-proxy-key",
			modelId: "vendor/custom-alias",
		})
	})

	it("supports HTTP local proxies and blank model overrides", () => {
		expect(
			customModelEndpoint({
				MODEL_BASE_URL: "http://localhost:4000/v1",
				MODEL_API_KEY: "local-key",
				MODEL_ID: " ",
			}),
		).toEqual({
			baseURL: "http://localhost:4000/v1",
			apiKey: "local-key",
			modelId: undefined,
		})
	})

	it.each([
		"not-a-url",
		"/v1",
		"ftp://proxy.example.com/v1",
		"https://user:secret@proxy.example.com/v1",
		"https://proxy.example.com/v1?key=secret",
		"https://proxy.example.com/v1#secret",
	])(
		"rejects unsafe/invalid URLs without reflecting secrets: %s",
		(MODEL_BASE_URL) => {
			const env = { MODEL_BASE_URL, MODEL_API_KEY: "secret-key" }
			const error = customModelEndpointError(env)
			expect(error).toContain("MODEL_BASE_URL")
			expect(error).not.toContain("secret")
			expect(() => customModelEndpoint(env)).toThrow(error!)
		},
	)

	it.each([undefined, "", "   "])(
		"requires a nonempty proxy key: %s",
		(MODEL_API_KEY) => {
			const env = {
				MODEL_BASE_URL: "https://proxy.example.com/v1",
				MODEL_API_KEY,
			}
			expect(customModelEndpointError(env)).toBe(
				"MODEL_API_KEY is required when MODEL_BASE_URL is set.",
			)
			expect(() => customModelEndpoint(env)).toThrow(
				"MODEL_API_KEY is required",
			)
		},
	)
})
