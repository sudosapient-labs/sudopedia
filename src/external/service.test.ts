import { describe, expect, it, vi } from "vitest"
import { execute, normalizeSearch, type ExternalDependencies } from "./service"
import {
	boundedText,
	jsonBytes,
	MAX_RESULT_BYTES,
	readJson,
	readBody,
} from "./limits"
import { checkRequest, isExternalPath } from "./security"
import { ExternalError } from "./errors"
import type { Principal } from "./contracts"

const skillId = "12345678-1234-4234-8234-123456789012"
function fixture() {
	let principal: Principal = {
		credentialId: "a",
		orgId: "org-a",
		userId: "admin",
		grants: ["memory.shared:read", "skills.org:read"],
	}
	let revoked = false
	const deps: ExternalDependencies = {
		authenticate: vi.fn(async () => {
			if (revoked)
				throw new ExternalError("unauthorized", 401, "Invalid credential")
			return principal
		}),
		quota: vi.fn(async () => {}),
		search: vi.fn(async () => ({ results: [] })),
		listSkills: vi.fn(async () => [
			{
				id: skillId,
				name: "Release",
				description: "Check releases",
				version: 1,
				body: "not indexed",
			},
		]),
		loadSkill: vi.fn(async () => ({
			skill: {
				id: skillId,
				name: "Release",
				description: "Check releases",
				version: 1,
				body: "Use your own approvals",
			},
		})),
		audit: vi.fn(),
	}
	return {
		deps,
		revoke: () => {
			revoked = true
		},
		switchIdentity: (p: Principal) => {
			principal = p
		},
	}
}

describe("external shared service", () => {
	it("revalidates revocation, live grants and caller identity on every call", async () => {
		const f = fixture()
		await execute(f.deps, "search", { query: "release" })
		f.switchIdentity({
			credentialId: "b",
			orgId: "org-b",
			userId: "other",
			grants: ["skills.org:read"],
		})
		await expect(
			execute(f.deps, "search", { query: "release" }),
		).rejects.toMatchObject({ status: 403 })
		await execute(f.deps, "list", {})
		expect(f.deps.listSkills).toHaveBeenCalledWith("org-b")
		f.revoke()
		await expect(
			execute(f.deps, "load", { id: skillId }),
		).rejects.toMatchObject({ status: 401 })
		expect(f.deps.search).toHaveBeenCalledTimes(1)
		expect(f.deps.loadSkill).not.toHaveBeenCalled()
	})
	it("rejects forged scope and quota failures before provider calls", async () => {
		const { deps } = fixture()
		await expect(
			execute(deps, "search", { query: "secret", containerTag: "private" }),
		).rejects.toMatchObject({ status: 400 })
		deps.quota = vi.fn(async () => {
			throw new ExternalError("rate_limited", 429, "Quota exceeded")
		})
		await expect(
			execute(deps, "search", { query: "secret" }),
		).rejects.toMatchObject({ status: 429 })
		expect(deps.search).not.toHaveBeenCalled()
	})
	it("projects lists without bodies and maps inaccessible/version conflict results", async () => {
		const { deps } = fixture()
		const listed = await execute(deps, "list", {})
		expect(JSON.stringify(listed)).not.toContain("body")
		deps.loadSkill = vi.fn(async () => ({ error: "not_found" as const }))
		await expect(execute(deps, "load", { id: skillId })).rejects.toMatchObject({
			status: 404,
		})
		deps.loadSkill = vi.fn(async () => ({
			error: "version_conflict" as const,
			currentVersion: 2,
		}))
		await expect(
			execute(deps, "load", { id: skillId, expectedVersion: 1 }),
		).rejects.toMatchObject({ status: 409 })
	})
	it("sanitizes upstream failures and excludes queries/bodies from audits", async () => {
		const { deps } = fixture()
		deps.search = vi.fn(async () => {
			throw new Error("provider-key-query-secret")
		})
		await expect(
			execute(deps, "search", { query: "sensitive-query" }),
		).rejects.toMatchObject({
			status: 502,
			message: "Memory search unavailable",
		})
		expect(
			JSON.stringify((deps.audit as ReturnType<typeof vi.fn>).mock.calls),
		).not.toMatch(/sensitive-query|provider-key/)
	})
	it("applies a bounded abort deadline to provider work", async () => {
		vi.useFakeTimers()
		const { deps } = fixture()
		const requestAbort = new AbortController()
		deps.search = vi.fn(
			(_input, signal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					}),
				),
		)
		const pending = expect(
			execute(deps, "search", { query: "release" }, requestAbort.signal),
		).rejects.toMatchObject({ status: 502 })
		await vi.advanceTimersByTimeAsync(1)
		requestAbort.abort()
		await pending
		vi.useRealTimers()
	})
	it("maps a provider deadline to sanitized 504", async () => {
		const { deps } = fixture()
		const controller = new AbortController()
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal)
		deps.search = vi.fn(async () => {
			controller.abort()
			throw new Error("SECRET upstream timed out")
		})
		try {
			await expect(
				execute(deps, "search", { query: "release" }),
			).rejects.toMatchObject({
				status: 504,
				message: "Memory search timed out",
			})
		} finally {
			timeout.mockRestore()
		}
	})
})

