import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { CoreHubLocalStorageAdapter, createCoreHubApiHandler } from "../src/api-server.mjs";
import { CoreHubCatalog, CoreHubSkillInspector, validateCatalog } from "../src/corehub.mjs";
import { createCoreHubServer } from "../src/server.mjs";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";
import { runAuditIncidentCheck } from "../ops/cloudflare/audit-incident-worker.mjs";
import {
  buildAuditAlertPayload,
  deliverAuditAlert,
  formatEmailAlert,
  formatSlackAlert,
  formatTeamsAlert,
} from "../ops/cloudflare/audit-alert-adapters.mjs";

const execFileAsync = promisify(execFile);
const entries = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf-8"));
const schema = JSON.parse(
  await readFile(new URL("../schemas/corehub.catalog.schema.json", import.meta.url), "utf-8"),
);
const writeSideSchema = JSON.parse(
  await readFile(new URL("../schemas/corehub.write-side.schema.json", import.meta.url), "utf-8"),
);
const writeSideState = JSON.parse(
  await readFile(new URL("../fixtures/write-side-state.json", import.meta.url), "utf-8"),
);
const auditAlertSchema = JSON.parse(
  await readFile(new URL("../schemas/corehub.audit-alert.schema.json", import.meta.url), "utf-8"),
);
const auditAlertFixture = JSON.parse(
  await readFile(new URL("../fixtures/audit-alert-fail-closed.json", import.meta.url), "utf-8"),
);
const pluginLabEntry = entries.find((entry) => entry.id === "plugin-lab");
const errors = validateCatalog(entries);
const pluginLabArtifactBytes = await readFile(
  new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url),
);
const pluginLabArtifactManifest = JSON.parse(
  await readFile(
    new URL("../artifacts/plugin-lab-0.1.0.corehub-manifest.json", import.meta.url),
    "utf-8",
  ),
);
const pluginLabArtifactUrl = "/artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz";
const pluginLabRemoteArtifact = {
  ...entries[2].versions[0].artifact,
  storage: {
    ...entries[2].versions[0].artifact.storage,
    url: pluginLabArtifactUrl,
  },
};

assert.deepEqual(errors, []);
assert.deepEqual(new CoreHubCatalogSchemaValidator(schema).validate(entries), []);
assert.deepEqual(new CoreHubCatalogSchemaValidator(writeSideSchema).validate(writeSideState), []);
assert.deepEqual(new CoreHubCatalogSchemaValidator(auditAlertSchema).validate(auditAlertFixture), []);
assert.equal(entries[0].id, "coreblow");
assert.equal(writeSideState.schemaVersion, "corehub.write.v1");
assert.equal(writeSideState.authSessions[0].actor.id, "github:coreblow-admin");
assert.equal(writeSideState.publisherClaims[0].handle, "coreblow");
assert.equal(writeSideState.packageSubmissions[0].status, "approved");
assert.equal(writeSideState.packageVersions[0].status, "available");
assert.equal(writeSideState.artifactUploads[0].sha256, pluginLabEntry.versions[0].artifact.sha256);
assert.equal(writeSideState.artifactUploads[0].size, pluginLabEntry.versions[0].artifact.size);
assert.equal(writeSideState.auditEvents.some((event) => event.action === "review.approve"), true);
assert.match(writeSideState.auditEvents[0].eventHash, /^[a-f0-9]{64}$/);
assert.equal(writeSideState.auditEvents[1].previousHash, writeSideState.auditEvents[0].eventHash);

const catalog = new CoreHubCatalog(entries);
assert.equal(catalog.findById("plugin-lab").kind, "plugin");
assert.equal(catalog.findById("plugin-lab").publisher.handle, "coreblow");
assert.equal(catalog.listVersions("plugin-lab")[0].publisher.handle, "coreblow");
assert.equal(catalog.findVersion("plugin-lab", "latest").status, "available");
assert.equal(catalog.findVersion("plugin-lab", "latest").artifact.downloadEnabled, true);
assert.equal(
  catalog.findVersion("plugin-lab", "0.1.0").artifact.name,
  "plugin-lab-0.1.0.coreblow-plugin.tgz",
);
assert.equal(
  catalog.findVersion("plugin-lab", "0.1.0").artifact.storage.key,
  "artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz",
);
assert.equal(catalog.findVersion("plugin-lab", "0.1.0").artifact.files.length, 5);
assert.ok(
  catalog
    .findVersion("plugin-lab", "0.1.0")
    .artifact.files.some((file) => file.path === "corehub.artifact.json"),
);
assert.equal(pluginLabArtifactManifest.schemaVersion, "corehub.artifact.v1");
assert.equal(pluginLabArtifactManifest.package.id, "plugin-lab");
assert.deepEqual(
  pluginLabArtifactManifest.artifact.files,
  catalog.findVersion("plugin-lab", "0.1.0").artifact.files,
);
assert.equal(
  pluginLabArtifactManifest.artifact.sha256,
  catalog.findVersion("plugin-lab", "0.1.0").artifact.sha256,
);

