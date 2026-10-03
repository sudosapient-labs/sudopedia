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
	captureSchema,
	correctSchema,
	retractSchema,
	statusSchema,
	type WriteInput,
	type RetractInput,
} from "./contracts"
import { hashSecret, requireGrant } from "./credentials"
import { ExternalError, publicError } from "./errors"
import { boundedText, jsonBytes, MAX_RESULT_BYTES } from "./limits"
import {
	maintainPersonal,
	referenceId,
	type PersonalStore,
	type PersonalProvider,
	type PersonalEntry,
} from "./personal"

export type Operation =
	"search" | "list" | "load" | "capture" | "correct" | "retract" | "status"
export type ExternalDependencies = {
	authenticate: () => Promise<Principal>
	quota: (principal: Principal, operation: Operation) => Promise<void>
	search: (input: SearchInput, signal: AbortSignal) => Promise<unknown>
	personalSearch?: (
		input: SearchInput,
		principal: Principal,
		signal: AbortSignal,
	) => Promise<unknown>
	personalStore?: PersonalStore
	personalProvider?: PersonalProvider
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

export function normalizeSearch(
	response: unknown,
	limit: number,
	scope: "shared" | "personal" = "shared",
) {
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
			!(scope === "shared" ? ["shared"] : ["personal", "dm"]).includes(
				String(metadata.memory_scope),
			)
		)
			continue
		const tags = Array.isArray(metadata.brain_tags)
			? (metadata.brain_tags
					.slice(0, 10)
					.filter((tag) => topicTagSchema.safeParse(tag).success) as string[])
			: []
		const result: MemoryResult = {
			scope,
			editable: false,
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
		if (operation === "search") {
			if (
				!principal.grants.some(
					(g) => g === "memory.shared:read" || g === "memory.personal:read",
				)
			)
				throw new ExternalError(
					"forbidden",
					403,
					"Required read grant not present",
				)
		} else
			requireGrant(
				principal,
				["list", "load"].includes(operation)
					? "skills.org:read"
					: "memory.personal:write",
			)
		const parsed =
			operation === "search"
				? parseInput(searchSchema, input)
				: operation === "load"
					? parseInput(loadSchema, input)
					: operation === "capture"
						? parseInput(captureSchema, input)
						: operation === "correct"
							? parseInput(correctSchema, input)
							: operation === "retract"
								? parseInput(retractSchema, input)
								: operation === "status"
									? parseInput(statusSchema, input)
									: parseInput(listSchema, input)
		await deps.quota(principal, operation)
		let result: unknown
		if (operation === "search") {
			const timeout = AbortSignal.timeout(8000)
			const signal = requestSignal
				? AbortSignal.any([timeout, requestSignal])
				: timeout
			try {
				const query = parsed as SearchInput
				const snapshots = new Map<MemoryResult, PersonalEntry>()
				const scopes = await Promise.all([
					...(principal.grants.includes("memory.shared:read")
						? [
								deps
									.search(query, signal)
									.then((r) => normalizeSearch(r, query.limit)),
							]
						: []),
					...(principal.grants.includes("memory.personal:read")
						? [
								(async () => {
									if (!deps.personalSearch || !deps.personalStore)
										throw new ExternalError(
											"unavailable",
											503,
											"Personal memory unavailable",
										)
									const raw = await deps.personalSearch(
										query,
										principal!,
										signal,
									)
									const normalized = normalizeSearch(
										raw,
										query.limit,
										"personal",
									)
									const rows = object(raw).results as unknown[]
									for (const row of normalized.results) {
										signal.throwIfAborted()
										// Keep personal provider IDs opaque even for read-only credentials.
										const source = object(
											rows.find((r) => object(r).id === row.id.value),
										)
										if (
											row.id.kind === "memory" &&
											date(source.updatedAt) !== undefined
										) {
											const entry = source as PersonalEntry
											const ref = await referenceId(principal!, entry)
											row.id.value = ref
												if (principal!.grants.includes("memory.personal:write")) {
													snapshots.set(row, entry)
													// Reserve reference output bytes before ranking/limiting.
													row.reference = ref
												row.editable = true
											}
										} else {
											row.id.value = await hashSecret(JSON.stringify([
												principal!.orgId, principal!.userId, row.id.value,
											]))
										}
									}
									return normalized
								})(),
							]
						: []),
				])
				signal.throwIfAborted()
				const seen = new Set<string>()
				const combined = scopes
					.flatMap((s) => s.results)
					.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
				const results: MemoryResult[] = []
				let truncated = scopes.some((s) => s.truncated)
				for (const row of combined) {
					const key = `${row.scope}:${row.id.kind}:${row.id.value}`
					if (seen.has(key)) continue
					seen.add(key)
					if (
						results.length >= query.limit ||
						jsonBytes({ results: [...results, row], truncated: true }) >
							MAX_RESULT_BYTES
					) {
						truncated = true
						continue
					}
					results.push(row)
				}
				const editable = results.filter((r) => snapshots.has(r))
				if (editable.length) {
					const refs = await deps.personalStore!.references(
						principal!, editable.map((r) => snapshots.get(r)!), signal,
					)
					signal.throwIfAborted()
					editable.forEach((row, i) => {
						if (refs[i]) row.reference = refs[i]!
						else {
							delete row.reference
							row.editable = false
						}
					})
				}
				result = { results, truncated }
			} catch (error) {
				if (error instanceof ExternalError) throw error
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
		} else if (operation === "load") {
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
		} else {
			if (!deps.personalStore || !deps.personalProvider)
				throw new ExternalError(
					"unavailable",
					503,
					"Personal memory unavailable",
				)
			const signal = requestSignal
				? AbortSignal.any([requestSignal, AbortSignal.timeout(8000)])
				: AbortSignal.timeout(8000)
			result = await maintainPersonal(
				deps.personalStore,
				deps.personalProvider,
				principal,
				operation,
				parsed as WriteInput | RetractInput,
				signal,
			)
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
