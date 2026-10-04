import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { MIGRATIONS } from "../../src/db/migrations.generated"

/** In-memory SQL only; uses production migrations/queries, never remote D1. */
export function sqliteFixture() {
	const sqlite = new DatabaseSync(":memory:")
	sqlite.exec("PRAGMA foreign_keys=ON")
	for (const migration of MIGRATIONS)
		for (const sql of migration.statements) sqlite.exec(sql)
	sqlite.exec(`
		INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Fictional','fictional',1);
		INSERT INTO user(id,email,name,created_at,updated_at) VALUES
		('a','a@example.invalid','A',1,1),('b','b@example.invalid','B',1,1),('admin','admin@example.invalid','Admin',1,1);
		INSERT INTO member(id,user_id,organization_id,role,created_at) VALUES
		('ma','a','org','member',1),('mb','b','org','member',1),('madmin','admin','org','admin',1);
	`)
	let queryCount = 0, queryLimit = Infinity
	const dispatched = () => { if (++queryCount > queryLimit) throw new Error("D1 query budget exceeded") }
	const DB = {
		prepare(sql: string) {
			const query = sqlite.prepare(sql)
			let values: SQLInputValue[] = []
			const statement = {
				bind(...args: SQLInputValue[]) { values = args; return statement },
				async first<T>() { dispatched(); return (query.get(...values) ?? null) as T | null },
				async all<T>() { dispatched(); return { results: query.all(...values) as T[] } },
				async run() { dispatched(); return { meta: query.run(...values) } },
			}
			return statement
		},
	}
	return { sqlite, env: { DB, EXTERNAL_EMPLOYEE_CREATION_ENABLED: "on" } as unknown as Env, queryCount: () => queryCount,
		resetQueryBudget(limit = Infinity) { queryCount = 0; queryLimit = limit } }
}
