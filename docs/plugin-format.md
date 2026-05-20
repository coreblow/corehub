# CoreHub Plugin Directory Format

CoreHub plugin entries describe CoreBlow plugin packages, compatibility labs, and provider or channel integrations.

Plugin source code may live in `coreblow/coreblow` under `extensions/*` or in an approved satellite repository. CoreHub records metadata; it is not a replacement for the canonical plugin source.

## Required Entry Fields

```json
{
  "id": "plugin-lab",
  "kind": "plugin",
  "name": "Plugin Lab",
  "summary": "Compatibility lab for CoreBlow community plugins and plugin API contracts.",
  "source": "https://github.com/coreblow/plugin-lab"
}
```

## Recommended Fields

- `homepage`
- `version`
- `tags`
- `capabilities`
- `review`
- `coreblow.minCoreblowVersion`
- `coreblow.platforms`
- `coreblow.requiresEnv`
- `coreblow.requiresBins`

## Directory Rules

- Use CoreBlow branding.
- Use `plugin` in public docs and UI.
- Keep `extensions/*` as an internal source path when referring to bundled plugins.
- Do not publish package versions or release artifacts from CoreHub without explicit release approval.
- Do not list private sources, secrets, private paths, phone numbers, or live hostnames.

## Installable Archive Template

Installable plugin archives should include:

- `package.json` with `coreblow.extensions` and `coreblow.install.minHostVersion`.
- `coreblow.plugin.json` with `id`, `name`, `version`, `entry`, and `configSchema`.
- The declared entry file, for example `index.js`.
- `corehub.artifact.json` with package, publisher, and install locator metadata.
- A README with safe setup notes.

CoreHub stores a sidecar `*.corehub-manifest.json` beside the archive. The sidecar records the archive checksum and per-file checksums so clients and registry APIs can compare artifact metadata without unpacking untrusted code first.
