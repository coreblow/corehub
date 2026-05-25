# CoreHub Production Release Lock - 2026-05-25

This document locks the CoreHub post-v1 production baseline after the accepted marketplace parity pass and post-v1 hardening phases.

## Release Scope

Status: locked.

Accepted baseline tag:

- `corehub-v1-accepted-2026-05-25`

Accepted scope:

- CoreHub v1 package marketplace parity.
- Post-v1 account and organization settings.
- Publisher portal hardening.
- Community moderation UI.
- Split CI/test matrix by surface.
- npm release approval with fail-closed protected publication policy.
- Production release evidence: live smoke, rollback drill, and release notes.

The npm package manifest is approved for public release readiness. This release lock does not publish npm artifacts or change package versions.

## Release Notes

CoreHub is accepted as the CoreBlow-native package marketplace baseline:

- Public registry, npm mirror, artifact/file routes, package lifecycle, scanner status, reports, appeals, delete/undelete, and release moderation enforcement are implemented.
- Publisher identity, trusted publisher OIDC publish tokens, organization membership, transfer flows, and publisher self-service UI are implemented.
- Admin review, assignment, evidence, support bundle, comment moderation, release moderation visibility, and operator status surfaces are implemented.
- Hosted skill lifecycle, search digest depth, community signals, install lifecycle, and CLI parity surfaces are implemented.
- Production persistence uses D1 with normalized rows and external artifact URL storage; R2 is intentionally not required.
- Production deploy, seed, smoke, backup, restore, rollback, and finalization workflows are present.
- npm release readiness is open at the manifest level, while live publication remains fail-closed until the protected workflow receives explicit operator approval.

## Local Evidence

Local release lock gates:

| Evidence | Result |
| --- | --- |
| Live smoke | pass |
| Production drill rehearsal | pass |
| npm package visibility | public manifest approved |
| npm dry-run package size | 45 files, 165.2 kB |

Live smoke command:

```sh
npm run smoke:post-deploy -- --registry https://coreblow.com/corehub --package plugin-lab --verify-web --verify-read
```

Live smoke result:

- health ok from `/healthz`
- web surface ok at `https://coreblow.com/corehub/`
- v1 registry discovery document returned
- package read ok for `plugin-lab`
- signed download metadata ok for `plugin-lab-0.1.0.coreblow-plugin.tgz`
- default download endpoint returns signed redirect
- signed read fetched 736 bytes and checksum verified
- runtime: Cloudflare Worker
- state store: D1
- object store: external URL
- signed read key: `primary`

Rollback rehearsal command:

```sh
npm run drill:production
```

Rollback rehearsal result:

- production finalization pass
- snapshot export pass
- backup validation pass
- restore dry run pass
- restore apply pass
- restored snapshot validation pass
- persistence migration smoke pass
- Worker local smoke pass

## Production Drill Evidence

Protected Production Drill workflow:

| Evidence | Result |
| --- | --- |
| Workflow | Production Drill |
| Run id | `26389174159` |
| Result | success |
| Started | `2026-05-25T07:35:50Z` |
| Finished | `2026-05-25T07:36:39Z` |
| Head SHA | `977e99a3f3ef3888230e5874d48ec82d17bcd3d4` |
| Run URL | `https://github.com/coreblow/corehub/actions/runs/26389174159` |

Workflow inputs:

- `registry`: `https://coreblow.com/corehub`
- `package`: `plugin-lab`
- `rollback_version_id`: `8406bea7-bfa7-4ad4-af11-d36870dd329d`
- `verify_read`: `true`

Acceptance result:

- current revision live smoke passed
- D1 SQL export was non-empty
- D1 state snapshot export was valid
- restore dry run passed
- approved no-op D1 restore passed
- restored snapshot validation passed
- Worker rollback smoke passed
- current Worker revision restore passed
- final live smoke passed

## Release Lock Procedure

1. Commit this release lock document.
2. Dispatch the protected Production Drill workflow.
3. Update this document with the Production Drill run id and result.
4. Tag the accepted baseline with `corehub-v1-accepted-2026-05-25`.
5. Push the commit and tag.

Completed release-lock procedure result:

- release lock document committed
- protected Production Drill workflow passed
- release lock evidence updated
- accepted baseline tag created and pushed

## Deferred

- npm live publication remains deferred until explicit operator approval runs the protected npm release workflow.
- npm preflight for `v0.1.0` passed in run `26389641795`; live publish is still not executed.
- Browser OAuth polish remains a later UI hardening item, not a blocker for this production lock.
