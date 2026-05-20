# CoreHub Directory API

CoreHub currently provides the local registry contract. The same model backs the public web directory now and should back future hosted API, publish, install, moderation, and search surfaces.

## Local Commands

```sh
npm run corehub -- validate
npm run corehub -- explore
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- publishers list
npm run corehub -- publishers inspect coreblow
npm run corehub -- package explore
npm run corehub -- package search plugin
npm run corehub -- package inspect plugin-lab
npm run corehub -- package versions plugin-lab
npm run corehub -- package files plugin-lab
npm run corehub -- package artifact plugin-lab
npm run corehub -- package download plugin-lab
npm run corehub -- inspect fixtures/example-skill
npm run corehub -- skill publish fixtures/example-skill
```

Use the hosted Registry API v1 by passing `--registry`:

```sh
npm run corehub -- explore --registry https://coreblow.com/corehub
npm run corehub -- search plugin --registry https://coreblow.com/corehub
npm run corehub -- publishers list --registry https://coreblow.com/corehub
npm run corehub -- publishers inspect coreblow --registry https://coreblow.com/corehub
npm run corehub -- package inspect plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package versions plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package files plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package artifact plugin-lab --registry https://coreblow.com/corehub
npm run corehub -- package download plugin-lab --registry https://coreblow.com/corehub
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
| `GET` | `/corehub/api/v1/packages/:id/versions` | Return the current static version as `latest`. |
| `GET` | `/corehub/api/v1/packages/:id/files` | Return file metadata for a package version. Currently empty until artifact storage lands. |
| `GET` | `/corehub/api/v1/packages/:id/artifact` | Return artifact metadata for a package version. Currently reports no artifact. |
| `GET` | `/corehub/api/v1/packages/:id/download` | Download a package artifact. Currently returns `501 not_implemented`. |
| `GET` | `/corehub/api/v1/download?id=<id>` | Top-level download alias. Currently returns `501 not_implemented`. |

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

Download endpoints are intentionally present before binary storage. They return structured metadata now so CLI clients can detect the contract, while write-side publishing, artifact integrity, and file storage are added later. Publisher identity is the first ownership layer; real artifact downloads should require publisher ownership, provenance, and moderation checks.

## Search

The local search index scores matches across id, kind, name, summary, tags, and capabilities. This is intentionally deterministic so CI can validate catalog behavior before a hosted search service exists.

## ClawHub-Compatible Command Shape

CoreHub keeps a ClawHub-style command shape so future backend work can attach to stable CLI habits:

- `corehub explore`
- `corehub inspect <entry-id|skill-folder>`
- `corehub skill publish <skill-folder>`
- `corehub package explore`
- `corehub package search <query>`
- `corehub package inspect <entry-id>`
- `corehub package versions <entry-id>`
- `corehub package publish <source>`
- `corehub registry info`

Commands that need a hosted registry currently report or perform local dry-run behavior. They must not publish remote artifacts until CoreHub Registry API v1 is available and release approval is explicit.

Read commands can use the hosted API with `--registry https://coreblow.com/corehub` or `COREHUB_REGISTRY=https://coreblow.com/corehub`.
