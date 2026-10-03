import { describe, expect, it } from "vitest"
import {
	authenticate,
	hashSecret,
	resolveCredential,
	requireGrant,
	type CredentialRow,
} from "./credentials"
import { searchSchema, loadSchema, grantsSchema } from "./contracts"

describe("external policy before transport", () => {
	const row: CredentialRow = {
		id: "integration",
		org_id: "org",
		user_id: "owner",
		secret_hash: "digest",
		grants: '["memory.shared:read"]',
		expires_at: 100,
		revoked_at: null,
		deleted: 0,
		kind: "organization",
		role: "owner",
	}
	it("binds exact live grants, no admin escalation", () => {
		const principal = resolveCredential(row, "digest", 99)
		expect(principal).toEqual({
			credentialId: "integration",
			orgId: "org",
			userId: "owner",
			grants: ["memory.shared:read"],
		})
		expect(() => requireGrant(principal, "skills.org:read")).toThrow(
			"Required grant",
		)
	})
	it("fails closed on missing, expired, revoked, deleted, malformed grants and incorrect secrets", () => {
		for (const invalid of [
			null,
			{ ...row, expires_at: 99 },
			{ ...row, expires_at: NaN },
			{ ...row, user_id: "" },
			{ ...row, revoked_at: 1 },
			{ ...row, deleted: 1 },
			{ ...row, grants: "invalid" },
			{ ...row, grants: '["admin"]' },
			{ ...row, secret_hash: "other" },
		])
			expect(() => resolveCredential(invalid, "digest", 99)).toThrow()
	})
	it("hashes secrets cryptographically", async () => {
		expect(await hashSecret("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		)
	})
	it("binds integration kinds to grants and revalidates organization admin role", () => {
		expect(
			resolveCredential(
				{
					...row,
					kind: "personal",
					role: "member",
					grants: '["memory.personal:read","memory.personal:write"]',
				},
				"digest",
				99,
			).grants,
		).toEqual(["memory.personal:read", "memory.personal:write"])
		for (const invalid of [
			{ ...row, kind: "personal", grants: '["skills.org:read"]' },
			{ ...row, kind: "organization", grants: '["memory.personal:write"]' },
			{ ...row, role: "member" },
			{ ...row, kind: "unknown" },
		])
			expect(() => resolveCredential(invalid, "digest", 99)).toThrow()
	})
	it("fails closed on auth storage failure without exposing database errors", async () => {
		const env = {
			DB: {
				prepare: () => {
					throw new Error("database credentials SECRET")
				},
			},
		} as unknown as Env
		const request = new Request("https://example.com/mcp", {
			headers: {
				Authorization: `Bearer sd_ext_12345678-1234-4234-8234-123456789012_${"a".repeat(64)}`,
			},
		})
		await expect(authenticate(env, request)).rejects.toMatchObject({
			status: 503,
			message: "Credential verification unavailable",
		})
		await expect(
			authenticate(env, new Request("https://example.com/mcp")),
		).rejects.toMatchObject({ status: 401 })
	})
	it("rejects scope, identity, arbitrary filters and container-like topic tags", () => {
		for (const key of [
			"orgId",
			"userId",
			"slackUserId",
			"admin",
			"containerTag",
			"containerTagsOverride",
			"filters",
		])
			expect(
				searchSchema.safeParse({ query: "release", [key]: "private" }).success,
			).toBe(false)
		for (const tag of [
			"user_owner",
			"slack_channel_secret",
			"sm_org_shared",
			"topic_../private",
		])
			expect(
				searchSchema.safeParse({ query: "release", topicTags: [tag] }).success,
			).toBe(false)
		expect(
			searchSchema.parse({ query: "release", topicTags: ["project_release"] })
				.limit,
		).toBe(5)
		expect(
			grantsSchema.safeParse(["skills.org:read", "skills.org:read"]).success,
		).toBe(false)
		expect(loadSchema.safeParse({ id: "guessed", admin: true }).success).toBe(
			false,
		)
	})
})
