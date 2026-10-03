import { readFileSync } from "node:fs"
import { URL } from "node:url"
import { parseEnv } from "node:util"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { availableProviders } from "../brain/turn/brain-model"
import { customModelEndpoint } from "./model-endpoint"

const read = (path: string) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")

const template = parseEnv(read(".dev.vars.example"))
const wrangler = ts.parseConfigFileTextToJson(
	"wrangler.jsonc",
	read("wrangler.jsonc"),
).config as { keep_vars?: boolean; vars: Record<string, unknown> }
const metadata = JSON.parse(read("package.json")) as {
	cloudflare: { bindings: Record<string, { description: string }> }
}

describe("Cloudflare deployment configuration", () => {
	it("exposes the model key, base URL and model ID as deployment secret inputs", () => {
		for (const name of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_ID"]) {
			// Parse the dotenv file, not its comments: a commented entry is invisible
			// to Cloudflare's Deploy button secret discovery.
			expect(template).toHaveProperty(name, "")
			expect(metadata.cloudflare.bindings[name]?.description).toBeTruthy()
		}
		expect(template).toHaveProperty("SUPERMEMORY_API_KEY", "")
	})

	it("explains the optional proxy inputs in the deployment form", () => {
		expect(metadata.cloudflare.bindings.MODEL_BASE_URL?.description).toContain(
			"Optional",
		)
		expect(metadata.cloudflare.bindings.MODEL_BASE_URL?.description).toContain(
			"Leave blank",
		)
		expect(metadata.cloudflare.bindings.MODEL_ID?.description).toContain(
			"Optional",
		)
		expect(metadata.cloudflare.bindings.MODEL_API_KEY?.description).toContain(
			"proxy",
		)
	})

	it("preserves dashboard variables without overwriting model settings with committed defaults", () => {
		expect(wrangler.keep_vars).toBe(true)
		for (const name of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL_ID"]) {
			expect(wrangler.vars).not.toHaveProperty(name)
		}
	})

	it("keeps custom routing disabled with blank deployment defaults", () => {
		const env = { ...template, OPENAI_API_KEY: "sk-native" } as Env
		expect(customModelEndpoint(env)).toBeNull()
		expect(availableProviders(env)).toEqual(["openai"])
	})

	it("deploys from this fork instead of the upstream repository", () => {
		const readme = read("README.md")
		const buttonUrl = readme.match(
			/href="(https:\/\/deploy\.workers\.cloudflare\.com\/\?[^" ]+)"/,
		)?.[1]
		expect(buttonUrl).toBeDefined()
		expect(new URL(buttonUrl!).searchParams.get("url")).toBe(
			"https://github.com/sudosapient-labs/sudopedia",
		)
	})
})
