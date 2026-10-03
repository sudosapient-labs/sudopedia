import { ExternalError } from "./errors"

export const MAX_BODY_BYTES = 64 * 1024
// MCP returns both readable content and structured data within a 64-KiB envelope.
export const MAX_RESULT_BYTES = 28 * 1024
const encoder = new TextEncoder()
export const jsonBytes = (value: unknown) =>
	encoder.encode(JSON.stringify(value)).byteLength

export function boundedText(
	value: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	if (encoder.encode(value).byteLength <= maxBytes)
		return { text: value, truncated: false }
	let bytes = 0
	let text = ""
	for (const char of value) {
		bytes += encoder.encode(char).byteLength
		if (bytes > maxBytes) break
		text += char
	}
	return { text, truncated: true }
}

export async function readBody(request: Request): Promise<Uint8Array> {
	if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
		throw new ExternalError("too_large", 413, "Request exceeds 64 KiB")
	const reader = request.body?.getReader()
	if (!reader) return new Uint8Array()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > MAX_BODY_BYTES) {
				await reader.cancel()
				throw new ExternalError("too_large", 413, "Request exceeds 64 KiB")
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

export async function readJson(request: Request): Promise<unknown> {
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim() !==
		"application/json"
	)
		throw new ExternalError("media_type", 415, "Use application/json")
	const bytes = await readBody(request)
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
		)
	} catch {
		throw new ExternalError("invalid_input", 400, "Invalid JSON")
	}
}

export function boundedSetting(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = Number(value)
	return value && Number.isFinite(parsed)
		? Math.max(min, Math.min(max, parsed))
		: fallback
}