for (const entry of entries) {
  for (const version of entry.versions ?? []) {
    const artifact = version.artifact;
    if (artifact?.storage?.provider !== "github-raw") continue;
    const bytes = await readFile(new URL(`../${artifact.storage.key}`, import.meta.url));
    assert.equal(bytes.byteLength, artifact.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
}
assert.equal(catalog.list({ kind: "skill" }).length, 1);
assert.equal(catalog.list({ verifiedOnly: true }).length, entries.length);
assert.equal(catalog.listPublishers().length, 1);
assert.equal(catalog.findPublisher("coreblow").entries.length, entries.length);

const originalFetch = globalThis.fetch;
try {
  const workerResponses = {
    "/corehub/api/v2/audit/verify": {
      apiVersion: "v2",
      data: { valid: true, behavior: "proceed", count: 2, head: "a".repeat(64), errors: [] },
    },
    "/corehub/api/v2/audit/retention": {
      apiVersion: "v2",
      data: { status: "noop", policy: { integrityFailureBehavior: "fail_closed" } },
    },
    "/corehub/api/v2/audit/events": {
      apiVersion: "v2",
      data: [{ sequence: 2, action: "audit.verify", targetType: "audit", targetId: "ok" }],
      meta: { count: 1 },
    },
  };
  globalThis.fetch = async (url) => Response.json(workerResponses[new URL(url).pathname]);
  const workerReport = await runAuditIncidentCheck({ COREHUB_REGISTRY: "https://coreblow.com/corehub" });
  assert.equal(workerReport.status, "ok");
  assert.equal(workerReport.recentAuditEvents.length, 1);

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/corehub/api/v2/audit/verify") {
      return Response.json({
        apiVersion: "v2",
        data: { valid: false, behavior: "fail_closed", count: 1, head: "b".repeat(64), errors: ["tampered"] },
      });
    }
    return Response.json(workerResponses[parsed.pathname]);
  };
  const failClosedWorkerReport = await runAuditIncidentCheck({ COREHUB_REGISTRY: "https://coreblow.com/corehub" });
  assert.equal(failClosedWorkerReport.status, "fail_closed");
  const alertPayload = buildAuditAlertPayload(failClosedWorkerReport);
  assert.deepEqual(new CoreHubCatalogSchemaValidator(auditAlertSchema).validate(alertPayload), []);
  assert.equal(formatSlackAlert(alertPayload).blocks[0].type, "section");
  assert.equal(formatTeamsAlert(alertPayload).attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(formatEmailAlert(alertPayload, { COREHUB_AUDIT_ALERT_EMAIL_TO: "security@coreblow.com" }).to, "security@coreblow.com");

  const deliveredAlerts = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/alert") {
      deliveredAlerts.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    if (parsed.pathname === "/corehub/api/v2/audit/verify") {
      return Response.json({
        apiVersion: "v2",
        data: { valid: false, behavior: "fail_closed", count: 1, head: "b".repeat(64), errors: ["tampered"] },
      });
    }
    return Response.json(workerResponses[parsed.pathname]);
  };
  const alertedWorkerReport = await runAuditIncidentCheck({
    COREHUB_REGISTRY: "https://coreblow.com/corehub",
    COREHUB_AUDIT_ALERT_WEBHOOK: "https://alerts.example.invalid/alert",
    COREHUB_AUDIT_ALERT_DESTINATION: "slack",
  });
  assert.equal(alertedWorkerReport.alertDelivery.delivered, true);
  assert.equal(alertedWorkerReport.alertDelivery.status, "delivered");
  assert.equal(deliveredAlerts[0].text, "CoreHub audit fail_closed");

  let retryAttempts = 0;
  globalThis.fetch = async () => {
    retryAttempts += 1;
    if (retryAttempts < 3) return new Response("temporary outage", { status: 503, statusText: "Service Unavailable" });
    return Response.json({ ok: true });
  };
  const retriedDelivery = await deliverAuditAlert(failClosedWorkerReport, {
    COREHUB_AUDIT_ALERT_WEBHOOK: "https://alerts.example.invalid/retry",
    COREHUB_AUDIT_ALERT_RETRIES: "2",
    COREHUB_AUDIT_ALERT_RETRY_DELAY_MS: "0",
  });
  assert.equal(retriedDelivery.delivered, true);
  assert.equal(retriedDelivery.status, "delivered");
  assert.equal(retriedDelivery.attempts, 3);

  globalThis.fetch = async () => new Response("still down", { status: 503, statusText: "Service Unavailable" });
  const deadLetterDelivery = await deliverAuditAlert(failClosedWorkerReport, {
    COREHUB_AUDIT_ALERT_WEBHOOK: "https://alerts.example.invalid/dead-letter",
    COREHUB_AUDIT_ALERT_RETRIES: "1",
    COREHUB_AUDIT_ALERT_RETRY_DELAY_MS: "0",
  });
  assert.equal(deadLetterDelivery.delivered, false);
  assert.equal(deadLetterDelivery.status, "dead_letter");
  assert.equal(deadLetterDelivery.attempts, 2);
  assert.equal(deadLetterDelivery.deadLetter.destination, "webhook");
  assert.equal(deadLetterDelivery.deadLetter.webhookHost, "alerts.example.invalid");
  assert.equal(deadLetterDelivery.deadLetter.errors.length, 2);

  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/corehub/api/v2/audit/verify") {
      return Response.json({
        apiVersion: "v2",
        data: { valid: false, behavior: "fail_closed", count: 1, head: "b".repeat(64), errors: ["tampered"] },
      });
    }
    return Response.json(workerResponses[parsed.pathname]);
  };
  await assert.rejects(
    runAuditIncidentCheck({ COREHUB_REGISTRY: "https://coreblow.com/corehub" }, { throwOnFail: true }),
    /fail_closed/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

const searchResults = catalog.search("compatibility lab fixtures");
assert.equal(searchResults[0].id, "plugin-lab");
assert.ok(searchResults[0].score > 0);

const invalid = validateCatalog([
  {
    id: "Bad ID",
    kind: "unknown",
    name: "",
    summary: "",
    source: "https://example.com/not-github",
    tags: ["Not Kebab"],
    publisher: {
      handle: "Bad Publisher",
      displayName: "",
      url: "not-url",
      verified: "yes",
    },
    versions: [
      {
        version: "v1",
        tag: "Bad Tag",
        publishedAt: "",
        publisher: { handle: "other" },
        status: "unknown",
        artifact: {
          name: "",
          mediaType: "",
          size: -1,
          sha256: "bad",
          downloadEnabled: "yes",
          storage: { provider: "unknown", key: "", url: "not-url" },
          provenance: { source: "https://example.com/not-github", reviewState: "unknown" },
          files: [{ path: "", size: -1, sha256: "bad" }],
        },
      },
    ],
    coreblow: {
      minCoreblowVersion: "v1",
      requiresEnv: ["bad-env"],
    },
  },
]);
assert.ok(invalid.some((error) => error.includes("id must be kebab-case")));
assert.ok(invalid.some((error) => error.includes("kind must be one of")));
assert.ok(invalid.some((error) => error.includes("source must be a GitHub URL")));
assert.ok(invalid.some((error) => error.includes("publisher.handle")));
assert.ok(invalid.some((error) => error.includes("publisher.verified")));
assert.ok(invalid.some((error) => error.includes("versions[0].publisher.handle")));
assert.ok(invalid.some((error) => error.includes("versions[0].artifact.sha256")));
assert.ok(invalid.some((error) => error.includes("versions[0].artifact.storage.provider")));
assert.ok(invalid.some((error) => error.includes("coreblow.requiresEnv")));

const inspected = await new CoreHubSkillInspector().inspectFolder(
  new URL("../fixtures/example-skill", import.meta.url).pathname,
);
assert.equal(inspected.hasSkillFile, true);
assert.equal(inspected.hasManifest, true);
assert.ok(inspected.fingerprint);
assert.ok(inspected.files.some((file) => file.path === "SKILL.md"));

const cliPath = new URL("../src/cli.mjs", import.meta.url).pathname;
const auditIncidentCheckPath = new URL("../scripts/audit-incident-check.mjs", import.meta.url).pathname;
const explore = await execFileAsync(process.execPath, [cliPath, "explore"]);
assert.match(explore.stdout, /corehub-directory\tskill\tCoreHub Directory Metadata/);

const packageInspect = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "inspect",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageInspect.stdout).id, "plugin-lab");

const packageVersions = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "versions",
  "plugin-lab",
]);
assert.match(packageVersions.stdout, /plugin-lab\tlatest\t0\.1\.0\tavailable/);
assert.match(packageVersions.stdout, /publisher=coreblow/);

const packageArtifact = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "artifact",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageArtifact.stdout).artifact.downloadEnabled, true);

const packageFiles = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "files",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageFiles.stdout).artifact.name, "plugin-lab-0.1.0.coreblow-plugin.tgz");

