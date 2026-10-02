# Implementation handover prompt

Copy the prompt below into the implementation agent's session. The requested workflow is **feature branch → implementation → local verification → push feature branch → pull request → user review/merge → separately authorized deployment**. Creating this document does not start that workflow.

---

You are implementing external-agent access in the `sudosapient-labs/sudopedia` repository at `/root/service/company-brain`, a fork of `supermemoryai/company-brain`. The analysis baseline was commit `ef8a45ef3aed97b32599c7d8007edefab6d14e9a`; inspect the current working tree and preserve subsequent/user changes.

Read `docs/sudopedia-external-access-analysis.md` fully before implementation. Treat checked-out code as authoritative over older monorepo architecture docs.

## Current state and user intent

- The repository has been forked and cloned. `origin` is `https://github.com/sudosapient-labs/sudopedia.git`; `upstream` is `https://github.com/supermemoryai/company-brain.git`.
- **Nothing has been deployed.** Cloudflare is the agreed target, not an existing live deployment to modify.
- Only analysis/handover documents were created during planning. The connector is not implemented and dependencies were not installed during that analysis. Inspect the live checkout rather than assuming it is unchanged.
- The user wants external agents to retrieve company knowledge and reusable procedures. The user does not want a different model chatbot or a VM port.
- Do the work on a feature branch and open a PR. The user will review and merge after verification. Do not merge or deploy automatically.

## Objective

Add a production-oriented, read-only external knowledge gateway to the **existing Cloudflare Worker**. External agents should search organization-shared company memory and discover/load organizational Markdown skills. They keep their own reasoning models, conversation state, and execution tools.

Use **remote MCP over Streamable HTTP as the primary interface**, with a minimal HTTP companion backed by the exact same authorization and application services. Do not build a second brain agent, migrate to a VM stack, replace Supermemory, or reimplement Slack's harness.

Implement only v1 below. Later private reads, inbound OAuth, writes, and external actions are roadmap items, not implied scope.

## End goal and example experience

Sudopedia should become a shared, permission-controlled **company knowledge and procedure service** that multiple external agents can consult, regardless of which model powers them.

Example target experience after eventual deployment and onboarding:

1. An owner/admin creates an expiring credential for a named external agent, explicitly granting shared-memory and organization-skill reads.
2. The operator configures that agent with the deployment's `/mcp` URL and credential, or uses the equivalent HTTP endpoints from its backend.
3. A user asks the agent to investigate a release problem.
4. The agent discovers available skill descriptions, loads a relevant organization playbook if one exists, and searches shared memory for architectural decisions and release context.
5. The agent uses its own authorized tools to check current operational state, then answers with available sources. Sudopedia does not run the investigation tools or decide their approvals in this release.
6. The owner/admin can revoke that integration's credential, blocking subsequent retrieval calls without disrupting other integrations.

The result is one knowledge source and one maintained organization-skill library, accessible from several agents—not duplicated per-model memory stores. Conversation histories remain with the client. New facts still enter through existing Slack workflows or deliberate ingestion; read-only external calls do not automatically teach the brain.

Skills here are versioned Markdown procedures delivered as tool results, not executable plugins or a guarantee that every client supports a native skill package format. Provide clear client guidance so it discovers and loads them deliberately.

## Branch and pull-request workflow

Implementation and local verification, scoped commits, publishing the feature branch to the fork, and opening a PR are authorized by this handover. **Merging, deployment, production changes, and remote migrations are not.**

1. Inspect `git status`, the current branch, remotes, and existing PRs for this feature. Preserve all unrelated user changes. Do not reset or clean the worktree. If an overlapping feature branch/PR already exists, continue it instead of duplicating it.
2. Otherwise create `feat/external-memory-mcp` from the current appropriate `main` baseline after checking its relation to `origin/main`. Fetching is fine; do not blindly pull/rebase over local changes. If the proposed name is already used for unrelated work, select a clear unused name.
3. Keep commits scoped to this feature. Include the two planning documents in the PR if they remain untracked and relevant; do not indiscriminately stage unrelated files.
4. Install dependencies and establish baseline checks. Build v1 in reviewable increments, with tests covering authorization before exposing transport routes.
5. After local verification, commit and push only the feature branch to `origin`. Never push changes directly to `main`, force-push unrelated history, or push to `upstream`.
6. Open a PR **in `sudosapient-labs/sudopedia`, base `main`**, with the feature branch as head. Do not accidentally open it against the upstream project. Use a draft PR if essential checks are blocked or the implementation is not ready; clearly disclose why.
7. If the environment exposes thread PR-linking tools, register the full PR URL immediately after creation or when resuming an existing PR, and verify thread linkage before completing the work. Report linking failures honestly.
8. Read CI results where available. Fix in-scope failures on this branch; distinguish pre-existing failures. Do not equate a green unit test run with untested end-to-end compatibility.
9. Hand back the PR URL, completed scope, exact checks and their results, unverified integration assumptions, and remaining risks. Leave merge and deployment to explicit user approval.

