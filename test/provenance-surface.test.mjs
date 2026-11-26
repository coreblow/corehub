import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { promisify } from "node:util";
import {
  adminActor,
  fixedNow,
  pluginLabArtifactBytes,
  pluginLabEntry,
  seedManagedPackage,
  startCoreHubTestServer,
} from "./helpers/corehub-testkit.mjs";

const pluginLabArtifact = pluginLabEntry.versions[0].artifact;

const execFileAsync = promisify(execFile);
const cliPath = new URL("../src/cli.mjs", import.meta.url).pathname;
const artifactPath = new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname;

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signTestJwt(payload, privateKey, { kid = "provenance-test-key" } = {}) {
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT", kid });
  const encodedPayload = base64UrlJson(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKey).toString("base64url")}`;
}

const server = await startCoreHubTestServer();
try {
  // 1. Review-approved package without OIDC -> verificationMethod: "review+sha256"
  await seedManagedPackage(server.storage, { packageId: "prov-review-pkg" });

  const reviewPkgRes = await fetch(`${server.v1Url}/packages/prov-review-pkg`);
  assert.equal(reviewPkgRes.status, 200);
  const reviewPkg = (await reviewPkgRes.json()).data;
  assert.deepEqual(reviewPkg.provenance, {
    verificationMethod: "review+sha256",
    verified: true,
    publisher: "coreblow",
    artifactSha256: pluginLabArtifact.sha256,
    minCoreblowVersion: "1.0.0",
    source: "https://github.com/coreblow/prov-review-pkg",
  });

  const reviewVersionsRes = await fetch(`${server.v1Url}/packages/prov-review-pkg/versions`);
  assert.equal(reviewVersionsRes.status, 200);
  const reviewVersions = (await reviewVersionsRes.json()).data;
  assert.equal(reviewVersions[0].provenance.verificationMethod, "review+sha256");
  assert.equal(reviewVersions[0].provenance.artifactSha256, pluginLabArtifact.sha256);

  // 2. OIDC-minted + approved package -> verificationMethod: "github-oidc+sha256"
  const laterNow = new Date("2026-05-21T01:00:00Z");
  await seedManagedPackage(server.storage, { packageId: "prov-oidc-pkg", version: "0.1.0" });
  await server.storage.setTrustedPublisher(
    "prov-oidc-pkg",
    { repository: "coreblow/prov-oidc-pkg", workflowFilename: "publish.yml" },
    { actor: adminActor, now: fixedNow },
  );
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  server.storage.githubOidcJwks = { keys: [{ ...publicJwk, kid: "provenance-test-key", alg: "RS256", use: "sig" }] };
  const nowSeconds = Math.floor(laterNow.getTime() / 1000);
  const oidcToken = signTestJwt(
    {
      iss: "https://token.actions.githubusercontent.com",
      aud: "corehub-publish-token",
      sub: "repo:coreblow/prov-oidc-pkg:ref:refs/heads/main",
      repository: "coreblow/prov-oidc-pkg",
      repository_id: "998877",
      repository_owner: "coreblow",
      repository_owner_id: "42",
      job_workflow_ref: "coreblow/prov-oidc-pkg/.github/workflows/publish.yml@refs/heads/main",
      job_workflow_sha: "deadbeefworkflow",
      workflow_ref: "coreblow/prov-oidc-pkg/.github/workflows/publish.yml@refs/heads/main",
      run_id: "54321",
      run_attempt: "1",
      sha: "deadbeef1234",
      ref: "refs/heads/main",
      nbf: nowSeconds - 60,
      exp: nowSeconds + 300,
    },
    privateKey,
  );
  const minted = await server.storage.mintPublishToken(
    "prov-oidc-pkg",
    { version: "0.2.0", oidcToken },
    { actor: adminActor, now: laterNow },
  );

  const slot = await server.storage.requestUploadSlot(
    {
      packageId: "prov-oidc-pkg",
      version: "0.2.0",
      publisherHandle: "coreblow",
      provider: "managed",
      artifact: { ...pluginLabArtifact },
    },
    { actor: adminActor, now: laterNow },
  );
  await server.storage.putObject(
    slot.id,
    pluginLabArtifactBytes,
    { "x-corehub-artifact-sha256": pluginLabArtifact.sha256 },
    { actor: adminActor, now: laterNow },
  );
  const verifiedUpload = await server.storage.verifyUpload(slot.id, { actor: adminActor, now: laterNow });
  const submissionResult = await server.storage.createSubmission(
    {
      packageId: "prov-oidc-pkg",
      version: "0.2.0",
      kind: "plugin",
      publisherHandle: "coreblow",
      channel: "official",
      artifactUploadId: verifiedUpload.artifactUpload.id,
      publishTokenId: minted.publishToken.id,
      changelog: "OIDC provenance test release.",
    },
    { actor: adminActor, now: laterNow },
  );
  await server.storage.decideReview(
    submissionResult.moderationReview.id,
    "approve",
    { notes: "OIDC release approved." },
    { actor: adminActor, now: laterNow },
  );

  const oidcPkgRes = await fetch(`${server.v1Url}/packages/prov-oidc-pkg`);
  assert.equal(oidcPkgRes.status, 200);
  const oidcPkg = (await oidcPkgRes.json()).data;
  assert.equal(oidcPkg.provenance.verificationMethod, "github-oidc+sha256");
  assert.equal(oidcPkg.provenance.verified, true);
  assert.equal(oidcPkg.provenance.publisher, "coreblow");
  assert.equal(oidcPkg.provenance.artifactSha256, pluginLabArtifact.sha256);
  assert.equal(oidcPkg.provenance.minCoreblowVersion, "1.0.0");
  assert.equal(oidcPkg.provenance.oidc.provider, "github-actions");
  assert.equal(oidcPkg.provenance.oidc.repository, "coreblow/prov-oidc-pkg");
  assert.equal(oidcPkg.provenance.oidc.workflowFilename, "publish.yml");

  const oidcVersionsRes = await fetch(`${server.v1Url}/packages/prov-oidc-pkg/versions`);
  assert.equal(oidcVersionsRes.status, 200);
  const oidcVersions = (await oidcVersionsRes.json()).data;
  assert.equal(oidcVersions[0].provenance.verificationMethod, "github-oidc+sha256");
  assert.equal(oidcVersions[0].provenance.oidc.runId, "54321");

  // 3. CLI inspect (local + remote) and verify (local + remote)
  const localInspect = await execFileAsync(process.execPath, [cliPath, "package", "inspect", "plugin-lab"]);
  const localInspectJson = JSON.parse(localInspect.stdout);
  assert.equal(localInspectJson.provenance.verificationMethod, "review+sha256");
  assert.equal(localInspectJson.provenance.verified, true);
  assert.equal(localInspectJson.provenance.publisher, "coreblow");
  assert.equal(localInspectJson.provenance.minCoreblowVersion, "1.0.0");

  const remoteInspect = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "inspect",
    "prov-oidc-pkg",
    "--registry",
    server.corehubUrl,
  ]);
  const remoteInspectJson = JSON.parse(remoteInspect.stdout);
  assert.equal(remoteInspectJson.provenance.verificationMethod, "github-oidc+sha256");
  assert.equal(remoteInspectJson.provenance.verified, true);

  const localVerify = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "verify",
    artifactPath,
    "--sha256",
    pluginLabArtifact.sha256,
  ]);
  const localVerifyJson = JSON.parse(localVerify.stdout);
  assert.equal(localVerifyJson.status, "verified");
  assert.equal(localVerifyJson.provenance.verificationMethod, "sha256");
  assert.equal(localVerifyJson.provenance.verified, true);
  assert.equal(localVerifyJson.provenance.artifactSha256, pluginLabArtifact.sha256);

  const remoteVerify = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "verify",
    artifactPath,
    "--package",
    "prov-oidc-pkg",
    "--registry",
    server.corehubUrl,
  ]);
  const remoteVerifyJson = JSON.parse(remoteVerify.stdout);
  assert.equal(remoteVerifyJson.status, "verified");
  assert.equal(remoteVerifyJson.provenance.verificationMethod, "github-oidc+sha256");
  assert.equal(remoteVerifyJson.provenance.verified, true);
  assert.equal(remoteVerifyJson.provenance.publisher, "coreblow");
  assert.equal(remoteVerifyJson.provenance.minCoreblowVersion, "1.0.0");
} finally {
  await server.close();
}
