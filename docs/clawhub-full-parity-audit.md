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

CoreHub is accepted for v1 package marketplace parity. Full ClawHub parity is not complete.

The main remaining gap is not basic marketplace lifecycle anymore. The remaining gap is depth: deep hosted scanner pipeline, normalized persistence/indexing, full account/org/auth model, richer moderator tooling, and full skill/community marketplace surfaces.

## Matrix Lock

| Surface | CoreHub status | ClawHub reference behavior | CoreHub evidence | Next action |
| --- | --- | --- | --- | --- |
| Public package list/search/detail | v1 accepted | `GET /api/v1/packages`, `/packages/search`, `/plugins`, `/plugins/search`, package detail. | CoreHub exposes package and plugin browse/search/detail routes with filters and deterministic ranking. | Keep covered by smoke and regression tests. |
| Package versions and artifact metadata | v1 accepted | Version detail, artifact metadata, artifact download routes. | CoreHub exposes versions, signed metadata, signed redirect/read, and external artifact URL mode. | Keep v1 accepted. |
| Release quarantine/revoke enforcement | v1 accepted | Moderation final actions block install/download through trust state. | CoreHub report triage final actions block release downloads and readiness/install signals. | Keep covered by package download/readiness tests. |
| Reports and appeals | v1 accepted | Package reports, triage, appeals, event logs. | CoreHub API, CLI, audit events, and support bundle include reports and appeals. | Keep accepted; add owner-facing portal visibility as hardening. |
| Soft delete/undelete | v1 accepted | Hide deleted packages from public reads while preserving history. | CoreHub hides deleted packages in v1 projections and keeps history. | Keep accepted. |
| Publisher identity and scoped names | v1 accepted | User/org publishers, scoped packages, ownership boundary. | CoreHub validates scoped package ownership and exposes publisher claim/whoami/session flows. | Keep v1 accepted; real OAuth/org depth remains separate. |
| Ownership transfer | v1 accepted | Transfer request/list/status/accept/reject/cancel. | CoreHub API, CLI, and publisher portal cover v1 transfer request/status flow. | Add browser accept/reject controls as hardening. |
| Trusted publisher and CI token flow | v1 accepted | GitHub Actions trusted publishing and OIDC token boundary. | CoreHub verifies GitHub Actions OIDC JWTs before minting publish tokens. | Keep accepted; preserve official channel guard. |
| Admin review and evidence | v1 accepted | Review queues, approve/block, evidence, assignment. | CoreHub admin API/UI has health/status, support bundle, queue counts, review detail, evidence, assign, approve, block. | Keep accepted; expand queue ergonomics only after P0 API gaps. |
| Publisher portal self-service | v1 accepted | Publisher operations in web UI. | CoreHub portal has token session UX, whoami/role, package list, upload, submission status, transfer request/status. | Polish after P0 compatibility. |
| Install lifecycle and telemetry opt-out | v1 accepted | Install, pin, update, sync, opt-out telemetry. | CoreHub CLI stores local install state and honors `COREHUB_DISABLE_TELEMETRY=1`. | Keep accepted; app installer handoff remains separate. |
| Production D1/deploy/drill | v1 accepted | Operational deployment, backup, restore, rollback. | CoreHub production-lite drill passed with real Worker/D1 revision, smoke, export, restore dry run/apply, rollback, restore. | Keep accepted; repeat after compatibility changes. |
| Exact package security endpoint | v1 accepted | `GET /api/v1/packages/{name}/versions/{version}/security` returns exact release security and trust summary. | CoreHub now exposes version-exact public security and trust summary for install clients. | Keep covered by route tests. |
| npm packument endpoint | v1 accepted | `GET /api/npm/{package}` supports npm-compatible packument, including scoped package paths. | CoreHub now emits minimal npm-compatible packuments for available `.tgz` versions, with tarball, integrity, shasum, and CoreHub SHA-256 metadata. | Keep covered by route tests. |
| npm tarball endpoint | v1 accepted | `GET /api/npm/{package}/-/{tarball}.tgz` redirects/serves package tarballs. | CoreHub now redirects npm tarball requests to the exact signed or external artifact URL and preserves integrity headers. | Keep covered by route tests. |
| Package file route | v1 accepted | `GET /api/v1/packages/{name}/file?path=...` reads package file content. | CoreHub now exposes package file manifests and raw UTF-8 text reads for managed verified artifact files, with path, size, checksum, and moderation checks. | Keep covered by route tests. |
| Cursor pagination | v1 accepted | ClawHub list/search supports cursor pagination and merged source cursors. | CoreHub list/search/version routes now return cursor-aware metadata with backward-compatible offset reads. | Keep covered by route tests. |
| Standard rate limit headers | v1 accepted | ClawHub documents read/write/download buckets with `X-RateLimit-*` and `RateLimit-*` headers. | CoreHub fixed-window limiter now emits `X-RateLimit-*`, `RateLimit-*`, and `Retry-After` on limited responses. | Add separate policy buckets later if needed. |
| Error envelope compatibility | full parity missing | ClawHub public API has documented auth, permission, rate-limit, and blocked-download failure semantics. | CoreHub has JSON errors, but not a locked ClawHub-compatible public error contract. | Lock and test error response schema. |
| Static scanner pipeline | v1 accepted | Static scan job model, scan status, rescan/backfill operations, and scanner evidence. | CoreHub now stores static scan jobs, emits public scan status, exposes admin rescan/backfill routes, and includes scan counts/evidence in support bundles. | Keep covered by route tests. |
| Deep hosted scanner parity | intentionally deferred | VirusTotal-style scanner state, LLM/ClawScan review, hosted queues, external scanner callbacks, and rich rescan policy. | CoreHub has the scanner boundary and static evidence model, but does not implement ClawHub scanner internals. | Post-v1 major phase. |
| Normalized package persistence | v1 accepted | ClawHub has normalized `packages`, `packageReleases`, stats, reports, appeals, scan jobs, search digests, trusted publishers, token tables. | CoreHub now uses D1 normalized meta/row/index tables while preserving the logical state-store boundary and legacy snapshot fallback. | Keep covered by D1 migration and Worker smoke tests. |
| Search digest/index depth | partial | ClawHub stores package/skill search digest tables and indexed query paths. | CoreHub now persists lookup indexes for normalized state rows, but public search still projects deterministic catalog/state results instead of a dedicated search digest table. | Add dedicated search digest if scale requires it. |
| Real browser OAuth | intentionally deferred | ClawHub has GitHub-backed browser auth/account model. | CoreHub v1 accepts token-backed browser sessions plus token-hash enforcement. | Implement with CoreBlow app auth boundary. |
| User/org management | intentionally deferred | ClawHub includes user, organization, publisher-admin, settings, memberships, and org ownership semantics. | CoreHub has publisher identity and memberships sufficient for v1 package ownership. | Post-v1 account/org phase. |
| Moderator CLI depth | full parity missing | `clawhub-mod` has richer moderation, migration, repair, and backfill operator commands. | CoreHub admin CLI/API covers v1 review/status/support but not all mod tooling. | Add after public API compatibility. |
| Skill marketplace parity | full parity missing | ClawHub supports skills, `SKILL.md` rendering, skill publish, skill file/security routes, rename/merge/transfer, skill search. | CoreHub v1 acceptance is package marketplace focused; static skill catalog exists, but full hosted skill lifecycle is not parity-complete. | Separate full skill marketplace phase. |
| Community signals | full parity missing | ClawHub has comments, stars, leaderboards, public profiles, and community-oriented surfaces. | CoreHub has marketplace/package lifecycle, not community surfaces. | Defer unless CoreHub product scope expands. |
| Artifact schema richness | full parity missing | ClawHub release records include artifact kind, npm integrity/shasum/tarball, unpacked size, file count, manifests, capabilities, scan fields. | CoreHub schema is smaller and CoreBlow-native. | Add fields needed for npm/tarball and scanner phases. |
| Test surface parity | full parity missing | ClawHub has broad unit, API, route, package, scanner, rate-limit, and CLI tests. | CoreHub has one main Node test plus smoke scripts. | Add focused tests with every new compatibility row. |
| Documentation consistency | full parity missing | ClawHub docs and specs define endpoint-level behavior. | CoreHub `final-acceptance.md` is current for v1, while older `clawhub-parity.md` still contains stale pending notes. | Update old docs after this audit lock. |

