# CoreHub ClawHub-Style Package Marketplace Plan

CoreHub uses ClawHub as the product and behavior specification, while keeping the implementation CoreBlow-native. Do not copy ClawHub Convex/function-style code into CoreHub. Read the ClawHub surface, mark parity, then implement the missing behavior through CoreHub's D1/local adapter, optional object storage, audit, CLI, Worker, and admin boundaries.

## Working Loop

1. Read the relevant ClawHub package marketplace surface from `/Users/febrinanda/openclaw-refs/clawhub`.
2. Update the parity matrix with `done`, `partial`, or `missing`.
3. Implement one missing row or tightly coupled group in CoreHub style.
4. Extend CLI/API/docs/tests for that row.
5. Run gates.
6. Commit and push.
7. Continue with the next matrix row.

## Current Baseline

Latest CoreHub split commit used for this acceptance lock:

- `9d99daa CoreHub: add production drill workflow`

Already implemented:

- Registry v1 read surface for catalog, entries, packages, search, versions, artifact/download metadata.
- API v2 upload, artifact verify, submission, review approve/block, assignment, evidence.
- Publisher login/whoami, claim, verification, publisher permission boundary.
- Ownership transfer request/list/status/accept/reject/cancel.
- Reports, appeals, report triage, appeal resolution.
- Soft delete/undelete lifecycle.
- Release moderation enforcement for report final actions `quarantine` and `revoke`.
- Marketplace filters, deterministic ranking, and plugin-only v1 routes.
- Publisher Portal self-service foundation.
- Local install lifecycle state and telemetry opt-out.
- Audit hash chain, retention, incident reporting, admin status, support bundle.
- D1 production persistence boundary, external artifact URL mode, and Worker deploy checks.
- Protected production deploy and production drill with D1 export, validated backup, restore dry run/apply, Worker rollback, revision restore, and live smoke evidence.

## Parity Matrix

| ClawHub behavior | CoreHub status | CoreHub implementation target |
| --- | --- | --- |
| Public package list/search/detail | done | Keep CoreBlow URL/schema naming, preserve v1 compatibility. |
| Package versions/artifact/download | done | Signed read path and trust metadata already present. |
| Download block on quarantined/revoked release | done | Keep `blockedFromDownload` as install block signal. |
| Package reports and triage | done | Keep final actions `none`, `quarantine`, `revoke`. |
| Package appeals and resolution | done | Keep statuses `open`, `accepted`, `rejected`. |
| Soft delete/undelete | done | Preserve history; hide from v1 projections when deleted. |
| Publisher identity and claims | done | Keep local/JWT/session shape until browser OAuth hardens. |
| Ownership transfers | done | Keep CoreHub transfer endpoints and CLI commands. |
| Trusted publisher config | done | API v2 and CLI store package-level GitHub Actions trusted publisher policy. |
| CI/OIDC publish token flow | done | CoreHub verifies GitHub Actions OIDC JWTs against JWKS before minting publish tokens. |
| Official channel guard | done | API and reusable workflow require admin, trusted publisher token, or explicit admin override for official live publish. |
| Direct package publish endpoint parity | done | `corehub package publish` and the reusable package publish workflow wrap upload, verify, and pending review submission. |
| Marketplace filters | done | Family, channel, category, capability, official, featured, and executes-code filters are wired into API v1/CLI. |
| Marketplace ranking | done | Search uses deterministic exact/id/name/category/capability boosts with download/install tie-breakers. |
| Plugin-specific list/search | done | `/corehub/api/v1/plugins` and `/corehub/api/v1/plugins/search` provide plugin-only parity. |
| Publisher portal UI | done | `/corehub/publisher` provides publisher self-service foundation. |
| Browser login/session for publisher portal | done | Token/session UX, explicit session validation, and production token-hash verification are accepted for v1; real OAuth is intentionally deferred to the CoreBlow app auth boundary. |
| Artifact upload UI | done | Publisher portal uploads, verifies, and submits artifacts through API v2. |
| Submission/review status UI | done | Publisher portal lists owned submissions and review ids/statuses. |
| Transfer UI | done | Publisher portal can request ownership transfers and list transfer statuses. |
| Install pin/unpin/uninstall/list/update/sync | done | CLI stores CoreHub-local install state and skips pinned updates/syncs. |
| Telemetry opt-out | done | `COREHUB_DISABLE_TELEMETRY=1` skips CLI analytics record writes. |
| Production auth/rate limit/private visibility | done | Private v1 visibility, session token hash verification, and API rate-limit boundary are wired; real OAuth is intentionally deferred. |
| Production deploy/rollback drill | done | Protected production deploy and Production Drill workflow passed against real D1/Worker resources. |

