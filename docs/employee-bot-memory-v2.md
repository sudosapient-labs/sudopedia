# Employee-bot memory gateway v2: local handoff

## Repository and deployment state

Work started with a clean worktree on `t3code/employee-memory-gateway` at `b91c039`.
Fetched origin and verified merged main `af891e598616be365a53945bab578248019759ba`
has the same tree as that tested feature head. Created
`feat/employee-bot-memory-v2` from origin/main, not the local main branch.
No merged code was reverted and no existing user edits were overwritten.
The exact implementation commit is reported in the accompanying delivery message
and obtainable with `git rev-parse HEAD` on this branch.

Production remains on the user-reported deliberate rollback version
`56bf1536-fa2e-4737-820b-0e280b012f3e`, with D1 migrations 0002–0004 already applied.
This work did not query production memory, change traffic, deploy, apply remote
migrations, perform live-provider writes or revoke/delete production credentials.

## Implemented journeys and permissions

An employee creates one self-owned `employee` credential with independent grants:
shared read, own-personal read, own-personal write and permitted-private-channel read.
Owners/admins can additionally grant shared write and organization-skill read on the
same connection. New UI creation has no personal/organization type dropdown.
Consent is required; private/privileged grants start unchecked. Changing grants
clears consent. The suggested expiry remains seven days; all layers accept 1–365.

Personal is the default mutation scope. Explicit `scope: "shared"` plus its grant
and live owner/admin role are required for shared writes. DM context is not an
authorization input. Determining that the human actually requested publication
is a trusted-client requirement, not server classification of conversation text.

Employee: authorize → search own memory → capture durable fact → later recall →
search/correct changed fact → corrected recall → search/retract specifically wrong
fact. Admin additionally: grant shared write → search shared current facts → explicit
company capture/correction/retraction → resulting current company recall.
MCP instructions and tool descriptions describe these workflows; executable
demonstrations issue scripted calls, not autonomous model decisions.

Private reads use server identity mappings and positive live Slack evidence.
They retrieve only ingested knowledge, not unrestricted Slack messages. No private
writes, arbitrary app actions, Slack posting, scripts or skill execution are added.

## Compatibility and migration decisions

- Preserve legacy `personal` and `organization` kinds, including omitted-kind mint
  compatibility, grant restrictions, old role semantics and legacy shared hybrid reads.
- Existing credentials acquire no new grants and no expiry extensions. New mixed
  credentials lose effective privileged grants on demotion without losing otherwise
  valid ordinary permissions. Removed org membership/deleted users/revocation/expiry
  still deny authentication. Admins cannot impersonate another employee.
- Preserve personal reference IDs, operation IDs, request hashes and retry receipts.
  Explicit personal scope normalizes to the omitted legacy identity. New shared
  references/operations/receipts include scope and cannot collide with personal ones.
- Personal and employee credentials share the five-active/100-history self bucket;
  legacy organization integrations retain their separate 100-active/200-history
  bucket. This preserves the bounded 300-row management/pagination surface.
- Append `drizzle/0005_first_eternals.sql` only. It adds shared operation/reference
  tables and indexes. Generated snapshot, journal and bundled migrations were
  regenerated with `bun run db:generate`. Migrations/snapshots 0002–0004 are unchanged.
- Shared operations are org-owned with non-cascading immutable actor provenance,
  not issuer-user/member/credential foreign keys. Shared references may expire or
  cascade with their actor; necessary ambiguous-operation evidence and org-wide locks
  cannot disappear on issuer deletion. Operators reconcile with exact snapshots.
- Creation is gated by `EXTERNAL_EMPLOYEE_CREATION_ENABLED`; committed production
  default is `off`. Backend/schema can be deployed with new controls hidden. Turning
  it off later does not revoke existing credentials or disable their operations.

## Requirement-to-code/test map

Paths are repository-relative. Tests use fictional content/identities/providers.

