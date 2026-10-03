// Local-only UI fixture. Run after `bun run build:web`; stop with Ctrl-C.
import { unstable_dev } from "wrangler"

const worker = await unstable_dev("test/external/worker.ts", {
	config: "test/external/wrangler.preview.jsonc",
	ip: "127.0.0.1",
	port: 8798,
	local: true,
	persist: false,
	logLevel: "error",
	vars: { EXTERNAL_PUBLIC_URL: "http://127.0.0.1:8798" },
	experimental: {
		disableExperimentalWarning: true,
		disableDevRegistry: true,
		watch: false,
	},
})
console.log(
	"Fake-data UI preview: http://127.0.0.1:8798/configure/external-access",
)
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, async () => {
		await worker.stop()
		process.exit(0)
	})
await worker.waitUntilExit()
