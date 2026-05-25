# CoreHub Marketing Notes

CoreHub is the CoreBlow marketplace for skills and plugins.

## Positioning

CoreHub gives CoreBlow a production-ready registry for discovering, publishing, reviewing, moderating, and installing ecosystem packages. It follows the ClawHub product shape where users expect it, while staying CoreBlow-native in architecture, URLs, D1 persistence, external artifact storage, audit events, CLI design, and operator workflows.

## Primary Message

CoreHub is the trusted package marketplace for CoreBlow skills and plugins, built for production registry operations from day one.

## Value Props

- Discover CoreBlow skills and plugins through a public web surface and Registry API.
- Publish packages through a moderated upload, review, and release lifecycle.
- Protect users with scanner evidence, reports, appeals, quarantine, revoke, and signed download metadata.
- Support publishers with identity, organization membership, ownership transfer, trusted publishing, and a self-service portal.
- Run production safely with D1 persistence, external artifact URL storage, audit trails, support bundles, protected deploy, backup, restore, rollback, and live smoke workflows.
- Use the CLI locally or in CI for search, inspection, publishing, moderation, install state, and operator checks.

## Short Copy

CoreHub is the official CoreBlow marketplace for skills and plugins. Browse packages, publish through review, inspect scanner evidence, and install with signed metadata from `https://coreblow.com/corehub`.

## npm Copy

`@coreblow/corehub` provides the CoreHub CLI for interacting with the CoreBlow skill and plugin registry. It supports package search, registry inspection, publisher workflows, moderation operations, install state, production checks, and local development smokes.

## Launch Checklist

- CoreHub v1 accepted production baseline is tagged.
- Production live smoke passed against `https://coreblow.com/corehub`.
- Production rollback drill passed.
- npm package manifest is public-release ready.
- npm dry-run passes before live publication.
- Live npm publication runs only from the protected release workflow.

## Links

- CoreHub web: `https://coreblow.com/corehub`
- Repository: `https://github.com/coreblow/corehub`
- CoreBlow: `https://github.com/coreblow/coreblow`
- Documentation: `https://docs.coreblow.com`