| Requirement | Implementation | Verification |
| --- | --- | --- |
| One connection, six independent permissions | `src/external/contracts.ts`, `credentials.ts`; `web/components/settings/external-access.tsx` | `gateway-v2.test.ts`: all-six credential; employee privileged-grant denials; `verify-gateway-v2.ts`: real Worker mixed connection/skills |
| Live role, expiry, revocation, deleted user, org membership | `credentials.ts` live join/effective grants | `credentials.test.ts`, `gateway-v2.test.ts` demotion/deletion/revocation/member removal; existing real-Worker checks plus v2 demotion |
| Personal self-only; no admin impersonation/forged target | self-owned management routes, strict schemas, server-selected adapters | `gateway-v2.test.ts`, `personal.test.ts`, `verify-personal.ts`: management/reference/identity denials |
| Personal default; explicit shared scope | `service.ts`, schemas, MCP trusted instructions | `gateway-v2.test.ts` separate default/explicit scope; `verify-gateway-v2.ts` shared journey/default personal after demotion |
| Scope-bound references and durable retries | `personal.ts` reusable store/engine and separate scope identities | `gateway-v2.test.ts` same-key/reference isolation, changed-input rejection, explicit personal legacy replay; existing durability/personal tests |
| Organization-wide shared serialization | shared domain predicate in `personal.ts` | `gateway-v2.test.ts` paused write from one admin denies another admin but allows personal writes |
| Ambiguous shared writes survive issuer deletion | org-owned `external_shared_operation`; `reconciliation.ts` shared CAS | `gateway-v2.test.ts` transient/persistent journal failure, deletion, surviving lock and exact actor snapshot; legacy `durability.test.ts` fencing/reconciliation |
| Current shared correction/retraction recall | `search-request.ts` memories mode; shared provider; explicit historical labeling | `shared-provider.test.ts` production SQL + installed SDK fictional wire journey; `verify-gateway-v2.ts` shared journey and HTTP/MCP parity |
| Preserve metadata/dates/expiry/no-op/specific retraction | shared/personal provider adapter validates merged metadata before dispatch | `provider-metadata.test.ts`, `shared-provider.test.ts`, `provider.test.ts`, `provider-wire.test.ts` |
| Private live employee membership, not bot/admin access | `private-channels.ts`: mapping joins, auth/users/list/members checks; reuse ingestion container helper | `private-channels.test.ts`: member removal, bot-only, wrong token/workspace/org, missing/inactive/ambiguous mapping, deleted user; real Worker strict-verifier group |
| Guessed channel/identity/filter denial; private writes excluded | strict search/mutation schemas; no caller channel argument | `private-channels.test.ts`, `gateway-v2.test.ts`, existing credential/personal/transport tests; v2 Worker guessed-channel rejection |
| Slack errors, bounded pagination, cancellation, incomplete coverage | strict verifier, 8-second signals, cursor/cap validation, sibling abort; two workers | `private-channels.test.ts`: all API failure stages, malformed/oversized responses, pages/caps/repeated cursors, cancellation/deadline/siblings/concurrency; v2 Worker Slack error |
| Global result/Unicode bounds and D1 query budget | `service.ts` global selection before reference allocation; `limits.ts`; bounded private search | `availability.test.ts`, `gateway-v2.test.ts` 26-statement mixed search; `private-channels.test.ts` Unicode/private fan-out; existing Worker output/capacity groups |
| 365 accepted / 366 denied, no automatic extension | API schema, server policy, UI maximum | `gateway-v2.test.ts`, `verify-gateway-v2.ts`; mounted UI script checks 365; existing expiry tests |
| Existing database/credentials/retries | append-only migration; legacy-kind normalization/identity preservation | `gateway-v2.test.ts` upgrade of already-0004 database and legacy row preservation; `migrations.test.ts`; all original 173 tests rerun |
| Session-only management, CSRF/no-store/secrets/pagination/stale pages | unchanged security routes; self bucket and gated creation UI | existing `availability.test.ts`, Worker management/security/pagination groups; `verify-mounted-ui.js` for fictional mounted UI; optional updated `verify-ui.py` (not run here) |
| Durable dispatch, no automatic redispatch, honest receipts/operator CAS | same mutation engine, scope-selected SQL/provider adapters | `durability.test.ts`, `personal.test.ts`, `gateway-v2.test.ts`; Worker preflight/journal-failure/reconciliation groups |
| Content-free audits and strict bearer/browser separation | `service.ts`, existing gateway/management transport middleware | existing `service.test.ts`, `credentials.test.ts` and real-Worker transport groups |
| Staged rollout without exposing new controls first | creation gate in config/server/listing/UI | `gateway-v2.test.ts` gate blocks new creation but preserves existing authentication; local config explicitly enables it |

## Local verification record

Baseline reproduced: 173 tests / 24 files before changes.

Final required commands:

- `bun run test`: 222 tests / 27 files passed (136 external tests).
- `bun run test:external-runtime`: 27 local Worker groups passed; real workerd,
  ephemeral D1/SQLite DOs, fictional memory and Slack APIs. New scripted groups
  cover mixed grants/lifetime, shared journey, demotion and private verification.
- `bun run check-types`: Worker and web checks passed.
- `bun run build`: Worker/web dry-run build passed; no deployment. Existing unsafe
  rate-limit-binding warning remains.
- `git diff --check`: passed.
- `bun run db:generate`: appended migration and regenerated bundle/snapshot;
  production SQL upgrade compatibility is tested locally.

One concurrent runtime run emitted a workerd broken-pipe diagnostic but returned
success with all 27 groups passed; it did not change timeouts or security checks.
Earlier v2-script failures were fixture quota reuse and the deliberately unresolved
old employee personal lock. The demonstration now resets only fictional quotas and
uses a separate fictional employee; it never clears that unresolved journal lock.

