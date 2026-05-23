# CoreHub Production Rollback

Rollback is intentionally conservative: preserve the audit chain, keep artifact bytes intact, and restore write-side metadata only from a validated snapshot.

## When To Roll Back

Use rollback when a deploy causes any of these:

- `smoke:post-deploy` fails after a successful previous deploy.
- `GET /corehub/api/v2/admin/status` reports readiness other than `ready`.
- Audit verification reports `valid: false`.
- D1 state cannot load or save the `write-side-state` row.
- Signed artifact download metadata or read verification regresses.

## Before Rollback

Collect current evidence:

```sh
COREHUB_TOKEN=<operator-token> COREHUB_USER=github:coreblow-admin \
npm run smoke:post-deploy -- \
  --registry https://coreblow.com/corehub \
  --package plugin-lab \
  --verify-admin \
  --admin-support-bundle-output ./corehub-support-bundle.rollback.json
```

Export or capture the current state before replacing it. If the audit chain is invalid, keep the current snapshot for incident review and do not prune.

Before a planned production change, rehearse the rollback path locally:

```sh
npm run drill:production
```

The rehearsal exports a snapshot, validates the backup, performs restore dry run and apply checks, then runs the persistence migration and Worker-local smokes.

## Code Rollback

Redeploy the last known good Worker revision from the protected deploy workflow. Run the workflow in `check` mode first, then `deploy` after production approval.

The deploy workflow applies the D1 schema migration before deploy. The migration is idempotent (`CREATE TABLE IF NOT EXISTS`) and should remain safe during rollback.

## State Rollback

Only restore state from a validated snapshot:

```sh
npm run persistence:snapshot -- validate --input .corehub-backups/write-side-state.<timestamp>.json
npm run persistence:snapshot -- restore \
  --input .corehub-backups/write-side-state.<timestamp>.json \
  --output .corehub-local/write-side-state.json \
  --dry-run
```

Apply only after the dry run reports `restore_planned`:

```sh
npm run persistence:snapshot -- restore \
  --input .corehub-backups/write-side-state.<timestamp>.json \
  --output .corehub-local/write-side-state.json \
  --apply
```

For D1 production, use the Cloudflare D1 backup or SQL import procedure approved for the environment, then verify with the same post-deploy smoke and admin support bundle export.

## After Rollback

Run:

```sh
npm run smoke:persistence-migration
npm run smoke:worker-local
COREHUB_TOKEN=<operator-token> COREHUB_USER=github:coreblow-admin \
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-admin
```

The rollback is complete only when:

- public registry reads work,
- admin readiness is `ready`,
- audit integrity is valid,
- signed download metadata works,
- artifact byte reads work when `--verify-read` is intentionally enabled.
