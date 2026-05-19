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
