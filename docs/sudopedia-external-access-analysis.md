# Sudopedia external-agent access: codebase analysis and design

Date: 2026-10-02. Reviewed baseline: `ef8a45ef3aed97b32599c7d8007edefab6d14e9a`.

Repository: `sudosapient-labs/sudopedia`, forked from `supermemoryai/company-brain`.

## 1. Recommendation

Keep the existing Cloudflare architecture and Slack harness. **The user has not deployed this project yet.** Add an **authenticated, read-only knowledge gateway**, with **remote MCP as the primary agent interface** and a small HTTP companion for applications that do not support MCP. Implement and verify it on a feature branch before PR review, merge, and a separately authorized first deployment.

Both interfaces must call the same authorization and application services. This is not two backends, a new reasoning agent, or a port of the harness.

The first release should expose exactly three capabilities:

1. Search organization-shared memory.
2. List organization skill descriptions without their bodies.
3. Load an organization skill's Markdown instructions and version.

External agents retain their own model, conversation history, tools, and execution policy. Sudopedia supplies company knowledge and procedures. The existing Slack bot remains a consumer of the same underlying knowledge.

Default external credentials should be bound to an existing member, revocable, expiring, and granted only `memory.shared:read` and/or `skills.org:read`. Private memory, personal skills, memory writes, and connected-app execution are out of scope for v1.

## 2. What is actually present

The implementation is Slack-first, single-tenant per deployment, and already Cloudflare-native. Some architecture documents still describe the original monorepo and Postgres system. Use checked-out code and the current user guide over those historical documents.

| Component | Code evidence | Implication for this change |
| --- | --- | --- |
| Worker / Hono routing | `src/worker.ts`, `src/routes/index.ts` | Add routes to the current Worker; no separate deployment is required. |
| Org agent / durable state | `src/brain/turn/agent.ts`, `agent.impl.ts` | One Agents SDK Durable Object per org owns runtime state and skills. Preserve its lazy-loading design. |
| Application database | `src/db/index.ts`, `src/db/schema/auth.ts` | Drizzle over D1; appropriate home for external credentials. |
| Browser identity | `src/auth/routes.ts`, `src/auth/session.ts` | Slack login creates org/member identities; signed browser cookies are not external-agent credentials. |
| Slack-to-user mappings | `src/db/schema/slack.ts`, `src/brain/slack/workspace.ts` | Useful for a later delegated private-memory release, not an identity supplied by a model. |
| Memory storage | `src/memory/client.ts` | The server uses a deployment-level Supermemory key. Keep it server-side. |
| Memory provider search | `src/compat/routes/v4/search/handlers.ts` | Calls `client.search.memories` with a container tag; it is a helper, not an exposed public question API. |
| Harness search | `src/brain/memory/search-brain.ts` | Per-container hybrid search, batches of six, deduplication by ID, top 40 results. |
| Memory read policy | `src/brain/memory/read-scope.ts` | Derives Slack room visibility; includes an explicit container override intended for trusted callers. |
| Memory provenance | `src/brain/memory/writeback.ts` | Writes titles, sources, ingestion dates, event context, memory scope, and topic metadata. |
| Memory listing | `src/memory/memories.ts` | Normalizes list responses, filters forgotten/non-latest/expired entries, tracks document IDs. |
| Existing memory UI routes | `src/routes/memories.ts`, `src/routes/graph.ts` | Session-authenticated list/export/graph views, not a general external search contract. |
| Skills | `src/brain/skills/store.ts`, `validation.ts`, `context.ts` | Durable SQL storage, scoped visibility, active/disabled status, versioning, bounded Markdown and progressive disclosure. |
| Skill editing routes | `src/routes/skills.ts` | Existing UI administration can remain; external read-only access should not reuse edit-capable route behavior blindly. |
| Outgoing MCP | `src/brain/tools/mcp/client.ts`, `oauth-provider.ts` | This is an MCP client with outbound OAuth/token handling, not an inbound server or authorization server. |
| Admin chat | `src/brain/admin/chat.ts`, `surfaces.ts` | Internal operator path can select broad surfaces and run `computeTurn`; unsafe as a shortcut for public agent access. |

`@modelcontextprotocol/sdk`, Hono, Zod, the Agents SDK, Drizzle, and Supermemory are already dependencies. Verify their resolved versions and Workers-compatible server transport before selecting an MCP implementation; an installed client transport does not establish server transport compatibility.

## 3. API versus MCP

### MCP-first is the best product interface for this requirement

The target consumer is an agent that needs to discover and invoke knowledge/skill tools. MCP gives it tool names, descriptions, input schemas, structured results, and a standard connection mechanism. A plain API alone would require each agent backend to recreate these tool definitions.

