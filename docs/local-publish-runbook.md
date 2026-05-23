# CoreHub Local Publish Runbook

This runbook exercises the local write-side API without production R2, S3, or database persistence.

## One Command Smoke

```sh
npm run smoke:local-publish
```

The smoke starts a local CoreHub API server on an ephemeral port, logs in with local test credentials, requests an upload slot, uploads and verifies the plugin artifact, submits the package, approves the review, exercises a package ownership transfer, and checks the projected Registry API v1 package entry.

## Manual Flow

Start the local API server:

```sh
npm run serve
```

In another terminal, log in and publish through the local server:

```sh
npm run corehub -- login --token local-dev-token --user github:coreblow-admin --publisher coreblow
npm run corehub -- package publish artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --family code-plugin --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- package upload request artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- package upload verify artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- package submit artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- submissions list --status pending_review --limit 20 --offset 0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- submissions inspect submission-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- reviews list --status open --limit 20 --offset 0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- review status review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- review assign review-plugin-lab-0-1-0 --to moderator:corehub --registry http://127.0.0.1:8787/corehub
npm run corehub -- review evidence add review-plugin-lab-0-1-0 --type manual_note --summary "Artifact, source, and publisher scope checked." --registry http://127.0.0.1:8787/corehub
npm run corehub -- review approve review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub --notes "Local review approved."
npm run corehub -- reviews status review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- reviews list --status approved --limit 20 --offset 0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- transfers request plugin-lab --to example-org --registry http://127.0.0.1:8787/corehub --reason "Move plugin-lab to Example Org."
npm run corehub -- transfers list --status requested --package plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- transfers accept transfer-plugin-lab-coreblow-to-example-org --registry http://127.0.0.1:8787/corehub --notes "Accepted."
npm run corehub -- audit list --target review-plugin-lab-0-1-0 --limit 20 --registry http://127.0.0.1:8787/corehub
npm run corehub -- audit list --action review.approve --actor github:coreblow-admin --target-type review --format jsonl --output ./review-approvals.audit.jsonl --registry http://127.0.0.1:8787/corehub
npm run corehub -- audit verify --registry http://127.0.0.1:8787/corehub
npm run corehub -- audit incident report --limit 5 --registry http://127.0.0.1:8787/corehub
npm run audit:incident -- --registry http://127.0.0.1:8787/corehub --output ./corehub-audit-incident.md --limit 5
npm run corehub -- audit retention --dry-run --registry http://127.0.0.1:8787/corehub
npm run corehub -- package inspect plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- package verify artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --package plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- package moderation-status plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- package readiness plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- package delete plugin-lab --yes --reason "Soft delete fixture." --registry http://127.0.0.1:8787/corehub
npm run corehub -- package undelete plugin-lab --yes --registry http://127.0.0.1:8787/corehub
npm run corehub -- package report plugin-lab --version 0.1.0 --reason "Suspicious package report fixture." --registry http://127.0.0.1:8787/corehub
npm run corehub -- package reports list --status open --package plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- package reports triage package-report-plugin-lab-0-1-0-000001 --status confirmed --note "Confirmed report fixture." --action none --registry http://127.0.0.1:8787/corehub
npm run corehub -- package appeal plugin-lab --version 0.1.0 --message "Appeal report fixture." --registry http://127.0.0.1:8787/corehub
npm run corehub -- package appeals list --status open --package plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- package appeals resolve package-appeal-plugin-lab-0-1-0-000001 --status accepted --note "Accepted appeal fixture." --action approve --registry http://127.0.0.1:8787/corehub
npm run corehub -- analytics record plugin-lab --version 0.1.0 --event installed --source cli --client-id local-client --registry http://127.0.0.1:8787/corehub
npm run corehub -- analytics summary --package plugin-lab --registry http://127.0.0.1:8787/corehub
npm run corehub -- admin status --registry http://127.0.0.1:8787/corehub
npm run corehub -- admin support-bundle --limit 20 --output ./corehub-support-bundle.json --registry http://127.0.0.1:8787/corehub
```

Expected result: `plugin-lab` appears through Registry API v1 with an `available` version after review approval, delete hides it from Registry API v1 without removing history, undelete restores it, the transfer reaches `completed` when accepted by the target publisher, the package report reaches `confirmed` after triage, the package appeal reaches `accepted` after resolution, analytics summary reports aggregate install counts without raw client identifiers, `corehub audit verify` returns `valid: true` with the current audit head hash, the incident report and automation check return `status: ok`, the retention dry run reports the export-before-prune policy, and `corehub admin status` reports `ok` with readiness `ready`.

The support bundle is a redacted JSON artifact for operator escalation. It includes state store and object store kind, queue counts, transfer counts, lifecycle counts, report counts, appeal counts, install analytics totals, audit integrity, deploy readiness, and recent queue/audit samples. It does not include signing secrets, raw client identifiers, raw IP addresses, or raw user agents.

## Local State

By default the local server writes metadata to `.corehub-local/write-side-state.json` and uploaded bytes under `.corehub-local/storage`.

These files are local development artifacts and are ignored by git.

Set `COREHUB_AUDIT_RETENTION_DAYS` to change the local audit retention window. Pruning requires an operator export through `corehub audit retention --prune --output <file>` so the export hash can be checkpointed before old events are removed.