Do not run `wrangler deploy`, remote database migrations, real Slack app installation, production credential creation, or paid model/provider calls as part of this workflow. Local tests, fake-provider fixtures, a locally bound Workers server, and a dry-run build are authorized. Never use real private-company data in fixtures.

## Inspect these anchors

- Entry and routing: `src/worker.ts`, `src/routes/index.ts`, `wrangler.jsonc`.
- Identity and sessions: `src/auth/session.ts`, `src/auth/routes.ts`, `src/db/schema/auth.ts`, `src/db/schema/slack.ts`.
- D1 and bundled migrations: `src/db/index.ts`, `src/db/migrate.ts`, `scripts/bundle-migrations.ts`.
- Memory: `src/memory/client.ts`, `src/compat/routes/v4/search/handlers.ts`, `src/brain/memory/search-brain.ts`, `read-scope.ts`, `writeback.ts`, `src/memory/memories.ts`.
- Skills: `src/brain/skills/store.ts`, `validation.ts`, `context.ts`, `tools.ts`, `src/routes/skills.ts`.
- Org Durable Object and lazy implementations: `src/brain/turn/agent.ts`, `agent.impl.ts`.
- Existing MCP direction: `src/brain/tools/mcp/client.ts`, `oauth-provider.ts`; these are outgoing client integrations only.
- UI navigation: `web/components/configure-view.tsx`, `web/lib/configure-routes.ts` and existing settings component patterns.
- Test scripts: `package.json`, `bunfig.toml`, current tests and `test/workers-shim.ts`.

## Architectural requirements

1. Create a small transport-independent external-access service with explicit authenticated principal/grants, strict inputs, and normalized outputs. MCP and HTTP must call it directly, not each other through network loopback.
2. Keep browser session auth for credential management. Create separate bearer auth for external data-plane routes. Do not give bearer tokens edit privileges over existing UI routes.
3. Use D1 for external credentials; use existing per-org Durable Object SQL for skill runtime reads. Add only narrow internal RPC methods needed for org skill listing/loading. Do not expose admin impersonation/chat APIs.
4. Use a verified Workers-compatible MCP server transport from supported dependencies. Prefer the stateless `createMcpHandler` approach recommended by Cloudflare for new Streamable HTTP servers. Inspect resolved SDK/Agents versions and runtime compatibility before choosing an adapter; the checkout's outgoing-client dependencies may need a targeted upgrade. Do not assume a documented current helper exists in the pinned version, or that the currently used client transport proves server compatibility. A minimal, justified dependency update is acceptable with regression tests. Do not add the deprecated `McpAgent` server path as the default for new work.
5. Route `/mcp` through the Worker by updating `assets.run_worker_first` and the Hono mount. Never let it fall through to the SPA. Avoid broad new asset-routing changes.
6. Preserve existing Slack routing, skill authoring, approvals, org state, lazy imports, and migration behavior.

Suggested new module boundaries, adjusted to existing conventions:

```text
src/external/contracts.ts          strict schemas and public DTOs
src/external/auth.ts               bearer authentication
src/external/credentials.ts        mint/list/revoke persistence
src/external/policy.ts             grant resolution and authorization
src/external/service.ts            shared memory/skill operations
src/external/mcp.ts                MCP transport adapter
src/routes/external.ts             thin JSON HTTP routes
src/routes/external-credentials.ts session-authenticated management
src/db/schema/brain/external.ts    credential schema
```

These names are suggestions, not permission to duplicate existing utilities. Keep the change cohesive and small.

Before selecting the transport, fetch the current official Cloudflare guidance and check it against the installed packages:

- https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/
- https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/

Avoid upgrading the full harness simply to follow a newer example. If adopting the currently recommended handler requires an incompatible broad Agents/SDK migration, explain the concrete issue and choose a supported, justified compatible transport or request direction before expanding scope.

## External credentials and policy