Use remote **Streamable HTTP** at `/mcp`. Prefer a supported stateless Workers-compatible transport for these read-only requests. Do not run an Express server inside a Worker or manually implement partial JSON-RPC.

Cloudflare's current [transport guidance](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/) recommends a stateless `createMcpHandler` for new servers and describes `McpAgent` as a deprecated server path. This recommendation must be checked against the versions installed from this repository; adopting it may require a narrowly justified dependency update, not an assumed drop-in import.

An MCP endpoint does not mean every consumer supports its authentication or automatically loads skills. V1 targets clients where the operator can configure a bearer credential. Browser-managed clients requiring OAuth need a later standards-compliant inbound authorization flow.

### A small HTTP companion is valuable, not a second project

Expose three narrowly equivalent operations under `/brain/external/v1`. This enables backend-controlled bots to use ordinary HTTP and makes contracts easier to test. It is not permission to expose every existing `/brain/*` route under bearer authentication.

If delivery must be split, establish the shared core and credential model first, then ship MCP. The HTTP companion is a thin adapter over that core and must never contain a second visibility policy.

## 4. Proposed architecture

```text
MCP-capable agent                   Backend-controlled bot
       |                                   |
       v                                   v
 /mcp: Streamable HTTP          /brain/external/v1: JSON
       |                                   |
       +--------------+--------------------+
                      v
         External credential verification
       membership + expiry + grants + quota
                      v
          Shared external-access services
             |                    |
             v                    v
    Shared-memory search       Skill runtime reads
    Supermemory API            Existing org Durable Object
             |                    |
             +---------+----------+
                       v
          Bounded, normalized, source-aware output
```

Keep browser management of credentials session-authenticated and separate from data-plane bearer access. Suggested management route: `/brain/external-credentials`.

Reuse D1 for credential metadata. Reuse existing Durable Object SQL for skills. Use the existing memory provider helper for retrieval. The Worker can search shared memory without invoking the full agent/model loop.

Do not add another Durable Object merely because the feature is MCP. A separate stateful component is justified only if the selected transport or strongly consistent quotas require it. Never retain a per-user authenticated MCP server instance in an isolate-global variable shared across requests.

## 5. Security boundary: the most important implementation work

### The provider key is broader than the application policy

`memoryClient(env)` authenticates with `SUPERMEMORY_API_KEY`. Application identity is not passed as a provider credential. The application must constrain every query before calling Supermemory.

Current tags are:

- `sm_org_shared`: shared organization knowledge.
- `user_<internal user id>`: personal memory; this is not necessarily a Slack user ID.
- `slack_channel_<channel id>`: private-room memory.

The shared tag is not org-ID-prefixed. The current single-tenant design assumes the configured provider account/key and its stored data are appropriate for this deployment. Two independent deployments sharing an account and the same tags may share data. Document a dedicated account/namespace requirement; do not claim this work implements multi-tenant isolation at the provider level.

### V1 grants

Each opaque token binds to an organization and an issuing member. Separate tokens for separate agent integrations make revocation and auditing meaningful. Require explicit owner/admin consent for minting external-access credentials in v1; this is an external data-egress permission, not just another internal login.

Store only a cryptographic hash of a high-entropy random secret, plus an opaque lookup identifier, label, issuing user/org, grants, expiry, and revocation timestamp. Reveal the raw credential once. Revalidate live membership and `user.deleted` on every data-plane operation. Unknown grants, malformed credentials, missing members, or auth storage failure deny access.

A token is a credential for the configured integration. It does **not** prove which human is conversing with a downstream bot. Do not take a `userId`, `orgId`, `slackUserId`, role, container tag, or impersonation header from tool arguments as authority.

### Shared-only is intentional

Even a token created by an admin reads only shared memory and organization skills in v1. Admin status must not unlock coworkers' DMs or personal playbooks. Reject fields that attempt to expand the authorized surface rather than silently ignoring them.

Private-memory access is later work because a bearer token alone cannot establish the current downstream audience. For example, a bot with a person's private memory can leak it into a public thread even if retrieval was technically permitted for that person.

### Future private access

Require explicit, limited grants and either authenticated end-user delegation or an explicitly approved service principal/audience policy. Map identities server-side. Bound reads by the intersection of current org membership, token grant, current channel membership, and verified destination policy. The local Slack membership cache and its reconciliation are useful, but do not equate cached membership with immediate authoritative revocation for an external private-data endpoint. Define freshness and fail-closed behavior before shipping it.

## 6. V1 contracts

Suggested tool names deliberately distinguish this server from generic memory tools:

