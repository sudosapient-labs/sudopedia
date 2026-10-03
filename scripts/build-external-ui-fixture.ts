// Optional native-browser harness: no changes to app aliases or dependencies.
const result = await Bun.build({
	entrypoints: [`${import.meta.dir}/../test/external/ui-preview.tsx`],
	outdir: `${import.meta.dir}/../dist/external-ui-fixture`,
	target: "browser",
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	plugins: [
		{
			name: "fictional-auth",
			setup(build) {
				build.onResolve({ filter: /^@lib\/auth-context$/ }, () => ({
					path: "auth",
					namespace: "fictional",
				}))
				build.onLoad({ filter: /.*/, namespace: "fictional" }, () => ({
					contents:
						"export function useAuth() { return globalThis.__externalUiAuth }",
					loader: "js",
				}))
			},
		},
	],
})
if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}
console.log("Built isolated fictional UI component harness")
