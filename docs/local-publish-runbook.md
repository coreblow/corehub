# CoreHub Local Publish Runbook

This runbook exercises the local write-side API without production R2, S3, or database persistence.

## One Command Smoke

```sh
npm run smoke:local-publish
```

The smoke starts a local CoreHub API server on an ephemeral port, logs in with local test credentials, requests an upload slot, uploads and verifies the plugin artifact, submits the package, approves the review, and checks the projected Registry API v1 package entry.

## Manual Flow

Start the local API server:

```sh
npm run serve
```

In another terminal, log in and publish through the local server:

```sh
npm run corehub -- login --token local-dev-token --user github:coreblow-admin --publisher coreblow
npm run corehub -- package upload request artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- package upload verify artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --upload-slot upload-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- package submit artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz --registry http://127.0.0.1:8787/corehub --dry-run
npm run corehub -- submissions list --status pending_review --limit 20 --offset 0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- submissions inspect submission-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- reviews list --status open --limit 20 --offset 0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- review status review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- review approve review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub --notes "Local review approved."
npm run corehub -- reviews status review-plugin-lab-0-1-0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- reviews list --status approved --limit 20 --offset 0 --registry http://127.0.0.1:8787/corehub
npm run corehub -- audit list --target review-plugin-lab-0-1-0 --limit 20 --registry http://127.0.0.1:8787/corehub
npm run corehub -- package inspect plugin-lab --registry http://127.0.0.1:8787/corehub
```

Expected result: `plugin-lab` appears through Registry API v1 with an `available` version after review approval.

## Local State

By default the local server writes metadata to `.corehub-local/write-side-state.json` and uploaded bytes under `.corehub-local/storage`.

These files are local development artifacts and are ignored by git.
