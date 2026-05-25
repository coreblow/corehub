# ClawHub Full Parity Audit

This document locks the disk-based CoreHub-to-ClawHub audit for the full marketplace surface. It separates three statuses that must not be mixed:

- `v1 accepted`: implemented and accepted for CoreHub v1 package marketplace parity.
- `full parity missing`: still absent or meaningfully thinner than ClawHub.
- `intentionally deferred`: consciously outside CoreHub v1, but still a real gap for full ClawHub parity.

CoreHub uses ClawHub as the product behavior reference, while implementation stays CoreBlow-native: D1/state adapters, external artifact URL mode, audit boundaries, CoreHub CLI names, Worker deployment, and CoreBlow package metadata.

## Audit Sources

CoreHub sources audited:

- `src/api-server.mjs`
- `src/corehub.mjs`
- `src/cli.mjs`
- `schemas/corehub.catalog.schema.json`
- `schemas/corehub.write-side.schema.json`
- `docs/clawhub-parity.md`
- `docs/clawhub-package-marketplace-implementation-plan.md`
- `docs/final-acceptance.md`
- `docs/production-persistence.md`
- `test/catalog.test.mjs`

ClawHub sources audited from `/Users/febrinanda/openclaw-refs/clawhub`:

- `docs/api.md`
- `docs/http-api.md`
- `docs/publishing.md`
- `docs/security-audits.md`
- `specs/security-moderation.md`
- `specs/orgs.md`
- `convex/schema.ts`
- `convex/httpApiV1/packagesV1.ts`
- `convex/httpApiV1/skillsV1.ts`
- `convex/lib/packageRegistry.ts`
- `convex/lib/packageSecurity.ts`
- `convex/lib/httpRateLimit.ts`
- `convex/packagePublishTokens.ts`
- `packages/clawhub/src/cli`
- `packages/clawhub-mod/src/commands`

## Executive Status

CoreHub is accepted for v1 package marketplace parity. Full ClawHub product parity still has intentionally deferred post-v1 product scope.

The main remaining gap is not basic marketplace lifecycle anymore. The remaining gap is depth outside the accepted marketplace surface: browser OAuth UI polish and richer product UI hardening.

## Matrix Lock

