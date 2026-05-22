# CoreHub Write-Side Schema

CoreHub write-side records are the planned marketplace control plane for publisher accounts, package submissions, managed artifact uploads, moderation reviews, ownership transfers, and install analytics.

The public Registry API v1 remains read-only. The write-side schema is a separate contract so CoreHub can add authenticated publishing without changing the existing catalog read shape.

## Reference Pattern

The schema follows the ClawHub pattern where publishing is owner-scoped:

1. A publisher owns a package namespace.
2. A submission targets one publisher, package id, and version.
3. The server validates owner permission, package scope, artifact metadata, and source attribution.
4. A release remains hidden from install/download surfaces until review approves it.
5. Moderation can block or deprecate versions without rewriting package history.

## Tables

| Collection | Purpose |
| --- | --- |
| `authSessions` | Authenticated CLI or API sessions for publisher workflows. |
| `publisherClaims` | Handle reservation and verification requests before an account is active. |
| `publisherAccounts` | Stable publisher handles for users or organizations. |
| `publisherMembers` | Role bindings for organization-owned publishers. |
| `packageSubmissions` | Authenticated publish attempts before they become public versions. |
| `packageVersions` | Immutable package version records after review. |
| `artifactUploads` | Managed upload metadata, storage locator, size, and checksum. |
| `moderationReviews` | Human or automated review decisions. |
| `ownershipTransfers` | Explicit publisher ownership moves with audit history. |
| `installEvents` | Privacy-preserving aggregate install and verification events. |
| `auditEvents` | Operator audit trail for write-side actions and admin reads. |
| `auditRetentionCheckpoints` | Export-before-prune checkpoints for archived audit prefixes. |

## Status Flow

```text
auth session -> publisher claim -> publisher account -> package submission -> artifact upload -> moderation review -> package version -> install event
```

Submissions start as `draft` or `pending_review`. Only approved submissions can create an `available` package version. Blocked, rejected, or held records must not become installable.

## Compatibility With Registry API v1

The write-side schema does not replace `corehub.catalog.schema.json`.

| Surface | Contract |
| --- | --- |
| `corehub.catalog.schema.json` | Public read-only catalog consumed by web, API v1, and current CLI reads. |
| `corehub.write-side.schema.json` | Authenticated marketplace state for future write-side APIs. |

Public API v1 can continue to project approved `packageVersions` and verified `artifactUploads` into the existing catalog shape.

## API Contract Draft

The future authenticated API should expose these resources under a new versioned write surface:

| Endpoint | Purpose |
| --- | --- |
| `POST /corehub/api/v2/publishers` | Reserve or claim a publisher handle. |
| `GET /corehub/api/v2/publishers/me` | Show the current actor's publisher memberships. |
| `POST /corehub/api/v2/artifacts/uploads` | Request a managed artifact upload slot. |
| `PUT /corehub/api/v2/artifacts/uploads/:id` | Upload artifact bytes with signed request metadata. |
| `POST /corehub/api/v2/artifacts/uploads/:id/verify` | Verify uploaded bytes against expected size and checksum. |
| `POST /corehub/api/v2/submissions` | Create a package submission from uploaded artifact metadata. |
| `GET /corehub/api/v2/submissions/:id` | Inspect submission status and review diagnostics. |
| `POST /corehub/api/v2/reviews/:id/approve` | Approve a submission or version for install surfaces. |
| `POST /corehub/api/v2/reviews/:id/block` | Block a submission, version, artifact, or publisher. |
| `GET /corehub/api/v2/audit/events` | List write-side audit events with target, action, actor, and pagination filters. |
| `GET /corehub/api/v2/audit/verify` | Verify the append-only audit hash chain and return the current head hash. |
| `GET /corehub/api/v2/audit/retention` | Inspect retention policy, prune cutoff, and integrity failure behavior. |
| `POST /corehub/api/v2/audit/retention/prune` | Prune only after an operator export hash is supplied. |
| `POST /corehub/api/v2/transfers` | Request package ownership transfer. |
| `POST /corehub/api/v2/install-events` | Record opt-in aggregate install telemetry. |

## CLI Contract Draft

Future CLI commands should keep the ClawHub-style dry-run habit:

```sh
corehub publisher login
corehub publisher whoami
corehub package upload request ./plugin-lab.coreblow-plugin.tgz --dry-run
corehub package upload verify ./plugin-lab.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --dry-run
corehub package submit ./plugin --dry-run
corehub package submit ./plugin-lab.coreblow-plugin.tgz --dry-run
corehub package submit ./plugin-lab.coreblow-plugin.tgz --registry https://coreblow.com/corehub --dry-run
corehub package publish ./plugin --dry-run
corehub package publish ./plugin
corehub package submit ./plugin-lab.coreblow-plugin.tgz
corehub package transfer request plugin-lab --to coreblow
```

