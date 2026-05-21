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

The current adapter is local and mocked for tests. Its storage key shape is already compatible with managed object storage:

```text
uploads/<publisher>/<package>/<version>/<artifact>
```

Future production binding should replace only the adapter internals with R2 or S3 operations. The route contract, signed upload fields, checksum verification result, and artifact upload status graph should remain stable.