No `missing` rows remain for CoreHub v1 package marketplace parity. Deferred OAuth and deeper hosted scanner parity are documented v1 product decisions, not blockers for this acceptance scope.

## Implementation Phases From Here

### Phase F: Trusted Publisher and CI Publish Parity

Status: implemented for CoreHub local/API v2/CLI/workflow parity, including GitHub Actions OIDC JWT verification for publish-token minting.

Goal: ClawHub-style trusted publishing, implemented with CoreHub's auth, audit, and storage boundaries.

Tasks:

- Add trusted publisher config state per package:
  - provider, repository, repository owner, workflow filename, optional environment.
  - package owner/admin write boundary.
  - public-safe projection where appropriate.
- Add API v2 routes:
  - `PUT /corehub/api/v2/packages/:id/trusted-publisher`
  - `DELETE /corehub/api/v2/packages/:id/trusted-publisher`
  - `POST /corehub/api/v2/packages/:id/publish-tokens`
  - `POST /corehub/api/v2/packages/:id/publish-tokens/:tokenId/revoke`
- Add CLI:
  - `corehub package trusted-publisher set|get|delete`
  - `corehub package publish-token mint|revoke`
  - CI-friendly publish preflight output.
- Enforce official channel guard:
  - official releases require admin or trusted publisher path.
  - manual override reason required when bypassing trusted publisher policy.
- Add audit events:
  - `package.trusted_publisher.set`
  - `package.trusted_publisher.delete`
  - `package.publish_token.mint`
  - `package.publish_token.use`
  - `package.publish_token.revoke`
- Extend tests and docs.

Implemented:

- `corehub package publish <source> --dry-run` previews the combined publish path.
- `corehub package publish <source> --registry <url>` uploads/verifies artifacts and creates a pending review submission.
- `.github/workflows/package-publish.yml` provides a reusable CI wrapper with safe dry-run defaults and token-gated live submissions.
- `corehub package publish-token mint --oidc` sends the GitHub Actions OIDC JWT to API v2, where CoreHub verifies issuer, audience, signature, repository, workflow, environment, expiry, and run metadata before minting.
- `.github/workflows/package-publish.yml` can set `mint_publish_token: true` to mint a publish token from the caller's protected GitHub Actions run before live publish.
- Live reusable workflow publishes must run from protected refs.
- Live `official` workflow publishes require `publish_token_id`, `mint_publish_token`, or an explicit `manual_override_reason`; the API still rejects non-admin official submissions without a trusted publisher token.

Gate:

```sh
npm test
npm run validate:ops
npm run validate:schema
npm run validate:write-schema
npm run deploy:worker:check -- --template --skip-wrangler
git diff --check
```

### Phase G: Marketplace Search and Discovery Depth

Status: implemented for CoreHub static/projected API v1 and CLI discovery filters.

Goal: ClawHub-style discovery behavior with deterministic CoreHub implementation.

Tasks:

- Add filters to package list/search:
  - family, channel, category, capability tag, official, featured, highlighted, executes code.
- Add plugin-only routes:
  - `/corehub/api/v1/plugins`
  - `/corehub/api/v1/plugins/search`
- Add deterministic ranking:
  - exact id/name token boost.
  - tags/capabilities/category boost.
  - downloads/installs as small tie-breakers.
  - blocked/deleted/private items excluded unless actor can see them.
- Add CLI flags for filters and sort.
- Add docs and test fixtures covering filter/ranking expectations.

### Phase H: Publisher Portal Full Self-Service

Status: complete for CoreHub v1. Token-backed browser sessions, explicit session validation, publisher dashboard operations, artifact upload, submission status, and transfer request/status are accepted for this release scope.

Goal: Publisher can operate CoreHub without admin-only tools.

Tasks:

- Add publisher portal session UX:
  - token setup/login state.
  - whoami, role, publisher memberships.
  - permission error states.
