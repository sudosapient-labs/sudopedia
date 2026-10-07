import type { CompanyBrainAgent } from "../turn/agent"

export type KnowledgeAgent = Pick<CompanyBrainAgent, "sql">
export type SimpleAudience =
	| { kind: "users"; userIds: string[] }
	| { kind: "slack_channel"; teamId: string; channelId: string }
export type Audience = SimpleAudience | { kind: "intersection"; audiences: SimpleAudience[] }

export interface KnowledgeSource {
	id: string
	orgId: string
	connectionId: string
	provider: string
	ownerUserId: string | null
	audience: Audience
	state: "active" | "error" | "revoked" | "unsupported" | "partial"
	coverage: string[]
	cursor: string | null
	lastCheckedAt: number | null
	lastProcessedAt: number | null
	processedThrough: number | null
	nextCheckAt: number
	intervalMs: number
	failures: number
	error: string | null
}

export interface EvidenceEvent {
	sourceId: string
	eventId: string
	objectId: string
	version: number
	/** Original message/object timestamp, not the latest edit's observation time. */
	occurredAt: number
	/** Time this version/state was observed; version remains authoritative ordering. */
	observedAt: number
	deleted: boolean
	url: string
	text: string
	audience: Audience
	context?: string
	/** Full-content identity before clipping/redaction; never a source credential. */
	contentFingerprint?: string
	/** Provider's content edit timestamp, distinct from webhook delivery ordering. */
	contentVersion?: number
}

export interface FactProposal {
	subject: string
	predicate: string
	value: string
	evidenceIds: string[]
	confidence: "confirmed" | "uncertain"
	relatedObjectIds?: string[]
}

export interface KnowledgeFact extends FactProposal {
	id: number
	sourceId: string
	objectId: string
	version: number
	occurredAt: number
	observedAt: number
	audience: Audience
	evidence: EvidenceEvent[]
	current: boolean
	invalidatedAt: number | null
}

export interface KnowledgeQueryResult {
	facts: KnowledgeFact[]
	truncated: boolean
}
