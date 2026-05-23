# CoreHub Production Persistence

CoreHub write-side state now uses an explicit persistence boundary.

## Adapter Contract

The API storage layer owns write-side behavior, while a state store owns durable persistence.

Current state store:

| Store | Purpose |
| --- | --- |
| `CoreHubLocalJsonStateStore` | Local JSON persistence for development, smoke tests, and single-node bootstrap deployments. |
| `CoreHubSnapshotStateStore` | Generic production-style full-snapshot adapter for mocked DB, KV, or future managed stores. |
| `CoreHubD1StateStore` | Cloudflare D1-style snapshot adapter skeleton for future Worker deployments. |

The state store contract is intentionally small:

| Method | Contract |
| --- | --- |
| `load()` | Return a `corehub.local-state.v1` snapshot or `null` when no state exists. |
| `save(snapshot)` | Persist the full write-side snapshot and return it. |

## Production Direction

Production DB, D1, or Postgres adapters should implement the same `load()` and `save(snapshot)` boundary first. Later phases can replace full-snapshot persistence with table-level writes without changing the API or CLI flow.

Required behavior for any production store:

1. Preserve `schemaVersion`.
2. Preserve audit event ordering and hash-chain fields.
3. Persist upload slots, submissions, reviews, package versions, audit events, and audit checkpoints.
4. Fail closed on unsupported schema versions.
5. Provide backup/export before destructive migrations.

## Backup And Restore Contract

Use the snapshot tool before migrations, destructive schema changes, or state-store adapter swaps:

```sh
npm run persistence:snapshot -- export --input .corehub-local/write-side-state.json --output .corehub-backups/write-side-state.backup.json
npm run persistence:snapshot -- validate --input .corehub-backups/write-side-state.backup.json
npm run persistence:snapshot -- restore --input .corehub-backups/write-side-state.backup.json --output .corehub-local/write-side-state.json --dry-run
```

Restore is dry-run by default unless `--apply` is provided:

```sh
npm run persistence:snapshot -- restore --input .corehub-backups/write-side-state.backup.json --output .corehub-local/write-side-state.json --apply
```

The tool validates:

| Check | Purpose |
| --- | --- |
| `schemaVersion` | Blocks unsupported snapshot versions. |
| Collection shape | Ensures slots, submissions, reviews, package versions, audit events, and audit checkpoints are arrays. |
| Audit chain shape | Ensures audit sequence and `previousHash` continuity can be inspected before restore. |
| Export hash | Reports a SHA-256 for backup custody records. |

The full operator flow is documented in [State Export And Import Runbook](state-export-import-runbook.md).

## Migration Versioning Contract

Inspect the current persistence version and migration list:

```sh
npm run persistence:snapshot -- current
npm run persistence:snapshot -- migrations
```

Run migration planning with a validated backup:

```sh
npm run persistence:snapshot -- migrate --input .corehub-local/write-side-state.json --backup .corehub-backups/write-side-state.backup.json --dry-run
```

Apply only after the dry-run plan confirms both the input snapshot and backup are valid:

```sh
npm run persistence:snapshot -- migrate --input .corehub-local/write-side-state.json --backup .corehub-backups/write-side-state.backup.json --apply
```

The current baseline migration is `2026-05-22-corehub-local-state-v1`, which establishes `corehub.persistence.v1` over `corehub.local-state.v1`. It is reported as `already_applied` for existing v1 snapshots, but still requires a valid backup before apply.

## D1 Skeleton

`CoreHubD1StateStore` stores the current full snapshot under a single key while the API contract is still stabilizing. This is deliberately conservative: it gives production-like persistence without changing upload, submit, approve, audit, or projection behavior.

Migration skeleton:

