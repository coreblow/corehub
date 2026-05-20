# CoreHub Directory API

CoreHub currently provides the local registry contract. The same model backs the public web directory now and should back future hosted API, publish, install, moderation, and search surfaces.

## Local Commands

```sh
npm run corehub -- validate
npm run corehub -- explore
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- package explore
npm run corehub -- package search plugin
npm run corehub -- package inspect plugin-lab
npm run corehub -- inspect fixtures/example-skill
npm run corehub -- skill publish fixtures/example-skill
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
- `corehub package publish <source>`

Commands that need a hosted registry currently report or perform local dry-run behavior. They must not publish remote artifacts until CoreHub Registry API v1 is available and release approval is explicit.
