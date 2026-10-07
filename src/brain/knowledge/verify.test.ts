import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ connection: vi.fn(), open: vi.fn(), inspect: vi.fn(), call: vi.fn(), close: vi.fn(), slack: vi.fn(), history: vi.fn() }))
vi.mock("../tools/mcp/store", () => ({ getConnectionById: mocks.connection }))
vi.mock("../tools/mcp/client", () => ({ connectMcpClient: vi.fn() }))
vi.mock("../tools/mcp/provider", () => ({ connectToolProvider: vi.fn() }))
vi.mock("../slack/client", () => ({ getSlackChannelHistoryPage: mocks.history }))
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
	it.each([15, 25, 100])("checks full content identity across clipping/redaction with page size %i", async limit => {
		const slackSource = { ...source, provider: "slack", audience: { kind: "slack_channel" as const, teamId: "T1", channelId: "C1" } }
		const raw = { ts: "1.000001", user: "U1", text: "x".repeat(2500) + " password=supersecret " + "y".repeat(14000) }
		const { KnowledgeBudget, pollSlack, slackEvidence } = await import("./adapters")
		const { redactKnowledgeSecrets } = await import("./secrets")
		mocks.history.mockResolvedValue({ ok: true, items: [raw], complete: true })
		const page = await pollSlack(slackSource, "fictional", new KnowledgeBudget(4, Date.now() + 1000), { now: Date.now(), backfillMs: 1000, limit })
		const recorded = { ...page.events[0]!, text: redactKnowledgeSecrets(page.events[0]!.text) }
		expect(recorded.text.length).toBeLessThan(raw.text.length)
		const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ bot_token_enc: "encrypted" }) }) }) } } as unknown as Env
		mocks.slack.mockResolvedValue({ messages: [raw] })
		expect(await evidenceVerifier(env).verify(slackSource, recorded)).toBe(true)
		const webhook = slackEvidence(slackSource, raw, Date.now(), "delivery", "2.000001")!
		expect(webhook.contentFingerprint).toBe(recorded.contentFingerprint)
		expect(await evidenceVerifier(env).verify(slackSource, webhook)).toBe(true)
		// Even an edit beyond both display clipping limits changes the fingerprint.
		mocks.slack.mockResolvedValue({ messages: [{ ...raw, text: raw.text + " changed", edited: { ts: "3.000001" } }] })
		expect(await evidenceVerifier(env).verify(slackSource, recorded)).toBe(false)
	})
	it("verifies a default 25-issue batch with one catalog lookup and retained bounded setup cost", async () => {
		mocks.open.mockImplementation(async (_env, _connection, budget) => { budget.take(6); return { callTool: mocks.call, close: mocks.close } })
		mocks.inspect.mockImplementation(async (_handle, budget) => { budget.take(); return [{ name: "get_issue", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }] })
		mocks.call.mockImplementation(async (_name, input) => ({ structuredContent: { id: input.id, updatedAt: new Date(1000).toISOString() } }))
		const verifier = evidenceVerifier({} as Env)
		for (let index = 0; index < 25; index++) expect(await verifier.verify(source, { ...event, objectId: `issue-${index}` })).toBe(true)
		expect(mocks.inspect).toHaveBeenCalledOnce(); expect(mocks.open).toHaveBeenCalledOnce()
		expect(verifier.incomplete()).toBe(false)
	})
	it("covers all five distinct source inputs emitted by bounded reasoning, including setup costs", async () => {
		mocks.open.mockImplementation(async (_env, _connection, budget) => { budget.take(6); return { callTool: mocks.call, close: mocks.close } })
		mocks.inspect.mockImplementation(async (_handle, budget) => { budget.take(); return [{ name: "get_issue", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }] })
		mocks.call.mockImplementation(async (_name, input) => ({ structuredContent: { id: input.id, updatedAt: new Date(1000).toISOString() } }))
		const verifier = evidenceVerifier({} as Env)
		for (let index = 0; index < 5; index++) {
			const s = { ...source, id: `s${index}` }
			expect(await verifier.verify(s, { ...event, sourceId: s.id, objectId: `issue-${index}` })).toBe(true)
		}
		expect(mocks.open).toHaveBeenCalledTimes(5); expect(mocks.inspect).toHaveBeenCalledTimes(5)
		expect(verifier.incomplete()).toBe(false)
	})
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
