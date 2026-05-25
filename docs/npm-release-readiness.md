# CoreHub npm Release Readiness

CoreHub npm publication is intentionally fail-closed until an operator explicitly approves opening the CLI package.

Current policy:

- Keep `package.json` with `private: true` by default.
- Do not change `version` without an approved release task.
- Do not remove `private: true` without an approved release task.
- Do not run live `npm publish` from a local shell.
- Use the protected `CoreHub CLI NPM Release` workflow for real publication.

## Local Preflight

Run the metadata gate without preparing a public package:

```sh
npm run release:npm:preflight
```

The preflight validates package name, stable semver, homepage, license, Node engine, and CLI bin wiring. When the package is still private, the command warns that live publish remains blocked.

The npm package uses the `package.json` `files` allowlist so the release tarball includes runtime CLI sources, catalog/schema data, docs, fixtures, and example artifacts, while excluding CI workflows, test suites, operator scripts, and Cloudflare deployment templates from the published CLI package.

Run the local dry-run rehearsal:

```sh
npm run release:npm:dry-run
```

The dry run performs `npm pack`, extracts the tarball into a temporary directory, removes `private` only from the temporary manifest, and runs `npm publish --dry-run --ignore-scripts --access public`. The repository `package.json` is not modified.

## GitHub Preflight

Use the workflow with `preflight_only=true`:

```text
Workflow: CoreHub CLI NPM Release
tag: vX.Y.Z
preflight_only: true
release_approved: false
```

The preflight checks the release tag, runs the release gates, runs the safe npm publish dry run, packs the prepared tarball, and uploads the preflight artifact.

While `private: true` is still present, this workflow is readiness-only. A preflight artifact produced from a private package is rejected by the later publish job, so the real publish path must use a fresh preflight run after the approved manifest change.

## Live Publish Approval

Real publication requires all of these conditions:

1. A reviewed release change removes `private: true` from `package.json`.
2. The package version matches the release tag.
3. The successful preflight workflow run id is provided.
4. The workflow is dispatched from `main`.
5. The protected `npm-release` environment approval is granted.
6. The workflow input `release_approved` is set to `true`.
7. `scripts/corehub-cli-npm-publish.sh` receives `COREHUB_NPM_RELEASE_APPROVED=1`.

If any condition is missing, the publish path exits before calling `npm publish`.

## Live Publish Dispatch

After the approved manifest change and successful preflight:

```text
Workflow: CoreHub CLI NPM Release
tag: vX.Y.Z
preflight_only: false
preflight_run_id: <successful-preflight-run-id>
release_approved: true
```

The workflow publishes the tarball produced by the preflight run with GitHub OIDC trusted publishing and npm provenance.

## Rollback

npm packages cannot be fully rolled back once published. If a bad CLI release is published:

- Publish a fixed patch version.
- Deprecate the bad version with a clear replacement message.
- Keep the CoreHub registry and Worker rollback flow separate from npm package rollback.
