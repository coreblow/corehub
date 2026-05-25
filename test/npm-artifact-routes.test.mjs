import assert from "node:assert/strict";
import { pluginLabEntry, seedManagedPackage, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  await seedManagedPackage(server.storage, { packageId: "surface-plugin" });

  const packument = await fetch(`${server.npmUrl}/surface-plugin`);
  assert.equal(packument.status, 200);
  const packumentPayload = await packument.json();
  assert.equal(packumentPayload.name, "surface-plugin");
  assert.equal(packumentPayload["dist-tags"].latest, "0.1.0");
  assert.equal(packumentPayload.versions["0.1.0"].dist.integrity, pluginLabEntry.versions[0].artifact.npm.integrity);
  assert.equal(packumentPayload.versions["0.1.0"].dist.shasum, pluginLabEntry.versions[0].artifact.npm.shasum);
  assert.equal(packumentPayload.versions["0.1.0"].dist.fileCount, 5);
  assert.match(
    packumentPayload.versions["0.1.0"].dist.tarball,
    /\/corehub\/api\/npm\/surface-plugin\/-\/surface-plugin-0\.1\.0\.coreblow-plugin\.tgz$/,
  );

  const tarball = await fetch(`${server.npmUrl}/surface-plugin/-/surface-plugin-0.1.0.coreblow-plugin.tgz`, {
    redirect: "manual",
  });
  assert.equal(tarball.status, 302);
  assert.match(tarball.headers.get("location"), /\/corehub\/api\/v1\/artifacts\/read\?/);
  assert.equal(tarball.headers.get("x-corehub-artifact-sha256"), pluginLabEntry.versions[0].artifact.sha256);
  assert.equal(tarball.headers.get("x-corehub-npm-integrity"), pluginLabEntry.versions[0].artifact.npm.integrity);

  const files = await fetch(`${server.v1Url}/packages/surface-plugin/files`);
  assert.equal(files.status, 200);
  const filesPayload = await files.json();
  assert.equal(filesPayload.data.files.some((file) => file.path === "README.md"), true);

  const readme = await fetch(`${server.v1Url}/packages/surface-plugin/file?path=README.md`);
  assert.equal(readme.status, 200);
  assert.match(readme.headers.get("content-type"), /text\/plain/);
  assert.equal(
    readme.headers.get("x-corehub-file-sha256"),
    pluginLabEntry.versions[0].artifact.files.find((file) => file.path === "README.md").sha256,
  );
  assert.match(await readme.text(), /Plugin Lab Basic Plugin/);

  const traversal = await fetch(`${server.v1Url}/packages/surface-plugin/file?path=../package.json`);
  assert.equal(traversal.status, 400);
  assert.match(await traversal.text(), /relative package file path/);
} finally {
  await server.close();
}
