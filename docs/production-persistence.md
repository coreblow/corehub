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
npm run smoke:worker-local
```

The smoke invokes `src/worker.mjs` through the Fetch API with mock D1 and R2 bindings, uploads and verifies an artifact, approves the review, checks the projected v1 registry response, and reads the artifact back through a signed download URL.

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
