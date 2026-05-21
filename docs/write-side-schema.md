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
corehub package publish ./plugin --dry-run
corehub package publish ./plugin
corehub package submit ./plugin-lab.coreblow-plugin.tgz
corehub package transfer request plugin-lab --to coreblow
```

Publishing should fail closed when package scope, publisher ownership, artifact checksum, or moderation status cannot be verified.