| Surface | CoreHub status | ClawHub reference behavior | CoreHub evidence | Next action |
| --- | --- | --- | --- | --- |
| Public package list/search/detail | v1 accepted | `GET /api/v1/packages`, `/packages/search`, `/plugins`, `/plugins/search`, package detail. | CoreHub exposes package and plugin browse/search/detail routes with filters and deterministic ranking. | Keep covered by smoke and regression tests. |
| Package versions and artifact metadata | v1 accepted | Version detail, artifact metadata, artifact download routes. | CoreHub exposes versions, signed metadata, signed redirect/read, and external artifact URL mode. | Keep v1 accepted. |
| Release quarantine/revoke enforcement | v1 accepted | Moderation final actions block install/download through trust state. | CoreHub report triage final actions block release downloads and readiness/install signals. | Keep covered by package download/readiness tests. |
| Reports and appeals | v1 accepted | Package reports, triage, appeals, event logs. | CoreHub API, CLI, audit events, support bundle, and publisher portal owner-facing visibility include reports and appeals. | Keep accepted; expand web moderation ergonomics only as product polish. |
| Soft delete/undelete | v1 accepted | Hide deleted packages from public reads while preserving history. | CoreHub hides deleted packages in v1 projections and keeps history. | Keep accepted. |
| Publisher identity and scoped names | v1 accepted | User/org publishers, scoped packages, ownership boundary. | CoreHub validates scoped package ownership and exposes publisher claim/whoami/session flows. | Keep v1 accepted; real OAuth/org depth remains separate. |
| Ownership transfer | v1 accepted | Transfer request/list/status/accept/reject/cancel. | CoreHub API, CLI, and publisher portal cover transfer request/status plus browser accept/reject/cancel controls where the actor has the target/source role. | Keep accepted. |
| Trusted publisher and CI token flow | v1 accepted | GitHub Actions trusted publishing and OIDC token boundary. | CoreHub verifies GitHub Actions OIDC JWTs before minting publish tokens. | Keep accepted; preserve official channel guard. |
| OAuth account and org boundary | v1 accepted | GitHub-backed account identity, personal publishers, org publishers, and publisher membership role checks. | CoreHub accepts signed upstream GitHub identity completion and now supports real GitHub browser OAuth start/exchange, signed browser session tokens, account storage, personal publisher bootstrap, org publishers, org members, and membership enforcement for package upload/submission boundaries. | Keep browser UI polish in post-v1 rows. |
| Admin review and evidence | v1 accepted | Review queues, approve/block, evidence, assignment. | CoreHub admin API/UI has health/status, support bundle, queue counts, review detail, evidence, assign, approve, block. | Keep accepted; expand queue ergonomics only after P0 API gaps. |
| Publisher portal self-service | v1 accepted | Publisher operations in web UI. | CoreHub portal has token session UX, whoami/role, package list, upload, submission status, transfer request/decision/status, reports/appeals visibility, and package moderation status. | Polish visual ergonomics after compatibility. |
| Install lifecycle and telemetry opt-out | v1 accepted | Install, pin, update, sync, opt-out telemetry. | CoreHub CLI stores local install state and honors `COREHUB_DISABLE_TELEMETRY=1`. | Keep accepted; app installer handoff remains separate. |
| Production D1/deploy/drill | v1 accepted | Operational deployment, backup, restore, rollback. | CoreHub production-lite drill passed with real Worker/D1 revision, smoke, export, restore dry run/apply, rollback, restore. | Keep accepted; repeat after compatibility changes. |
| Exact package security endpoint | v1 accepted | `GET /api/v1/packages/{name}/versions/{version}/security` returns exact release security and trust summary. | CoreHub now exposes version-exact public security and trust summary for install clients. | Keep covered by route tests. |
| npm packument endpoint | v1 accepted | `GET /api/npm/{package}` supports npm-compatible packument, including scoped package paths. | CoreHub now emits minimal npm-compatible packuments for available `.tgz` versions, with tarball, integrity, shasum, and CoreHub SHA-256 metadata. | Keep covered by route tests. |
| npm tarball endpoint | v1 accepted | `GET /api/npm/{package}/-/{tarball}.tgz` redirects/serves package tarballs. | CoreHub now redirects npm tarball requests to the exact signed or external artifact URL and preserves integrity headers. | Keep covered by route tests. |
| Package file route | v1 accepted | `GET /api/v1/packages/{name}/file?path=...` reads package file content. | CoreHub now exposes package file manifests and raw UTF-8 text reads for managed verified artifact files, with path, size, checksum, and moderation checks. | Keep covered by route tests. |
| Cursor pagination | v1 accepted | ClawHub list/search supports cursor pagination and merged source cursors. | CoreHub list/search/version routes now return cursor-aware metadata with backward-compatible offset reads. | Keep covered by route tests. |
| Standard rate limit headers | v1 accepted | ClawHub documents read/write/download buckets with `X-RateLimit-*` and `RateLimit-*` headers. | CoreHub fixed-window limiter now emits `X-RateLimit-*`, `RateLimit-*`, and `Retry-After` on limited responses. | Add separate policy buckets later if needed. |
| Error response compatibility | v1 accepted | ClawHub public API uses plain text errors for validation, auth, permission, rate-limit, not found, and blocked-download failures. | CoreHub public v1/npm errors now use ClawHub-compatible plain text, while authenticated v2 errors have a stable JSON envelope with legacy `error` string compatibility. | Keep covered by public and v2 error route tests. |
| Static scanner pipeline | v1 accepted | Static scan job model, scan status, rescan/backfill operations, and scanner evidence. | CoreHub now stores static scan jobs, emits public scan status, exposes admin rescan/backfill routes, and includes scan counts/evidence in support bundles. | Keep covered by route tests. |
| Deep hosted scanner parity | v1 accepted | VirusTotal-style scanner state, LLM/ClawScan review, hosted queues, external scanner callbacks, and rich rescan policy. | CoreHub now supports hosted scanner queue jobs, CoreHub ClawScan and VirusTotal analysis snapshots, external result ingestion, reason codes, risk levels, evidence, and scan trust enforcement through public security/download readiness paths. | Keep covered by hosted scanner route and CLI tests; external provider workers remain operator infrastructure. |
| Normalized package persistence | v1 accepted | ClawHub has normalized `packages`, `packageReleases`, stats, reports, appeals, scan jobs, search digests, trusted publishers, token tables. | CoreHub now uses D1 normalized meta/row/index tables while preserving the logical state-store boundary and legacy snapshot fallback. | Keep covered by D1 migration and Worker smoke tests. |
| Search digest/index depth | v1 accepted | ClawHub stores package/skill search digest tables and indexed query paths. | CoreHub now persists package and hosted skill search digests, rebuilds them from write-side projections, stores normalized D1 row/index entries for filter/search tokens, and serves public list/search from digest-backed entries. | Keep covered by persistence migration and public route tests. |
| Real browser OAuth | v1 accepted | ClawHub has GitHub-backed browser auth/account model. | CoreHub now exposes GitHub OAuth start/callback/exchange endpoints, validates signed state, exchanges provider codes, fetches GitHub profiles, mints signed browser session tokens, and links/refreshes accounts. | Browser UI entry polish remains post-v1 hardening, not an API parity blocker. |
| Full user/org settings | v1 accepted | ClawHub includes full user profile settings, org settings pages, invites, and account deletion flows. | CoreHub now supports account profile update, account soft deletion/session revocation, organization profile/settings update, organization soft deletion, invited members, invite acceptance, and member removal with audit events. | Browser settings UI polish remains post-v1 hardening. |
| Moderator CLI depth | v1 accepted | `clawhub-mod` has richer moderation, migration, repair, and backfill operator commands. | CoreHub CLI now covers review/status/support plus package reports, report triage, release moderation, moderation queue, scanner list/rescan/backfill, appeals, trusted publishers, publish tokens, and delete/undelete in CoreHub-native API v2 form. | Keep migrations/repair-name deferred unless CoreHub needs ClawHub internal migration repair tooling. |
| Skill marketplace parity | v1 accepted | ClawHub supports skills, `SKILL.md` rendering, skill publish, skill file/security routes, rename/merge/transfer, skill search. | CoreHub now has hosted skill publish, public skill list/search/detail, `SKILL.md` rendering, file/security routes, and owner delete/restore/rename/transfer actions in CoreHub-native API v2 plus projected v1 reads. Merge/alias depth remains intentionally deferred. | Keep covered by hosted skill route tests; add alias/merge only if CoreHub needs ClawHub's legacy slug repair depth. |
| Community signals | v1 accepted | ClawHub has comments, stars, leaderboards, public profiles, and community-oriented surfaces. | CoreHub now has package/skill stars, comments, comment reports with soft-hide thresholding, admin comment report queue, hide/unhide/close actions, public publisher profiles, profile signals, and package/skill leaderboards in CoreHub-native state collections and API routes. | Keep richer community product pages as visual polish. |
| Artifact schema richness | v1 accepted | ClawHub release records include artifact kind, npm integrity/shasum/tarball, unpacked size, file count, manifests, capabilities, scan fields. | CoreHub now preserves artifact kind, format, SHA-256, npm integrity/shasum/tarball, unpacked size, file count, file manifests, capability summaries, compatibility summaries, verification summaries, and scan trust fields through catalog, CLI submit, API projection, npm mirror, and production seed flows. | Keep covered by schema, CLI, npm mirror, and route tests. |
| Test surface parity | v1 accepted | ClawHub has broad unit, API, route, package, scanner, rate-limit, and CLI tests. | CoreHub now keeps the legacy catalog integration test, adds focused surface tests for public API compatibility, npm/tarball/file routes, scanner routes, community/skill routes, and moderator CLI scanner flow, and runs CI as split public-api/CLI/scanner/skill/community/worker/persistence jobs. | Continue adding focused tests with every new compatibility row. |
| Documentation consistency | v1 accepted | ClawHub docs and specs define endpoint-level behavior. | CoreHub `final-acceptance.md`, `clawhub-parity.md`, and this audit now agree on accepted hosted skill lifecycle, hosted scanner depth, and remaining deferred/full-parity rows. | Keep docs updated with every accepted compatibility row. |

