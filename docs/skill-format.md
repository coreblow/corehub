# CoreHub Skill Format

CoreHub skills are folders that package agent instructions, metadata, and optional text-based supporting files for CoreBlow.

## Required Files

- `SKILL.md`

## Optional Files

- `corehub.skill.json`
- supporting text files such as Markdown, JSON, YAML, TypeScript, shell, Python, Swift, Kotlin, and SQL
- `.corehubignore`
- `.gitignore`

Binary artifacts, private credentials, live configuration, phone numbers, private hostnames, and generated dependency folders are not accepted.

## `SKILL.md`

`SKILL.md` contains Markdown instructions for the skill. YAML frontmatter is recommended.

```yaml
---
name: calendar-ops
description: Manage calendar operations through the CoreBlow gateway.
version: 1.0.0
metadata:
  coreblow:
    requires:
      env:
        - COREBLOW_GATEWAY_TOKEN
      bins:
        - coreblow
    primaryEnv: COREBLOW_GATEWAY_TOKEN
---
```

## CoreBlow Metadata

Use `metadata.coreblow` for runtime requirements.

| Field | Type | Purpose |
| --- | --- | --- |
| `requires.env` | `string[]` | Required environment variables. |
| `requires.bins` | `string[]` | Required CLI binaries. |
| `requires.config` | `string[]` | Config files the skill expects. |
| `primaryEnv` | `string` | Main credential or token variable. |
| `platforms` | `string[]` | Supported platforms such as `linux`, `macos`, or `windows`. |
| `minCoreblowVersion` | `string` | Minimum compatible CoreBlow version. |

## `corehub.skill.json`

The optional manifest gives the directory a stable machine-readable contract.

```json
{
  "schema": "https://coreblow.com/schemas/corehub.skill.json",
  "id": "calendar-ops",
  "version": "1.0.0",
  "entrypoint": "SKILL.md"
}
```

## Review States

CoreHub directory entries use these review states:

- `draft`
- `review`
- `verified`
- `deprecated`

Verified entries must have a public GitHub source, a clear summary, declared runtime requirements, and no secret-bearing files.