```sql
CREATE TABLE IF NOT EXISTS corehub_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Generate, plan, and apply the D1 migration through the checked-in helper:

```sh
npm run persistence:d1 -- sql
npm run persistence:d1 -- apply --config ops/cloudflare/wrangler.corehub-api.production.toml --dry-run
npm run persistence:d1 -- apply --config ops/cloudflare/wrangler.corehub-api.production.toml --apply
```

The helper is fail-closed: `apply` is dry-run unless `--apply` is present, and production apply refuses placeholder D1 database ids. The deploy workflow runs the dry run during production checks and applies the migration immediately before `wrangler deploy`.

Future phases can split this snapshot into normalized tables for artifact uploads, submissions, reviews, package versions, audit events, and audit checkpoints.

## Bootstrap Selection

The server still defaults to local JSON:

```sh
COREHUB_STATE_STORE=local-json \
COREHUB_STATE_PATH=.corehub-local/write-side-state.json npm run serve
```

This keeps local development and CI deterministic while the production persistence adapter is introduced.

D1 is opt-in and requires the runtime to pass a D1 binding object into the server bootstrap. Shell env alone is not enough because `COREHUB_D1` must be a Worker binding object:

```sh
COREHUB_STATE_STORE=d1 \
COREHUB_D1_STATE_KEY=write-side-state \
COREHUB_D1_STATE_TABLE=corehub_state
```

For Cloudflare Worker deployments, bind the database as `COREHUB_D1`, artifact storage as `COREHUB_R2`, and a signing secret as `COREHUB_SIGNING_SECRET`. The Worker entrypoint in `src/worker.mjs` passes `env.COREHUB_D1` into the same state-store bootstrap used by the local server, uses `env.COREHUB_R2` for uploaded artifact bytes, and signs artifact read URLs with `COREHUB_SIGNING_KEY_ID`.

Deploy from the placeholder config:

```sh
wrangler deploy --config ops/cloudflare/wrangler.corehub-api.persistence.example.toml
```

Before deploying, run the Worker-local smoke:

```sh
npm run smoke:persistence-migration
npm run smoke:worker-local
```

`smoke:persistence-migration` applies the D1 schema to a mock D1 binding and verifies a save/load round trip for the `write-side-state` snapshot. `smoke:worker-local` invokes `src/worker.mjs` through the Fetch API with mock D1 and R2 bindings, uploads and verifies an artifact, approves the review, checks the projected v1 registry response, and reads the artifact back through a signed download URL.

Then run the deploy readiness gate before `wrangler deploy`:

```sh
npm run validate:deploy-template
COREHUB_SIGNING_SECRET=replace-with-operator-managed-secret npm run validate:deploy
```

`validate:deploy-template` keeps the committed Wrangler template from drifting. `validate:deploy` is the operator preflight: it fails when D1/R2 bindings are missing, `COREHUB_SIGNING_SECRET` is absent, `COREHUB_SIGNING_KEY_ID` is invalid, `COREHUB_PUBLIC_BASE_URL` is not HTTPS, or the D1 database id is still a placeholder.

For the full deploy dry-run wrapper, run:

```sh
COREHUB_SIGNING_SECRET=replace-with-operator-managed-secret npm run deploy:worker:check
```

The wrapper runs production readiness, the Worker-local smoke, and `wrangler deploy --dry-run` when Wrangler is installed. Use `npm run deploy:worker:check -- --require-wrangler` to fail when Wrangler is missing. CI uses `npm run deploy:worker:check -- --template --skip-wrangler` to exercise the wrapper without real production secrets.

To materialize a production config from the template:

```sh
npm run deploy:worker:materialize -- --database-id <cloudflare-d1-database-id>
wrangler secret put COREHUB_SIGNING_SECRET --config ops/cloudflare/wrangler.corehub-api.production.toml
COREHUB_SIGNING_SECRET=replace-with-operator-managed-secret npm run deploy:worker:check -- --config ops/cloudflare/wrangler.corehub-api.production.toml --require-wrangler
wrangler deploy --config ops/cloudflare/wrangler.corehub-api.production.toml
```

The generated `ops/cloudflare/wrangler.corehub-api.production.toml` is ignored by git because it contains environment-specific resource ids. Re-run materialization with `--force` when replacing an existing local production config.

After the real deploy finishes, run the post-deploy smoke against the public CoreHub route:

```sh
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab
```

The post-deploy smoke is read-only for write-side publishing state. It checks the canonical web surface at `https://coreblow.com/corehub/`, checks `/healthz` when the deployment exposes it, falls back to v1 registry discovery as the public health proof when `/healthz` is routed elsewhere, then checks the v1 package read, signed download metadata, and the default signed redirect.

To point the web smoke at another route explicitly:

```sh
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --web-url https://coreblow.com/corehub/ --verify-web --package plugin-lab
```

To also fetch the signed artifact bytes and verify the response size plus SHA-256:

```sh
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-read
```

`--verify-read` performs an artifact read and may create the normal `artifact.download.read` audit event, but it does not create upload, submission, review, or publisher mutations.

To include admin visibility in the post-deploy gate, provide an admin token and run:

```sh
COREHUB_TOKEN=<operator-token> COREHUB_USER=github:coreblow-admin npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-admin
```

The admin check calls `GET /corehub/api/v2/admin/status` and fails unless readiness is `ready` and audit integrity is valid. To also export a redacted support bundle:

```sh
COREHUB_TOKEN=<operator-token> COREHUB_USER=github:coreblow-admin npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-admin --admin-support-bundle-output ./corehub-support-bundle.json --admin-limit 20
```

The support bundle includes state store, object store, queue counts, transfer counts, install analytics totals, audit integrity, readiness, and recent queue/audit samples. It does not include signing secrets, raw client identifiers, raw IP addresses, or raw user agents.

## CoreHub Admin Web Foundation

CoreHub serves an admin web surface at `/corehub/admin`.

