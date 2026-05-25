# CoreHub Production Release Lock - 2026-05-25

This document locks the CoreHub post-v1 production baseline after the accepted marketplace parity pass and post-v1 hardening phases.

## Release Scope

Status: production release lock in progress.

Accepted baseline tag:

- `corehub-v1-accepted-2026-05-25`

Accepted scope:

- CoreHub v1 package marketplace parity.
- Post-v1 account and organization settings.
- Publisher portal hardening.
- Community moderation UI.
- Split CI/test matrix by surface.
- npm release readiness with fail-closed publication policy.
- Production release evidence: live smoke, rollback drill, and release notes.

The npm package remains `private: true`. This release lock does not publish npm artifacts, remove `private: true`, or change package versions.

## Release Notes

CoreHub is accepted as the CoreBlow-native package marketplace baseline:

- Public registry, npm mirror, artifact/file routes, package lifecycle, scanner status, reports, appeals, delete/undelete, and release moderation enforcement are implemented.
- Publisher identity, trusted publisher OIDC publish tokens, organization membership, transfer flows, and publisher self-service UI are implemented.
- Admin review, assignment, evidence, support bundle, comment moderation, release moderation visibility, and operator status surfaces are implemented.
- Hosted skill lifecycle, search digest depth, community signals, install lifecycle, and CLI parity surfaces are implemented.
- Production persistence uses D1 with normalized rows and external artifact URL storage; R2 is intentionally not required.
- Production deploy, seed, smoke, backup, restore, rollback, and finalization workflows are present.
- npm release readiness is fail-closed until a separate explicit operator approval opens publication.

## Local Evidence

Local release lock gates:

| Evidence | Result |
| --- | --- |
| Live smoke | pass |
| Production drill rehearsal | pass |
| npm package visibility | `private: true` retained |
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

Protected Production Drill workflow evidence will be locked here after the workflow completes for this release baseline.

Required workflow inputs:

- `registry`: `https://coreblow.com/corehub`
- `package`: `plugin-lab`
- `rollback_version_id`: last known-good Worker rollback version
- `verify_read`: `true`

Acceptance condition:

- current revision live smoke passes
- D1 SQL export is non-empty
- D1 state snapshot export is valid
- restore dry run passes
- approved no-op D1 restore passes
- restored snapshot validation passes
- Worker rollback smoke passes
- current Worker revision restore passes
- final live smoke passes

## Release Lock Procedure

1. Commit this release lock document.
2. Dispatch the protected Production Drill workflow.
3. Update this document with the Production Drill run id and result.
4. Tag the accepted baseline with `corehub-v1-accepted-2026-05-25`.
5. Push the commit and tag.

## Deferred

- npm live publication remains deferred until explicit operator approval removes `private: true` and runs the protected npm release workflow.
- Browser OAuth polish remains a later UI hardening item, not a blocker for this production lock.
