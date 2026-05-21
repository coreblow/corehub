# CoreHub Publisher Identity

CoreHub publisher identity is the authentication and ownership layer for future write-side registry flows.

This phase follows the ClawHub pattern:

- publishers are stable handles
- users can authenticate with a token
- organization publishers can have multiple members
- publish and transfer actions are scoped to publisher ownership
- claim and publish flows support dry-run previews before writes

## Current Contract

The CLI supports a headless token contract while browser and device login are still planned:

```sh
corehub login --token <token> --user github:<login> --publisher <handle>
corehub whoami
corehub publisher whoami --json
corehub publisher claim <handle> --dry-run
corehub logout
```

`COREHUB_TOKEN`, `COREHUB_USER`, and `COREHUB_PUBLISHER` can be used in CI or headless environments.

## Auth State

Local CLI login writes an auth state file under:

```text
~/.corehub/auth.json
```

Set `COREHUB_HOME` to use an isolated auth directory for tests or CI.

The auth state uses schema version `corehub.auth.v1` and stores:

| Field | Purpose |
| --- | --- |
| `token` | Headless CoreHub token until browser/device login lands. |
| `actor` | Authenticated user identity. |
| `defaultPublisherHandle` | Preferred publisher handle for future publish flows. |
| `createdAt` | Local auth creation timestamp. |

## Publisher Claims

`corehub publisher claim <handle> --dry-run` produces the future API payload for a publisher handle claim. It does not mutate registry state yet.

The claim maps to `publisherClaims` in `schemas/corehub.write-side.schema.json`.

## Whoami

`corehub whoami` and `corehub publisher whoami` resolve the local actor and match it against write-side publisher memberships in the fixture state.

Future API v2 will replace fixture lookup with:

```text
GET /corehub/api/v2/publishers/me
```

## Planned Follow-Up

- Browser login at `https://coreblow.com/corehub/cli/auth`.
- Device login for remote/headless terminals.
- Server-side token verification.
- Publisher claim review workflow.
- Membership management for organization publishers.