| MCP tool | HTTP equivalent | Authorized behavior |
| --- | --- | --- |
| `sudopedia_search_memory` | `POST /brain/external/v1/memory/search` | Query only `sm_org_shared`; return bounded snippets and allowlisted provenance. |
| `sudopedia_list_skills` | `GET /brain/external/v1/skills` | List active org skill IDs, names, descriptions, versions; no bodies. |
| `sudopedia_load_skill` | `POST /brain/external/v1/skills/load` | Load one authorized active org skill by ID, with optional expected version. |

Search arguments: `query` (1–2,000 characters), `limit` (default 5, maximum 20), optional canonical topic tags (maximum 10). Validate lengths and UTF-8 request size. Tags can narrow relevance, never expand memory containers. Reject provider-level arbitrary filter objects.

Search output should identify the result kind (`memory` or `chunk`), its typed ID, bounded content, relevance score, available dates, topic tags, and allowlisted source URLs. Scores are retrieval scores, not calibrated truth probabilities. Distinguish record-update time, ingestion time, and event date where actually available. Do not fabricate missing citations or dates. Return an empty result set for no match, not a synthesized answer.

There are distinct derived-memory IDs and source-document IDs. Do not offer a naive `get_memory(id)` that fetches a source document by arbitrary ID: it can expose data beyond the search result's authorized scope. Defer direct record retrieval until the provider response shapes and container validation are proven.

Skill listing must strip the body even though `RuntimeSkill` currently contains it. Skill loads should use stable IDs to avoid name-collision ambiguity. Existing runtime visibility includes system skills, personal skills, and org skills; v1 must explicitly select only active org skills, not return the result of a broad runtime helper unchanged. A curated system skill may be offered later with explicit policy; the existing Supermemory-specific system skill expects `search_web`, which an external client may not have.

If `expectedVersion` is specified and differs, return a version-conflict result with the current version, not a silently different body. No skill editing or saving through MCP v1. Existing browser UI editing and its optimistic concurrency should remain intact.

Skill usage accounting changes internal telemetry; retrieval is still read-only in the meaningful sense that it cannot alter company knowledge, playbooks, or external tools. Failed/denied loads must not increment usage. Define whether a loaded skill counts once per successful call and test it.

MCP results should supply readable text plus structured data where supported by the verified SDK/protocol. Skill bodies are organizational instructions, not system-policy overrides. Memory snippets and source metadata are untrusted retrieved content. Explain those boundaries in tool descriptions and client setup guidance.

## 7. Reuse versus new work

### Reuse or adapt

- Existing Worker and org Durable Object routing.
- D1 identity/member tables and migration bundling.
- `searchMemoryEntries` and the deployment memory client.
- Existing relevance threshold (`0.3`) as an initial default, not a quality guarantee.
- Skill validation, active/disabled state, versions, org scope, and load accounting.
- Existing browser skill management; no new authoring interface is necessary.
- Existing test tooling and request-size/content validation patterns.

### Add

- External credential schema, mint/list/revoke endpoints and a minimal UI.
- Separate bearer middleware and strict grant resolver.
- A transport-independent search/skill service and normalized DTOs.
- Narrow org-skill read RPCs on `CompanyBrainAgent` without exposing its broad admin APIs.
- Workers-compatible MCP server adapter and the three HTTP routes.
- Endpoint routing in `wrangler.jsonc` so `/mcp` reaches the Worker rather than SPA assets.
- Auditing, bounded quotas, input/output limits, error mapping, and client instructions.
- Automated negative authorization tests and a protocol-level MCP smoke test.

### Avoid

- Reusing outgoing `mcp_connection` rows as incoming credentials.
- Exposing `runAdminChat`, raw container overrides, or `computeTurn` as a general MCP tool.
- Reusing skill save tools: their approval path requires Slack context.
- Returning raw provider metadata or full source documents.
- Applying bearer authentication to all existing UI/administrative routes.
- Automatically storing every agent conversation or all live app output.
- Advertising universal compatibility with managed chatbot apps before their actual auth/transport requirements are tested.

## 8. Transport and operational details

Verify a supported SDK server transport under workerd. Validate initialization, tool discovery, calls, headers/version negotiation, errors, and unsupported methods. Handle request lifecycle and cleanup correctly. Authenticate and enforce grants on each operation, not just initialization; a session ID is not authorization. Prefer stateless operation and avoid requiring affinity to a Worker isolate.

Configure a stable canonical deployment URL. Do not construct OAuth audiences or external client configuration from arbitrary forwarded host headers or the existing remembered-origin fallback. For bearer-only v1, document explicit URL/token configuration; do not publish fake OAuth discovery metadata.

