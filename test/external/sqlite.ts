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
	const DB = {
		prepare(sql: string) {
			const query = sqlite.prepare(sql)
			let values: SQLInputValue[] = []
			const statement = {
				bind(...args: SQLInputValue[]) { values = args; return statement },
				async first<T>() { return (query.get(...values) ?? null) as T | null },
				async all<T>() { return { results: query.all(...values) as T[] } },
				async run() { return { meta: query.run(...values) } },
			}
			return statement
		},
	}
	return { sqlite, env: { DB } as unknown as Env }
}
