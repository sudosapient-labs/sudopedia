// Deterministic fictional provider semantics, NOT evidence of live consistency.
import type {
	PersonalEntry,
	PersonalProvider,
} from "../../src/external/personal"
import type { Principal, SearchInput } from "../../src/external/contracts"
import { fingerprint } from "../../src/external/personal"

type Row = PersonalEntry & {
	owner: string
	metadata: NonNullable<PersonalEntry["metadata"]>
}
export const personalRows: Row[] = [
	{
		id: "employee-a-preference",
		owner: "owner",
		memory: "Employee A prefers morning reviews.",
		updatedAt: "2026-10-01T12:00:00Z",
		metadata: { memory_scope: "dm" },
	},
	{
		id: "employee-b-preference",
		owner: "member",
		memory: "Employee B prefers afternoon reviews.",
		updatedAt: "2026-10-01T12:00:00Z",
		metadata: { memory_scope: "personal" },
	},
	{
		id: "private-channel-secret",
		owner: "slack_channel_secret",
		memory: "Private-channel fictional launch plan.",
		updatedAt: "2026-10-01T12:00:00Z",
		metadata: { memory_scope: "private_channel" },
	},
]
export let personalMutations = 0
export const fakePersonalProvider: PersonalProvider = {
	async find(owner, id) {
		return (
			personalRows.find(
				(r) =>
					r.id === id &&
					r.owner === owner.userId &&
					!r.isForgotten &&
					r.isLatest !== false,
			) ?? null
		)
	},
	async mutate(owner, operation, input, id, operationId, signal, context) {
		await context.onDispatch({ action: operation, providerId: id,
			fingerprint: context.current ? await fingerprint(context.current) : undefined })
		personalMutations++
		if ("content" in input && input.content === "pending fictional fact")
			return { status: "pending" }
		if ("content" in input && input.content === "provider failure")
			throw new Error("SECRET_PROVIDER_ERROR")
		if ("content" in input && input.content === "provider timeout") {
			await new Promise((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason)
				else
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					})
			})
		}
		const current = personalRows.find(
			(r) => r.id === id && r.owner === owner.userId,
		)
		if (
			operation !== "capture" &&
			(!current || current.isLatest === false || current.isForgotten)
		)
			throw new Error("Out of scope")
		if (operation === "retract") current!.isForgotten = true
		else {
			if (
				operation === "capture" &&
				personalRows.some(
					(r) =>
						r.owner === owner.userId &&
						!r.isForgotten &&
						r.isLatest !== false &&
						r.memory === (input as { content: string }).content,
				)
			)
				return { status: "applied" }
			if (current) current.isLatest = false
			personalRows.push({
				id: crypto.randomUUID(),
				owner: owner.userId,
				memory: (input as { content: string }).content,
				updatedAt: new Date().toISOString(),
				forgetAfter: operation === "correct" && "retention" in input &&
					input.retention === "preserve" ? current?.forgetAfter : null,
				metadata: {
					...(operation === "correct" ? context.current?.metadata : {}),
					memory_scope: "personal",
					source_type: "external-primary-bot",
					external_operation: operationId,
				},
			})
		}
		return { status: "applied" }
	},
}
export async function fakePersonalSearch(input: SearchInput, owner: Principal) {
	return {
		results: personalRows
			.filter(
				(r) =>
					r.owner === owner.userId &&
					!r.isForgotten &&
					r.isLatest !== false &&
					(input.query === "all personal" ||
						input.query
							.toLowerCase()
							.split(/\s+/)
							.some((word) => r.memory.toLowerCase().includes(word))),
			)
			.slice(0, input.limit)
			.map((r) => ({ ...r, similarity: 0.92 })),
	}
}
