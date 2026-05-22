#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  const pendingSubmissions = JSON.parse(
    await runCoreHub([
      "submissions",
      "list",
      "--status",
      "pending_review",
      "--limit",
      "1",
      "--offset",
      "0",
      "--registry",
      registry,
    ]),
  );
  assert.equal(pendingSubmissions.count, 1);
  assert.equal(pendingSubmissions.total, 1);
  assert.equal(pendingSubmissions.limit, 1);
  assert.equal(pendingSubmissions.offset, 0);
  assert.equal(pendingSubmissions.submissions[0].submission.id, submission.submission.id);
  logStep(`pending submissions listed: ${pendingSubmissions.count}`);

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

  const openReviews = JSON.parse(
    await runCoreHub(["reviews", "list", "--status", "open", "--limit", "1", "--offset", "0", "--registry", registry]),
  );
  assert.equal(openReviews.count, 1);
  assert.equal(openReviews.total, 1);
  assert.equal(openReviews.reviews[0].moderationReview.id, submission.moderationReview.id);
  logStep(`open reviews listed: ${openReviews.count}`);

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

  const remainingOpenReviews = JSON.parse(
    await runCoreHub(["reviews", "list", "--status", "open", "--registry", registry]),
  );
  assert.equal(remainingOpenReviews.count, 0);
  const approvedReviews = JSON.parse(
    await runCoreHub(["reviews", "list", "--status", "approved", "--registry", registry]),
  );
  assert.equal(approvedReviews.count, 1);
  logStep(`approved reviews listed: ${approvedReviews.count}`);

  const reviewAudit = JSON.parse(
    await runCoreHub(["audit", "list", "--target", submission.moderationReview.id, "--limit", "20", "--registry", registry]),
  );
  assert.equal(reviewAudit.auditEvents.some((event) => event.action === "review.approve"), true);
  assert.equal(reviewAudit.auditEvents.some((event) => event.action === "review.inspect"), true);
  logStep(`review audit events listed: ${reviewAudit.count}`);

  const approvalAuditJsonl = await runCoreHub([
    "audit",
    "list",
    "--action",
    "review.approve",
    "--actor",
    "github:coreblow-admin",
    "--target-type",
    "review",
    "--format",
    "jsonl",
    "--limit",
    "20",
    "--registry",
    registry,
  ]);
  const approvalAuditEvents = approvalAuditJsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(approvalAuditEvents.length, 1);
  assert.equal(approvalAuditEvents[0].targetId, submission.moderationReview.id);
  assert.match(approvalAuditEvents[0].eventHash, /^[a-f0-9]{64}$/);
  assert.match(approvalAuditEvents[0].previousHash, /^[a-f0-9]{64}$/);
  logStep(`approval audit jsonl exported: ${approvalAuditEvents.length}`);

  const auditVerify = JSON.parse(await runCoreHub(["audit", "verify", "--registry", registry]));
  assert.equal(auditVerify.status, "valid");
  assert.equal(auditVerify.valid, true);
  assert.match(auditVerify.head, /^[a-f0-9]{64}$/);
  logStep(`audit hash chain verified: ${auditVerify.count}`);

  const auditRetention = JSON.parse(await runCoreHub(["audit", "retention", "--dry-run", "--registry", registry]));
  assert.equal(auditRetention.policy.mode, "export-before-prune");
  assert.equal(auditRetention.policy.integrityFailureBehavior, "fail_closed");
  assert.equal(auditRetention.verification.valid, true);
  logStep(`audit retention policy checked: ${auditRetention.policy.retentionDays} days`);

  const auditIncident = JSON.parse(await runCoreHub(["audit", "incident", "report", "--limit", "5", "--registry", registry]));
  assert.equal(auditIncident.status, "ok");
  assert.equal(auditIncident.verification.valid, true);
  assert.equal(auditIncident.recentAuditEvents.length, 5);
  logStep(`audit incident report generated: ${auditIncident.status}`);

  const auditIncidentCheck = await execFileAsync(process.execPath, [
    join(repoRoot, "scripts/audit-incident-check.mjs"),
    "--registry",
    registry,
    "--output",
    join(tempRoot, "audit-incident.md"),
    "--limit",
    "5",
  ]);
  assert.equal(JSON.parse(auditIncidentCheck.stdout).incidentStatus, "ok");
  logStep("audit incident automation check passed");

  const projected = await fetch(`${registry}/api/v1/packages/plugin-lab`);
  assert.equal(projected.status, 200);
  const projectedPayload = await projected.json();
  assert.equal(projectedPayload.apiVersion, "v1");
  assert.equal(projectedPayload.data.id, "plugin-lab");
  assert.equal(projectedPayload.data.versions[0].status, "available");
  assert.equal(projectedPayload.data.versions[0].artifact.sha256, uploadVerify.artifactUpload.sha256);
  logStep("projected v1 package entry verified");

  const downloadPath = join(tempRoot, "plugin-lab.coreblow-plugin.tgz");
  const verifiedDownload = JSON.parse(
    await runCoreHub(["package", "download", "plugin-lab", "--output", downloadPath, "--registry", registry]),
  );
  assert.equal(verifiedDownload.output.verified, true);
  assert.equal(verifiedDownload.output.sha256, uploadVerify.artifactUpload.sha256);
  assert.deepEqual(await readFile(downloadPath), await readFile(artifactPath));
  logStep("signed v1 download fetched and verified");

  console.log("CoreHub local publish smoke passed.");
} finally {
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
}
