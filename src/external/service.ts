import type { z } from "zod"
import {
	searchSchema,
	listSchema,
	loadSchema,
	topicTagSchema,
	type Principal,
	type SearchInput,
	type MemoryResult,
	type SkillIndex,
	type SkillLoadResult,
} from "./contracts"
import { requireGrant } from "./credentials"
import { ExternalError, publicError } from "./errors"
import { boundedText, jsonBytes, MAX_RESULT_BYTES } from "./limits"

export type Operation = "search" | "list" | "load"
export type ExternalDependencies = {
	authenticate: () => Promise<Principal>
	quota: (principal: Principal, operation: Operation) => Promise<void>
	search: (input: SearchInput, signal: AbortSignal) => Promise<unknown>
	listSkills: (orgId: string) => Promise<SkillIndex[]>
	loadSkill: (
		orgId: string,
		id: string,
		expectedVersion?: number,
	) => Promise<SkillLoadResult>
	audit?: (event: Record<string, unknown>) => void
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input)
	if (!parsed.success)
		throw new ExternalError(
			"invalid_input",
			400,
			"Invalid or unauthorized input fields",
		)
	return parsed.data
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {}
const date = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value.length <= 40 &&
	/^\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?$/.test(value) &&
	Number.isFinite(Date.parse(value))
		? value
		: undefined

function sources(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.slice(0, 10).flatMap((item) => {
		if (typeof item !== "string" || item.length > 2048) return []
		try {
			const url = new URL(item)
			return url.protocol === "https:" && !url.username && !url.password
				? [url.href]
				: []
		} catch {
			return []
		}
	})
}

export function normalizeSearch(response: unknown, limit: number) {
	const raw = object(response).results
	const candidates = Array.isArray(raw) ? raw : []
	const results: MemoryResult[] = []
	let truncated = candidates.length > limit
	for (const candidate of candidates.slice(0, limit)) {
		const row = object(candidate)
		if (typeof row.id !== "string" || !row.id || row.id.length > 200) continue
		const kind =
			typeof row.memory === "string"
				? "memory"
				: typeof row.chunk === "string"
					? "chunk"
					: null
		if (!kind) continue
		const text = boundedText(
			(kind === "memory" ? row.memory : row.chunk) as string,
			4096,
		)
		const metadata = object(row.metadata)
		// Defense in depth for incorrectly tagged provider data; missing scope is
		// accepted only because the server has already selected the shared container.
		if (
			metadata.memory_scope !== undefined &&
			metadata.memory_scope !== "shared"
		)
			continue
		const tags = Array.isArray(metadata.brain_tags)
			? (metadata.brain_tags
					.slice(0, 10)
					.filter((tag) => topicTagSchema.safeParse(tag).success) as string[])
			: []
		const result: MemoryResult = {
			id: { kind, value: row.id },
			text: text.text,
			textTruncated: text.truncated,
			...(typeof row.similarity === "number" && Number.isFinite(row.similarity)
				? { score: row.similarity }
				: {}),
			sourceUrls: sources(metadata.sources),
			topicTags: tags,
			dates: {
				recordUpdatedAt: date(row.updatedAt),
				ingestionDate: date(metadata.ingestion_date),
				eventDate: date(metadata.event_date),
			},
		}
		if (
			jsonBytes({ results: [...results, result], truncated: true }) >
			MAX_RESULT_BYTES
		) {
			truncated = true
			break
		}
		results.push(result)
	}
	return { results, truncated }
}

/** Reauthenticate every operation, even after MCP initialization. No cached principal. */
export async function execute(
	deps: ExternalDependencies,
	operation: Operation,
	input: unknown,
	requestSignal?: AbortSignal,
) {
	const started = Date.now()
	const requestId = crypto.randomUUID()
	let principal: Principal | undefined
	let status = "ok"
	let resultCount = 0
	try {
		principal = await deps.authenticate()
		requireGrant(
			principal,
			operation === "search" ? "memory.shared:read" : "skills.org:read",
		)
		const parsed =
			operation === "search"
				? parseInput(searchSchema, input)
				: operation === "load"
					? parseInput(loadSchema, input)
					: parseInput(listSchema, input)
		await deps.quota(principal, operation)
		let result: unknown
		if (operation === "search") {
			const timeout = AbortSignal.timeout(8000)
			const signal = requestSignal
				? AbortSignal.any([timeout, requestSignal])
				: timeout
			try {
				result = normalizeSearch(
					await deps.search(parsed as SearchInput, signal),
					(parsed as SearchInput).limit,
				)
			} catch {
				throw new ExternalError(
					timeout.aborted ? "upstream_timeout" : "upstream_failure",
					timeout.aborted ? 504 : 502,
					timeout.aborted
						? "Memory search timed out"
						: "Memory search unavailable",
				)
			}
			resultCount = (result as { results: unknown[] }).results.length
		} else if (operation === "list") {
			const skills: SkillIndex[] = []
			const rows = await deps.listSkills(principal.orgId)
			let truncated = rows.length > 100
			for (const row of rows.slice(0, 100)) {
				const skill = {
					id: row.id,
					name: row.name,
					description: row.description,
					version: row.version,
				}
				if (
					jsonBytes({ skills: [...skills, skill], truncated: true }) >
					MAX_RESULT_BYTES
				) {
					truncated = true
					break
				}
				skills.push(skill)
			}
			result = { skills, truncated }
			resultCount = skills.length
		} else {
			const { id, expectedVersion } = parsed as {
				id: string
				expectedVersion?: number
			}
			const loaded = await deps.loadSkill(principal.orgId, id, expectedVersion)
			if ("error" in loaded) {
				if (loaded.error === "output_limit")
					throw new ExternalError(
						"output_limit",
						502,
						"Skill exceeds output limit",
					)
				throw new ExternalError(
					loaded.error,
					loaded.error === "not_found" ? 404 : 409,
					loaded.error === "not_found"
						? "Skill not found"
						: "Skill version changed",
					loaded.error === "version_conflict"
						? { currentVersion: loaded.currentVersion }
						: undefined,
				)
			}
			result = loaded
			resultCount = 1
		}
		if (jsonBytes(result) > MAX_RESULT_BYTES)
			throw new ExternalError(
				"output_limit",
				502,
				"Result exceeds output limit",
			)
		return result
	} catch (error) {
		status = publicError(error).code
		throw publicError(error)
	} finally {
		deps.audit?.({
			requestId,
			credentialId: principal?.credentialId,
			actor: principal?.userId,
			org: principal?.orgId,
			grants: principal?.grants,
			operation,
			resultCount,
			status,
			durationMs: Date.now() - started,
		})
	}
}
