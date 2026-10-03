import { describe, expect, it } from "vitest"
import { setupPage } from "./page"

const params: Parameters<typeof setupPage>[0] = {
	origin: "https://brain.example.com",
	databaseReady: true,
	pendingMigrations: [],
	migrationError: null,
	hasMemoryKey: true,
	modelKeyUnrecognized: false,
	customModelEndpoint: false,
	modelEndpointError: null,
	sandbox: null,
	providers: [],
	slackConfigured: false,
	signedIn: false,
	installedTeam: null,
	manifest: {},
}

describe("setup model endpoint guidance", () => {
	it("shows the custom endpoint as configured without mislabeling it as a native provider", () => {
		const page = setupPage({
			...params,
			customModelEndpoint: true,
			providers: ["anthropic", "openai", "google", "xai"],
		})
		expect(page).toContain('class="step done" id="step-keys"')
		expect(page).toContain("model on your custom OpenAI-compatible endpoint.")
		expect(page).not.toContain("model on Anthropic")
		expect(page).not.toContain("doesn't look like")
	})

	it("shows actionable custom configuration errors and keeps the key step incomplete", () => {
		const page = setupPage({
			...params,
			customModelEndpoint: true,
			modelEndpointError:
				"MODEL_API_KEY is required when MODEL_BASE_URL is set.",
		})
		expect(page).toContain('class="step current" id="step-keys"')
		expect(page).toContain(
			"MODEL_API_KEY is required when MODEL_BASE_URL is set.",
		)
		expect(page).not.toContain("MODEL_API_KEY</code></strong> is missing")
	})

	it("suggests the custom base URL for unrecognized provider keys", () => {
		const page = setupPage({ ...params, modelKeyUnrecognized: true })
		expect(page).toContain("also set <code>MODEL_BASE_URL</code>")
	})

	it("preserves the existing provider summary", () => {
		expect(
			setupPage({ ...params, providers: ["anthropic", "openai"] }),
		).toContain("model on Anthropic, OpenAI.")
	})
})
