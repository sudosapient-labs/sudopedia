import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import { member, organization, user } from "../auth"

export const externalCredential = sqliteTable(
	"external_credential",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		memberId: text("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		secretHash: text("secret_hash").notNull(),
		grants: text("grants").notNull(),
		createdAt: integer("created_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		revokedAt: integer("revoked_at"),
	},
	(t) => [index("external_credential_org").on(t.orgId)],
)

// One bounded counter per operation/credential; no queries or audit bodies.
export const externalQuota = sqliteTable("external_quota", {
	key: text("key").primaryKey(),
	credentialId: text("credential_id")
		.notNull()
		.references(() => externalCredential.id, { onDelete: "cascade" }),
	window: integer("window").notNull(),
	count: integer("count").notNull(),
})