## P0 Implementation Order

The next work should not start another broad phase. Implement these rows one at a time:

1. Lock the public error envelope for auth, permission, rate limit, not found, and blocked download.

## P1 Implementation Order

After P0:

1. Add dedicated search digest rows if public marketplace scale requires query-time search acceleration.
2. Expand moderator CLI around scanner/backfill operations.
3. Add publisher portal report/appeal visibility and transfer accept/reject controls.

## P2 Product Scope Decisions

These are not required for CoreHub v1 package marketplace final, but are required if the target becomes full ClawHub product parity:

- Hosted skill publish lifecycle.
- Skill file/security routes.
- Skill rename, merge, transfer, delete, restore.
- Comments, stars, leaderboards, public profiles.
- Full user/org settings and organization management.
- Real browser OAuth and account linking.
- CLI/npm publication opening after explicit operator approval.

## Acceptance Interpretation

`docs/final-acceptance.md` remains true for CoreHub v1 package marketplace acceptance. This audit supersedes any older wording that implies CoreHub has no remaining gaps against the full ClawHub product.

Future work should use this document as the source of truth:

- Do not reopen completed v1 rows unless a regression is found.
- Do not call intentionally deferred rows blockers for v1.
- Do treat `full parity missing` rows as the next concrete backlog for ClawHub-level parity.
- Continue using ClawHub as behavior specification and CoreHub/CoreBlow architecture as implementation boundary.
