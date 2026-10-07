import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ connection: vi.fn(), open: vi.fn(), inspect: vi.fn(), call: vi.fn(), close: vi.fn(), slack: vi.fn() }))
vi.mock("../tools/mcp/store", () => ({ getConnectionById: mocks.connection }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: vi.fn() }))
vi.mock("./adapters", async importOriginal => ({ ...await importOriginal<typeof import("./adapters")>(), openKnowledgeProvider: mocks.open, inspectKnowledgeTools: mocks.inspect, slackKnowledgeRequest: mocks.slack, slackKnowledgeToken: async () => "fictional" }))
import { evidenceVerifier } from "./verify"
import type { EvidenceEvent, KnowledgeSource } from "./types"
const source: KnowledgeSource = { id: "s", orgId: "org", connectionId: "conn", provider: "linear", ownerUserId: "a", audience: { kind: "users", userIds: ["a"] }, state: "partial", coverage: [], cursor: null, lastCheckedAt: null, lastProcessedAt: null, processedThrough: null, nextCheckAt: 0, intervalMs: 60000, failures: 0, error: null }
const event: EvidenceEvent = { sourceId: "s", eventId: "e", objectId: "issue", version: 1000, occurredAt: 1000, observedAt: 1000, deleted: false, url: "https://linear.app/test", text: "Recorded progress", audience: source.audience }
beforeEach(() => {
	vi.clearAllMocks(); mocks.connection.mockResolvedValue({ orgId: "org", status: "active", serverUrl: "https://mcp.linear.app/mcp" })
	mocks.open.mockResolvedValue({ callTool: mocks.call, close: mocks.close }); mocks.close.mockResolvedValue(undefined)
	mocks.inspect.mockResolvedValue([{ name: "get_issue", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: true } }])
	mocks.call.mockResolvedValue({ structuredContent: { id: "issue", updatedAt: new Date(1000).toISOString() } })
})
describe("live provider object access", () => {
	it("withholds missed Slack deletions/edits and verifies old reply objects", async () => {
		const slackSource = { ...source, provider: "slack", audience: { kind: "slack_channel" as const, teamId: "T1", channelId: "C1" } }
		const raw = { ts: "1.000001", user: "U1", text: "Original", thread_ts: "0.000001" }
		const { slackEvidence } = await import("./adapters")
		const recorded = slackEvidence(slackSource, raw, 1000)!
		const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ bot_token_enc: "encrypted" }) }) }) } } as unknown as Env
		mocks.slack.mockResolvedValue({ messages: [raw] })
		expect(await evidenceVerifier(env).verify(slackSource, recorded)).toBe(true)
		expect(mocks.slack).toHaveBeenCalledWith("fictional", "conversations.replies", expect.objectContaining({ ts: "0.000001", oldest: "1.000001", inclusive: "true" }), expect.anything())
		for (const messages of [[], [{ ...raw, text: "Changed", edited: { ts: "2.000001" } }]]) {
			mocks.slack.mockResolvedValue({ messages })
			const verifier = evidenceVerifier(env)
			expect(await verifier.verify(slackSource, recorded)).toBe(false)
			expect(verifier.incomplete()).toBe(true)
		}
	})
	it("requires a matching accessible object and caches only within the request", async () => {
		const verifier = evidenceVerifier({} as Env)
		expect(await verifier.verify(source, event)).toBe(true); expect(await verifier.verify(source, event)).toBe(true)
		expect(mocks.call).toHaveBeenCalledExactlyOnceWith("get_issue", { id: "issue" })
		await verifier.close(); expect(mocks.close).toHaveBeenCalledOnce()
	})
	it("withholds current facts when the live version is newer, but permits explicitly historical recall", async () => {
		mocks.call.mockResolvedValue({ structuredContent: { id: "issue", updatedAt: new Date(2000).toISOString() } })
		const verifier = evidenceVerifier({} as Env)
		expect(await verifier.verify(source, event)).toBe(false)
		expect(verifier.incomplete()).toBe(true)
		expect(await verifier.verify(source, event, true)).toBe(true)
	})
	it("revoked OAuth, object permission errors and foreign object identity fail closed", async () => {
		for (const response of [{ isError: true }, { structuredContent: { id: "other", updatedAt: new Date(1000).toISOString() } }]) {
			mocks.call.mockResolvedValue(response)
			const verifier = evidenceVerifier({} as Env)
			expect(await verifier.verify(source, event)).toBe(false); expect(verifier.incomplete()).toBe(true)
		}
		mocks.open.mockRejectedValue(new Error("secret provider error"))
		expect(await evidenceVerifier({} as Env).verify(source, event)).toBe(false)
	})
	it("does not guess get-tool schemas, invoke writes, or trust lookalike provider hosts", async () => {
		mocks.inspect.mockResolvedValue([{ name: "get_issue", inputSchema: { type: "object", required: ["team"] } }])
		expect(await evidenceVerifier({} as Env).verify(source, event)).toBe(false)
		expect(mocks.call).not.toHaveBeenCalled()
		mocks.connection.mockResolvedValue({ orgId: "org", status: "active", serverUrl: "https://mcp.linear.app.attacker.invalid/mcp" })
		expect(await evidenceVerifier({} as Env).verify(source, event)).toBe(false)
	})
})
