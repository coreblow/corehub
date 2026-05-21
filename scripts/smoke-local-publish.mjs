#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCoreHubServer } from "../src/server.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(repoRoot, "src/cli.mjs");
const artifactPath = join(repoRoot, "artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz");

const tempRoot = await mkdtemp(join(tmpdir(), "corehub-local-publish-"));
const dataRoot = join(tempRoot, "data");
const authHome = join(tempRoot, "auth");
const app = await createCoreHubServer({
  dataRoot,
  host: "127.0.0.1",
  port: 0,
});

function logStep(message) {
  console.log(`- ${message}`);
}

async function runCoreHub(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      COREHUB_HOME: authHome,
    },
  });
  return result.stdout.trim();
}

try {
  const info = await app.listen();
  const registry = info.url;
  logStep(`server listening at ${registry}`);

  await runCoreHub([
    "login",
    "--token",
    "local-dev-token",
    "--user",
    "github:coreblow-admin",
    "--publisher",
    "coreblow",
  ]);
  logStep("logged in as github:coreblow-admin");

  const uploadRequest = JSON.parse(
    await runCoreHub(["package", "upload", "request", artifactPath, "--registry", registry, "--dry-run"]),
  );
  assert.equal(uploadRequest.status, "remote_planned");
  assert.equal(uploadRequest.uploadSlot.id, "upload-plugin-lab-0-1-0");
  logStep(`upload slot requested: ${uploadRequest.uploadSlot.id}`);

  const uploadVerify = JSON.parse(
    await runCoreHub([
      "package",
      "upload",
      "verify",
      artifactPath,
      "--upload-slot",
      uploadRequest.uploadSlot.id,
      "--registry",
      registry,
      "--dry-run",
    ]),
  );
  assert.equal(uploadVerify.status, "verified");
  assert.equal(uploadVerify.artifactUpload.status, "verified");
  logStep(`artifact verified: ${uploadVerify.artifactUpload.id}`);

  const submission = JSON.parse(
    await runCoreHub(["package", "submit", artifactPath, "--registry", registry, "--dry-run"]),
  );
  assert.equal(submission.status, "remote_pending_review");
  assert.equal(submission.submission.status, "pending_review");
  assert.equal(submission.moderationReview.status, "open");
  logStep(`submission created: ${submission.submission.id}`);

  const submissionInspect = JSON.parse(
    await runCoreHub(["submissions", "inspect", submission.submission.id, "--registry", registry]),
  );
  assert.equal(submissionInspect.status, "pending_review");
  assert.equal(submissionInspect.artifactUpload.status, "verified");
  logStep(`submission inspect status: ${submissionInspect.status}`);

  const reviewStatus = JSON.parse(
    await runCoreHub(["review", "status", submission.moderationReview.id, "--registry", registry]),
  );
  assert.equal(reviewStatus.status, "open");
  assert.equal(reviewStatus.submission.status, "pending_review");
  logStep(`review status before approval: ${reviewStatus.status}`);

  const approval = JSON.parse(
    await runCoreHub([
      "review",
      "approve",
      submission.moderationReview.id,
      "--registry",
      registry,
      "--notes",
      "Local publish smoke approved.",
    ]),
  );
  assert.equal(approval.status, "approved");
  assert.equal(approval.packageVersion.status, "available");
  logStep(`review approved: ${approval.moderationReview.id}`);

  const approvedReview = JSON.parse(
    await runCoreHub(["reviews", "status", submission.moderationReview.id, "--registry", registry]),
  );
  assert.equal(approvedReview.status, "approved");
  assert.equal(approvedReview.packageVersion.status, "available");
  logStep(`review status after approval: ${approvedReview.status}`);

  const projected = await fetch(`${registry}/api/v1/packages/plugin-lab`);
  assert.equal(projected.status, 200);
  const projectedPayload = await projected.json();
  assert.equal(projectedPayload.apiVersion, "v1");
  assert.equal(projectedPayload.data.id, "plugin-lab");
  assert.equal(projectedPayload.data.versions[0].status, "available");
  assert.equal(projectedPayload.data.versions[0].artifact.sha256, uploadVerify.artifactUpload.sha256);
  logStep("projected v1 package entry verified");

  console.log("CoreHub local publish smoke passed.");
} finally {
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
}
