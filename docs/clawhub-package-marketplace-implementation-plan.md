# CoreHub ClawHub-Style Package Marketplace Plan

CoreHub uses ClawHub as the product and behavior specification, while keeping the implementation CoreBlow-native. Do not copy ClawHub Convex/function-style code into CoreHub. Read the ClawHub surface, mark parity, then implement the missing behavior through CoreHub's D1/R2/local adapter, audit, CLI, Worker, and admin boundaries.

## Working Loop

1. Read the relevant ClawHub package marketplace surface from `/Users/febrinanda/openclaw-refs/clawhub`.
2. Update the parity matrix with `done`, `partial`, or `missing`.
3. Implement one missing row or tightly coupled group in CoreHub style.
4. Extend CLI/API/docs/tests for that row.
5. Run gates.
6. Commit and push.
7. Continue with the next matrix row.

## Current Baseline

Latest CoreHub split commit used for this plan:

- `1e15e85 CoreHub: add publisher portal UI`

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
- Audit hash chain, retention, incident reporting, admin status, support bundle.
- D1/R2 production persistence boundary and Worker deploy checks.

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
| CI/OIDC publish token flow | partial | CoreHub-native mint/use/revoke exists; real GitHub OIDC JWT verification remains. |
| Official channel guard | partial | Submission guard exists; needs full CI publish wrapper and public deploy policy. |
| Direct package publish endpoint parity | partial | Current flow is upload/verify/submit; add CI-friendly publish wrapper only after trusted publisher boundary. |
| Marketplace filters | done | Family, channel, category, capability, official, featured, and executes-code filters are wired into API v1/CLI. |
| Marketplace ranking | done | Search uses deterministic exact/id/name/category/capability boosts with download/install tie-breakers. |
| Plugin-specific list/search | done | `/corehub/api/v1/plugins` and `/corehub/api/v1/plugins/search` provide plugin-only parity. |
| Publisher portal UI | done | `/corehub/publisher` provides publisher self-service foundation. |
| Browser login/session for publisher portal | partial | Token/session UX is wired; real OAuth/session hardening remains. |
| Artifact upload UI | done | Publisher portal uploads, verifies, and submits artifacts through API v2. |
| Submission/review status UI | done | Publisher portal lists owned submissions and review ids/statuses. |
| Transfer UI | done | Publisher portal can request ownership transfers and list transfer statuses. |
| Install pin/unpin/uninstall/list/update/sync | done | CLI stores CoreHub-local install state and skips pinned updates/syncs. |
| Telemetry opt-out | done | `COREHUB_DISABLE_TELEMETRY=1` skips CLI analytics record writes. |
| Production auth/rate limit/private visibility | partial | Harden browser OAuth, permissions, private package rules, and edge rate limits. |
| Production deploy/rollback drill | partial | Persistence runbooks exist; final applied production drill remains. |

## Implementation Phases From Here

### Phase F: Trusted Publisher and CI Publish Parity

Status: implemented for CoreHub local/API v2/CLI parity, with real GitHub OIDC verification remaining as production hardening.

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

Status: implemented for token-session publisher self-service foundation; real OAuth/session hardening and owned report/appeal visibility remain production hardening.

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

Remaining hardening:

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

Goal: CoreHub v1 package marketplace can be called final for ClawHub-inspired parity.

Tasks:

- Real browser OAuth/session login.
- Private package visibility rules.
- Edge rate limiting policy.
- Production D1/R2/secrets applied.
- Backup/restore drill.
- Rollback drill.
- Post-deploy smoke against real deployment.
- Final docs/runbooks.
- Release readiness decision for CLI/npm only with explicit operator approval.

## Done Criteria For Final

CoreHub is final for v1 ClawHub-inspired package marketplace parity when:

- Phase F through J are complete.
- All gates pass locally and in CI.
- Production deployment is exercised with real D1/R2/secrets.
- Rollback and restore are tested, not only documented.
- CLI, admin, publisher portal, and public API behavior are consistent.
- ClawHub-to-CoreHub matrix has no `missing` rows for package marketplace v1.