The current foundation intentionally stays narrow:

- Browser session gate with an operator actor id and token stored in session storage.
- Admin status and health summary from `GET /corehub/api/v2/admin/status`.
- Redacted support bundle summary from `GET /corehub/api/v2/admin/support-bundle`.
- Queue counters for submissions, reviews, ownership transfers, install analytics, audit events, and readiness checks.
- Pending submissions table from `GET /corehub/api/v2/submissions?status=pending_review`.
- Open reviews table from `GET /corehub/api/v2/reviews?status=open`.

Approve, block, assignment, and evidence actions remain API/CLI driven until browser auth is hardened. The page sends `x-corehub-user`, `x-corehub-token`, and `Authorization: Bearer <token>` so the API can keep using the same actor boundary as the CLI and post-deploy smoke.

Run the authenticated admin UI smoke locally with:

```sh
npm run smoke:admin-ui
```

The smoke starts a local CoreHub server, opens `/corehub/admin` with Playwright, connects as `github:coreblow-admin`, verifies the dashboard sections, and checks admin status through the browser context. CI runs the same command after the local publish and Worker-local smokes.

## CoreHub Publisher Portal Foundation

CoreHub serves a publisher self-service web surface at `/corehub/publisher`.

The current foundation covers the ClawHub-style publisher workflow through CoreHub-native API boundaries:

- Browser session gate with publisher actor id and token stored in session storage.
- Whoami, role status, and publisher memberships from `GET /corehub/api/v2/publisher/dashboard`.
- Owned package list with latest version, marketplace channel, and trusted publisher status.
- Publisher claim form through `POST /corehub/api/v2/publishers/claim`.
- Artifact upload and package submission form through upload slot, artifact verify, and submission APIs.
- Submission status tracking for packages owned by the signed-in publisher.
- Ownership transfer request and transfer status table.

Run the authenticated publisher UI smoke locally with:

```sh
npm run smoke:publisher-ui
```

The smoke starts a local CoreHub server, opens `/corehub/publisher` with Playwright, connects as `github:coreblow-admin`, verifies the publisher dashboard sections, and checks `GET /corehub/api/v2/publisher/dashboard` through the browser context.

## Operator Smoke Workflow

CoreHub also has a scheduled/manual operator smoke workflow at `.github/workflows/operator-smoke.yml`.

The workflow follows the ClawHub operator pattern:

- `workflow_dispatch` for manual checks.
- `schedule` for recurring production confidence checks.
- GitHub environment `Production`.
- `COREHUB_TOKEN` secret for admin API access.
- `COREHUB_USER` variable for audit actor attribution.
- `actions/upload-artifact@v7` for the post-deploy smoke output and redacted support bundle.

Run it manually from GitHub Actions when checking production after deploy, or let the schedule exercise the same read-only path. The workflow runs:

```sh
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-admin --admin-support-bundle-output <artifact> --admin-limit 20
```

Set `verify_read` on manual runs when the operator wants the workflow to fetch signed artifact bytes and verify SHA-256. The default scheduled run avoids artifact byte reads and only checks web, API, signed metadata, redirect, admin readiness, audit integrity, and the support bundle.

## Production Deploy Workflow

CoreHub has a manual production deploy workflow at `.github/workflows/deploy.yml`.

The workflow follows the ClawHub production deploy shape:

- `workflow_dispatch` only.
- Main branch guard.
- GitHub environment `Production`.
- `check` mode for production preflight and Wrangler dry run.
- `deploy` mode for real `wrangler deploy`.
- Post-deploy smoke with admin visibility and a redacted support bundle.
- Artifact upload for deploy logs, post-deploy smoke output, support bundle, and the materialized Wrangler config.

Required GitHub configuration:

| Name | Kind | Purpose |
| --- | --- | --- |
| `COREHUB_D1_DATABASE_ID` | variable or workflow input | Production Cloudflare D1 database id. |
| `COREHUB_USER` | variable | Audit actor for admin smoke, for example `github:coreblow-admin`. |
| `COREHUB_SIGNING_SECRET` | secret | HMAC signing secret for artifact reads. |
| `COREHUB_TOKEN` | secret | Operator token for admin status/support-bundle smoke. |
| `CLOUDFLARE_API_TOKEN` | secret | Wrangler authentication. |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Cloudflare account used by Wrangler. |

Run `mode=check` before a real deploy. Run `mode=deploy` only after the check passes and the production environment approval is complete.

In `deploy` mode the workflow applies the idempotent D1 schema migration before deploying the Worker. Keep `mode=check` as the required preflight so the migration plan, Worker-local smoke, and Wrangler dry run are visible before production approval.

## Production Rollback

Rollback is documented in [Production Rollback](production-rollback.md).

The short version:

