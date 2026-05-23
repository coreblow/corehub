# CoreHub Directory API

CoreHub currently provides the local registry contract. The same model backs the public web directory now and should back future hosted API, publish, install, moderation, and search surfaces.

## Local Commands

```sh
npm run corehub -- validate
npm run corehub -- explore
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- install plugin-lab
npm run corehub -- install plugin-lab --dry-run
npm run corehub -- publishers list
npm run corehub -- publishers inspect coreblow
npm run corehub -- package explore
npm run corehub -- package search plugin
npm run corehub -- package inspect plugin-lab
npm run corehub -- package versions plugin-lab
npm run corehub -- package files plugin-lab
npm run corehub -- package artifact plugin-lab
npm run corehub -- package download plugin-lab
npm run corehub -- package download plugin-lab --output plugin-lab.coreblow-plugin.tgz
npm run corehub -- package install plugin-lab
npm run corehub -- package install plugin-lab --output plugin-lab.coreblow-plugin.tgz
npm run corehub -- review approve review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- review block review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- inspect fixtures/example-skill
npm run corehub -- skill publish fixtures/example-skill
```

Run the local API server with persisted JSON write-side state:

```sh
npm run serve
```

By default it listens at `http://127.0.0.1:8787/corehub`, writes metadata to `.corehub-local/write-side-state.json`, and stores uploaded artifact bytes under `.corehub-local/storage`.

Run the full local publish smoke:

```sh
npm run smoke:local-publish
```

For manual steps, see `docs/local-publish-runbook.md`.

Use the hosted Registry API v1 by passing `--registry`:

```sh
npm run corehub -- explore --registry https://coreblow.com/corehub
npm run corehub -- search plugin --registry https://coreblow.com/corehub
npm run corehub -- install plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- install plugin-lab --dry-run --registry https://coreblow.com/corehub
npm run corehub -- publishers list --registry https://coreblow.com/corehub
npm run corehub -- publishers inspect coreblow --registry https://coreblow.com/corehub
npm run corehub -- package inspect plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package versions plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package files plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package artifact plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package download plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package download plugin-lab --output plugin-lab.coreblow-plugin.tgz --registry https://coreblow.com/corehub
npm run corehub -- package install plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package install plugin-lab --output plugin-lab.coreblow-plugin.tgz --registry https://coreblow.com/corehub
npm run corehub -- registry info --registry https://coreblow.com/corehub
```

## Canonical Catalog

`catalog.json` in this repository is the canonical directory source. The public website serves a generated copy at:

```text
https://coreblow.com/corehub/catalog.json
```

The `coreblow.com` CI checks that its generated copy matches this catalog.

## Public Schema

The catalog contract is described by:

```text
schemas/corehub.catalog.schema.json
```

Validate the catalog against the schema with:

```sh
npm run validate:schema
```

## Public Record

Directory records expose:

- `id`
- `kind`
- `name`
- `summary`
- `source`
- `homepage`
- `version`
- `tags`
- `capabilities`
- `review`
- `coreblow`
- `publisher`

Publisher records expose:

- `handle`
- `displayName`
- `url`
- `verified`
- `contact`

## Registry API v1

CoreHub exposes the first public read API under:

```text
https://coreblow.com/corehub/api/v1
```

