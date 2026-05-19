# CoreHub Directory API

CoreHub currently provides a local directory contract. The same model is intended to back future API and web surfaces.

## Local Commands

```sh
npm run corehub -- validate
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- inspect fixtures/example-skill
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