const packageDownload = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "download",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageDownload.stdout).download.available, true);

const packageInstall = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "install",
  "plugin-lab",
]);
const installPlan = JSON.parse(packageInstall.stdout);
assert.equal(installPlan.dryRun, false);
assert.equal(installPlan.install.status, "blocked");
assert.equal(installPlan.download.verified, false);
assert.match(installPlan.install.message, /resolved an installable CoreBlow plugin archive/);
assert.equal(installPlan.plan.at(-1).step, "install-plugin");

const topLevelInstallPreview = await execFileAsync(process.execPath, [
  cliPath,
  "install",
  "--dry-run",
  "plugin-lab",
  "--json",
]);
const previewPlan = JSON.parse(topLevelInstallPreview.stdout);
assert.equal(previewPlan.dryRun, true);
assert.equal(previewPlan.install.status, "planned");

const publisherList = await execFileAsync(process.execPath, [cliPath, "publishers", "list"]);
assert.equal(JSON.parse(publisherList.stdout)[0].handle, "coreblow");

const publisherInspect = await execFileAsync(process.execPath, [
  cliPath,
  "publishers",
  "inspect",
  "coreblow",
]);
assert.equal(JSON.parse(publisherInspect.stdout).entries.length, entries.length);

const authHome = await mkdtemp(join(tmpdir(), "corehub-auth-"));
try {
  const authEnv = { ...process.env, COREHUB_HOME: authHome };
  const login = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "login",
      "--token",
      "local-dev-token",
      "--user",
      "github:coreblow-admin",
      "--publisher",
      "coreblow",
      "--json",
    ],
    { env: authEnv },
  );
  assert.equal(JSON.parse(login.stdout).defaultPublisher.handle, "coreblow");

  const whoami = await execFileAsync(process.execPath, [cliPath, "publisher", "whoami", "--json"], {
    env: authEnv,
  });
  const whoamiPayload = JSON.parse(whoami.stdout);
  assert.equal(whoamiPayload.actor.id, "github:coreblow-admin");
  assert.equal(whoamiPayload.memberships[0].publisherHandle, "coreblow");

  const claim = await execFileAsync(
    process.execPath,
    [cliPath, "publisher", "claim", "example-org", "--dry-run", "--display-name", "Example Org"],
    { env: authEnv },
  );
  const claimPayload = JSON.parse(claim.stdout);
  assert.equal(claimPayload.dryRun, true);
  assert.equal(claimPayload.status, "planned");
  assert.equal(claimPayload.claim.handle, "example-org");

  const folderSubmit = await execFileAsync(
    process.execPath,
    [cliPath, "package", "submit", new URL("../fixtures/plugin-lab-plugin", import.meta.url).pathname, "--dry-run"],
    { env: authEnv },
  );
  const folderSubmitPayload = JSON.parse(folderSubmit.stdout);
  assert.equal(folderSubmitPayload.dryRun, true);
  assert.equal(folderSubmitPayload.submission.status, "pending_review");
  assert.equal(folderSubmitPayload.submission.packageId, "plugin-lab");
  assert.equal(folderSubmitPayload.submission.publisherHandle, "coreblow");
  assert.equal(folderSubmitPayload.artifactUpload.status, "verified");
  assert.equal(folderSubmitPayload.artifactUpload.mediaType, "application/vnd.coreblow.plugin-folder");

  const archiveSubmit = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "submit",
      new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
      "--dry-run",
    ],
    { env: authEnv },
  );
  const archiveSubmitPayload = JSON.parse(archiveSubmit.stdout);
  assert.equal(archiveSubmitPayload.source.type, "archive");
  assert.equal(archiveSubmitPayload.submission.status, "pending_review");
  assert.equal(archiveSubmitPayload.artifactUpload.sha256, pluginLabEntry.versions[0].artifact.sha256);
  assert.equal(archiveSubmitPayload.artifactUpload.size, pluginLabEntry.versions[0].artifact.size);

  const uploadRequest = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "upload",
      "request",
      new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
      "--dry-run",
    ],
    { env: authEnv },
  );
  const uploadRequestPayload = JSON.parse(uploadRequest.stdout);
  assert.equal(uploadRequestPayload.dryRun, true);
  assert.equal(uploadRequestPayload.uploadSlot.artifactUpload.status, "requested");
  assert.equal(uploadRequestPayload.uploadSlot.upload.method, "PUT");
  assert.equal(uploadRequestPayload.uploadSlot.expected.sha256, pluginLabEntry.versions[0].artifact.sha256);

  const uploadVerify = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "upload",
      "verify",
      new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
      "--upload-slot",
      uploadRequestPayload.uploadSlot.id,
      "--dry-run",
    ],
    { env: authEnv },
  );
  const uploadVerifyPayload = JSON.parse(uploadVerify.stdout);
  assert.equal(uploadVerifyPayload.status, "verified");
  assert.equal(uploadVerifyPayload.artifactUpload.status, "verified");
  assert.equal(uploadVerifyPayload.verification.checksumMatches, true);
  assert.equal(uploadVerifyPayload.verification.uploadSlotMatchesSource, true);

  const logout = await execFileAsync(process.execPath, [cliPath, "logout"], { env: authEnv });
  assert.match(logout.stdout, /Logged out/);
} finally {
  await rm(authHome, { recursive: true, force: true });
}

const skillPublish = await execFileAsync(process.execPath, [
  cliPath,
  "skill",
  "publish",
  new URL("../fixtures/example-skill", import.meta.url).pathname,
]);
assert.equal(JSON.parse(skillPublish.stdout).dryRun, true);

const bootstrapDir = await mkdtemp(join(tmpdir(), "corehub-server-"));
const bootstrapServer = await createCoreHubServer({
  dataRoot: bootstrapDir,
  host: "127.0.0.1",
  port: 0,
});
const bootstrapInfo = await bootstrapServer.listen();
try {
  const health = await fetch(bootstrapInfo.healthUrl);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "corehub-api");
  const registryInfo = await fetch(`${bootstrapInfo.url}/api/v1`);
  assert.equal(registryInfo.status, 200);
  assert.equal((await registryInfo.json()).data.name, "CoreHub Registry API");
  assert.match(bootstrapServer.statePath, /write-side-state\.json$/);
} finally {
  await bootstrapServer.close();
  await rm(bootstrapDir, { recursive: true, force: true });
}

