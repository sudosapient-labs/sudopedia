import { z } from "zod"

export const GRANTS = [
	"memory.shared:read",
	"skills.org:read",
	"memory.personal:read",
	"memory.personal:write",
] as const
export type Grant = (typeof GRANTS)[number]
export const grantsSchema = z
	.array(z.enum(GRANTS))
	.min(1)
	.max(4)
	.refine((v) => new Set(v).size === v.length)
export const topicTagSchema = z
	.string()
	.max(128)
	.regex(
		/^(?:person|topic|project|customer|team)_[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/,
	)
export const searchSchema = z.strictObject({
	query: z.string().trim().min(1).max(2000),
	limit: z.number().int().min(1).max(20).default(5),
	topicTags: z.array(topicTagSchema).max(10).optional(),
})
export const listSchema = z.strictObject({})
export const loadSchema = z.strictObject({
	id: z.string().uuid(),
	expectedVersion: z.number().int().positive().optional(),
})
const durableContent = z
	.string()
	.trim()
	.min(1)
	.max(4000)
	.refine(
		(value) => new TextEncoder().encode(value).byteLength <= 4096,
		"Memory exceeds 4 KiB",
	)
const requestId = z.string().uuid()
const provenance = {
	eventDate: z.iso.date().optional(),
}
export const captureSchema = z.strictObject({
	idempotencyKey: requestId,
	content: durableContent,
	...provenance,
})
export const correctSchema = z.strictObject({
	idempotencyKey: requestId,
	reference: z.string().uuid(),
	content: durableContent,
	...provenance,
})
export const retractSchema = z.strictObject({
	idempotencyKey: requestId,
	reference: z.string().uuid(),
})
export const statusSchema = z.strictObject({ idempotencyKey: requestId })
export type WriteInput = z.infer<typeof captureSchema> & { reference?: string }
export type RetractInput = z.infer<typeof retractSchema>
export const mintSchema = z.strictObject({
	label: z.string().trim().min(1).max(100),
	grants: grantsSchema,
	expiresInDays: z.number().int().min(1).max(90),
	consent: z.literal(true),
	// Omitted for backwards-compatible organization credentials.
	kind: z.enum(["personal", "organization"]).default("organization"),
})
export type SearchInput = z.infer<typeof searchSchema>
export type SkillIndex = {
	id: string
	name: string
	description: string
	version: number
}
export type SkillLoad = SkillIndex & { body: string }
export type SkillLoadResult =
	| { skill: SkillLoad }
	| { error: "not_found" | "output_limit" }
	| { error: "version_conflict"; currentVersion: number }
export type Principal = {
	credentialId: string
	userId: string
	orgId: string
	grants: Grant[]
}
export type MemoryResult = {
	id: { kind: "memory" | "chunk"; value: string }
	scope?: "shared" | "personal"
	editable?: boolean
	reference?: string
	text: string
	textTruncated: boolean
	score?: number
	sourceUrls: string[]
	topicTags: string[]
	dates: {
		recordUpdatedAt?: string
		ingestionDate?: string
		eventDate?: string
	}
}
