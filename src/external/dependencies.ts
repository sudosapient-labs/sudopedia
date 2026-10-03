import { getAgentByName } from "agents"
import type { CompanyBrainAgent } from "../brain/turn/agent"
import { memoryClient } from "../memory/client"
import { authenticate, consumeQuota } from "./credentials"
import { boundedSetting } from "./limits"
import type { ExternalDependencies } from "./service"
import type { SearchInput } from "./contracts"
import {
	personalStore,
	type PersonalEntry,
	type PersonalProvider,
} from "./personal"

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

export const personalContainer = (userId: string) => `user_${userId}`

/** Public provider v4 CRUD, verified against its OpenAPI, not document updates. */
export function personalProvider(env: Env): PersonalProvider {
	return {
		async find(owner, id, signal) {
			const client = memoryClient(env)
			for (let page = 1; page <= 3; page++) {
				const response = await client.post<{
					memoryEntries: PersonalEntry[]
					pagination: { totalPages: number }
				}>("/v4/memories/list", {
					body: {
						containerTags: [personalContainer(owner.userId)],
						limit: 100,
						page,
						sort: "updatedAt",
						order: "desc",
					},
					signal,
					timeout: 8000,
					maxRetries: 0,
				})
				const found = response.memoryEntries.find((row) => row.id === id)
				if (found) return found
				if (page >= response.pagination.totalPages) break
			}
			return null // Fail closed outside the bounded verification window.
		},
		async mutate(owner, operation, input, id, operationId, signal, context) {
			const client = memoryClient(env)
			const options = { signal, timeout: 8000, maxRetries: 0 }
			const containerTag = personalContainer(owner.userId)
			const metadata = {
				...(operation === "correct" ? context.current?.metadata : {}),
				memory_scope: "personal",
				source_type: "external-primary-bot",
				external_integration: owner.credentialId,
				external_operation: operationId,
				ingestion_date: new Date().toISOString().slice(0, 10),
				...("eventDate" in input && input.eventDate
					? { event_date: input.eventDate }
					: {}),
			}
			if (operation === "retract") {
				context.onDispatch()
				const response = await client.memories.forget(
					{
						id,
						containerTag,
						reason: "Employee retraction through external integration",
					},
					options,
				)
				if (!response.forgotten || response.id !== id)
					throw new Error("Invalid provider result")
			} else if (operation === "correct") {
				if (!context.current || context.current.id !== id)
					throw new Error("Verified personal memory required")
				context.onDispatch()
				const response = await client.memories.updateMemory(
					{
						id,
						containerTag,
						newContent: (input as { content: string }).content,
						metadata,
					},
					options,
				)
				if (!response.id || response.parentMemoryId !== id)
					throw new Error("Invalid provider result")
			} else {
				const content = (input as { content: string }).content
				// Provision before search: a first-time employee may not have a space yet.
				try {
					await client.get(
						`/v3/container-tags/${encodeURIComponent(containerTag)}`,
						options,
					)
				} catch (error) {
					if ((error as { status?: number }).status !== 404) throw error
					await client.patch(
						`/v3/container-tags/${encodeURIComponent(containerTag)}`,
						{
							...options,
							body: {
								name: "My Brain",
								entityContext:
									"Employee-specific private knowledge from explicitly authorized conversations.",
							},
						},
					)
				}
				const existing = await client.search.memories(
					{
						q: content,
						containerTag,
						limit: 20,
						searchMode: "memories",
						threshold: 0,
						rerank: false,
						rewriteQuery: false,
						include: {
							forgottenMemories: false,
							relatedMemories: false,
							documents: false,
							summaries: false,
						},
					},
					options,
				)
				if (existing.results.some((row) => row.memory?.trim() === content))
					return { status: "applied" }
				context.onDispatch()
				const response = await client.post<{ memories: Array<{ id: string }> }>(
					"/v4/memories",
					{
						...options,
						body: {
							containerTag,
							memories: [
								{
									content: (input as { content: string }).content,
									isStatic: false,
									metadata,
								},
							],
						},
					},
				)
				if (response.memories?.length !== 1 || !response.memories[0]?.id)
					throw new Error("Invalid provider result")
			}
			return { status: "applied" }
		},
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
		personalSearch: (input, principal, signal) =>
			memoryClient(env).search.memories(
				{
					...sharedSearchRequest(
						input,
						boundedSetting(env.EXTERNAL_SEARCH_THRESHOLD, 0.3, 0, 1),
					),
					containerTag: personalContainer(principal.userId),
					searchMode: "memories",
				},
				{ signal, timeout: 8000, maxRetries: 0 },
			),
		personalStore: personalStore(env),
		personalProvider: personalProvider(env),
		listSkills: async (orgId) => (await agent(orgId)).listExternalOrgSkills(),
		loadSkill: async (orgId, id, expectedVersion) =>
			(await agent(orgId)).loadExternalOrgSkill(id, expectedVersion),
		audit: (event) => console.log(JSON.stringify({ externalAccess: event })),
	}
}
