# CoreHub

CoreHub is the public skill and plugin registry for CoreBlow.

## Overview

CoreHub is part of the CoreBlow public repository family. It is the CoreBlow counterpart to ClawHub: publish, version, search, inspect, and review CoreBlow skills, plugins, providers, channels, and compatibility metadata.

The current implementation is the registry foundation: catalog validation, deterministic search, skill folder inspection, command-shape parity, and a hosted public directory at `https://coreblow.com/corehub`. The next implementation phases add the backend registry API, publisher identity, versioning, moderation, and install/update flows.

## Repository Role

- Phase: 2
- Priority: ecosystem
- Kind: directory
- Family: CoreBlow public repository family
- Branding: CoreBlow

## Scope

- Browse skills and plugins with CoreBlow compatibility metadata.
- Publish and version skill entries with changelogs and latest tags.
- Publish code-plugin and bundle-plugin packages through registry APIs.
- Search skills and packages through CLI-friendly and web-friendly APIs.
- Inspect entries, files, versions, review status, and compatibility data.
- Manage local install/update flows from the CoreBlow CLI.
- Support publisher identity, ownership, transfer, moderation, and review flows.
- Track safe aggregate install/download metadata.

## Out of Scope

- Bundled plugin source code.
- A paid marketplace.
- A replacement for `coreblow/coreblow` `extensions/*`.

## Key Files

- `.gitignore`
- `catalog.json`
- `docs/skill-format.md`
- `docs/plugin-format.md`
- `docs/directory-api.md`
- `docs/publisher-identity.md`
- `docs/write-side-schema.md`
- `package.json`
- `schemas/corehub.write-side.schema.json`
- `src/catalog.mjs`
- `src/cli.mjs`
- `src/corehub.mjs`
- `test/catalog.test.mjs`
- `.github/CODEOWNERS`
- `.github/dependabot.yml`
- `.github/ISSUE_TEMPLATE/bug_report.yml`

## Development

### Test

```sh
npm test
```

### Validate Schema

```sh
npm run validate:schema
npm run validate:write-schema
```

### Local API Server

```sh
npm run serve
```

The local server defaults to `http://127.0.0.1:8787/corehub`, persists write-side state under `.corehub-local/write-side-state.json`, and stores uploaded bytes under `.corehub-local/storage`. Override with `COREHUB_PORT`, `COREHUB_DATA_ROOT`, `COREHUB_STATE_PATH`, `COREHUB_STORAGE_ROOT`, and `COREHUB_PUBLIC_BASE_URL`.

Run the local publish smoke:

```sh
npm run smoke:local-publish
```

See `docs/local-publish-runbook.md` for the manual command flow.

### CLI

```sh
npm run corehub -- validate
npm run corehub -- explore
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- login --token local-dev-token --user github:coreblow-admin --publisher coreblow
npm run corehub -- whoami
npm run corehub -- publisher claim example-org --dry-run
npm run corehub -- package explore
npm run corehub -- package inspect plugin-lab
npm run corehub -- package versions plugin-lab
npm run corehub -- package upload request artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --dry-run
npm run corehub -- package upload verify artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --dry-run
npm run corehub -- package upload request artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --registry https://coreblow.com/corehub --dry-run
npm run corehub -- package upload verify artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --registry https://coreblow.com/corehub --dry-run
npm run corehub -- package submit fixtures/plugin-lab-plugin --dry-run
npm run corehub -- package submit artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --dry-run
npm run corehub -- package submit artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --registry https://coreblow.com/corehub --dry-run
npm run corehub -- review approve review-plugin-lab-0-1-0 --registry https://coreblow.com/corehub --notes "Artifact verified."
npm run corehub -- review block review-plugin-lab-0-1-0 --registry https://coreblow.com/corehub --notes "Blocked by moderation."
npm run corehub -- inspect fixtures/example-skill
npm run corehub -- skill publish fixtures/example-skill
```

CoreHub also exposes a server-side upload and review boundary for future R2/S3-backed publishing. The current implementation keeps storage local/mocked for tests while preserving the API contract for `POST /corehub/api/v2/artifacts/uploads`, signed `PUT /corehub/api/v2/artifacts/uploads/:id`, `POST /corehub/api/v2/artifacts/uploads/:id/verify`, `POST /corehub/api/v2/submissions`, and `POST /corehub/api/v2/reviews/:id/approve|block`.

Approved write-side package versions can be projected into the read-only Registry API v1 shape from local state. Blocked versions stay out of projected install/search surfaces.

The local write-side adapter can persist upload slots, submissions, moderation reviews, and package versions to a JSON state file before production database or object-storage metadata persistence lands.

Use production Registry API v1:

```sh
npm run corehub -- search plugin --registry https://coreblow.com/corehub
npm run corehub -- registry info --registry https://coreblow.com/corehub
```

## Directory Model

CoreHub entries use these kinds:

- `skill`
- `plugin`
- `provider`
- `channel`

Review states:

- `draft`
- `review`
- `verified`
- `deprecated`

See [Skill Format](docs/skill-format.md), [Plugin Format](docs/plugin-format.md), [Directory API](docs/directory-api.md), [Publisher Identity](docs/publisher-identity.md), [Write-Side Schema](docs/write-side-schema.md), and [ClawHub Parity](docs/clawhub-parity.md).

## Public Web Surface

CoreHub is published under the main CoreBlow website:

```text
https://coreblow.com/corehub
```

## Catalog Source of Truth

`catalog.json` is the canonical CoreHub directory source. The `coreblow.com` repository serves a generated copy at `https://coreblow.com/corehub/catalog.json` and checks for drift in CI.

`schemas/corehub.catalog.schema.json` is the public catalog schema.

`schemas/corehub.write-side.schema.json` is the planned authenticated marketplace schema for future publisher writes. It is intentionally separate from the read-only catalog schema so Registry API v1 stays stable while API v2 publishing work is built.

## Release Policy

Do not publish packages, tags, installers, or release artifacts from this repository without explicit CoreBlow release approval.

Version changes must follow the coordinated CoreBlow release plan.

## Links

- [CoreBlow](https://github.com/coreblow/coreblow)
- [CoreHub Web](https://coreblow.com/corehub)
- [Documentation](https://docs.coreblow.com)
- [Website](https://coreblow.com)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
