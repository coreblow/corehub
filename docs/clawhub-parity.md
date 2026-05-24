# ClawHub Parity

CoreHub follows the ClawHub registry pattern for CoreBlow. The product behavior should remain recognizable to a ClawHub user, while names, URLs, schemas, commands, and compatibility metadata stay CoreBlow-native.

## Canonical Surfaces

| OpenClaw | CoreBlow |
| --- | --- |
| `https://clawhub.ai` | `https://coreblow.com/corehub` |
| `openclaw/clawhub` | `coreblow/corehub` |
| `clawhub` CLI | `corehub` CLI |
| `openclaw.*` compatibility metadata | `coreblow.*` compatibility metadata |
| ClawHub package catalog | CoreHub package catalog |

## Functional Target

CoreHub should provide the same registry class of features as ClawHub:

- Browse skills and render their `SKILL.md`.
- Publish new skill versions with changelogs and latest tags.
- Rename, delete, restore, and merge owned entries without breaking install links.
- Search via deterministic local search first, then hosted search when the backend is available.
- Browse packages with family, trust, capability, review, and compatibility metadata.
- Publish code-plugin and bundle-plugin packages through API and CLI flows.
- Use `package publish <source>` as a single publisher-facing wrapper for preflight, upload, verification, and pending review submission.
- Inspect entries without installing them.
- Manage local installs with install, pin, unpin, uninstall, list, update, and sync flows.
- Support publisher identity, ownership, transfers, moderation, reports, appeals, and admin review.
- Track minimal aggregate install/download telemetry with an opt-out.

## Implementation Phases

### Phase 1: Directory Contract

Status: active.

- `catalog.json` is the canonical static catalog.
- `schemas/corehub.catalog.schema.json` validates the public catalog contract.
- `corehub validate`, `corehub explore`, `corehub search`, and `corehub inspect` work locally.
- `corehub package explore/search/inspect` mirrors the ClawHub package command shape.
- `corehub skill publish` performs a local dry-run inspection until the registry backend lands.

### Phase 2: Registry API

Status: active.

- Add a hosted API under `https://coreblow.com/corehub/api/v1`.
- Expose list, search, inspect, versions, file, and download endpoints.
- Keep response shapes stable enough for the CoreBlow CLI to consume.
- Keep static catalog generation as the fallback source of truth until the backend is promoted.

Implemented v1 read endpoints:

- `GET /corehub/api/v1`
- `GET /corehub/api/v1/catalog`
- `GET /corehub/api/v1/entries`
- `GET /corehub/api/v1/entries/:id`
- `GET /corehub/api/v1/search?q=<query>`
- `GET /corehub/api/v1/packages`
- `GET /corehub/api/v1/packages/search?q=<query>`
- `GET /corehub/api/v1/plugins`
- `GET /corehub/api/v1/plugins/search?q=<query>`
- `GET /corehub/api/v1/packages/:id`
- `GET /corehub/api/v1/packages/:id/versions`

Still pending for full ClawHub parity:

- file and download endpoints
- auth and publisher identity
- write-side publish APIs
- moderation queues and audit logs
- install/sync telemetry

Implemented package CLI parity starters:

- `corehub package publish <source> --dry-run` resolves local folder or archive metadata, publisher ownership, artifact checksum, upload plan, submission plan, and pending review status.
- `corehub package publish <source> --registry <url>` wraps upload, verification, and submission into one CI-friendly command that still lands in pending review.
- `--family code-plugin|bundle-plugin` maps to the CoreHub `plugin` kind while preserving CoreBlow-native catalog metadata.
- `corehub package verify <artifact>` checks local SHA-256 directly or compares the artifact against hosted package metadata.
- `corehub package moderation-status <id>` and `corehub package readiness <id>` expose read-only lifecycle and marketplace readiness state.
- `corehub package delete <id> --yes` and `corehub package undelete <id> --yes` provide soft lifecycle parity for hiding and restoring published packages without deleting history.
- Lower-level `package upload request`, `package upload verify`, and `package submit` commands remain available for debugging and operator runbooks.

### Phase 3: Publisher Identity

- Add GitHub-backed identity.
- Add user and organization publishers.
- Add scoped names such as `@coreblow/plugin-lab`.
- Add ownership transfer and trusted publisher metadata.

### Phase 4: Publishing and Versioning

- Add skill publish and package publish APIs.
- Store versions, changelogs, file manifests, fingerprints, and latest tags.
- Add dry-run and CI publishing paths before enabling writes from public users.

### Phase 5: Moderation and Trust

- Add review queues, reports, appeals, hidden listings, deprecated listings, and audit logs.
- Add security metadata checks for environment variables, binaries, package manifests, and source links.
- Keep moderation states visible in web and CLI inspect output.

Implemented moderation/trust starters:

- `corehub package report <id>` creates an auditable package report for a published version.
- `corehub package reports list` and `corehub package reports triage` expose moderator intake; confirmed reports with `quarantine` or `revoke` final actions now block release downloads.
- `corehub package appeal <id>` creates a publisher appeal for a published version.
- `corehub package appeals list` and `corehub package appeals resolve` expose the moderator/admin appeal queue with ClawHub-style `open`, `accepted`, and `rejected` statuses.
- Admin status and support bundles include package lifecycle, report, and appeal counts with recent samples.
- `corehub package trusted-publisher set|get|delete <id>` stores package-level GitHub Actions trusted publisher policy.
- `corehub package publish-token mint|revoke <id>` mints and revokes short-lived publish tokens for matching trusted publisher runs.
- Package browse/search now supports ClawHub-style discovery filters and deterministic ranking for family, channel, category, capability, official, featured, and executes-code fields.

### Phase 6: Install and Sync

- Add install, pin, unpin, uninstall, list, update, and sync flows.
- Add minimal aggregate telemetry with a `COREHUB_DISABLE_TELEMETRY=1` opt-out.
- Ensure install/update never overwrites pinned local entries.

## Non-Negotiables

- Use CoreBlow branding everywhere.
- Use `https://coreblow.com/corehub` as the public web surface.
- Keep bundled plugin source in `coreblow/coreblow` under `extensions/*`.
- Do not publish release artifacts or mutate version numbers without explicit CoreBlow release approval.
- Treat ClawHub as the behavioral reference, not a copy-paste source.
