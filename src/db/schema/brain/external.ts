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
		kind: text("kind").notNull().default("organization"),
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

// References contain no memory text; scoped to a verified owner, not a bearer token.
export const externalMemoryReference = sqliteTable(
	"external_memory_reference",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		providerId: text("provider_id").notNull(),
		fingerprint: text("fingerprint").notNull(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		index("external_memory_reference_owner").on(t.orgId, t.userId, t.createdAt),
	],
)

// At most one unresolved provider mutation per owner. Never lease/automatically
// retry an uncertain write: the provider has no documented idempotency/CAS key.
export const externalMemoryOperation = sqliteTable(
	"external_memory_operation",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		requestHash: text("request_hash").notNull(),
		operation: text("operation").notNull().default("legacy"),
		// Legacy rows are conservatively treated as potentially dispatched.
		phase: text("phase").notNull().default("dispatched"),
		providerAction: text("provider_action"),
		providerId: text("provider_id"),
		targetFingerprint: text("target_fingerprint"),
		deadlineAt: integer("deadline_at"),
		dispatchedAt: integer("dispatched_at"),
		reconciledAt: integer("reconciled_at"),
		state: text("state").notNull(),
		result: text("result"),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		index("external_memory_operation_owner").on(t.orgId, t.userId, t.state),
	],
)
