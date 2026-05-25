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
| `GET` | `/corehub/api/v1/packages` | ClawHub-style package list alias with family, channel, official, featured, category, and capability filters. |
| `GET` | `/corehub/api/v1/packages/search?q=<query>` | ClawHub-style package search alias with deterministic ranking and the same discovery filters. |
| `GET` | `/corehub/api/v1/plugins` | Plugin-only package browse across CoreHub code-plugin and bundle-plugin families. |
| `GET` | `/corehub/api/v1/plugins/search?q=<query>` | Plugin-only search in relevance order. |
| `GET` | `/corehub/api/v1/publishers` | List publishers represented in the catalog. |
| `GET` | `/corehub/api/v1/publishers/:handle` | Inspect one publisher and its catalog entries. |
| `GET` | `/corehub/api/v1/packages/:id` | Inspect one package-compatible entry. |
| `GET` | `/corehub/api/v1/packages/:id/versions` | Return publisher-owned version metadata. |
| `GET` | `/corehub/api/v1/packages/:id/versions/:version/security` | Return the version-exact public security and trust summary used by install clients. |
| `GET` | `/corehub/api/v1/packages/:id/files` | Return file metadata from the artifact manifest. |
| `GET` | `/corehub/api/v1/packages/:id/file?path=<path>` | Return raw UTF-8 text content for a verified package file. Supports optional `version` or `tag`. |
| `GET` | `/corehub/api/v1/packages/:id/artifact` | Return artifact manifest metadata, checksum, provenance, storage locator, and download policy. |
| `GET` | `/corehub/api/v1/packages/:id/scan` | Return latest public static scan status for the selected package version. Supports optional `version` or `tag`. |
| `GET` | `/corehub/api/v1/packages/:id/download` | Return a signed storage redirect, or signed download metadata with `redirect=false`. |
| `GET` | `/corehub/api/v1/packages/:id/moderation` | Return package review state, latest-version download block state, and moderation reasons. |
| `GET` | `/corehub/api/v1/packages/:id/readiness` | Return marketplace readiness checks for publisher, version, artifact, source, compatibility, and moderation state. |
| `GET` | `/corehub/api/v1/download?id=<id>` | Top-level signed download alias. |
| `GET` | `/corehub/api/npm/:package` | Return an npm-compatible packument for tarball-backed CoreHub package versions. |
| `GET` | `/corehub/api/npm/:package/-/:tarball.tgz` | Redirect to the exact CoreHub signed or external tarball artifact URL. |

### Response Shape

List and search v1 responses return:

```json
{
  "apiVersion": "v1",
  "data": [],
  "meta": {
    "count": 0,
    "total": 0,
    "limit": 50,
    "offset": 0,
    "cursor": null,
    "nextCursor": null,
    "hasMore": false
  }
}
```

List and search routes support `limit` and `cursor`. Clients should pass the returned `meta.nextCursor` to continue. Existing `offset` reads remain accepted for local tooling, but cursor reads are the public compatibility path.

Public API v1 error responses follow the ClawHub-compatible plain text contract. Validation failures, missing resources, rate limits, and blocked downloads return `content-type: text/plain; charset=utf-8` with a human-readable body. For example, an invalid cursor returns `400` with `cursor must be a valid CoreHub pagination cursor`, and a moderation-blocked package download returns `403` with the moderation reason.

