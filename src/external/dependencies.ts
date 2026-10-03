import { getAgentByName } from "agents"
import type { CompanyBrainAgent } from "../brain/turn/agent"
import { memoryClient } from "../memory/client"
import { authenticate, consumeQuota } from "./credentials"
import { boundedSetting } from "./limits"
import type { ExternalDependencies } from "./service"
import type { SearchInput } from "./contracts"

/** Only this server-built request reaches the provider; no caller container/filter pass-through. */
export function sharedSearchRequest(input: SearchInput, threshold = 0.3) {
	return {
		q: input.query,
		limit: input.limit,
		containerTag: "sm_org_shared",
		searchMode: "hybrid" as const,
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

export function externalDependencies(
	env: Env,
	request: Request,
): ExternalDependencies {
	const agent = async (orgId: string) =>
		(await getAgentByName(
			env.COMPANY_BRAIN_AGENT,
			orgId,
		)) as unknown as CompanyBrainAgent
	return {
		authenticate: () => authenticate(env, request),
		quota: (principal, operation) => consumeQuota(env, principal, operation),
		search: (input, signal) =>
			memoryClient(env).search.memories(
				sharedSearchRequest(
					input,
					boundedSetting(env.EXTERNAL_SEARCH_THRESHOLD, 0.3, 0, 1),
				),
				{ signal, timeout: 8000, maxRetries: 0 },
			),
		listSkills: async (orgId) => (await agent(orgId)).listExternalOrgSkills(),
		loadSkill: async (orgId, id, expectedVersion) =>
			(await agent(orgId)).loadExternalOrgSkill(id, expectedVersion),
		audit: (event) => console.log(JSON.stringify({ externalAccess: event })),
	}
}