1. Capture a support bundle and current smoke output.
2. Redeploy the last known good Worker revision through the protected deploy workflow.
3. Restore state only from a validated snapshot or approved D1 backup.
4. Verify admin readiness, audit integrity, public registry reads, signed download metadata, and artifact reads when intentionally enabled.

## Security Gate Workflows

CoreHub mirrors the ClawHub repo-level security gates with:

| Workflow | Purpose |
| --- | --- |
| `.github/workflows/secret-scan.yml` | Runs TruffleHog verified-only secret scanning on pushes and pull requests. |
| `.github/workflows/codeql-light.yml` | Runs focused CodeQL profiles for API/Worker code, CLI/scripts, and GitHub Actions. |

`CodeQL Light` also runs on a daily schedule and can be run manually with a single profile when reviewing a narrow surface.

## Package Publish Workflow

CoreHub exposes a reusable package publish workflow at `.github/workflows/package-publish.yml`.

The workflow follows the ClawHub reusable publish pattern, but stays fail-closed while CoreHub write-side publishing is still staged:

- `workflow_call` entrypoint for package repos.
- Caller repo checkout plus OIDC-based checkout of the exact CoreHub workflow source revision.
- `dry_run: true` by default.
- Local `corehub package submit <source> --dry-run` by default, with no production mutation.
- Optional `remote_dry_run: true` for explicit API v2 submission exercises. This requires `secrets.corehub_token` because it can create pending review state.
- `dry_run: false` fails until production write-side publishing is intentionally opened.
- JSON output and an uploaded `corehub-package-submit.json` artifact for downstream review.

Example caller workflow:

```yaml
jobs:
  corehub-package-publish:
    uses: coreblow/corehub/.github/workflows/package-publish.yml@main
    with:
      source: ./dist/plugin-lab-0.1.0.coreblow-plugin.tgz
      publisher: coreblow
      dry_run: true
```

Use `remote_dry_run: true` only from protected branches or release workflows that are allowed to create pending review records in CoreHub.

## CLI NPM Release Workflow

CoreHub has a manual CLI npm release workflow at `.github/workflows/corehub-cli-npm-release.yml`.

The workflow follows the ClawHub CLI release shape:

- `workflow_dispatch` with a release tag input.
- `preflight_only: true` by default.
- Tag checkout from `refs/tags/<tag>`.
- npm registry setup with Node 22.
- package metadata and tag validation with `scripts/corehub-cli-npm-release-check.mjs`.
- release gates before packing: `npm test`, `npm run validate:ops`, `npm run validate:schema`, `npm run validate:write-schema`, and `npm run validate:deploy-template`.
- prepared npm tarball upload as `corehub-cli-npm-preflight-<tag>`.
- real publish requires `preflight_run_id`, `main`, the `npm-release` environment, OIDC trusted publishing, and provenance.

The current package is still marked `private: true`, so real publish fails closed in `scripts/corehub-cli-npm-publish.sh` until an operator explicitly approves opening the CLI package for npm release. Use the workflow in preflight mode to validate a future tag without publishing.

The placeholder config is in `ops/cloudflare/wrangler.corehub-api.persistence.example.toml`.

The production environment template is in `ops/corehub-api.production.env.example`.

| Env | Default | Purpose |
| --- | --- | --- |
| `COREHUB_STATE_STORE` | `local-json` | Selects `local-json` or `d1`. |
| `COREHUB_STATE_PATH` | `.corehub-local/write-side-state.json` | Local JSON snapshot path. |
| `COREHUB_D1_STATE_KEY` | `write-side-state` | D1 row key for the full snapshot. |
| `COREHUB_D1_STATE_TABLE` | `corehub_state` | D1 table used by `CoreHubD1StateStore`. |
| `COREHUB_R2_BUCKET_NAME` | `COREHUB_R2` | Human-readable bucket label reported in uploaded artifact metadata. |
| `COREHUB_SIGNING_SECRET` | none in Worker | Required HMAC secret for signed artifact read URLs. |
| `COREHUB_SIGNING_KEY_ID` | `primary` in Worker | Current signing key id included in signed read URLs for rotation. |
| `COREHUB_SIGNING_PREVIOUS_SECRETS` | unset | Optional comma-separated `keyId:secret` rotation placeholder accepted for old read URLs. |
| `COREHUB_PUBLIC_BASE_URL` | `https://coreblow.com/corehub` | Public registry URL used in upload contracts. |
| `COREHUB_AUDIT_RETENTION_DAYS` | `365` | Audit retention window before prune planning. |
| `COREHUB_ADMIN_ACTORS` | `github:coreblow-admin,moderator:corehub` | Comma-separated actor ids allowed to inspect queues, decide reviews, read audit evidence, and run retention actions. |
| `COREHUB_ANALYTICS_SALT` | `corehub-local-analytics-salt` locally | Salt used to hash optional install analytics client ids before storage. |