The native collaborative browser could not reach the loopback Worker
(`ERR_CONNECTION_REFUSED`), so no browser-session-to-gateway integration was proven.
The separately mounted component uses fictional auth/fetch and instrumented storage.
`test/external/verify-mounted-ui.js` passed in the native preview: four employee
choices, six admin choices, mixed consent and consent reset, 365-day UI maximum,
zero component storage writes, secret removal on remount, and pagination across
multiple pages. This is functional component evidence, not a layout or live browser
session check. Component UI evidence is separate from Worker correctness and model/
client behavior. No production
credential screenshots or real employee data were captured.

## Separate readiness verdicts

Gateway correctness: locally verified for the implemented contracts, scope/permission
model, bounded live-authorization path and durable mutation adapters. It is a candidate
for an explicitly approved staged rollout, not a claim of live-provider consistency
or production readiness without canary validation.

Complete primary-bot readiness: NOT achieved/verified. Remaining named-client work:
confirm bearer support; integrate a trusted recognition/maintenance policy; protect
employee secrets/opt-outs; search and semantically resolve duplicates/contradictions;
persist intent keys across retries/conversations; invoke recall across conversations;
honestly display receipts/recovery; evaluate explicit shared-publication intent and
untrusted-context resistance. Tool instructions and scripted calls do not prove these.
No OAuth expansion or arbitrary actions are included.

## Risks and architectural limits

- One organization and a dedicated provider namespace remain deployment assumptions;
  this is not provider-level multi-tenancy. Shared container is not org-prefixed.
- Current recall excludes unchanged source chunks, but source re-ingestion can
  reintroduce obsolete assertions. Source correction/re-ingestion policy needs an
  operator decision before enabling shared mutation in production.
- External writers are outside gateway serialization, and provider APIs lack atomic
  CAS/idempotency keys. Freshness checks do not eliminate check-to-write races.
- Shared pending/unknown operations intentionally block ALL admins' shared writes.
  Org-owned journals have a 10,000-intent cap and require an explicit retention and
  operator-reconciliation procedure. No automatic reconciliation/lock clearing.
- Private discovery supports at most 20 bot-visible non-archived private channels,
  three discovery pages and five membership pages/channel. Missing scopes/mapping,
  larger/incomplete coverage, API/rate-limit errors and deadlines deny the search;
  this is not a complete inventory of indexed private history.
- Granting private read to a credential makes unscoped search fail closed if that
  verification is unavailable. Clients can explicitly search shared/personal scope
  independently; do not interpret a failed combined search as “nothing found.”
- Downloaded context and already-authorized in-flight operations cannot be recalled
  by demotion/revocation/channel removal. Future operations reauthorize.
- Exact-text deduplication is bounded; semantic duplicate/contradiction policy and
  correct targeting/publication decisions are still client responsibilities.
- Real Slack installation scopes/identity shapes, first-container provisioning,
  provider eventual consistency and a full browser/client journey need approved
  isolated validation. Historical retrieval is intentionally read-only.

## Staged deployment plan — explicit authorization required

1. Preserve the rollback and review this branch/schema/source-policy/operator plan.
   Choose the named primary client and confirm bearer-header support. Obtain separate
   authorization for any deployment, remote migration, traffic change or live access.
2. With authorization, snapshot/backup D1 and verify its recorded 0002–0004 state.
   Apply ONLY appended 0005 through the approved migration workflow; never rewrite
   old migrations or roll back company data. Deploy compatible backend/assets with
   `EXTERNAL_EMPLOYEE_CREATION_ENABLED=off`. Existing startup migration support is
   bundled, so deployment itself must be authorized as a potential schema operation.
3. Verify health/frontend/session management, legacy bearer/MCP reads, expiry,
   revocation and unauthenticated denial using approved test credentials/data only.
   Do not mint broad employee/shared credentials before these checks pass.
4. With separate live-test authorization, verify Slack recorded scopes/mappings and
   current membership removal, and provider current-fact version/forget semantics
   in an isolated dedicated test namespace. Establish historical-source/re-ingestion
   handling and operator reconciliation/retention ownership. Obtain authorization
   before reading or writing actual company memory.
5. With explicit enablement authorization, set creation gate on and canary with
   consenting employees/admins. Test same-connection ordinary and privileged journeys,
   demotion and named-client behavior. Monitor sanitized errors, quotas and unresolved
   locks; expand traffic/access only after review.
6. If needed, turn creation off without changing existing grants or deleting journals.
   Do not blindly return to a pre-v2 writer after shared ambiguity: that version does
   not understand new shared locks/current-fact policy. Keep reconciliation evidence
   and review any backend/traffic rollback explicitly. Schema is additive and can
   remain; no automatic credential revocation, provider mutation or database rollback.