The v1 API is static-catalog backed. It is intentionally read-only until publisher identity, version storage, moderation, and write-side registry flows land.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/corehub/api/v1` | API discovery document. |
| `GET` | `/corehub/api/v1/catalog` | Full catalog records. |
| `GET` | `/corehub/api/v1/entries` | Entry list, optionally filtered by `kind`. |
| `GET` | `/corehub/api/v1/entries/:id` | Inspect one catalog entry. |
| `GET` | `/corehub/api/v1/search?q=<query>` | Search entries by id, kind, name, summary, tags, capabilities, platforms, and review state. |
| `GET` | `/corehub/api/v1/packages` | ClawHub-style package list alias over the catalog. |
| `GET` | `/corehub/api/v1/packages/search?q=<query>` | ClawHub-style package search alias. |
| `GET` | `/corehub/api/v1/publishers` | List publishers represented in the catalog. |
| `GET` | `/corehub/api/v1/publishers/:handle` | Inspect one publisher and its catalog entries. |
| `GET` | `/corehub/api/v1/packages/:id` | Inspect one package-compatible entry. |
| `GET` | `/corehub/api/v1/packages/:id/versions` | Return publisher-owned version metadata. |
| `GET` | `/corehub/api/v1/packages/:id/files` | Return file metadata from the artifact manifest. |
| `GET` | `/corehub/api/v1/packages/:id/artifact` | Return artifact manifest metadata, checksum, provenance, storage locator, and download policy. |
| `GET` | `/corehub/api/v1/packages/:id/download` | Return a signed storage redirect, or signed download metadata with `redirect=false`. |
| `GET` | `/corehub/api/v1/packages/:id/moderation` | Return package review state, latest-version download block state, and moderation reasons. |
| `GET` | `/corehub/api/v1/packages/:id/readiness` | Return marketplace readiness checks for publisher, version, artifact, source, compatibility, and moderation state. |
| `GET` | `/corehub/api/v1/download?id=<id>` | Top-level signed download alias. |

### Response Shape

All v1 responses return:

```json
{
  "apiVersion": "v1",
  "data": [],
  "meta": {
    "count": 0
  }
}
```

The response shape is designed for CoreBlow CLI use and can be backed by a database later without changing URLs.

Download endpoints support storage-backed signed redirects. The default response is a `302` to the artifact storage URL; CLI clients use `redirect=false` to inspect the signed contract before fetching bytes.

The CLI can perform a verified artifact fetch with `corehub package download <id> --output <path>`. Verified downloads write the artifact only after checking byte size and SHA-256 against the artifact manifest.

The OpenClaw-style user command is `corehub install <id>`. It is the intended install entrypoint, while `corehub package install <id> --dry-run` remains the technical planner. CoreHub now publishes the `plugin-lab` version as an installable CoreBlow plugin archive; install apply fetches and verifies the archive, then reports the CoreBlow installer handoff as blocked until the installer boundary is wired.

## Search

The local search index scores matches across id, kind, name, summary, tags, and capabilities. This is intentionally deterministic so CI can validate catalog behavior before a hosted search service exists.

## ClawHub-Compatible Command Shape

CoreHub keeps a ClawHub-style command shape so future backend work can attach to stable CLI habits:

- `corehub explore`
- `corehub install <entry-id>`
- `corehub inspect <entry-id|skill-folder>`
- `corehub skill publish <skill-folder>`
- `corehub package explore`
- `corehub package search <query>`
- `corehub package inspect <entry-id>`
- `corehub package versions <entry-id>`
- `corehub package moderation-status <entry-id>`
- `corehub package readiness <entry-id>`
- `corehub package report <entry-id> --reason <text>`
- `corehub package reports list`
- `corehub package reports triage <report-id>`
- `corehub package appeal <entry-id> --version <version> --message <text>`
- `corehub package appeals list`
- `corehub package appeals resolve <appeal-id>`
- `corehub package delete <entry-id> --yes`
- `corehub package undelete <entry-id> --yes`
- `corehub package install <entry-id>`
- `corehub package upload request <artifact|folder> --dry-run`
- `corehub package upload verify <artifact|folder> --upload-slot <id> --dry-run`
- `corehub package submit <artifact|folder> --dry-run`
- `corehub review approve <review-id> --registry <url>`
- `corehub review block <review-id> --registry <url>`
- `corehub package publish <source>`
- `corehub registry info`

Write commands currently report or perform local dry-run behavior. They must not publish remote artifacts until publisher write flows are available and release approval is explicit.

Read commands can use the hosted API with `--registry https://coreblow.com/corehub` or `COREHUB_REGISTRY=https://coreblow.com/corehub`.