describe("external normalization and byte limits", () => {
	it("isolates external requests from remembered Slack/OAuth origin updates", () => {
		for (const path of [
			"/mcp",
			"/mcp/",
			"/brain/external/v1/skills",
			"/brain/external-credentials/",
			"/brain/external-credentials/id/revoke",
		])
			expect(isExternalPath(path)).toBe(true)
		for (const path of [
			"/auth/session",
			"/slack/events",
			"/mcp-other",
			"/brain/external-credentials-other",
		])
			expect(isExternalPath(path)).toBe(false)
	})
	it("types memory/chunk IDs without inventing document provenance", () => {
		const result = normalizeSearch(
			{
				results: [
					{
						id: "m",
						memory: "fact",
						similarity: 0.9,
						updatedAt: "2026-10-02T12:00:00Z",
						metadata: {
							secret: "no",
							sources: [
								"https://example.com/fake",
								"javascript:alert(1)",
								"https://user:pass@example.com",
							],
							brain_tags: ["topic_release", "user_private"],
							ingestion_date: "2026-10-01",
							event_date: "2026-09-01",
						},
						chunks: [{ documentId: "do-not-conflate" }],
					},
					{ id: "c", chunk: "snippet", metadata: null },
					{},
				],
			},
			20,
		)
		expect(result.results[0]).toMatchObject({
			id: { kind: "memory", value: "m" },
			sourceUrls: ["https://example.com/fake"],
			topicTags: ["topic_release"],
			dates: { eventDate: "2026-09-01", ingestionDate: "2026-10-01" },
		})
		expect(result.results[1]).toMatchObject({
			id: { kind: "chunk", value: "c" },
			dates: {},
		})
		expect(JSON.stringify(result)).not.toMatch(
			/secret|do-not-conflate|documentId/,
		)
		expect(normalizeSearch({}, 5)).toEqual({ results: [], truncated: false })
	})
	it("truncates Unicode at codepoint boundaries and never truncates JSON", () => {
		expect(boundedText("😀😀", 5)).toEqual({ text: "😀", truncated: true })
		const result = normalizeSearch(
			{
				results: Array.from({ length: 20 }, (_, i) => ({
					id: String(i),
					memory: "😀".repeat(3000),
					metadata: {
						sources: Array(10).fill(`https://example.com/${"x".repeat(1900)}`),
					},
				})),
			},
			20,
		)
		expect(result.truncated).toBe(true)
		expect(result.results[0]?.textTruncated).toBe(true)
		expect(jsonBytes(result)).toBeLessThanOrEqual(MAX_RESULT_BYTES)
		expect(() => JSON.parse(JSON.stringify(result))).not.toThrow()
	})
	it("caps request streams without relying on Content-Length", async () => {
		const request = new Request("https://example.com", {
			method: "POST",
			body: "😀".repeat(17000),
		})
		await expect(readBody(request)).rejects.toMatchObject({ status: 413 })
		await expect(
			readJson(
				new Request("https://example.com", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{",
				}),
			),
		).rejects.toMatchObject({ status: 400 })
	})
	it("rejects foreign/null origins, URL credentials and CSRFless mutations", () => {
		const env = { EXTERNAL_PUBLIC_URL: "https://example.com" } as Env
		expect(() =>
			checkRequest(env, new Request("http://example.com/mcp")),
		).toThrow()
		for (const origin of [
			"null",
			"https://evil.example",
			"https://example.com.evil",
			"http://example.com",
		])
			expect(() =>
				checkRequest(
					env,
					new Request("https://example.com/mcp", {
						headers: { Origin: origin },
					}),
				),
			).toThrow()
		expect(() =>
			checkRequest(env, new Request("https://example.com/mcp?token=secret")),
		).toThrow()
		expect(() =>
			checkRequest(env, new Request("https://evil.example/mcp")),
		).toThrow()
		expect(() =>
			checkRequest(
				env,
				new Request("https://example.com/", { method: "POST" }),
				true,
			),
		).toThrow()
		expect(
			checkRequest(
				env,
				new Request("https://example.com/", {
					method: "POST",
					headers: { Origin: "https://example.com", "X-Sudopedia-CSRF": "1" },
				}),
				true,
			),
		).toBe("https://example.com")
	})
})