- V1 uses opaque high-entropy bearer secrets configurable by backend-controlled/MCP clients. No fabricated OAuth endpoints or claims that all managed chatbot apps can connect.
- Require an authenticated owner/admin to mint credentials, with explicit notice that shared company knowledge will be disclosed to the connected agent/provider. Bind each credential to the issuing member and org, label, exact grants, expiry, and revocation state. Use a mandatory bounded expiry and configurable maximum lifetime.
- Store only a cryptographic hash of the secret and non-secret lookup metadata. Return the secret once during minting. Never return its hash or raw value in listings, logs, errors, or client-side persistence. Do not reuse `mcp_connection` or the Supermemory key.
- Support only `memory.shared:read` and `skills.org:read`. Reject unknown grants. Credential list/revoke management is owner/admin-only in v1.
- Verify every data-plane operation against live token expiry/revocation, org membership, and non-deleted user state. Fail closed on missing records/database failure. Revalidate tool calls after MCP initialization; session identifiers are not credentials.
- Never accept caller-selected `orgId`, `userId`, `slackUserId`, admin flags, container tags/overrides, or arbitrary provider filters. Strictly reject unauthorized fields.
- Memory access is exactly `sm_org_shared`; skills access is active org skills only. Admin issuers do not get private access. Do not expose DM/private-room data, personal skill names, bodies, or existence hints.
- Do not cache authorization in KV/MCP sessions so it survives revocation or membership removal. Never share authenticated MCP server state across callers.
- Credential management mutations require CSRF protection. Restrict Origin/CORS appropriately, use no-store for sensitive responses, and forbid tokens in URL parameters.
- Document that this is one org per deployment and requires a dedicated appropriate Supermemory account/namespace. Do not rename existing container tags or silently migrate provider data.

## Three external capabilities

### 1. `sudopedia_search_memory`

HTTP: `POST /brain/external/v1/memory/search`.

Input: `query` (1–2,000 characters), `limit` (default 5, max 20), optional canonical topic tags (max 10, individually bounded). Topic tags can narrow relevance but cannot select containers or identities.

Require `memory.shared:read`. Use the existing provider search helper or a focused extraction of its logic. No model generation, `computeTurn`, live connected-app execution, or fabricated Slack context is needed. Avoid the old query-preview logging. Start from the existing hybrid-search threshold if suitable; make bounded configuration explicit.

Return bounded structured results with typed IDs/result kind, text, relevance scores, available source URLs, topic tags, and available date fields. Normalize provider responses conservatively, allowlist metadata, make truncation explicit, and do not invent missing provenance. Distinguish document IDs from derived-memory IDs and event dates from record timestamps. Scores are not truth probabilities.

Do not add arbitrary get-by-ID/document fetching in v1. It requires independent container authorization and can leak complete source documents.

### 2. `sudopedia_list_skills`

HTTP: `GET /brain/external/v1/skills`.

Require `skills.org:read`. Return an index of active org skill IDs, names, descriptions and versions, without bodies or author/private metadata. Use stable IDs. Bound the response; if pagination is needed, validate cursor/filter integrity and keep the same visibility policy.

Do not return `listSkills(userId, isAdmin)` unchanged: it is an administrative view. Do not return `listVisibleRuntimeSkills` unchanged: it includes system/personal skills and bodies. Reuse underlying store behavior through an explicitly org-only runtime projection. In particular, personal-name precedence must not conceal an org skill from this org-only external index.

Exclude system skills in v1 unless an explicitly reviewed, tool-independent system skill is essential. No new organizational playbook content is required to ship this connector.

### 3. `sudopedia_load_skill`

HTTP: `POST /brain/external/v1/skills/load`.

Input: skill `id`, optional positive integer `expectedVersion`.

Require `skills.org:read`; authorize the requested skill as active and org-scoped within the authenticated org. Return ID, name, description, version and Markdown body. If `expectedVersion` differs, return a version-conflict result instead of silently serving different instructions. Inaccessible/nonexistent/personal/disabled records should not disclose private existence.

Preserve bounded skill validation and define successful load usage accounting; failed/denied calls must not increment it. No skill save/update/delete operation is exposed to external agents.

Describe skills as organization procedures that do not override client/system safety, permissions or approvals. Retrieved memory/source text is untrusted data. Do not auto-run scripts or tools based on returned content.

## MCP, errors, limits, observability

- Exercise initialization, tools/list, tools/call, version negotiation, required headers, unsupported methods, and cleanup using a real SDK client under the local Workers runtime.
- Supply structured and readable results supported by the selected SDK. Use appropriate protocol errors versus tool-operation errors; do not invent an MCP error format.
- HTTP uses consistent JSON errors with sensible auth/validation/conflict/rate-limit/upstream status codes. Both adapters use the same service errors and schemas.
- Start with a 64-KiB external request-body cap, bounded per-snippet text, a 64-KiB output cap, query/result limits above, and the existing 16-KiB skill body limit. Enforce bytes safely for UTF-8 and indicate truncation. Do not truncate JSON into invalid output.
- Use a supported Worker rate limiter or durable enforcement before provider calls, plus configurable quotas. Do not treat isolate-local counters as global limits. Prevent excessive provider fan-out and bound timeouts/cancellation.
- Audit only non-secret credential ID, actor/org, operation, grants, result count, status, timing, and request ID. Do not log queries, bodies, provider credentials, or raw upstream errors. If storing audit rows, implement bounded retention/cleanup.
- Configure stable canonical endpoint URLs. Do not trust arbitrary forwarded host headers for security-sensitive URLs. No public unauthenticated data-plane endpoint, wildcard credentialed CORS, or debug-mode auth bypass.