- Package list per publisher.
- Submission form.
- Artifact upload UI.
- Submission/review status tracking.
- Ownership transfer request UI where permitted.
- Playwright smoke for authenticated publisher flows.
- External artifact URL metadata mode for production-lite package submissions.
- Upload history, submission filtering, permission summary, and clearer error/busy states.

Post-v1 hardening:

- Report/appeal visibility for owned packages.
- Transfer accept/reject browser controls for permitted recipient/source actors.
- Real browser OAuth/session validation when the CoreBlow app auth boundary is ready.

### Phase I: Install and Sync Lifecycle

Status: implemented for CoreHub-local CLI install state and telemetry opt-out; CoreBlow app installer handoff remains a separate integration boundary.

Goal: CoreHub can manage local installed package state safely.

Tasks:

- Add local install state:
  - install, list, pin, unpin, uninstall.
  - update and sync.
  - never overwrite pinned entries.
- Add install verification:
  - trust/readiness check before install.
  - block quarantined/revoked releases.
  - verify bytes before handoff.
- Add telemetry opt-out:
  - `COREHUB_DISABLE_TELEMETRY=1`.
  - no raw IP/user-agent/client identifiers in stored analytics.
- Add CLI tests around pinned state and blocked updates.

Implemented:

- `corehub package install <id>` records verified local install state after artifact verification.
- `corehub package installed list` lists active local installs from `COREHUB_HOME/installs.json`.
- `corehub package pin|unpin|uninstall <id>` manages local lifecycle state.
- `corehub package update <id>` and `corehub package sync` refuse to overwrite pinned packages.
- `COREHUB_DISABLE_TELEMETRY=1` skips CLI analytics record writes.

### Phase J: Production Finalization

Status: complete. Private package visibility, browser session validation with production token-hash verification, external artifact URL mode, rate-limit boundary, production D1/secrets application, live smoke, backup validation, restore path, Worker rollback, and Worker revision restore are implemented and operator-applied.

Goal: CoreHub v1 package marketplace can be called final for ClawHub-inspired parity.

Tasks:

- Private package visibility rules.
- Edge rate limiting policy.
- Production D1/secrets applied.
- Backup/restore drill.
- Rollback drill.
- Post-deploy smoke against real deployment.
- Final docs/runbooks.
- Release readiness decision for CLI/npm only with explicit operator approval.

Implemented in this phase:

- Registry API v1 hides `private` channel packages from anonymous catalog/list/search/detail/download metadata.
- Admin actors and active publisher members can read private package metadata.
- API handler supports a fixed-window rate limit via `COREHUB_RATE_LIMIT_MAX` and `COREHUB_RATE_LIMIT_WINDOW_MS`.
- API v2 exposes `GET /corehub/api/v2/session/validate?role=admin|publisher` so browser admin and publisher surfaces validate token-backed sessions before loading privileged data.
- Production config can enforce opaque browser session token SHA-256 hashes with `COREHUB_REQUIRE_SESSION_TOKEN_HASHES=1`; signed JWT sessions remain accepted through the CoreHub signing key.
- Worker production uses `COREHUB_OBJECT_STORE=external-url`, allowing moderated package artifacts to reference GitHub release/raw URLs without requiring paid object storage.
- `npm run validate:production-finalization` checks repository-side production readiness before operator approval.
- `npm run drill:production` rehearses backup validation, restore dry run/apply, persistence migration, and Worker-local smoke.
- The protected deploy workflow passed in production run `26363845788`.
- The protected Production Drill workflow passed in production run `26364024248`, covering live smoke, D1 SQL export, D1 state snapshot export, backup validation, restore dry run, approved no-op restore to D1, restored snapshot verification, Worker rollback, Worker revision restore, final live smoke, and artifact upload.

Post-v1 hardening:

- Real browser OAuth/session login when the CoreBlow app auth boundary is ready.
- CLI/npm publication only after the operator explicitly approves opening the package from `private: true`.

## Done Criteria For Final

CoreHub is final for v1 ClawHub-inspired package marketplace parity when:

- Phase F through J are complete.
- All gates pass locally and in CI.
- Production deployment is exercised with real D1/secrets and external artifact URL mode.
- Rollback and restore are tested, not only documented.
- CLI, admin, publisher portal, and public API behavior are consistent.
- ClawHub-to-CoreHub matrix has no `missing` rows for package marketplace v1.
