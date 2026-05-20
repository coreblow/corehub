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
- `package.json`
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
```

### CLI

```sh
npm run corehub -- validate
npm run corehub -- explore
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- package explore
npm run corehub -- package inspect plugin-lab
npm run corehub -- package versions plugin-lab
npm run corehub -- inspect fixtures/example-skill
npm run corehub -- skill publish fixtures/example-skill
```

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

See [Skill Format](docs/skill-format.md), [Plugin Format](docs/plugin-format.md), [Directory API](docs/directory-api.md), and [ClawHub Parity](docs/clawhub-parity.md).

## Public Web Surface

CoreHub is published under the main CoreBlow website:

```text
https://coreblow.com/corehub
```

## Catalog Source of Truth

`catalog.json` is the canonical CoreHub directory source. The `coreblow.com` repository serves a generated copy at `https://coreblow.com/corehub/catalog.json` and checks for drift in CI.

`schemas/corehub.catalog.schema.json` is the public catalog schema.

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