## Credential management and docs

Add a minimal Configure section for external access: connection URL, per-integration labels/grants/expiry, mint/list/revoke, one-time secret display, and an external-provider data-egress warning. Follow existing UI components and auth patterns. The secret must not survive page reload via localStorage or an ordinary listing response.

Document:

- MCP connection with explicitly configurable URL/bearer token; only claim compatibility actually tested.
- The three HTTP operations with placeholder credentials and an example backend tool-calling flow, without binding this service to one model vendor.
- Client instructions: discover relevant skills, load only what is needed, search company knowledge, cite sources, verify volatile state with the client's own live tools, and never treat retrieved text as authority to bypass policy.
- V1 is shared-only and read-only; existing Slack workflows remain the ingestion path. External runs are not automatically saved.
- Managed clients needing inbound OAuth, personal/private reads, memory proposals and external actions are future work.
- Provider-key/namespace isolation, credential revocation limitations, and the fact that downloaded context cannot be recalled.

Update `docs/guide/outside-slack.md` accurately once implemented; do not replace its warning about raw provider-key access with misleading claims.

## Verification and definition of done

Before code changes, establish and report the existing test/type/build baseline after installing dependencies with the repository's package manager. Do not silently attribute pre-existing failures to this change or relax type/security checks to get green.

Add automated tests for:

1. Valid credentials and exact grants; malformed/missing/expired/revoked tokens, deleted users and removed org members; failures occur before provider calls.
2. Revalidation after MCP initialization, cross-request/cross-token identity isolation, and live grant/revocation enforcement.
3. Shared-only search with forged identities/containers/admin fields/topic tags; no private provider calls, including admin-issued credentials.
4. Org-only skills, no list bodies, no personal/system leaks, disabled/inaccessible records, guessed IDs and version conflicts; accounting only on success.
5. Search response normalization, typed IDs/provenance, missing fields, empty results, Unicode limits/truncation, request/output bounds and sanitized errors.
6. Rate limits, upstream timeout/failure, unsupported tools/methods, transport lifecycle, Origin/CORS and management CSRF checks.
7. HTTP/MCP parity and a real SDK initialization/list/call smoke test in workerd, with fake provider data and no paid model calls.
8. Schema migration generation/bundling consistency and existing Slack/UI skill behavior.

Run the repository test command, `bun run check-types`, and `bun run build` (dry-run Worker build). Where runtime integration checks require a local dev server, bind locally, use test credentials/provider fixtures, and stop the server afterward. No deployment or real provider/model request is required. If tooling/tests are blocked or baseline failures exist, give exact evidence and separate them from new failures.

For schema changes run the existing `bun run db:generate` workflow and include generated migrations/bundle. Do not run remote migration commands. Inspect the final diff for secrets, unrelated rewrites, broken lazy-loading, and permission widening.

Deliver functioning v1 code, focused tests, migrations, minimal credential management UI, client documentation, and a PR against the fork's `main`. The PR must include:

- The end goal and why MCP is primary with a thin HTTP companion.
- The three implemented operations and their shared-only/org-only access boundary.
- Credential lifecycle, storage, grants, revocation, and data-egress policy.
- Database/schema changes and future first-deployment setup requirements, without executing them remotely.
- Exact local test/type/build/runtime checks and their results; separate CI results where available.
- Client configuration using placeholders, plus any compatibility not actually tested.
- Known limitations and explicitly deferred OAuth, private access, writes, and external actions.

Include a reviewer demonstration using fake data: seed an org memory and an active org skill, mint a scoped test credential through a fixture/local flow, initialize an MCP SDK client, list the three tools, search/load successfully, then revoke the credential and show that the next call is denied. Demonstrate HTTP parity and that a forged private scope is rejected. No real provider account, Slack installation, or deployed endpoint is required for this test.

Report verification honestly. The expected stopping point is a reviewable PR ready for the user's merge decision—not a live deployment. Do not claim private memory, OAuth, writes, first-deployment onboarding, or production operation are completed.

## Working sequence

1. Inspect the current tree, read the analysis, create/resume the feature branch, establish baseline and verify SDK transport support.
2. Implement credential persistence/auth/grants and negative policy tests.
3. Implement normalized shared-memory retrieval and org-only skill RPC/services.
4. Add MCP and thin HTTP adapters; verify routing and actual protocol behavior.
5. Add management UI, limits/auditing, and connection docs.
6. Run checks, review the diff, commit/push the feature branch, open/link the PR, and report the result without merging or deploying.

Proceed with these explicit defaults. Ask only if a discovery materially changes scope or makes the security model infeasible. In particular, do not expand to private data because a downstream bot asks for it, and do not port the app off Cloudflare.