When edge rate limiting is enabled, responses include standard limit headers:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`
- `RateLimit-Limit`
- `RateLimit-Remaining`
- `RateLimit-Reset`
- `Retry-After` on `429` responses

Rate-limited public responses return `429` and the plain text body `Rate limit exceeded`.

The response shape is designed for CoreBlow CLI use and can be backed by a database later without changing URLs.

Download endpoints support storage-backed signed redirects. The default response is a `302` to the artifact storage URL; CLI clients use `redirect=false` to inspect the signed contract before fetching bytes.

Package file reads are limited to files listed in the artifact manifest, or files derived from a managed `.tgz` artifact when the manifest is not stored yet. File reads reject absolute or parent-relative paths, return only UTF-8 text files, and enforce a 200KB public read limit. External artifact URL mode can list manifest files, but raw file reads require managed artifact bytes.

The npm mirror is intentionally minimal. It lists only available `.tgz` package versions and emits npm-compatible `dist.tarball`, `dist.integrity`, and `dist.shasum` fields. When a SHA-1 npm shasum is not available in package metadata, `dist.shasum` is `null` and clients should verify with `dist.integrity` plus CoreHub's `dist.corehubSha256`.

The CLI can perform a verified artifact fetch with `corehub package download <id> --output <path>`. Verified downloads write the artifact only after checking byte size and SHA-256 against the artifact manifest.

CoreHub also keeps local install lifecycle state in `COREHUB_HOME/installs.json`:

```sh
corehub package install plugin-lab --registry https://coreblow.com/corehub
corehub package installed list
corehub package pin plugin-lab
corehub package update plugin-lab --registry https://coreblow.com/corehub
corehub package sync --registry https://coreblow.com/corehub
corehub package unpin plugin-lab
corehub package uninstall plugin-lab
```

Pinned packages are never overwritten by `update` or `sync`; unpin first to allow CoreHub to refresh local state. Set `COREHUB_DISABLE_TELEMETRY=1` to skip CLI analytics record writes.

Private channel packages are excluded from anonymous Registry API v1 catalog, list, search, detail, and download metadata responses. Admin actors and active members of the package publisher can read private package metadata through the same routes.

The OpenClaw-style user command is `corehub install <id>`. It is the intended install entrypoint, while `corehub package install <id> --dry-run` remains the technical planner. CoreHub now publishes the `plugin-lab` version as an installable CoreBlow plugin archive; install apply fetches and verifies the archive, then reports the CoreBlow installer handoff as blocked until the installer boundary is wired.

## Search

The local search index scores matches across id, kind, name, summary, tags, capabilities, marketplace family, channel, and plugin category. This is intentionally deterministic so CI can validate catalog behavior before a hosted search service exists.

Discovery filters match the ClawHub package marketplace shape where CoreHub can express it today:

- `family=skill|code-plugin|bundle-plugin`
- `channel=official|community|private`
- `isOfficial=true|false`
- `featured=true|false`
- `executesCode=true|false`
- `category=dev-tools|channels|security|observability|deployment|data|automation|mcp-tooling`
- `capabilityTag=<tag>`

Plugin browse aliases apply `pluginOnly=true` internally, so `/corehub/api/v1/plugins` and `/corehub/api/v1/plugins/search` only return code-plugin or bundle-plugin marketplace entries.

## ClawHub-Compatible Command Shape

CoreHub keeps a ClawHub-style command shape so future backend work can attach to stable CLI habits:

- `corehub explore`
- `corehub install <entry-id>`
- `corehub inspect <entry-id|skill-folder>`
- `corehub skill publish <skill-folder>`
- `corehub package explore`
- `corehub package search <query> [--family code-plugin] [--category dev-tools] [--capability tag] [--official]`
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
- `corehub package trusted-publisher set|get|delete <entry-id>`
- `corehub package publish-token mint|revoke <entry-id>`
- `corehub package install <entry-id>`
- `corehub package upload request <artifact|folder> --dry-run`
- `corehub package upload verify <artifact|folder> --upload-slot <id> --dry-run`
- `corehub package submit <artifact|folder> --dry-run`
- `corehub review approve <review-id> --registry <url>`
- `corehub review block <review-id> --registry <url>`
- `corehub package publish <source>`
- `corehub registry info`

Write commands keep dry-run defaults where possible. Live `corehub package publish <source> --registry <url>` creates a pending review submission; it does not bypass moderation or project directly into the public catalog.

Read commands can use the hosted API with `--registry https://coreblow.com/corehub` or `COREHUB_REGISTRY=https://coreblow.com/corehub`.
