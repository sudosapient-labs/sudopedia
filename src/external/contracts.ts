import { z } from "zod"

export const GRANTS = ["memory.shared:read", "skills.org:read"] as const
export type Grant = (typeof GRANTS)[number]
export const grantsSchema = z
	.array(z.enum(GRANTS))
	.min(1)
	.max(2)
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
export const mintSchema = z.strictObject({
	label: z.string().trim().min(1).max(100),
	grants: grantsSchema,
	expiresInDays: z.number().int().min(1).max(90),
	consent: z.literal(true),
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
