# CoreHub

CoreHub is the CoreBlow skill and plugin directory.

## Overview

CoreHub is part of the CoreBlow public repository family. It stores the public directory contract for CoreBlow skills, plugins, providers, channels, review metadata, and compatibility information.

The current implementation is a local-first directory core: catalog validation, deterministic search, skill folder inspection, and format documentation. Hosted web/API surfaces can build on the same model without changing the directory contract.

## Repository Role

- Phase: 2
- Priority: ecosystem
- Kind: directory
- Family: CoreBlow public repository family
- Branding: CoreBlow

## Scope

- Catalog entries for skills, plugins, providers, and channels.
- Directory validation and duplicate detection.
- Deterministic local search.
- Skill folder inspection and fingerprinting.
- Compatibility metadata for CoreBlow releases.
- Review state metadata for verified and deprecated entries.

## Out of Scope

- Bundled plugin source code.
- A package registry mirror.
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

### CLI

```sh
npm run corehub -- validate
npm run corehub -- list
npm run corehub -- list --kind skill
npm run corehub -- search plugin
npm run corehub -- inspect fixtures/example-skill
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

See [Skill Format](docs/skill-format.md), [Plugin Format](docs/plugin-format.md), and [Directory API](docs/directory-api.md).

## Public Web Surface

CoreHub is published under the main CoreBlow website:

```text
https://coreblow.com/corehub
```

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
