import type { SearchInput } from "./contracts"

/** Only this server-built request reaches the provider; no caller container/filter pass-through. */
export function sharedSearchRequest(input: SearchInput, threshold = 0.3) {
	return {
		q: input.query,
		limit: input.limit,
		containerTag: "sm_org_shared",
		searchMode: input.recall === "current" ? "memories" as const : "hybrid" as const,
		threshold,
		rerank: false,
		rewriteQuery: false,
		include: {
			documents: false,
			summaries: false,
			relatedMemories: false,
			forgottenMemories: false,
		},
		...(input.topicTags?.length
			? {
					filters: {
						OR: input.topicTags.map((tag) => ({
							key: "brain_tags",
							value: tag,
							filterType: "array_contains" as const,
							negate: false,
						})),
					},
				}
			: {}),
	}
}
