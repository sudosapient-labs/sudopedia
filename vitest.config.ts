import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"
import tsconfig from "./tsconfig.json"

export default defineConfig({
	resolve: {
		// Match the aliases used by TypeScript and Bun in production.
		alias: [
			{
				find: "cloudflare:workers",
				replacement: fileURLToPath(
					new URL("./test/workers-runtime.ts", import.meta.url),
				),
			},
			...Object.entries(tsconfig.compilerOptions.paths).map(
				([alias, [path]]) => ({
					find: alias.replace(/\/\*$/, ""),
					replacement: fileURLToPath(
						new URL(path!.replace(/\/\*$/, ""), import.meta.url),
					),
				}),
			),
		],
	},
	test: {
		// Transform the Workers-only import so Node can use the inert runtime shim.
		server: { deps: { inline: ["@cloudflare/codemode"] } },
	},
})