Restrict browser CORS and validate Origin when present. Credential-management mutations must have CSRF protection; SameSite cookies alone are not the full policy. Set no-store on secrets and sensitive responses. Never accept a token in a URL query string.

Start with configurable defaults of 2,000-character queries, 20 search results, 64-KiB external request bodies, and 64-KiB response payloads. Bound per-snippet text and make truncation explicit. Existing skill bodies cap at 16 KiB. Apply rate limits before provider calls and separate read/search cost controls from credential-management controls. Use a supported Worker limiter or durable mechanism, not per-isolate counters presented as global enforcement.

Use short bounded timeouts for provider work; respect cancellation when the underlying API supports it. Do not invoke a second LLM to answer or summarize each search. This keeps latency and spend predictable and avoids answer-to-answer agent loops. Provider indexing is asynchronous; future write endpoints must not claim immediate searchable availability.

Audit credential ID (not secret), actor/org, operation, grants, status, latency, result count, and request ID. Default logs must not contain queries, skill bodies, memory text, or raw provider errors. Existing `searchBrain` logs query previews; avoid inheriting that behavior on the new surface. Any persistent audit table needs retention and bounded cleanup, not unbounded accumulation.

Revocation takes effect on the next authenticated operation. Do not cache a positive credential decision in KV or an MCP session such that it bypasses live D1 membership/revocation checks. No-store does not retract data an external agent has already read or persisted; communicate that limitation during credential creation.

## 9. Delivery stages

### Stage A: shared read-only gateway — implementation target

Credential lifecycle and management UI; strict shared/org grants; normalized memory search; skill index/load; MCP plus thin HTTP; tests and connection docs. This stage uses existing Slack-created identities and deployment onboarding. No new non-Slack account bootstrap is required.

### Stage B: client compatibility and delegated private reads

Only after selecting actual consumers: inbound OAuth with a standards-compliant implementation and tested audience/resource binding; end-user delegation; personal skills/private memory with explicit audience and freshness policy. Do not repurpose the outgoing MCP OAuth helper as an authorization server.

### Stage C: reviewed learning and selected actions

Memory proposals with provenance, owner review, idempotency and asynchronous ingestion status; version-aware skill proposals; selective action tools with explicit approval and recovery semantics. Do not make the existing Slack approval cards the only approval mechanism for an external caller without designing its lifecycle.

## 10. Acceptance tests that matter

1. An external credential searches public/shared memories and loads an active org skill without Slack event context or model generation.
2. A shared-only token never queries personal/private containers, even with forged scope fields, malicious topic tags, an admin issuer, or guessed IDs.
3. Different tokens/grants/requests cannot inherit another caller's identity through MCP sessions, global state, or cached server instances.
4. Missing, malformed, expired, revoked tokens and deleted/non-member issuers fail before memory provider calls.
5. Removing a required grant or revoking a credential blocks the next tool call, including an already-established session.
6. Disabled, personal, nonexistent, and inaccessible skills are indistinguishable to an unauthorized caller; listings never include bodies or private-name hints.
7. Skill list/load and HTTP/MCP results agree; version conflicts and accounting are correct.
8. Search results have correctly typed IDs, bounded text, available provenance, explicit truncation, and no raw secrets/provider metadata.
9. Oversized inputs, rate limits, provider timeouts/errors, unknown tools/methods, and unsupported protocol requests are handled safely.
10. `/mcp` is handled by the Worker, not the SPA; a real MCP SDK client can initialize, list tools, and call them under the local Workers runtime.
11. Credential management is role-restricted, CSRF-protected, reveals a secret only on creation, and lists no secret/hash. Membership checks and revocation are live.
12. Existing Slack behavior, UI skills editing, type checks, bundled D1 migrations, and dry-run Worker build remain valid.

## 11. Validation and uncertainty

This is static analysis of the baseline code and configuration, not a deployed security audit. Dependencies are not installed in this checkout; no test suite, Worker runtime, or deployment was started. No provider requests were made.

Before implementation, establish the repository's test/build baseline, confirm SDK server transport compatibility, and inspect actual provider search response fixtures. Do not assume metadata is always present, that memory IDs are document IDs, or that an unbounded search can safely be reduced after the provider has returned all data.

Read-only external access is still deliberate data disclosure to another agent/provider. The org must authorize that egress. External retrieval does not itself ingest new knowledge: v1 learns through the existing Slack workflow and explicitly ingested provider documents, not automatically from every external agent run.

The implementation handover is in `docs/sudopedia-external-access-handover.md`. It includes the agreed feature-branch and PR workflow. Creating these planning documents does not create a branch/PR or authorize automatic merge/deployment.
