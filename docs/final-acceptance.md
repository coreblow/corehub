# CoreHub Final Acceptance

This document locks the CoreHub v1 package marketplace acceptance pass against the ClawHub behavior reference.

CoreHub follows ClawHub product behavior where it matters for package marketplace users and operators, while keeping CoreBlow-native names, URLs, schemas, D1 persistence, external artifact URL storage, audit events, CLI commands, and Worker deployment boundaries.

## Acceptance Status

Status: accepted for CoreHub v1 package marketplace parity.

Accepted scope:

- Public package browse, search, detail, versions, signed artifact metadata, and download redirect/read.
- Package publish wrapper, upload verification, pending review submission, and reusable CI publish workflow.
- Publisher identity, signed upstream GitHub account completion, personal publishers, org publishers, membership role enforcement, scoped namespace validation, package ownership, trusted publisher policy, and GitHub Actions OIDC publish token verification.
- Admin review, assignment, evidence, approve, block, support bundle, audit visibility, and authenticated admin UI smoke.
- Publisher portal token session UX, whoami/role status, owned package list, artifact upload, submission status, and transfer request/status.
- Reports, triage, appeals, soft delete/undelete, release quarantine/revoke download enforcement, and install/readiness signals.
- Marketplace filters, plugin-only routes, deterministic ranking, hosted skill publish/search/detail/file/security/rendered lifecycle, install lifecycle state, pin/unpin/uninstall/update/sync, and telemetry opt-out.
- Production D1 persistence, external artifact URL mode, session token hash enforcement, rate limit boundary, private package visibility, protected deploy, seed, smoke, backup, restore, rollback, and production drill workflows.

Intentionally deferred outside v1 acceptance:

- Real browser provider exchange UI. CoreHub v1 accepts signed upstream GitHub identity completion plus token-backed browser sessions and production token-hash enforcement until the CoreBlow app auth boundary owns the browser OAuth exchange.
- npm release publication. The package remains `private: true` until an operator explicitly approves opening the CoreHub CLI release surface.

## ClawHub-To-CoreHub Matrix Lock

| ClawHub behavior class | CoreHub v1 result | Acceptance note |
| --- | --- | --- |
| Public package registry | done | CoreHub exposes `/corehub/api/v1` package list/search/detail/version/download surfaces. |
| Public plugin discovery | done | Plugin-only list/search routes and CLI filters are present. |
| Package publish lifecycle | done | CLI and reusable workflow wrap upload, verify, submit, and pending review. |
| Publisher identity and scoped packages | done | Publisher claims, whoami, memberships, and scope-owner validation are enforced. |
| OAuth account and org boundary | done | Signed upstream GitHub identity completion, account records, personal publishers, org publishers, and member role enforcement are present. |
| Ownership transfer | done | API, CLI, and publisher portal transfer request/status flow are present. |
| Trusted publisher and CI token flow | done | GitHub Actions OIDC JWT verification mints short-lived publish tokens. |
| Official release guard | done | Official live publish requires admin, trusted publisher token, or explicit override. |
| Admin moderation and review | done | Admin API/CLI/UI cover status, support bundle, review action, assignment, and evidence. |
| Reports and appeals | done | Reports, triage, appeals, resolution, and audit events are wired. |
| Quarantine/revoke enforcement | done | Confirmed final actions block release downloads through trust metadata and download routes. |
| Soft delete/undelete | done | Deleted packages are hidden from public v1 projections while preserving history. |
| Marketplace search depth | done | Filters and deterministic ranking are implemented. |
| Hosted skill lifecycle | done | Hosted skill publish, search, detail, file/security routes, `SKILL.md` rendering, delete/restore, rename, and transfer are present. |
| Hosted scanner depth | done | Static scan jobs, hosted queue/result ingestion, VirusTotal/LLM/ClawScan-style snapshots, and public scan trust summaries are present. |
| Publisher portal | done | Token-backed self-service surface covers v1 publisher operations. |
| Install lifecycle | done | Local install state, pinning, update, sync, uninstall, and telemetry opt-out are implemented. |
| Production persistence | done | D1 normalized meta/row/index store, schema migration, backup/export, restore, and runbooks are present. |
| Production deployment and rollback | done | Protected deploy, live smoke, backup validation, restore drill, rollback drill, and final verification are exercised. |

No `missing` rows remain for CoreHub v1 package marketplace parity. Deferred items are documented product decisions, not acceptance blockers.

## Production Evidence

Latest accepted production evidence:

| Evidence | Result |
| --- | --- |
| Production deploy workflow | success, run `26363845788` |
| Production Drill workflow | success, run `26364024248` |
| Drill commit | `9d99daaa7b68b5542a72bfd375d47cc75099edd2` |
| Production registry | `https://coreblow.com/corehub` |
| Smoke package | `plugin-lab` |
| Rollback target used during drill | `8406bea7-bfa7-4ad4-af11-d36870dd329d` |
| Restored Worker version | `178b5a5d-9057-4cb0-b23c-8f35a2580291` at 100 percent |

The production drill completed:

- live smoke of the current revision
- D1 SQL export
- D1 state snapshot export
- backup validation
- restore dry run
- approved no-op restore to D1
- restored snapshot verification
- Worker rollback revision
- Worker revision restore
- final live smoke
- artifact upload for drill evidence

Final local live smoke after the drill also passed against `https://coreblow.com/corehub` with web surface, v1 registry discovery, package read, signed download metadata, signed redirect, and signed artifact read checksum verification.

## Final Acceptance Pass

Latest final acceptance pass:

| Evidence | Result |
| --- | --- |
| Date | 2026-05-25 |
| Commit | `fae3fbd` |
| Local gate | pass |
| Deploy template readiness | pass |
| Live post-deploy smoke | pass against `https://coreblow.com/corehub` |
| Smoke package | `plugin-lab` |
| Runtime | Cloudflare Worker |
| State store | D1 |
| Object store mode | external URL |
| Signed read key | `primary` |

The final pass verified:

- `npm test`
- `npm run validate:ops`
- `npm run validate:schema`
- `npm run validate:write-schema`
- `npm run validate:deploy-template`
- `git diff --check`
- `npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-web --verify-read`

The live smoke verified the web surface, health endpoint, v1 registry discovery, package read, signed download metadata, signed redirect, and signed artifact read checksum.

## Post-Acceptance Additions

After the final acceptance pass, CoreHub added API-level community signals for full ClawHub product parity:

- Package and hosted skill stars.
- Package and hosted skill comments.
- Comment reports with soft-hide thresholding.
- Public publisher profiles.
- Package and hosted skill leaderboards.

CoreHub also split the ClawHub parity test surface into focused route and CLI coverage:

- Public API compatibility: cursor pagination, exact security endpoint shape, v1 text errors, v2 error envelopes, and rate-limit headers.
- npm and artifact route parity: packument, tarball redirect, file manifest, raw file read, and path validation.
- Scanner route parity: static backfill, hosted scan enqueue/result, and security trust enforcement.
- Community and skill route parity: hosted skill read/security plus stars, comments, reports, deletion, and leaderboard scoring.
- Moderator CLI surface: scanner enqueue, completion, and list flow through the CoreHub registry client.

## Final Gate

Before changing acceptance status, run:

```sh
npm test
npm run validate:ops
npm run validate:schema
npm run validate:write-schema
npm run validate:deploy-template
git diff --check
```

For production confidence after a new deploy, run the protected `Production Drill` workflow again with the current known-good rollback version id, then run:

```sh
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-web --verify-read
```
