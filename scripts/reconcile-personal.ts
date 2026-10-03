import { reconciliationStatement } from "../src/external/reconciliation"

// Generates reviewable SQL only. It never connects to D1 or the memory provider.
// The operator, NOT this command, must independently establish the evidence.
const path = Bun.argv[2]
if (!path || Bun.argv.length !== 3) {
	console.error("Usage: bun scripts/reconcile-personal.ts <verified-snapshot.json>")
	process.exit(1)
}
try {
	const file = Bun.file(path)
	if (file.size > 16384) throw new Error("Snapshot too large")
	const statement = reconciliationStatement(await file.json())
	let index = 0
	const sql = statement.sql.replace(/\?/g, () => {
		const value = statement.bindings[index++]
		return value === null ? "NULL" : typeof value === "number" ? String(value) :
			`'${String(value).replaceAll("'", "''")}'`
	})
	console.log("-- Review evidence and target database before applying. No returned row means NO reconciliation.")
	console.log(`${sql};`)
} catch {
	console.error("Invalid snapshot or missing evidence; no SQL generated.")
	process.exit(1)
}