const apiStorageDir = await mkdtemp(join(tmpdir(), "corehub-api-storage-"));
const apiStatePath = join(apiStorageDir, "write-side-state.json");
const apiStorage = new CoreHubLocalStorageAdapter({ root: apiStorageDir, statePath: apiStatePath });
const apiServer = createServer(
  createCoreHubApiHandler({
    storage: apiStorage,
    now: () => new Date("2026-05-21T00:00:00Z"),
  }),
);
await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
try {
  const apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}/corehub/api/v2`;
  const uploadRequestResponse = await fetch(`${apiBaseUrl}/artifacts/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:coreblow-admin",
    },
    body: JSON.stringify({
      packageId: "plugin-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      provider: "r2",
      artifact: {
        name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: pluginLabArtifactBytes.byteLength,
        sha256: entries[2].versions[0].artifact.sha256,
      },
    }),
  });
  assert.equal(uploadRequestResponse.status, 201);
  const uploadRequestPayload = await uploadRequestResponse.json();
  const uploadSlot = uploadRequestPayload.data.uploadSlot;
  assert.equal(uploadSlot.id, "upload-plugin-lab-0-1-0");
  assert.equal(uploadSlot.artifactUpload.status, "requested");
  assert.equal(uploadSlot.upload.method, "PUT");
  assert.equal(uploadSlot.storage.provider, "r2");

  const uploadPutResponse = await fetch(`${apiBaseUrl}/artifacts/uploads/${uploadSlot.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/vnd.coreblow.plugin-archive+gzip",
      "x-corehub-artifact-sha256": entries[2].versions[0].artifact.sha256,
    },
    body: pluginLabArtifactBytes,
  });
  assert.equal(uploadPutResponse.status, 200);
  const uploadPutPayload = await uploadPutResponse.json();
  assert.equal(uploadPutPayload.data.artifactUpload.status, "uploaded");
  assert.equal(uploadPutPayload.data.uploaded.size, pluginLabArtifactBytes.byteLength);

  const uploadVerifyResponse = await fetch(`${apiBaseUrl}/artifacts/uploads/${uploadSlot.id}/verify`, {
    method: "POST",
    headers: {
      "x-corehub-user": "github:coreblow-admin",
    },
  });
  assert.equal(uploadVerifyResponse.status, 200);
  const uploadVerifyPayload = await uploadVerifyResponse.json();
  assert.equal(uploadVerifyPayload.data.status, "verified");
  assert.equal(uploadVerifyPayload.data.artifactUpload.status, "verified");
  assert.equal(uploadVerifyPayload.data.verification.checksumMatches, true);
  assert.equal(uploadVerifyPayload.data.verification.sizeMatches, true);

  const apiAuthHome = await mkdtemp(join(tmpdir(), "corehub-api-auth-"));
  try {
    const apiRegistryUrl = `http://127.0.0.1:${apiServer.address().port}/corehub`;
    const apiAuthEnv = { ...process.env, COREHUB_HOME: apiAuthHome };
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "login",
        "--token",
        "local-dev-token",
        "--user",
        "github:coreblow-admin",
        "--publisher",
        "coreblow",
      ],
      { env: apiAuthEnv },
    );
    const remoteUploadRequest = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "upload",
        "request",
        new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
        "--registry",
        apiRegistryUrl,
        "--dry-run",
      ],
      { env: apiAuthEnv },
    );
    const remoteUploadRequestPayload = JSON.parse(remoteUploadRequest.stdout);
    assert.equal(remoteUploadRequestPayload.status, "remote_planned");
    assert.equal(remoteUploadRequestPayload.uploadSlot.id, "upload-plugin-lab-0-1-0");
    assert.equal(remoteUploadRequestPayload.uploadSlot.artifactUpload.status, "requested");

    const remoteUploadVerify = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "upload",
        "verify",
        new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
        "--upload-slot",
        remoteUploadRequestPayload.uploadSlot.id,
        "--registry",
        apiRegistryUrl,
        "--dry-run",
      ],
      { env: apiAuthEnv },
    );
    const remoteUploadVerifyPayload = JSON.parse(remoteUploadVerify.stdout);
    assert.equal(remoteUploadVerifyPayload.status, "verified");
    assert.equal(remoteUploadVerifyPayload.uploaded.uploaded.size, pluginLabArtifactBytes.byteLength);
    assert.equal(remoteUploadVerifyPayload.artifactUpload.status, "verified");
    assert.equal(remoteUploadVerifyPayload.verification.checksumMatches, true);

    const remoteSubmit = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "submit",
        new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
        "--registry",
        apiRegistryUrl,
        "--dry-run",
      ],
      { env: apiAuthEnv },
    );
    const remoteSubmitPayload = JSON.parse(remoteSubmit.stdout);
    assert.equal(remoteSubmitPayload.status, "remote_pending_review");
    assert.equal(remoteSubmitPayload.submission.status, "pending_review");
    assert.equal(remoteSubmitPayload.submission.artifactUploadId, remoteUploadVerifyPayload.artifactUpload.id);
    assert.equal(remoteSubmitPayload.artifactUpload.status, "verified");
    assert.equal(remoteSubmitPayload.packageVersionPreview.moderationStatus, "pending");
    assert.equal(remoteSubmitPayload.moderationReview.status, "open");

    const pendingSubmissionsList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "submissions",
        "list",
        "--status",
        "pending_review",
        "--limit",
        "1",
        "--offset",
        "0",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const pendingSubmissionsListPayload = JSON.parse(pendingSubmissionsList.stdout);
    assert.equal(pendingSubmissionsListPayload.status, "ok");
    assert.equal(pendingSubmissionsListPayload.count, 1);
    assert.equal(pendingSubmissionsListPayload.total, 1);
    assert.equal(pendingSubmissionsListPayload.limit, 1);
    assert.equal(pendingSubmissionsListPayload.offset, 0);
    assert.equal(pendingSubmissionsListPayload.submissions[0].submission.id, remoteSubmitPayload.submission.id);

    const remoteSubmissionInspect = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "submissions",
        "inspect",
        remoteSubmitPayload.submission.id,
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const remoteSubmissionInspectPayload = JSON.parse(remoteSubmissionInspect.stdout);
    assert.equal(remoteSubmissionInspectPayload.status, "pending_review");
    assert.equal(remoteSubmissionInspectPayload.submission.id, remoteSubmitPayload.submission.id);
    assert.equal(remoteSubmissionInspectPayload.artifactUpload.status, "verified");
    assert.equal(remoteSubmissionInspectPayload.moderationReview.status, "open");
    assert.equal(remoteSubmissionInspectPayload.packageVersion, null);

    const remoteReviewStatus = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "review",
        "status",
        remoteSubmitPayload.moderationReview.id,
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const remoteReviewStatusPayload = JSON.parse(remoteReviewStatus.stdout);
    assert.equal(remoteReviewStatusPayload.status, "open");
    assert.equal(remoteReviewStatusPayload.moderationReview.id, remoteSubmitPayload.moderationReview.id);
    assert.equal(remoteReviewStatusPayload.submission.status, "pending_review");

    const openReviewsList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "reviews",
        "list",
        "--status",
        "open",
        "--limit",
        "1",
        "--offset",
        "0",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const openReviewsListPayload = JSON.parse(openReviewsList.stdout);
    assert.equal(openReviewsListPayload.status, "ok");
    assert.equal(openReviewsListPayload.count, 1);
    assert.equal(openReviewsListPayload.total, 1);
    assert.equal(openReviewsListPayload.limit, 1);
    assert.equal(openReviewsListPayload.offset, 0);
    assert.equal(openReviewsListPayload.reviews[0].moderationReview.id, remoteSubmitPayload.moderationReview.id);

    const approve = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "review",
        "approve",
        remoteSubmitPayload.moderationReview.id,
        "--registry",
        apiRegistryUrl,
        "--notes",
        "Artifact verified and package scope approved.",
      ],
      { env: apiAuthEnv },
    );
    const approvePayload = JSON.parse(approve.stdout);
    assert.equal(approvePayload.status, "approved");
    assert.equal(approvePayload.moderationReview.status, "approved");
    assert.equal(approvePayload.moderationReview.decision, "approve");
    assert.equal(approvePayload.submission.status, "approved");
    assert.equal(approvePayload.packageVersion.status, "available");
    assert.equal(approvePayload.packageVersion.moderationStatus, "approved");

    const approvedReviewStatus = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "reviews",
        "status",
        remoteSubmitPayload.moderationReview.id,
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const approvedReviewStatusPayload = JSON.parse(approvedReviewStatus.stdout);
    assert.equal(approvedReviewStatusPayload.status, "approved");
    assert.equal(approvedReviewStatusPayload.submission.status, "approved");
    assert.equal(approvedReviewStatusPayload.packageVersion.status, "available");

    const approvedSubmissionsList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "submissions",
        "list",
        "--status",
        "approved",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const approvedSubmissionsListPayload = JSON.parse(approvedSubmissionsList.stdout);
    assert.equal(approvedSubmissionsListPayload.count, 1);
    assert.equal(approvedSubmissionsListPayload.submissions[0].submission.status, "approved");

    const remainingOpenReviewsList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "reviews",
        "list",
        "--status",
        "open",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(remainingOpenReviewsList.stdout).count, 0);

    const reviewAuditList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "audit",
        "list",
        "--target",
        remoteSubmitPayload.moderationReview.id,
        "--limit",
        "20",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const reviewAuditListPayload = JSON.parse(reviewAuditList.stdout);
    assert.equal(reviewAuditListPayload.status, "ok");
    assert.equal(reviewAuditListPayload.auditEvents.some((event) => event.action === "review.approve"), true);
    assert.equal(reviewAuditListPayload.auditEvents.some((event) => event.action === "review.inspect"), true);
    assert.equal(reviewAuditListPayload.auditEvents[0].actor.id, "github:coreblow-admin");

    const uploadAuditList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "audit",
        "list",
        "--target",
        remoteUploadVerifyPayload.artifactUpload.id,
        "--limit",
        "20",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const uploadAuditListPayload = JSON.parse(uploadAuditList.stdout);
    assert.equal(uploadAuditListPayload.auditEvents.some((event) => event.action === "artifact.upload.request"), true);
    assert.equal(uploadAuditListPayload.auditEvents.some((event) => event.action === "artifact.upload.verify"), true);

    const filteredAuditJsonl = await execFileAsync(
      process.execPath,
      [
        cliPath,
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
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const filteredAuditEvents = filteredAuditJsonl.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(filteredAuditEvents.length, 1);
    assert.equal(filteredAuditEvents[0].action, "review.approve");
    assert.equal(filteredAuditEvents[0].actor.id, "github:coreblow-admin");
    assert.equal(filteredAuditEvents[0].targetType, "review");
    assert.match(filteredAuditEvents[0].eventHash, /^[a-f0-9]{64}$/);

    const auditExportDir = await mkdtemp(join(tmpdir(), "corehub-audit-export-"));
    try {
      const outputPath = join(auditExportDir, "review-approve.audit.jsonl");
      const auditExport = await execFileAsync(
        process.execPath,
        [
          cliPath,
          "audit",
          "list",
          "--action",
          "review.approve",
          "--format",
          "jsonl",
          "--output",
          outputPath,
          "--registry",
          apiRegistryUrl,
        ],
        { env: apiAuthEnv },
      );
      const auditExportPayload = JSON.parse(auditExport.stdout);
      assert.equal(auditExportPayload.status, "exported");
      assert.equal(auditExportPayload.format, "jsonl");
      const exportedEvents = (await readFile(outputPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(exportedEvents.some((event) => event.action === "review.approve"), true);
    } finally {
      await rm(auditExportDir, { recursive: true, force: true });
    }

    const auditVerify = await execFileAsync(
      process.execPath,
      [cliPath, "audit", "verify", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const auditVerifyPayload = JSON.parse(auditVerify.stdout);
    assert.equal(auditVerifyPayload.status, "valid");
    assert.equal(auditVerifyPayload.valid, true);
    assert.match(auditVerifyPayload.head, /^[a-f0-9]{64}$/);
    assert.equal(auditVerifyPayload.behavior, "proceed");

    const auditRetention = await execFileAsync(
      process.execPath,
      [cliPath, "audit", "retention", "--dry-run", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const auditRetentionPayload = JSON.parse(auditRetention.stdout);
    assert.equal(auditRetentionPayload.policy.mode, "export-before-prune");
    assert.equal(auditRetentionPayload.policy.integrityFailureBehavior, "fail_closed");
    assert.equal(auditRetentionPayload.verification.valid, true);

    const auditIncident = await execFileAsync(
      process.execPath,
      [cliPath, "audit", "incident", "report", "--limit", "5", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const auditIncidentPayload = JSON.parse(auditIncident.stdout);
    assert.equal(auditIncidentPayload.status, "ok");
    assert.equal(auditIncidentPayload.severity, "informational");
    assert.equal(auditIncidentPayload.verification.valid, true);
    assert.equal(auditIncidentPayload.recentAuditEvents.length, 5);
    assert.equal(auditIncidentPayload.alertDelivery.status, "not_configured");
    assert.equal(auditIncidentPayload.alertDelivery.attempts, 0);

    const retentionExportDir = await mkdtemp(join(tmpdir(), "corehub-retention-export-"));
    try {
      const outputPath = join(retentionExportDir, "audit-retention.audit.jsonl");
      const auditRetentionExport = await execFileAsync(
        process.execPath,
        [
          cliPath,
          "audit",
          "retention",
          "--dry-run",
          "--output",
          outputPath,
          "--registry",
          apiRegistryUrl,
        ],
        { env: apiAuthEnv },
      );
      const auditRetentionExportPayload = JSON.parse(auditRetentionExport.stdout);
      assert.match(auditRetentionExportPayload.exportHash, /^[a-f0-9]{64}$/);
      assert.equal(auditRetentionExportPayload.verification.valid, true);
      assert.match(await readFile(outputPath, "utf8"), /review\.approve/);
      const incidentOutputPath = join(retentionExportDir, "audit-incident.md");
      const auditIncidentExport = await execFileAsync(
        process.execPath,
        [
          cliPath,
          "audit",
          "incident",
          "report",
          "--format",
          "markdown",
          "--output",
          incidentOutputPath,
          "--registry",
          apiRegistryUrl,
        ],
        { env: apiAuthEnv },
      );
      const auditIncidentExportPayload = JSON.parse(auditIncidentExport.stdout);
      assert.equal(auditIncidentExportPayload.status, "exported");
      assert.equal(auditIncidentExportPayload.incidentStatus, "ok");
      const auditIncidentMarkdown = await readFile(incidentOutputPath, "utf8");
      assert.match(auditIncidentMarkdown, /CoreHub Audit Incident Report/);
      assert.match(auditIncidentMarkdown, /Alert Delivery Status: not_configured/);
      const auditIncidentCheck = await execFileAsync(
        process.execPath,
        [
          auditIncidentCheckPath,
          "--registry",
          apiRegistryUrl,
          "--output",
          join(retentionExportDir, "automation-incident.md"),
          "--limit",
          "5",
        ],
        { env: apiAuthEnv },
      );
      assert.equal(JSON.parse(auditIncidentCheck.stdout).incidentStatus, "ok");
    } finally {
      await rm(retentionExportDir, { recursive: true, force: true });
    }

    const projectedEntriesResponse = await fetch(`${apiRegistryUrl}/api/v1/entries`);
    assert.equal(projectedEntriesResponse.status, 200);
    const projectedEntriesPayload = await projectedEntriesResponse.json();
    assert.equal(projectedEntriesPayload.apiVersion, "v1");
    assert.equal(projectedEntriesPayload.data.length, 1);
    assert.equal(projectedEntriesPayload.data[0].id, "plugin-lab");
    assert.equal(projectedEntriesPayload.data[0].review.state, "verified");
    assert.equal(projectedEntriesPayload.data[0].versions[0].status, "available");
    assert.equal(projectedEntriesPayload.data[0].versions[0].artifact.sha256, entries[2].versions[0].artifact.sha256);

    const projectedPackageResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab`);
    assert.equal(projectedPackageResponse.status, 200);
    const projectedPackagePayload = await projectedPackageResponse.json();
    assert.equal(projectedPackagePayload.data.publisher.handle, "coreblow");
    assert.equal(projectedPackagePayload.data.versions[0].artifact.storage.provider, "r2");

    const projectedVersionsResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/versions`);
    assert.equal(projectedVersionsResponse.status, 200);
    const projectedVersionsPayload = await projectedVersionsResponse.json();
    assert.equal(projectedVersionsPayload.data[0].tag, "latest");

    const persistedState = JSON.parse(await readFile(apiStatePath, "utf8"));
    assert.equal(persistedState.schemaVersion, "corehub.local-state.v1");
    assert.equal(persistedState.slots[0].artifactUpload.status, "verified");
    assert.equal(persistedState.submissions[0].submission.status, "approved");
    assert.equal(persistedState.packageVersions[0].status, "available");
    assert.equal(persistedState.auditEvents.some((event) => event.action === "submission.create"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "audit.list"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "audit.retention.inspect"), true);
    assert.equal(persistedState.auditEvents.every((event) => /^[a-f0-9]{64}$/.test(event.eventHash)), true);

    const reloadedStorage = await CoreHubLocalStorageAdapter.open({
      root: apiStorageDir,
      statePath: apiStatePath,
    });
    const reloadedEntries = reloadedStorage.projectCatalogEntries();
    assert.equal(reloadedEntries.length, 1);
    assert.equal(reloadedEntries[0].id, "plugin-lab");
    assert.equal(reloadedEntries[0].versions[0].artifact.sha256, entries[2].versions[0].artifact.sha256);
    assert.ok(reloadedStorage.listAuditEvents({ target: remoteSubmitPayload.moderationReview.id }).items.length > 0);
    assert.equal(reloadedStorage.verifyAuditEvents().valid, true);
  } finally {
    await rm(apiAuthHome, { recursive: true, force: true });
  }
} finally {
  await new Promise((resolve) => apiServer.close(resolve));
  await rm(apiStorageDir, { recursive: true, force: true });
}

const blockStorageDir = await mkdtemp(join(tmpdir(), "corehub-block-storage-"));
const blockStorage = new CoreHubLocalStorageAdapter({ root: blockStorageDir });
const blockServer = createServer(
  createCoreHubApiHandler({
    storage: blockStorage,
    now: () => new Date("2026-05-21T01:00:00Z"),
  }),
);
await new Promise((resolve) => blockServer.listen(0, "127.0.0.1", resolve));
try {
  const blockApiBaseUrl = `http://127.0.0.1:${blockServer.address().port}/corehub/api/v2`;
  const uploadRequestResponse = await fetch(`${blockApiBaseUrl}/artifacts/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:coreblow-admin",
    },
    body: JSON.stringify({
      packageId: "plugin-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      provider: "r2",
      artifact: {
        name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: pluginLabArtifactBytes.byteLength,
        sha256: entries[2].versions[0].artifact.sha256,
      },
    }),
  });
  const uploadSlot = (await uploadRequestResponse.json()).data.uploadSlot;
  await fetch(`${blockApiBaseUrl}/artifacts/uploads/${uploadSlot.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/vnd.coreblow.plugin-archive+gzip",
      "x-corehub-artifact-sha256": entries[2].versions[0].artifact.sha256,
    },
    body: pluginLabArtifactBytes,
  });
  const verified = await fetch(`${blockApiBaseUrl}/artifacts/uploads/${uploadSlot.id}/verify`, {
    method: "POST",
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal((await verified.json()).data.status, "verified");
  const submissionResponse = await fetch(`${blockApiBaseUrl}/submissions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:coreblow-admin",
    },
    body: JSON.stringify({
      packageId: "plugin-lab",
      kind: "plugin",
      publisherHandle: "coreblow",
      version: "0.1.0",
      artifactUploadId: uploadSlot.artifactUpload.id,
      source: "https://github.com/coreblow/plugin-lab",
      changelog: "Blocked fixture review.",
    }),
  });
  const submissionPayload = await submissionResponse.json();
  const blockAuthHome = await mkdtemp(join(tmpdir(), "corehub-block-auth-"));
  try {
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "login",
        "--token",
        "local-dev-token",
        "--user",
        "moderator:corehub",
        "--publisher",
        "coreblow",
      ],
      { env: { ...process.env, COREHUB_HOME: blockAuthHome } },
    );
    const block = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "review",
        "block",
        submissionPayload.data.moderationReview.id,
        "--registry",
        blockApiBaseUrl.replace("/api/v2", ""),
        "--notes",
        "Blocked by moderation fixture.",
      ],
      { env: { ...process.env, COREHUB_HOME: blockAuthHome } },
    );
    const blockPayload = JSON.parse(block.stdout);
    assert.equal(blockPayload.status, "blocked");
    assert.equal(blockPayload.moderationReview.status, "blocked");
    assert.equal(blockPayload.moderationReview.decision, "block");
    assert.equal(blockPayload.submission.status, "rejected");
    assert.equal(blockPayload.packageVersion.status, "blocked");
    assert.equal(blockPayload.packageVersion.moderationStatus, "blocked");
  } finally {
    await rm(blockAuthHome, { recursive: true, force: true });
  }
  const blockedEntries = await fetch(`${blockApiBaseUrl.replace("/api/v2", "/api/v1")}/entries`);
  assert.equal((await blockedEntries.json()).data.length, 0);
} finally {
  await new Promise((resolve) => blockServer.close(resolve));
  await rm(blockStorageDir, { recursive: true, force: true });
}

const queueStorageDir = await mkdtemp(join(tmpdir(), "corehub-queue-storage-"));
try {
  const queueStorage = new CoreHubLocalStorageAdapter({ root: queueStorageDir });
  for (const item of [
    { id: "old", submittedAt: "2026-05-21T00:00:00Z", reviewStatus: "open" },
    { id: "new", submittedAt: "2026-05-21T00:01:00Z", reviewStatus: "open" },
  ]) {
    queueStorage.submissions.set(`submission-${item.id}`, {
      artifactUploadId: `artifact-${item.id}`,
      submission: {
        id: `submission-${item.id}`,
        packageId: `plugin-${item.id}`,
        kind: "plugin",
        publisherHandle: "coreblow",
        version: "0.1.0",
        status: "pending_review",
        artifactUploadId: `artifact-${item.id}`,
        changelog: "Queue ordering fixture.",
        submittedBy: { type: "user", id: "github:coreblow-admin" },
        submittedAt: item.submittedAt,
        reviewId: `review-${item.id}`,
      },
      packageVersionPreview: {
        id: `version-${item.id}`,
        packageId: `plugin-${item.id}`,
        version: "0.1.0",
        tag: "latest",
        publisherHandle: "coreblow",
        status: "pending_review",
        artifactUploadId: `artifact-${item.id}`,
        submissionId: `submission-${item.id}`,
        createdAt: item.submittedAt,
        moderationStatus: "pending",
      },
    });
    queueStorage.reviews.set(`review-${item.id}`, {
      id: `review-${item.id}`,
      targetType: "submission",
      targetId: `submission-${item.id}`,
      status: item.reviewStatus,
      decision: "none",
      reviewedBy: { type: "user", id: "github:coreblow-admin" },
      createdAt: item.submittedAt,
    });
  }
  const firstSubmissionPage = queueStorage.listSubmissions({ status: "pending_review", limit: 1, offset: 0 });
  assert.equal(firstSubmissionPage.meta.total, 2);
  assert.equal(firstSubmissionPage.meta.count, 1);
  assert.equal(firstSubmissionPage.items[0].submission.id, "submission-new");
  const secondSubmissionPage = queueStorage.listSubmissions({ status: "pending_review", limit: 1, offset: 1 });
  assert.equal(secondSubmissionPage.items[0].submission.id, "submission-old");
  const firstReviewPage = queueStorage.listReviews({ status: "open", limit: 1, offset: 0 });
  assert.equal(firstReviewPage.meta.total, 2);
  assert.equal(firstReviewPage.items[0].moderationReview.id, "review-new");
} finally {
  await rm(queueStorageDir, { recursive: true, force: true });
}

const retentionStorageDir = await mkdtemp(join(tmpdir(), "corehub-retention-storage-"));
try {
  const retentionStorage = new CoreHubLocalStorageAdapter({
    root: retentionStorageDir,
    auditRetentionDays: 1,
  });
  retentionStorage.recordAuditEvent({
    actor: { type: "system", id: "system:retention-test" },
    action: "audit.old",
    targetType: "audit",
    targetId: "old",
    metadata: {},
    createdAt: "2026-05-20T00:00:00.000Z",
  });
  retentionStorage.recordAuditEvent({
    actor: { type: "system", id: "system:retention-test" },
    action: "audit.recent",
    targetType: "audit",
    targetId: "recent",
    metadata: {},
    createdAt: "2026-05-21T12:00:00.000Z",
  });
  const retentionNow = new Date("2026-05-22T12:00:00.000Z");
  const retentionPlan = retentionStorage.auditRetentionPlan({ now: retentionNow });
  assert.equal(retentionPlan.status, "ready");
  assert.equal(retentionPlan.pruneableCount, 1);
  assert.equal(retentionPlan.requiresExportBeforePrune, true);

  const pruned = await retentionStorage.pruneAuditEvents({
    actor: { type: "user", id: "github:coreblow-admin" },
    dryRun: false,
    exportHash: "b".repeat(64),
    exportedAt: "2026-05-22T12:00:00.000Z",
    exportedCount: 2,
    now: retentionNow,
  });
  assert.equal(pruned.status, "pruned");
  assert.equal(pruned.checkpoint.prunedThroughSequence, 1);
  assert.equal(retentionStorage.auditCheckpoints.length, 1);
  assert.equal(retentionStorage.auditEvents.some((event) => event.action === "audit.old"), false);
  assert.equal(retentionStorage.auditEvents.some((event) => event.action === "audit.retention.prune"), true);
  assert.equal(retentionStorage.verifyAuditEvents().valid, true);

  retentionStorage.auditEvents[0].targetId = "tampered";
  const invalidRetention = retentionStorage.verifyAuditEvents();
  assert.equal(invalidRetention.valid, false);
  assert.equal(invalidRetention.behavior, "fail_closed");
  assert.match(invalidRetention.recommendation, /escalate/);
  const blockedPrune = await retentionStorage.pruneAuditEvents({ now: retentionNow });
  assert.equal(blockedPrune.status, "blocked");
} finally {
  await rm(retentionStorageDir, { recursive: true, force: true });
}

const incidentStorageDir = await mkdtemp(join(tmpdir(), "corehub-incident-storage-"));
try {
  const incidentStorage = new CoreHubLocalStorageAdapter({ root: incidentStorageDir });
  incidentStorage.recordAuditEvent({
    actor: { type: "system", id: "system:incident-test" },
    action: "audit.fixture",
    targetType: "audit",
    targetId: "fixture",
    metadata: {},
    createdAt: "2026-05-22T12:00:00.000Z",
  });
  incidentStorage.auditEvents[0].targetId = "tampered";
  const incidentServer = createServer(
    createCoreHubApiHandler({
      storage: incidentStorage,
      now: () => new Date("2026-05-22T12:01:00.000Z"),
    }),
  );
  try {
    await new Promise((resolve) => incidentServer.listen(0, "127.0.0.1", resolve));
    const address = incidentServer.address();
    const incidentRegistryUrl = `http://127.0.0.1:${address.port}/corehub`;
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "audit", "incident", "report", "--registry", incidentRegistryUrl]),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.status, "fail_closed");
        assert.equal(payload.severity, "critical");
        assert.match(payload.summary, /suspect/);
        assert.equal(payload.verification.behavior, "fail_closed");
        return true;
      },
    );
    const incidentAutomationOutput = join(incidentStorageDir, "incident.md");
    await assert.rejects(
      execFileAsync(process.execPath, [
        auditIncidentCheckPath,
        "--registry",
        incidentRegistryUrl,
        "--output",
        incidentAutomationOutput,
      ]),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.incidentStatus, "fail_closed");
        return true;
      },
    );
    assert.match(await readFile(incidentAutomationOutput, "utf8"), /Status: fail_closed/);
  } finally {
    await new Promise((resolve) => incidentServer.close(resolve));
  }
} finally {
  await rm(incidentStorageDir, { recursive: true, force: true });
}

const registryServer = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json;charset=UTF-8");

  if (url.pathname === "/corehub/api/v1/entries") {
    response.end(JSON.stringify({ apiVersion: "v1", data: [entries[1]], meta: { count: 1 } }));
    return;
  }

  if (url.pathname === "/corehub/api/v1") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          name: "CoreHub Registry API",
          entries: "/corehub/api/v1/entries",
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/search") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: [{ ...entries[2], score: 8 }],
        meta: { count: 1, query: url.searchParams.get("q") },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab") {
    response.end(JSON.stringify({ apiVersion: "v1", data: entries[2], meta: { count: 1 } }));
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/versions") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: new CoreHubCatalog(entries).listVersions("plugin-lab"),
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/artifact") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          package: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab" },
          version: "0.1.0",
          publisher: { handle: "coreblow" },
          artifact: pluginLabRemoteArtifact,
          files: [],
          download: { available: true, url: new URL(pluginLabArtifactUrl, `http://${request.headers.host}`) },
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/download") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          package: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab" },
          version: "0.1.0",
          publisher: { handle: "coreblow" },
          artifact: pluginLabRemoteArtifact,
          download: {
            available: true,
            url: new URL(pluginLabArtifactUrl, `http://${request.headers.host}`),
          },
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === pluginLabArtifactUrl) {
    response.setHeader("Content-Type", "application/vnd.coreblow.plugin-archive+gzip");
    response.end(pluginLabArtifactBytes);
    return;
  }

  if (url.pathname === "/corehub/api/v1/publishers") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: [{ handle: "coreblow", displayName: "CoreBlow", entries: [entries[2]] }],
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/publishers/coreblow") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: { handle: "coreblow", displayName: "CoreBlow", entries: [entries[2]] },
        meta: { count: 1 },
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ apiVersion: "v1", data: null, meta: { count: 0 } }));
});

