import { getAgentByName } from "agents"
import type { CompanyBrainAgent } from "../brain/turn/agent"
import { memoryClient } from "../memory/client"
import { authenticate, consumeQuota } from "./credentials"
import { hashSecret } from "./credentials"
import { boundedSetting } from "./limits"
import type { ExternalDependencies } from "./service"
import type { SearchInput } from "./contracts"
import {
	personalStore,
	fingerprint,
	type PersonalEntry,
	type PersonalProvider,
} from "./personal"
import { ExternalError } from "./errors"

type MutationMetadata = Record<string, string | number | boolean | string[]>
const unsupportedMetadata = () => new ExternalError(
	"unsupported_metadata", 409,
	"Personal memory metadata cannot be preserved safely; no memory write was dispatched",
)
function validateMutationMetadata(metadata: Record<string, unknown>): MutationMetadata {
	// Provider list metadata allows arbitrary JSON. PATCH accepts only these values.
	// Reject incompatible entries in preflight; never drop/coerce provenance fields.
	for (const value of Object.values(metadata)) {
		if (typeof value === "string" || typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value)) ||
			(Array.isArray(value) && Array.from(value).every((item) => typeof item === "string"))) continue
		throw unsupportedMetadata()
	}
	return metadata as MutationMetadata
}

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

// The documented document-ingestion API creates missing containers. SuperRAG
// skips fact extraction/profile updates; this static bootstrap contains no facts,
// secrets or conversation text. A stable custom ID bounds retries to one document.
export const PERSONAL_BOOTSTRAP =
	"Private memory container bootstrap. This is infrastructure, not an employee fact."

async function ensurePersonalContainer(
	env: Env,
	owner: Parameters<PersonalProvider["find"]>[0],
	signal: AbortSignal,
) {
	const client = memoryClient(env)
	const containerTag = personalContainer(owner.userId)
	const path = `/v3/container-tags/${encodeURIComponent(containerTag)}`
	const options = { signal, timeout: 8000, maxRetries: 0 }
	try {
		await client.get(path, options)
		return
	} catch (error) {
		if ((error as { status?: number }).status !== 404) throw error
	}
	const digest = await hashSecret(JSON.stringify([owner.orgId, owner.userId]))
	const response = await client.add({
		content: PERSONAL_BOOTSTRAP,
		customId: `sd_personal_bootstrap_${digest}`,
		containerTag,
		taskType: "superrag",
		metadata: { memory_scope: "personal", source_type: "external-container-bootstrap" },
	}, options)
	if (!response.id) throw new Error("Invalid bootstrap result")
	// Acceptance is not proof of provisioning. Fail preflight if not yet available;
	// a later intent can safely reuse the identical SuperRAG bootstrap custom ID.
	await client.get(path, options)
}

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
			const metadataFor = (entry?: PersonalEntry) => {
				if (entry?.metadata != null &&
					(typeof entry.metadata !== "object" || Array.isArray(entry.metadata)))
					throw unsupportedMetadata()
				return validateMutationMetadata({
					...entry?.metadata,
					memory_scope: "personal",
					source_type: "external-primary-bot",
					external_integration: owner.credentialId,
					external_operation: operationId,
					ingestion_date: new Date().toISOString().slice(0, 10),
					...("eventDate" in input && input.eventDate
						? { event_date: input.eventDate }
						: {}),
				})
			}
			const update = async (entry: PersonalEntry, preserveExpiry = false) => {
				const metadata = metadataFor(entry)
				await context.onDispatch({ action: "correct", providerId: entry.id,
					fingerprint: await fingerprint(entry) })
				const response = await client.memories.updateMemory({
					id: entry.id,
					containerTag,
					newContent: (input as { content: string }).content,
					metadata,
					...(!preserveExpiry ? { forgetAfter: null } : {}),
				}, options)
				if (!response.id || response.parentMemoryId !== entry.id ||
					(!preserveExpiry && response.forgetAfter !== null))
					throw new Error("Invalid provider result")
			}
			if (operation === "retract") {
				await context.onDispatch({ action: "retract", providerId: id,
					fingerprint: context.current ? await fingerprint(context.current) : undefined })
				const response = await client.memories.forget(
					{
						id,
						containerTag,
						reason: `Employee retraction; external_operation=${operationId}`,
					},
					options,
				)
				if (!response.forgotten || response.id !== id)
					throw new Error("Invalid provider result")
			} else if (operation === "correct") {
				if (!context.current || context.current.id !== id)
					throw new Error("Verified personal memory required")
				await update(context.current, (input as { retention?: string }).retention === "preserve")
			} else {
				const content = (input as { content: string }).content
				await ensurePersonalContainer(env, owner, signal)
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
				const match = existing.results.find((row) => row.memory?.trim() === content)
				if (match) {
					// Search omits expiry state. Reverify the full owner-scoped snapshot
					// before promoting an expiring repeat; never use an unscoped ID fetch.
					const current = await this.find(owner, match.id, signal)
					if (!current || current.isLatest === false || current.isForgotten ||
						current.memory.trim() !== content ||
						(current.forgetAfter && Date.parse(current.forgetAfter) <= Date.now()))
						throw new ExternalError("stale_reference", 409,
							"Matching personal memory changed or is unavailable; search again")
					if (current.forgetAfter) await update(current)
					return { status: "applied" }
				}
				const metadata = metadataFor()
				await context.onDispatch({ action: "capture" })
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
									forgetAfter: null,
									metadata,
								},
							],
						},
					},
				)
				if (response.memories?.length !== 1 || !response.memories[0]?.id ||
					(response.memories[0] as { forgetAfter?: string | null }).forgetAfter !== null)
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