Publishing should fail closed when package scope, publisher ownership, artifact checksum, or moderation status cannot be verified.

## Managed Artifact Upload Contract

CoreHub separates upload storage from submission review. A publisher first requests a managed upload slot, uploads bytes with signed metadata, then asks CoreHub to verify the uploaded artifact before a package submission can reference it.

| Step | Contract |
| --- | --- |
| Request upload slot | CLI or API resolves actor, publisher, package id, version, media type, size, and expected SHA-256. |
| Signed upload metadata | CoreHub returns method, URL, expiry, max byte limit, required headers, storage locator, and signature. |
| Upload bytes | Client uploads the exact artifact to the reserved storage locator. |
| Verify checksum | CoreHub reads the stored object metadata or bytes and compares size and SHA-256 before marking the artifact `verified`. |
| Submit package | Submission references only a verified artifact upload id. |

The dry-run CLI shape is:

```sh
corehub package upload request ./plugin-lab.coreblow-plugin.tgz --dry-run
corehub package upload verify ./plugin-lab.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --dry-run
corehub package upload request ./plugin-lab.coreblow-plugin.tgz --registry https://coreblow.com/corehub --dry-run
corehub package upload verify ./plugin-lab.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --registry https://coreblow.com/corehub --dry-run
```

`artifactUploads[].upload` records the signed upload contract used for a managed object. The public catalog should only expose verified artifact locators and checksums, not write-side upload signatures.

When `--registry` is provided, the CLI uses the API v2 upload boundary. Without `--registry`, it keeps the local dry-run fallback so publishers can inspect the planned payload before the hosted write API is available.

`corehub package submit <artifact> --registry <url> --dry-run` uses the verified artifact upload id for the package and version. A custom id can be passed with `--artifact-upload <id>` when the upload slot does not follow the default `artifact-<package>-<version>` shape.

## API and Storage Boundary

Phase 18 adds the server-side shape before wiring production R2 or S3 credentials. The API handler accepts the same write-side payload that the CLI dry run emits, stores uploaded bytes through a storage adapter, and verifies the stored object before a submission can reference it.

| Route | Behavior |
| --- | --- |
| `POST /corehub/api/v2/artifacts/uploads` | Validates publisher, package, artifact metadata, expected size, expected SHA-256, storage provider, and max byte limit, then returns an upload slot. |
| `PUT /corehub/api/v2/artifacts/uploads/:id` | Accepts artifact bytes for the reserved slot and writes them through the configured storage adapter. |
| `POST /corehub/api/v2/artifacts/uploads/:id/verify` | Reads the stored object, recomputes size and SHA-256, and returns a verified or rejected artifact upload record. |
| `POST /corehub/api/v2/submissions` | Accepts a verified artifact upload id and creates a pending-review package submission. |
| `POST /corehub/api/v2/reviews/:id/approve` | Approves a pending submission review and creates an `available` package version. |
| `POST /corehub/api/v2/reviews/:id/block` | Blocks a pending submission review and creates a blocked package version record for audit visibility. |

## Moderation Review Boundary

Each remote submission receives an open moderation review id. Review decisions are explicit write-side events:

| Decision | Submission result | Package version result |
| --- | --- | --- |
| `approve` | `approved` | `available` with `moderationStatus: approved` |
| `block` | `rejected` | `blocked` with `moderationStatus: blocked` |

Review approval is the first point where a submitted artifact can become installable. Blocked versions remain non-installable but auditable, preserving package/version history instead of deleting the failed submission.

The admin CLI can now call these API v2 review decisions:

```sh
corehub review approve review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub --notes "Artifact verified."
corehub review block review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub --notes "Blocked by moderation."
```

The current adapter is local and mocked for tests. Its storage key shape is already compatible with managed object storage:

```text
uploads/<publisher>/<package>/<version>/<artifact>
```

Production Worker binding now routes artifact bytes through an object-store boundary backed by `COREHUB_R2`. Local server bootstrap still uses filesystem storage for deterministic development and CI, but Worker deployments fail closed when the R2 binding is missing. The route contract, signed upload fields, checksum verification result, and artifact upload status graph remain stable.

## Projection Boundary

Approved write-side versions can now be projected into the read-only Registry API v1 shape before persistence is wired:

```text
verified artifact upload -> pending submission -> approved review -> available package version -> projected catalog entry
```

The local projection exposes approved package versions through the same public read contracts used by existing clients:

| Route | Projection behavior |
| --- | --- |
| `GET /corehub/api/v1/entries` | Returns projected catalog entries for approved versions only. |
| `GET /corehub/api/v1/packages/:id` | Returns the projected package entry. |
| `GET /corehub/api/v1/packages/:id/versions` | Returns projected available versions. |
| `GET /corehub/api/v1/packages/:id/artifact` | Returns artifact checksum, storage locator, and non-download metadata. |

