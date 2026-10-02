import { generateText, Output, stepCountIs, streamText, tool } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
	availableProviders,
	brainProviderModel,
	getBrainModel,
	hasBrainGateway,
	hasXai,
	wrapBrainGateway,
} from "./brain-model"

const proxyEnv = (overrides: Partial<Env> = {}): Env =>
	({
		MODEL_BASE_URL: "https://proxy.example.com/v1",
		MODEL_API_KEY: "arbitrary-proxy-key",
		...overrides,
	}) as Env

function completion(
	message: object = { role: "assistant", content: "ok" },
	finishReason = "stop",
) {
	return Response.json({
		id: "chatcmpl-test",
		object: "chat.completion",
		created: 1,
		model: "proxy-model",
		choices: [{ index: 0, message, finish_reason: finishReason }],
		usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
	})
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
	const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit]
	return {
		url,
		headers: new Headers(init.headers),
		body: JSON.parse(init.body as string),
	}
}

describe("brain model routing", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it("sends chat completions to the custom base URL with the exact proxy key", async () => {
		const fetchMock = vi.fn(async () => completion())
		vi.stubGlobal("fetch", fetchMock)
		const result = await generateText({
			model: getBrainModel(
				"grok-4.5",
				proxyEnv({ MODEL_BASE_URL: " https://proxy.example.com/v1/// " }),
			),
			prompt: "Say ok",
			maxRetries: 0,
		})
		expect(result.text).toBe("ok")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const request = requestOf(fetchMock)
		expect(request.url).toBe("https://proxy.example.com/v1/chat/completions")
		expect(request.headers.get("authorization")).toBe(
			"Bearer arbitrary-proxy-key",
		)
		expect(request.headers.has("x-title")).toBe(false)
		expect(request.body.model).toBe("grok-4.5")
	})

	it("uses a custom alias for main and triage even when native and gateway keys exist", async () => {
		const fetchMock = vi.fn(async () => completion())
		vi.stubGlobal("fetch", fetchMock)
		const env = proxyEnv({
			MODEL_ID: " vendor/private-model ",
			OPENAI_API_KEY: "sk-native",
			ANTHROPIC_API_KEY: "sk-ant-native",
			OPENROUTER_API_KEY: "sk-or-native",
			CLOUDFLARE_ACCOUNT_ID: "account",
			AI_GATEWAY_NAME: "gateway",
			AI_GATEWAY_TOKEN: "gateway-token",
		})
		for (const model of ["gpt-5.6", "claude-haiku-4.5"] as const) {
			await generateText({
				model: getBrainModel(model, env),
				prompt: "Say ok",
				maxRetries: 0,
			})
		}
		expect(fetchMock).toHaveBeenCalledTimes(2)
		for (let i = 0; i < 2; i++) {
			const request = requestOf(fetchMock, i)
			expect(request.url).toBe("https://proxy.example.com/v1/chat/completions")
			expect(request.body.model).toBe("vendor/private-model")
			expect(request.headers.get("authorization")).toBe(
				"Bearer arbitrary-proxy-key",
			)
		}
		expect(hasBrainGateway(env)).toBe(false)
		const model = brainProviderModel("gpt-5.6", env, "CF_TEMP_TOKEN")
		expect(wrapBrainGateway(env, [model])).toBe(model)
		expect(availableProviders(env)).toEqual([
			"anthropic",
			"openai",
			"google",
			"xai",
		])
		// A proxy key must not enable xAI's provider-native search.
		expect(hasXai(env)).toBe(false)
	})

	it("uses native API IDs without vendor prefixes when no alias is supplied", async () => {
		const fetchMock = vi.fn(async () => completion())
		vi.stubGlobal("fetch", fetchMock)
		await generateText({
			model: getBrainModel("claude-haiku-4.5", proxyEnv()),
			prompt: "Say ok",
			maxRetries: 0,
		})
		expect(requestOf(fetchMock).body.model).toBe("claude-haiku-4-5-20251001")
	})

	it("supports tool calls and sends tool results back through the proxy", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				completion(
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call-1",
								type: "function",
								function: { name: "lookup", arguments: '{"query":"test"}' },
							},
						],
					},
					"tool_calls",
				),
			)
			.mockResolvedValueOnce(completion())
		vi.stubGlobal("fetch", fetchMock)
		const execute = vi.fn(async () => "found")
		const result = await generateText({
			model: getBrainModel("grok-4.5", proxyEnv()),
			prompt: "Look up test",
			tools: {
				lookup: tool({ inputSchema: z.object({ query: z.string() }), execute }),
			},
			stopWhen: stepCountIs(2),
			maxRetries: 0,
		})
		expect(result.text).toBe("ok")
		expect(execute).toHaveBeenCalledWith({ query: "test" }, expect.anything())
		expect(requestOf(fetchMock).body.tools[0]).toMatchObject({
			type: "function",
			function: { name: "lookup" },
		})
		expect(requestOf(fetchMock, 1).body.messages).toContainEqual({
			role: "tool",
			tool_call_id: "call-1",
			content: "found",
		})
	})

	it("supports structured JSON output for triage and research", async () => {
		const fetchMock = vi.fn(async () =>
			completion({ role: "assistant", content: '{"ok":true}' }),
		)
		vi.stubGlobal("fetch", fetchMock)
		const result = await generateText({
			model: getBrainModel(
				"claude-haiku-4.5",
				proxyEnv({ MODEL_ID: "private-model" }),
			),
			prompt: "Return whether this is ok",
			output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
			maxRetries: 0,
		})
		expect(result.output).toEqual({ ok: true })
		expect(requestOf(fetchMock).body.response_format).toMatchObject({
			type: "json_schema",
		})
	})

	it("streams responses over the proxy's chat completions endpoint", async () => {
		const chunks = [
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 1,
				model: "proxy-model",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "ok" },
						finish_reason: null,
					},
				],
			},
			{
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				created: 1,
				model: "proxy-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			},
		]
		const fetchMock = vi.fn(
			async () =>
				new Response(
					chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				),
		)
		vi.stubGlobal("fetch", fetchMock)
		const result = streamText({
			model: getBrainModel("grok-4.5", proxyEnv()),
			prompt: "Say ok",
			maxRetries: 0,
		})
		let text = ""
		for await (const chunk of result.textStream) text += chunk
		expect(text).toBe("ok")
		expect(requestOf(fetchMock).body.stream).toBe(true)
	})

	it.each([{ MODEL_BASE_URL: "not-a-url" }, { MODEL_API_KEY: " " }])(
		"fails closed on invalid custom configuration, despite native keys: %s",
		(override) => {
			const fetchMock = vi.fn()
			vi.stubGlobal("fetch", fetchMock)
			const env = proxyEnv({ ...override, OPENAI_API_KEY: "sk-native" })
			expect(() => getBrainModel("gpt-5.6", env)).toThrow(
				/MODEL_(BASE_URL|API_KEY)/,
			)
			expect(availableProviders(env)).toEqual([])
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it("does not send requests or credentials to native providers when the proxy fails", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json(
				{ error: { message: "proxy unavailable" } },
				{ status: 503 },
			),
		)
		vi.stubGlobal("fetch", fetchMock)
		await expect(
			generateText({
				model: getBrainModel(
					"gpt-5.6",
					proxyEnv({
						OPENAI_API_KEY: "sk-native",
						OPENROUTER_API_KEY: "sk-or-native",
					}),
				),
				prompt: "Say ok",
				maxRetries: 0,
			}),
		).rejects.toThrow("proxy unavailable")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(requestOf(fetchMock).url).toBe(
			"https://proxy.example.com/v1/chat/completions",
		)
		expect(requestOf(fetchMock).headers.get("authorization")).toBe(
			"Bearer arbitrary-proxy-key",
		)
	})

	it("preserves direct provider routing and OpenRouter precedence without a custom URL", () => {
		const env = {
			OPENAI_API_KEY: "sk-native",
			OPENROUTER_API_KEY: "sk-or-native",
		} as Env
		expect(brainProviderModel("gpt-5.6", env)).toMatchObject({
			provider: "openai.responses",
		})
		expect(brainProviderModel("claude-sonnet-5", env)).toMatchObject({
			provider: "openrouter.chat",
		})
		expect(availableProviders(env)).toEqual([
			"anthropic",
			"openai",
			"google",
			"xai",
		])
		expect(availableProviders({ OPENAI_API_KEY: "sk-native" } as Env)).toEqual([
			"openai",
		])
		expect(
			hasBrainGateway({
				CLOUDFLARE_ACCOUNT_ID: "account",
				AI_GATEWAY_NAME: "gateway",
				AI_GATEWAY_TOKEN: "token",
			} as Env),
		).toBe(true)
	})

	it("preserves the legacy OpenRouter base URL override and vendor/model IDs", async () => {
		const fetchMock = vi.fn(async () => completion())
		vi.stubGlobal("fetch", fetchMock)
		await generateText({
			model: getBrainModel("grok-4.5", {
				OPENROUTER_API_KEY: "router-key",
				OPENROUTER_BASE_URL: "https://router.example.com/v1",
			} as Env),
			prompt: "Say ok",
			maxRetries: 0,
		})
		const request = requestOf(fetchMock)
		expect(request.url).toBe("https://router.example.com/v1/chat/completions")
		expect(request.body.model).toBe("x-ai/grok-4.5")
		expect(request.headers.get("authorization")).toBe("Bearer router-key")
	})
})