## P0 Implementation Order

No P0 compatibility rows remain for CoreHub v1 package marketplace acceptance.

## P1 Implementation Order

After P0:

1. Polish browser settings UI for account and organization management.
2. Add ClawHub-style migration repair tooling only if CoreHub needs package rename/migration operations.
3. Keep extending focused API/CLI/route suites with every new post-v1 compatibility row.

## P2 Product Scope Decisions

These are not required for CoreHub v1 package marketplace final, but are required if the target becomes full ClawHub product parity:

- Skill merge/alias repair beyond v1 hosted skill rename/transfer/delete/restore.
- Richer community product pages beyond admin moderation and API-level stars, comments, profiles, and leaderboards.
- Browser settings UI polish for account and organization management.
- Browser OAuth UI polish beyond the API-level provider exchange.
- CLI/npm publication opening after explicit operator approval.

## Acceptance Interpretation

`docs/final-acceptance.md` remains true for CoreHub v1 package marketplace acceptance. This audit supersedes any older wording that implies CoreHub has no remaining gaps against the full ClawHub product.

Future work should use this document as the source of truth:

- Do not reopen completed v1 rows unless a regression is found.
- Do not call intentionally deferred rows blockers for v1.
- Do treat `full parity missing` rows as the next concrete backlog for ClawHub-level parity.
- Continue using ClawHub as behavior specification and CoreHub/CoreBlow architecture as implementation boundary.