await new Promise((resolve) => registryServer.listen(0, "127.0.0.1", resolve));
try {
  const registryUrl = `http://127.0.0.1:${registryServer.address().port}/corehub`;
  const remoteExplore = await execFileAsync(process.execPath, [
    cliPath,
    "explore",
    "--registry",
    registryUrl,
  ]);
  assert.match(remoteExplore.stdout, /corehub-directory\tskill\tCoreHub Directory Metadata/);

  const remoteSearch = await execFileAsync(process.execPath, [
    cliPath,
    "search",
    "plugin",
    "--registry",
    registryUrl,
  ]);
  assert.match(remoteSearch.stdout, /plugin-lab\tplugin\tPlugin Lab score=8/);

  const remoteInspect = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "inspect",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteInspect.stdout).id, "plugin-lab");

  const remoteVersions = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "versions",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.match(remoteVersions.stdout, /plugin-lab\tlatest\t0\.1\.0\tavailable/);

  const remoteArtifact = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "artifact",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteArtifact.stdout).artifact.downloadEnabled, true);

  const remoteDownload = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "download",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteDownload.stdout).download.available, true);

  const downloadDir = await mkdtemp(join(tmpdir(), "corehub-download-"));
  try {
    const downloadPath = join(downloadDir, "plugin-lab.coreblow-plugin.tgz");
    const remoteVerifiedDownload = await execFileAsync(process.execPath, [
      cliPath,
      "package",
      "download",
      "plugin-lab",
      "--output",
      downloadPath,
      "--registry",
      registryUrl,
    ]);
    const verified = JSON.parse(remoteVerifiedDownload.stdout);
    assert.equal(verified.output.verified, true);
    assert.equal(verified.output.bytes, entries[2].versions[0].artifact.size);
    assert.equal(verified.output.sha256, entries[2].versions[0].artifact.sha256);
    assert.deepEqual(await readFile(downloadPath), pluginLabArtifactBytes);
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }

  const installDir = await mkdtemp(join(tmpdir(), "corehub-install-"));
  try {
    const installPath = join(installDir, "plugin-lab.coreblow-plugin.tgz");
    const remoteInstall = await execFileAsync(process.execPath, [
      cliPath,
      "package",
      "install",
      "plugin-lab",
      "--output",
      installPath,
      "--registry",
      registryUrl,
    ]);
    const plan = JSON.parse(remoteInstall.stdout);
    assert.equal(plan.dryRun, false);
    assert.equal(plan.install.status, "blocked");
    assert.equal(plan.download.verified, true);
    assert.equal(plan.download.output.bytes, entries[2].versions[0].artifact.size);
    assert.equal(plan.download.output.sha256, entries[2].versions[0].artifact.sha256);
    assert.equal(plan.plan.find((step) => step.step === "fetch-artifact").status, "complete");
    assert.deepEqual(await readFile(installPath), pluginLabArtifactBytes);
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }

  const remoteTopLevelPreview = await execFileAsync(process.execPath, [
    cliPath,
    "install",
    "plugin-lab",
    "--dry-run",
    "--json",
    "--registry",
    registryUrl,
  ]);
  const remotePreview = JSON.parse(remoteTopLevelPreview.stdout);
  assert.equal(remotePreview.dryRun, true);
  assert.equal(remotePreview.install.status, "planned");

  const remoteTopLevelInstall = await execFileAsync(process.execPath, [
    cliPath,
    "install",
    "plugin-lab",
    "--json",
    "--registry",
    registryUrl,
  ]);
  const remoteInstallPlan = JSON.parse(remoteTopLevelInstall.stdout);
  assert.equal(remoteInstallPlan.dryRun, false);
  assert.equal(remoteInstallPlan.install.status, "blocked");
  assert.equal(remoteInstallPlan.download.verified, true);
  assert.equal(remoteInstallPlan.download.output.bytes, entries[2].versions[0].artifact.size);
  assert.match(remoteInstallPlan.install.message, /verified an installable CoreBlow plugin archive/);

  const remotePublishers = await execFileAsync(process.execPath, [
    cliPath,
    "publishers",
    "list",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remotePublishers.stdout)[0].handle, "coreblow");

  const remotePublisher = await execFileAsync(process.execPath, [
    cliPath,
    "publishers",
    "inspect",
    "coreblow",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remotePublisher.stdout).handle, "coreblow");

  const remoteInfo = await execFileAsync(process.execPath, [
    cliPath,
    "registry",
    "info",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteInfo.stdout).name, "CoreHub Registry API");
} finally {
  await new Promise((resolve) => registryServer.close(resolve));
}
