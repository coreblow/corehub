# CoreHub State Export And Import Runbook

Use this runbook before persistence migrations, D1 adapter changes, emergency restore, or production rollback.

## Export

Create a custody directory outside the live state path:

```sh
mkdir -p .corehub-backups
npm run persistence:snapshot -- export \
  --input .corehub-local/write-side-state.json \
  --output .corehub-backups/write-side-state.$(date -u +%Y%m%dT%H%M%SZ).json
```

Validate the exported snapshot:

```sh
npm run persistence:snapshot -- validate --input .corehub-backups/write-side-state.<timestamp>.json
```

Record the reported SHA-256 with the deploy or incident ticket. The snapshot contains write-side metadata and audit events; treat it as operational data.

## Import Dry Run

Restore is dry-run by default. Always run a dry run first:

```sh
npm run persistence:snapshot -- restore \
  --input .corehub-backups/write-side-state.<timestamp>.json \
  --output .corehub-local/write-side-state.json \
  --dry-run
```

The dry run must report `restore_planned` and valid counts before apply.

## Import Apply

Stop the writer, apply the restore, then restart:

```sh
npm run persistence:snapshot -- restore \
  --input .corehub-backups/write-side-state.<timestamp>.json \
  --output .corehub-local/write-side-state.json \
  --apply
```

After restore, run:

```sh
npm run smoke:local-publish
npm run persistence:snapshot -- validate --input .corehub-local/write-side-state.json
```

For production Worker/D1 deployments, restore should be performed through an operator-controlled D1 snapshot path or Cloudflare backup workflow first, then verified through `npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-admin`.

## Migration

Plan with a validated backup:

```sh
npm run persistence:snapshot -- migrate \
  --input .corehub-local/write-side-state.json \
  --backup .corehub-backups/write-side-state.<timestamp>.json \
  --dry-run
```

Apply only after the dry run is valid:

```sh
npm run persistence:snapshot -- migrate \
  --input .corehub-local/write-side-state.json \
  --backup .corehub-backups/write-side-state.<timestamp>.json \
  --apply
```

## D1 Schema Apply

Plan the D1 schema migration from the Wrangler config:

```sh
npm run persistence:d1 -- apply --config ops/cloudflare/wrangler.corehub-api.production.toml --dry-run
```

Apply only after the production config has a real D1 database id:

```sh
npm run persistence:d1 -- apply --config ops/cloudflare/wrangler.corehub-api.production.toml --apply
```

The deploy workflow runs the dry run in `check` mode and applies the D1 schema before `wrangler deploy` in `deploy` mode.