Blocked versions remain write-side audit records and are intentionally excluded from projected v1 install/search surfaces.

## Persistence Adapter Boundary

Phase 23 keeps production persistence out of scope, but the local storage adapter can now persist write-side metadata to a JSON file. This gives the API boundary a durable state shape before replacing the internals with a database or object-storage metadata layer.

| State section | Contents |
| --- | --- |
| `slots` | Upload slots, signed upload metadata, expected artifact checksum, and artifact upload status. |
| `submissions` | Package submission records plus pending or decided package version previews. |
| `reviews` | Moderation review decisions and reviewer audit metadata. |
| `packageVersions` | Approved or blocked version records used by projection. |
| `auditEvents` | Append-only audit events for upload, verification, submission, review decision, and admin read actions. |
| `auditCheckpoints` | Local checkpoint records created after export-before-prune retention actions. |

The local state file uses `schemaVersion: corehub.local-state.v1`. Future production persistence should preserve this logical state model even if storage moves to SQL, KV, Durable Objects, or R2/S3 metadata.

## Audit Trail Boundary

CoreHub records audit events in the same spirit as ClawHub's general `auditLogs` and moderation event logs. Each event includes `id`, `sequence`, `actor`, `action`, `targetType`, `targetId`, `metadata`, `createdAt`, `previousHash`, and `eventHash`.

The audit trail is lightly tamper-evident. Every event hashes a canonical payload that includes its sequence number and the previous event hash. The first event uses 64 zeroes as `previousHash`, and `corehub audit verify` recomputes the chain to prove the current log has not been edited out of order.

Retention is fail-closed. If the chain is invalid, CoreHub blocks pruning and tells operators to export the current state and escalate. When retention pruning is allowed, the operator must export first; CoreHub records a checkpoint with the pruned prefix head hash and export hash so the remaining chain can still be verified.

The local API currently records:

| Action | Target |
| --- | --- |
| `artifact.upload.request` | Managed artifact upload id. |
| `artifact.upload.put` | Managed artifact upload id. |
| `artifact.upload.verify` | Managed artifact upload id. |
| `submission.create` | Package submission id. |
| `review.approve` / `review.block` | Moderation review id. |
| `submission.list` / `submission.inspect` | Submission queue or submission id. |
| `review.list` / `review.inspect` | Review queue or review id. |
| `audit.list` | Audit query target or filter. |
| `audit.verify` | Audit chain verification read. |
| `audit.retention.inspect` | Retention policy and prune plan read. |
| `audit.retention.prune` | Export-backed retention prune checkpoint. |

Operators can inspect the trail through the read-only CLI surface:

```sh
corehub audit list --target review-plugin-lab-0-1-0 --limit 20 --registry http://127.0.0.1:8787/corehub
corehub audit list --action review.approve --limit 20 --registry http://127.0.0.1:8787/corehub
corehub audit list --action review.approve --actor github:coreblow-admin --target-type review --format jsonl --output ./review-approvals.audit.jsonl --registry http://127.0.0.1:8787/corehub
corehub audit verify --registry http://127.0.0.1:8787/corehub
corehub audit incident report --format markdown --output ./audit-incident.md --registry http://127.0.0.1:8787/corehub
npm run audit:incident -- --registry http://127.0.0.1:8787/corehub --output ./audit-incident.md
corehub audit retention --dry-run --registry http://127.0.0.1:8787/corehub
corehub audit retention --prune --output ./audit-retention.audit.jsonl --registry http://127.0.0.1:8787/corehub
```

For enterprise export examples, see `docs/audit-runbook.md`. For `fail_closed` handling, see `docs/audit-incident-response.md`.

## Server Bootstrap

Phase 24 adds a production-ish local API server entrypoint:

```sh
npm run serve
```

Defaults:

| Setting | Default |
| --- | --- |
| `COREHUB_HOST` | `127.0.0.1` |
| `COREHUB_PORT` | `8787` |
| `COREHUB_DATA_ROOT` | `.corehub-local` |
| `COREHUB_STATE_PATH` | `.corehub-local/write-side-state.json` |
| `COREHUB_STORAGE_ROOT` | `.corehub-local/storage` |
| `COREHUB_PUBLIC_BASE_URL` | `https://coreblow.com/corehub` |
| `COREHUB_AUDIT_RETENTION_DAYS` | `365` |

This lets the upload, submit, review, and projected Registry API v1 flow run over HTTP without a test harness while still keeping production R2/S3 and database persistence out of scope.

## Local Publish Smoke

Phase 26 adds an end-to-end smoke script for the local server:

```sh
npm run smoke:local-publish
```

The smoke starts a local server on an ephemeral port, logs in with local test credentials, requests and verifies an upload slot, submits the package, approves the moderation review, and checks the projected Registry API v1 package entry.

For the manual command sequence, see `docs/local-publish-runbook.md`.
