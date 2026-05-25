import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  CoreHubD1StateStore,
  CoreHubLocalJsonStateStore,
  CoreHubLocalStorageAdapter,
  CoreHubSnapshotStateStore,
  createCoreHubApiHandler,
  signJwt,
  verifyJwt,
} from "../src/api-server.mjs";
import { CoreHubCatalog, CoreHubSkillInspector, validateCatalog } from "../src/corehub.mjs";
import { createCoreHubServer } from "../src/server.mjs";
import coreHubWorker, { handleCoreHubWorkerRequest } from "../src/worker.mjs";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";
import { runAuditIncidentCheck } from "../ops/cloudflare/audit-incident-worker.mjs";
import {
  buildAuditAlertPayload,
  deliverAuditAlert,
  formatAuditAlertDeliveryMetricsJsonl,
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

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signTestJwt(payload, privateKey, { kid = "test-key" } = {}) {
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT", kid });
  const encodedPayload = base64UrlJson(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKey).toString("base64url")}`;
}
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

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
  assert.equal(alertedWorkerReport.alertDelivery.metrics.length, 2);
  assert.equal(alertedWorkerReport.alertDelivery.metrics[0].eventType, "alert.delivery.attempt");
  assert.equal(alertedWorkerReport.alertDelivery.metrics[0].status, "delivered");
  assert.match(formatAuditAlertDeliveryMetricsJsonl(alertedWorkerReport.alertDelivery.metrics), /alert\.delivery\.final/);
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
  assert.equal(retriedDelivery.metrics.filter((metric) => metric.status === "retry").length, 2);
  assert.equal(retriedDelivery.metrics.at(-1).eventType, "alert.delivery.final");
  assert.equal(retriedDelivery.metrics.at(-1).status, "delivered");

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
  assert.equal(deadLetterDelivery.metrics.at(-1).status, "dead_letter");
  assert.equal(deadLetterDelivery.metrics.filter((metric) => metric.status === "failed").length, 1);

  const metricsDir = await mkdtemp(join(tmpdir(), "corehub-alert-metrics-"));
  try {
    const metricsPath = join(metricsDir, "delivery-metrics.jsonl");
    const metricsText = `${formatAuditAlertDeliveryMetricsJsonl([
      ...retriedDelivery.metrics,
      ...deadLetterDelivery.metrics,
    ])}\nignored log line\n`;
    await writeFile(metricsPath, metricsText);
    const metricsSummary = await execFileAsync(process.execPath, [
      new URL("../src/cli.mjs", import.meta.url).pathname,
      "audit",
      "alert-metrics",
      "summarize",
      metricsPath,
    ]);
    const metricsPayload = JSON.parse(metricsSummary.stdout);
    assert.equal(metricsPayload.parsedMetrics, 7);
    assert.equal(metricsPayload.ignoredLines, 1);
    assert.equal(metricsPayload.finalStatusCounts.delivered, 1);
    assert.equal(metricsPayload.finalStatusCounts.dead_letter, 1);
    assert.equal(metricsPayload.attemptStatusCounts.retry, 3);
    assert.equal(metricsPayload.attemptStatusCounts.failed, 1);
    assert.equal(metricsPayload.rates.delivered, 0.5);
    assert.equal(metricsPayload.rates.deadLetter, 0.5);
    assert.equal(metricsPayload.rates.retry, 0.6);

    const metricsMarkdownPath = join(metricsDir, "delivery-metrics.md");
    const metricsMarkdownSummary = await execFileAsync(process.execPath, [
      new URL("../src/cli.mjs", import.meta.url).pathname,
      "audit",
      "alert-metrics",
      "summarize",
      metricsPath,
      "--format",
      "markdown",
      "--output",
      metricsMarkdownPath,
    ]);
    assert.equal(JSON.parse(metricsMarkdownSummary.stdout).status, "exported");
    assert.match(await readFile(metricsMarkdownPath, "utf8"), /Dead-letter Rate: 50\.00%/);

    const passingAssert = await execFileAsync(process.execPath, [
      new URL("../src/cli.mjs", import.meta.url).pathname,
      "audit",
      "alert-metrics",
      "assert",
      metricsPath,
      "--max-dead-letter-rate",
      "0.5",
      "--max-retry-rate",
      "0.6",
    ]);
    assert.equal(JSON.parse(passingAssert.stdout).status, "passed");

    await assert.rejects(
      execFileAsync(process.execPath, [
        new URL("../src/cli.mjs", import.meta.url).pathname,
        "audit",
        "alert-metrics",
        "assert",
        metricsPath,
        "--max-dead-letter-rate",
        "0",
        "--max-retry-rate",
        "0.25",
      ]),
      (error) => {
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.status, "failed");
        assert.equal(payload.failures.length, 2);
        assert.equal(payload.failures[0].name, "deadLetter");
        return true;
      },
    );
  } finally {
    await rm(metricsDir, { recursive: true, force: true });
  }

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
assert.equal(catalog.plugins({ category: "dev-tools" }).some((entry) => entry.id === "plugin-lab"), true);
assert.equal(catalog.search("plugin", { pluginOnly: true, family: "code-plugin" })[0].marketplace.family, "code-plugin");
assert.equal(catalog.search("plugin", { capabilityTag: "contract-validation" })[0].id, "plugin-lab");

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
const d1MigrationPath = new URL("../scripts/corehub-d1-migration.mjs", import.meta.url).pathname;
const persistenceSnapshotPath = new URL("../scripts/persistence-snapshot.mjs", import.meta.url).pathname;
const persistenceMigrationSmokePath = new URL("../scripts/smoke-persistence-migration.mjs", import.meta.url).pathname;
const productionDrillPath = new URL("../scripts/production-drill-rehearsal.mjs", import.meta.url).pathname;
const productionFinalizationPath = new URL("../scripts/validate-production-finalization.mjs", import.meta.url).pathname;
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
const packageArtifactPayload = JSON.parse(packageArtifact.stdout);
assert.equal(packageArtifactPayload.artifact.downloadEnabled, true);
assert.equal(packageArtifactPayload.artifact.kind, "npm-pack");
assert.equal(packageArtifactPayload.artifact.npm.integrity, pluginLabEntry.versions[0].artifact.npm.integrity);
assert.equal(packageArtifactPayload.artifact.npmShasum, pluginLabEntry.versions[0].artifact.npm.shasum);
assert.equal(packageArtifactPayload.artifact.fileCount, 5);
assert.equal(packageArtifactPayload.artifact.capabilities.executesCode, true);

const packageFiles = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "files",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageFiles.stdout).artifact.name, "plugin-lab-0.1.0.coreblow-plugin.tgz");
assert.equal(JSON.parse(packageFiles.stdout).artifact.files.length, 5);

const packageDownload = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "download",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageDownload.stdout).download.available, true);

const packageVerify = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "verify",
  new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
  "--sha256",
  pluginLabEntry.versions[0].artifact.sha256,
]);
assert.equal(JSON.parse(packageVerify.stdout).status, "verified");

const packageModerationStatus = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "moderation-status",
  "plugin-lab",
]);
const packageModerationStatusPayload = JSON.parse(packageModerationStatus.stdout);
assert.equal(packageModerationStatusPayload.status, "ok");
assert.equal(packageModerationStatusPayload.latestVersion.blockedFromDownload, false);

const packageReadiness = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "readiness",
  "plugin-lab",
]);
const packageReadinessPayload = JSON.parse(packageReadiness.stdout);
assert.equal(packageReadinessPayload.ready, true);
assert.deepEqual(packageReadinessPayload.blockers, []);
assert.equal(packageReadinessPayload.checks.some((check) => check.id === "coreblow-compatibility"), true);

const localInstallHome = await mkdtemp(join(tmpdir(), "corehub-local-install-home-"));
try {
  const packageInstall = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "install",
      "plugin-lab",
    ],
    { env: { ...process.env, COREHUB_HOME: localInstallHome } },
  );
  const installPlan = JSON.parse(packageInstall.stdout);
  assert.equal(installPlan.dryRun, false);
  assert.equal(installPlan.install.status, "installed");
  assert.equal(installPlan.download.verified, true);
  assert.match(installPlan.install.message, /recorded local install state/);
  assert.equal(installPlan.plan.at(-1).step, "install-plugin");
} finally {
  await rm(localInstallHome, { recursive: true, force: true });
}

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
  assert.equal(folderSubmitPayload.artifactUpload.files.length, 5);

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
  assert.equal(archiveSubmitPayload.artifactUpload.files.length, 5);
  assert.equal(archiveSubmitPayload.artifactUpload.npm.integrity, pluginLabEntry.versions[0].artifact.npm.integrity);

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

  const packagePublish = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "publish",
      new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
      "--family",
      "code-plugin",
      "--dry-run",
      "--registry",
      "https://coreblow.com/corehub",
    ],
    { env: authEnv },
  );
  const packagePublishPayload = JSON.parse(packagePublish.stdout);
  assert.equal(packagePublishPayload.dryRun, true);
  assert.equal(packagePublishPayload.status, "remote_publish_planned");
  assert.equal(packagePublishPayload.package.id, "plugin-lab");
  assert.equal(packagePublishPayload.package.kind, "plugin");
  assert.equal(packagePublishPayload.artifact.sha256, pluginLabEntry.versions[0].artifact.sha256);
  assert.equal(packagePublishPayload.uploadPlan.endpoint, "/corehub/api/v2/artifacts/uploads");
  assert.equal(packagePublishPayload.submissionPlan.reviewStatus, "pending_review");
  assert.match(packagePublishPayload.nextStep, /protected publisher workflow/);

  const packagePublishWorkflow = await readFile(
    new URL("../.github/workflows/package-publish.yml", import.meta.url),
    "utf8",
  );
  assert.match(packagePublishWorkflow, /name: Run CoreHub package publish/);
  assert.match(packagePublishWorkflow, /args=\("package" "publish" "\$source_path" "--registry" "\$INPUT_REGISTRY"\)/);
  assert.match(packagePublishWorkflow, /live CoreHub package publish requires secrets\.corehub_token/);
  assert.match(packagePublishWorkflow, /live CoreHub package publish must run from a protected branch or tag/);
  assert.match(packagePublishWorkflow, /official live publish requires publish_token_id, mint_publish_token, or manual_override_reason/);
  assert.match(packagePublishWorkflow, /--oidc/);
  assert.match(packagePublishWorkflow, /corehub-publish-token\.json/);
  assert.doesNotMatch(packagePublishWorkflow, /dry-run only until production write-side publish is opened/);

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

const officialGuardRoot = await mkdtemp(join(tmpdir(), "corehub-official-guard-"));
try {
  const storage = new CoreHubLocalStorageAdapter({
    root: officialGuardRoot,
    adminActorIds: ["github:trusted-admin"],
  });
  const ownerActor = { type: "user", id: "github:coreblow-admin" };
  const adminActor = { type: "user", id: "github:trusted-admin" };
  const artifact = {
    name: "official-guard-0.0.1.coreblow-plugin.tgz",
    mediaType: "application/vnd.coreblow.plugin-archive+gzip",
    size: entries[2].versions[0].artifact.size,
    sha256: entries[2].versions[0].artifact.sha256,
    url: "https://raw.githubusercontent.com/coreblow/corehub/b184ccee4dc283abf850d880f971ef103ddb2ab8/artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz",
  };
  const stableSlot = await storage.requestUploadSlot(
    {
      packageId: "official-guard",
      version: "0.0.1",
      publisherHandle: "coreblow",
      provider: "external-url",
      artifact,
    },
    { actor: ownerActor },
  );
  const stableSubmission = await storage.createSubmission(
    {
      packageId: "official-guard",
      version: "0.0.1",
      publisherHandle: "coreblow",
      kind: "plugin",
      artifactUploadId: stableSlot.artifactUpload.id,
      source: "https://github.com/coreblow/official-guard",
      changelog: "Seed owner for official channel guard.",
      channel: "stable",
    },
    { actor: ownerActor },
  );
  await storage.decideReview(stableSubmission.moderationReview.id, "approve", { notes: "seed" }, { actor: adminActor });

  const officialSlot = await storage.requestUploadSlot(
    {
      packageId: "official-guard",
      version: "0.0.2",
      publisherHandle: "coreblow",
      provider: "external-url",
      artifact: { ...artifact, name: "official-guard-0.0.2.coreblow-plugin.tgz" },
    },
    { actor: ownerActor },
  );
  const officialSubmission = {
    packageId: "official-guard",
    version: "0.0.2",
    publisherHandle: "coreblow",
    kind: "plugin",
    artifactUploadId: officialSlot.artifactUpload.id,
    source: "https://github.com/coreblow/official-guard",
    changelog: "Official channel guard fixture.",
    channel: "official",
  };
  await assert.rejects(
    () => storage.createSubmission(officialSubmission, { actor: ownerActor }),
    /Official channel submissions require admin or trusted publisher token/,
  );
  await assert.rejects(
    () =>
      storage.createSubmission(
        { ...officialSubmission, manualOverrideReason: "Owner override should not bypass official guard." },
        { actor: ownerActor },
      ),
    /Official channel submissions require admin or trusted publisher token/,
  );
  await storage.setTrustedPublisher(
    "official-guard",
    { repository: "coreblow/official-guard", workflowFilename: "publish.yml" },
    { actor: ownerActor },
  );
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  storage.githubOidcJwks = { keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }] };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oidcClaims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "corehub-publish-token",
    sub: "repo:coreblow/official-guard:ref:refs/heads/main",
    repository: "coreblow/official-guard",
    repository_id: "123456",
    repository_owner: "coreblow",
    repository_owner_id: "42",
    job_workflow_ref: "coreblow/official-guard/.github/workflows/publish.yml@refs/heads/main",
    job_workflow_sha: "abc123workflow",
    workflow_ref: "coreblow/official-guard/.github/workflows/publish.yml@refs/heads/main",
    run_id: "12345",
    run_attempt: "1",
    sha: "abc123",
    ref: "refs/heads/main",
    nbf: nowSeconds - 60,
    exp: nowSeconds + 300,
  };
  await assert.rejects(
    () =>
      storage.mintPublishToken(
        "official-guard",
        {
          version: "0.0.2",
          oidcToken: signTestJwt({ ...oidcClaims, repository: "other/repo" }, privateKey),
        },
        { actor: ownerActor },
      ),
    /OIDC repository does not match trusted publisher config/,
  );
  const publishToken = await storage.mintPublishToken(
    "official-guard",
    {
      version: "0.0.2",
      oidcToken: signTestJwt(oidcClaims, privateKey),
    },
    { actor: ownerActor },
  );
  assert.equal(publishToken.publishToken.oidc.issuer, "https://token.actions.githubusercontent.com");
  assert.equal(publishToken.publishToken.oidc.jobWorkflowRef, oidcClaims.job_workflow_ref);
  const officialAccepted = await storage.createSubmission(
    { ...officialSubmission, publishTokenId: publishToken.publishToken.id },
    { actor: ownerActor },
  );
  assert.equal(officialAccepted.submission.status, "pending_review");
  assert.equal(officialAccepted.submission.channel, "official");
  assert.equal(officialAccepted.submission.publishTokenId, publishToken.publishToken.id);
  assert.equal(storage.publishTokens.get(publishToken.publishToken.id).usedBy.id, ownerActor.id);
  assert.equal(storage.auditEvents.some((event) => event.action === "package.publish_token.use"), true);
} finally {
  await rm(officialGuardRoot, { recursive: true, force: true });
}

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
  const adminPage = await fetch(`${bootstrapInfo.url}/admin`);
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get("content-type"), /text\/html/);
  const adminPageHtml = await adminPage.text();
  assert.match(adminPageHtml, /CoreHub Admin/);
  assert.match(adminPageHtml, /corehub\.admin\.session\.v1/);
  assert.match(adminPageHtml, /api\("\/session\/validate\?role=" \+ encodeURIComponent\(role\)\)/);
  assert.match(adminPageHtml, /api\("\/admin\/status"\)/);
  assert.match(adminPageHtml, /api\("\/reviews\?status=open&limit=25"\)/);
  const publisherPage = await fetch(`${bootstrapInfo.url}/publisher`);
  assert.equal(publisherPage.status, 200);
  assert.match(publisherPage.headers.get("content-type"), /text\/html/);
  const publisherPageHtml = await publisherPage.text();
  assert.match(publisherPageHtml, /CoreHub Publisher Portal/);
  assert.match(publisherPageHtml, /corehub\.publisher\.session\.v1/);
  assert.match(publisherPageHtml, /api\("\/session\/validate\?role=" \+ encodeURIComponent\(role\)\)/);
  assert.match(publisherPageHtml, /api\("\/publisher\/dashboard"\)/);
  assert.match(publisherPageHtml, /Upload Artifact and Submit Package/);
  assert.equal(bootstrapServer.stateStoreKind, "local-json");
  assert.match(bootstrapServer.statePath, /write-side-state\.json$/);
} finally {
  await bootstrapServer.close();
  await rm(bootstrapDir, { recursive: true, force: true });
}

const d1BootstrapDir = await mkdtemp(join(tmpdir(), "corehub-server-d1-"));
try {
  const d1Rows = new Map();
  const d1BootstrapServer = await createCoreHubServer({
    dataRoot: d1BootstrapDir,
    host: "127.0.0.1",
    port: 0,
    stateStoreKind: "d1",
    d1Database: createMockD1Database(d1Rows),
  });
  const slot = await d1BootstrapServer.storage.requestUploadSlot({
    packageId: "plugin-lab",
    version: "0.3.0",
    publisherHandle: "coreblow",
    provider: "managed",
    artifact: {
      name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: pluginLabArtifactBytes.byteLength,
      sha256: entries[2].versions[0].artifact.sha256,
    },
  });
  assert.equal(d1BootstrapServer.stateStoreKind, "d1");
  assert.equal(d1BootstrapServer.statePath, null);
  assert.equal(d1BootstrapServer.stateStoreKey, "write-side-state");
  assert.equal(d1BootstrapServer.stateStoreTable, "corehub_state");
  assert.equal(JSON.parse(d1Rows.get(`corehub_state_rows:slots:${slot.id}`).value).id, slot.id);
  await d1BootstrapServer.close();
  await assert.rejects(
    createCoreHubServer({
      dataRoot: d1BootstrapDir,
      stateStoreKind: "d1",
    }),
    /requires a D1 database binding/,
  );
} finally {
  await rm(d1BootstrapDir, { recursive: true, force: true });
}

const workerRows = new Map();
const workerObjects = new Map();
const workerEnv = {
  COREHUB_STATE_STORE: "d1",
  COREHUB_D1: createMockD1Database(workerRows),
  COREHUB_MANAGED_OBJECT_STORE: createMockManagedBucket(workerObjects),
  COREHUB_MANAGED_OBJECT_STORE_BUCKET_NAME: "corehub-managed-artifacts-test",
  COREHUB_PUBLIC_BASE_URL: "https://coreblow.com/corehub",
  COREHUB_SIGNING_SECRET: "corehub-worker-test-signing-secret",
  COREHUB_SIGNING_KEY_ID: "test-primary",
};
const workerHealth = await coreHubWorker.fetch(new Request("https://coreblow.com/healthz"), workerEnv);
assert.equal(workerHealth.status, 200);
const workerHealthPayload = await workerHealth.json();
assert.equal(workerHealthPayload.stateStore, "d1");
assert.equal(workerHealthPayload.objectStore, "managed");
assert.equal(workerHealthPayload.signedReadKeyId, "test-primary");
const workerUploadResponse = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/corehub/api/v2/artifacts/uploads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:coreblow-admin",
    },
    body: JSON.stringify({
      packageId: "plugin-lab",
      version: "0.4.0",
      publisherHandle: "coreblow",
      provider: "managed",
      artifact: {
        name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: pluginLabArtifactBytes.byteLength,
        sha256: entries[2].versions[0].artifact.sha256,
      },
    }),
  }),
  workerEnv,
);
assert.equal(workerUploadResponse.status, 201);
const workerUploadPayload = await workerUploadResponse.json();
assert.equal(workerUploadPayload.data.uploadSlot.id, "upload-plugin-lab-0-4-0");
const workerPutResponse = await coreHubWorker.fetch(
  new Request(`https://coreblow.com/corehub/api/v2/artifacts/uploads/${workerUploadPayload.data.uploadSlot.id}`, {
    method: "PUT",
    headers: {
      "content-type": "application/vnd.coreblow.plugin-archive+gzip",
      "x-corehub-user": "github:coreblow-admin",
      "x-corehub-artifact-sha256": entries[2].versions[0].artifact.sha256,
    },
    body: pluginLabArtifactBytes,
  }),
  workerEnv,
);
assert.equal(workerPutResponse.status, 200);
assert.equal(workerObjects.has(workerUploadPayload.data.uploadSlot.storage.key), true);
const workerAuditEvents = normalizedMockRows(workerRows, "auditEvents");
assert.equal(workerAuditEvents[0].actor.id, "github:coreblow-admin");
const workerRegistryInfo = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/corehub/api/v1"),
  workerEnv,
);
assert.equal(workerRegistryInfo.status, 200);
assert.equal((await workerRegistryInfo.json()).data.name, "CoreHub Registry API");
const workerAdminPage = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/corehub/admin"),
  workerEnv,
);
assert.equal(workerAdminPage.status, 200);
assert.match(workerAdminPage.headers.get("content-type"), /text\/html/);
assert.match(await workerAdminPage.text(), /CoreHub Admin/);
const workerMissingD1 = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/healthz"),
  { COREHUB_STATE_STORE: "d1", COREHUB_MANAGED_OBJECT_STORE: createMockManagedBucket(new Map()) },
);
assert.equal(workerMissingD1.status, 500);
assert.match((await workerMissingD1.json()).error, /requires a D1 database binding/);
const workerExternalUrlStore = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/healthz"),
  {
    COREHUB_STATE_STORE: "d1",
    COREHUB_D1: createMockD1Database(new Map()),
    COREHUB_SIGNING_SECRET: "corehub-worker-test-signing-secret",
  },
);
assert.equal(workerExternalUrlStore.status, 200);
assert.equal((await workerExternalUrlStore.json()).objectStore, "external-url");
const externalRows = new Map();
const externalEnv = {
  COREHUB_STATE_STORE: "d1",
  COREHUB_D1: createMockD1Database(externalRows),
  COREHUB_PUBLIC_BASE_URL: "https://coreblow.com/corehub",
  COREHUB_SIGNING_SECRET: "corehub-worker-test-signing-secret",
};
const externalUploadResponse = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/corehub/api/v2/artifacts/uploads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:coreblow-admin",
    },
    body: JSON.stringify({
      packageId: "plugin-lab",
      version: "0.5.0",
      publisherHandle: "coreblow",
      provider: "github-raw",
      artifact: {
        name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: pluginLabArtifactBytes.byteLength,
        sha256: entries[2].versions[0].artifact.sha256,
        url: "https://raw.githubusercontent.com/coreblow/corehub/main/artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz",
      },
    }),
  }),
  externalEnv,
);
assert.equal(externalUploadResponse.status, 201);
const externalUploadPayload = await externalUploadResponse.json();
assert.equal(externalUploadPayload.data.uploadSlot.artifactUpload.status, "verified");
assert.equal(externalUploadPayload.data.uploadSlot.storage.provider, "github-raw");
assert.match(externalUploadPayload.data.uploadSlot.storage.url, /^https:\/\/raw\.githubusercontent\.com/);
const workerMissingManagedStore = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/healthz"),
  {
    COREHUB_STATE_STORE: "d1",
    COREHUB_D1: createMockD1Database(new Map()),
    COREHUB_OBJECT_STORE: "managed",
    COREHUB_SIGNING_SECRET: "corehub-worker-test-signing-secret",
  },
);
assert.equal(workerMissingManagedStore.status, 500);
assert.match((await workerMissingManagedStore.json()).error, /requires COREHUB_MANAGED_OBJECT_STORE binding when COREHUB_OBJECT_STORE=managed/);
const workerMissingSigningSecret = await handleCoreHubWorkerRequest(
  new Request("https://coreblow.com/healthz"),
  {
    COREHUB_STATE_STORE: "d1",
    COREHUB_D1: createMockD1Database(new Map()),
    COREHUB_MANAGED_OBJECT_STORE: createMockManagedBucket(new Map()),
  },
);
assert.equal(workerMissingSigningSecret.status, 500);
assert.match((await workerMissingSigningSecret.json()).error, /requires COREHUB_SIGNING_SECRET/);

const stateStoreDir = await mkdtemp(join(tmpdir(), "corehub-state-store-"));
try {
  const stateStorePath = join(stateStoreDir, "state.json");
  const stateStore = new CoreHubLocalJsonStateStore({ statePath: stateStorePath });
  const stateStoreStorage = await CoreHubLocalStorageAdapter.open({
    root: stateStoreDir,
    stateStore,
  });
  const slot = await stateStoreStorage.requestUploadSlot({
    packageId: "plugin-lab",
    version: "0.1.0",
    publisherHandle: "coreblow",
    provider: "managed",
    artifact: {
      name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: pluginLabArtifactBytes.byteLength,
      sha256: entries[2].versions[0].artifact.sha256,
    },
  });
  assert.equal(slot.id, "upload-plugin-lab-0-1-0");
  const persisted = JSON.parse(await readFile(stateStorePath, "utf8"));
  assert.equal(persisted.schemaVersion, "corehub.local-state.v1");
  assert.equal(persisted.slots[0].id, slot.id);

  const restoredStorage = await CoreHubLocalStorageAdapter.open({
    root: stateStoreDir,
    stateStore: new CoreHubLocalJsonStateStore({ statePath: stateStorePath }),
  });
  assert.equal(restoredStorage.requireSlot(slot.id).artifactUpload.status, "requested");

  const backupPath = join(stateStoreDir, "backup.json");
  const exportResult = await execFileAsync(process.execPath, [
    persistenceSnapshotPath,
    "export",
    "--input",
    stateStorePath,
    "--output",
    backupPath,
  ]);
  const exportPayload = JSON.parse(exportResult.stdout);
  assert.equal(exportPayload.status, "exported");
  assert.equal(exportPayload.counts.slots, 1);
  assert.match(exportPayload.sha256, /^[a-f0-9]{64}$/);

  const validateResult = await execFileAsync(process.execPath, [persistenceSnapshotPath, "validate", "--input", backupPath]);
  assert.equal(JSON.parse(validateResult.stdout).status, "valid");

  const currentPersistence = await execFileAsync(process.execPath, [persistenceSnapshotPath, "current"]);
  assert.equal(JSON.parse(currentPersistence.stdout).currentPersistenceVersion, "corehub.persistence.v1");

  const migrations = await execFileAsync(process.execPath, [persistenceSnapshotPath, "migrations"]);
  assert.equal(JSON.parse(migrations.stdout).migrations[0].id, "2026-05-22-corehub-local-state-v1");

  const migrateDryRun = await execFileAsync(process.execPath, [
    persistenceSnapshotPath,
    "migrate",
    "--input",
    stateStorePath,
    "--backup",
    backupPath,
    "--dry-run",
  ]);
  const migrateDryRunPayload = JSON.parse(migrateDryRun.stdout);
  assert.equal(migrateDryRunPayload.status, "migration_planned");
  assert.equal(migrateDryRunPayload.backupValidation.status, "valid");
  assert.equal(migrateDryRunPayload.steps[0].status, "already_applied");

  const invalidBackupPath = join(stateStoreDir, "invalid-backup.json");
  await writeFile(invalidBackupPath, JSON.stringify({ schemaVersion: "bad" }));
  await assert.rejects(
    execFileAsync(process.execPath, [
      persistenceSnapshotPath,
      "migrate",
      "--input",
      stateStorePath,
      "--backup",
      invalidBackupPath,
      "--dry-run",
    ]),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.backupValidation.status, "invalid");
      return true;
    },
  );

  const restorePath = join(stateStoreDir, "restored.json");
  const restoreDryRun = await execFileAsync(process.execPath, [
    persistenceSnapshotPath,
    "restore",
    "--input",
    backupPath,
    "--output",
    restorePath,
    "--dry-run",
  ]);
  assert.equal(JSON.parse(restoreDryRun.stdout).status, "restore_planned");
  await assert.rejects(readFile(restorePath, "utf8"), /ENOENT/);

  const restoreApply = await execFileAsync(process.execPath, [
    persistenceSnapshotPath,
    "restore",
    "--input",
    backupPath,
    "--output",
    restorePath,
    "--apply",
  ]);
  assert.equal(JSON.parse(restoreApply.stdout).status, "restored");
  assert.equal(JSON.parse(await readFile(restorePath, "utf8")).schemaVersion, "corehub.local-state.v1");
} finally {
  await rm(stateStoreDir, { recursive: true, force: true });
}

const snapshotStoreDir = await mkdtemp(join(tmpdir(), "corehub-snapshot-store-"));
try {
  let snapshotState = null;
  const snapshotStore = new CoreHubSnapshotStateStore({
    kind: "memory-snapshot",
    loadSnapshot: async () => snapshotState,
    saveSnapshot: async (snapshot) => {
      snapshotState = snapshot;
    },
  });
  const snapshotStorage = await CoreHubLocalStorageAdapter.open({
    root: snapshotStoreDir,
    stateStore: snapshotStore,
  });
  const slot = await snapshotStorage.requestUploadSlot({
    packageId: "plugin-lab",
    version: "0.1.0",
    publisherHandle: "coreblow",
    provider: "managed",
    artifact: {
      name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: pluginLabArtifactBytes.byteLength,
      sha256: entries[2].versions[0].artifact.sha256,
    },
  });
  assert.equal(snapshotStore.kind, "memory-snapshot");
  assert.equal(snapshotState.slots[0].id, slot.id);

  const d1Rows = new Map();
  const d1Store = new CoreHubD1StateStore({ database: createMockD1Database(d1Rows) });
  const d1Storage = await CoreHubLocalStorageAdapter.open({
    root: snapshotStoreDir,
    stateStore: d1Store,
  });
  await d1Storage.requestUploadSlot({
    packageId: "plugin-lab",
    version: "0.2.0",
    publisherHandle: "coreblow",
    provider: "managed",
    artifact: {
      name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: pluginLabArtifactBytes.byteLength,
      sha256: entries[2].versions[0].artifact.sha256,
    },
  });
  assert.match(CoreHubD1StateStore.migrationSql(), /CREATE TABLE IF NOT EXISTS corehub_state_rows/);
  assert.equal(d1Store.kind, "d1-normalized");
  assert.equal(JSON.parse(d1Rows.get("corehub_state_meta:manifest").value).schemaVersion, "corehub.local-state.v1");
  assert.equal(
    JSON.parse(d1Rows.get("corehub_state_rows:slots:upload-plugin-lab-0-2-0").value).id,
    "upload-plugin-lab-0-2-0",
  );
  assert.equal(d1Rows.get("corehub_state_indexes:slots:by_package_version:plugin-lab\u00000.2.0:upload-plugin-lab-0-2-0").row_id, "upload-plugin-lab-0-2-0");
  const d1ReloadedStorage = await CoreHubLocalStorageAdapter.open({
    root: snapshotStoreDir,
    stateStore: new CoreHubD1StateStore({ database: createMockD1Database(d1Rows) }),
  });
  assert.equal(d1ReloadedStorage.slots.get("upload-plugin-lab-0-2-0").id, "upload-plugin-lab-0-2-0");

  const d1Sql = await execFileAsync(process.execPath, [d1MigrationPath, "sql"]);
  assert.match(d1Sql.stdout, /CREATE TABLE IF NOT EXISTS corehub_state/);

  const d1Plan = await execFileAsync(process.execPath, [d1MigrationPath, "apply", "--dry-run"]);
  const d1PlanPayload = JSON.parse(d1Plan.stdout);
  assert.equal(d1PlanPayload.status, "apply_planned");
  assert.equal(d1PlanPayload.table, "corehub_state");
  assert.match(d1PlanPayload.applyCommand, /wrangler d1 execute corehub/);

  const persistenceMigrationSmoke = await execFileAsync(process.execPath, [persistenceMigrationSmokePath]);
  const persistenceMigrationPayload = JSON.parse(persistenceMigrationSmoke.stdout);
  assert.equal(persistenceMigrationPayload.status, "ok");
  assert.deepEqual(persistenceMigrationPayload.persistedCollections, ["packageSearchDigests", "packageVersions", "slots"]);

  const productionFinalization = await execFileAsync(process.execPath, [productionFinalizationPath]);
  assert.equal(JSON.parse(productionFinalization.stdout).status, "ready");

  const productionDrill = await execFileAsync(process.execPath, [productionDrillPath]);
  assert.equal(JSON.parse(productionDrill.stdout).status, "ready");
} finally {
  await rm(snapshotStoreDir, { recursive: true, force: true });
}

const apiStorageDir = await mkdtemp(join(tmpdir(), "corehub-api-storage-"));
const apiStatePath = join(apiStorageDir, "write-side-state.json");
const apiStorage = new CoreHubLocalStorageAdapter({ root: apiStorageDir, statePath: apiStatePath });
const apiServer = createServer(
  createCoreHubApiHandler({
    storage: apiStorage,
    now: () => new Date("2026-05-21T00:00:00Z"),
    sessionTokens: {
      enforceOpaqueTokens: true,
      adminTokenHashes: [sha256Hex("local-admin-token")],
      publisherTokenHashes: [sha256Hex("local-publisher-token")],
    },
  }),
);
await new Promise((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
try {
  const apiBaseUrl = `http://127.0.0.1:${apiServer.address().port}/corehub/api/v2`;
  const whoamiResponse = await fetch(`${apiBaseUrl}/publishers/me`, {
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal(whoamiResponse.status, 200);
  const whoamiPayload = await whoamiResponse.json();
  assert.equal(whoamiPayload.data.actor.id, "github:coreblow-admin");
  assert.equal(whoamiPayload.data.memberships[0].publisherHandle, "coreblow");
  assert.deepEqual(whoamiPayload.data.memberships[0].permissions, ["artifact.upload", "submission.create"]);
  assert.equal(whoamiPayload.data.permissions.admin, true);

  const missingSessionToken = await fetch(`${apiBaseUrl}/session/validate?role=publisher`, {
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal(missingSessionToken.status, 401);

  const invalidSessionToken = await fetch(`${apiBaseUrl}/session/validate?role=publisher`, {
    headers: {
      authorization: "Bearer wrong-token",
      "x-corehub-user": "github:coreblow-admin",
    },
  });
  assert.equal(invalidSessionToken.status, 401);

  const adminSessionResponse = await fetch(`${apiBaseUrl}/session/validate?role=admin`, {
    headers: {
      authorization: "Bearer local-admin-token",
      "x-corehub-user": "github:coreblow-admin",
    },
  });
  assert.equal(adminSessionResponse.status, 200);
  const adminSessionPayload = await adminSessionResponse.json();
  assert.equal(adminSessionPayload.data.valid, true);
  assert.equal(adminSessionPayload.data.role, "admin");
  assert.equal(adminSessionPayload.data.permissions.admin, true);
  assert.equal(adminSessionPayload.data.token.type, "opaque");
  assert.equal(adminSessionPayload.data.token.verified, true);
  assert.equal(adminSessionPayload.data.token.verifier, "configured-sha256");

  const publisherSessionResponse = await fetch(`${apiBaseUrl}/session/validate?role=publisher`, {
    headers: {
      authorization: "Bearer local-publisher-token",
      "x-corehub-user": "github:coreblow-admin",
    },
  });
  assert.equal(publisherSessionResponse.status, 200);
  const publisherSessionPayload = await publisherSessionResponse.json();
  assert.equal(publisherSessionPayload.data.valid, true);
  assert.equal(publisherSessionPayload.data.role, "publisher");
  assert.equal(publisherSessionPayload.data.token.verified, true);
  assert.equal(publisherSessionPayload.data.memberships[0].publisherHandle, "coreblow");

  const dashboardResponse = await fetch(`${apiBaseUrl}/publisher/dashboard`, {
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal(dashboardResponse.status, 200);
  const dashboardPayload = await dashboardResponse.json();
  assert.equal(dashboardPayload.data.identity.defaultPublisher.handle, "coreblow");
  assert.equal(dashboardPayload.data.counts.publishers, 1);
  assert.deepEqual(dashboardPayload.data.packages, []);
  assert.equal(dashboardPayload.data.uploadSlots.length, 0);

  // Publisher Claim Integration Test
  const claimResponse = await fetch(`${apiBaseUrl}/publishers/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:new-publisher",
    },
    body: JSON.stringify({
      handle: "new-org",
      displayName: "New Org",
    }),
  });
  assert.equal(claimResponse.status, 201);
  const claimPayload = await claimResponse.json();
  assert.equal(claimPayload.data.claim.status, "pending");
  assert.equal(claimPayload.data.publisher.status, "pending");
  assert.equal(claimPayload.data.membership.role, "owner");

  // Admin can list all publishers (seed + newly claimed)
  const listPublishersResponse = await fetch(`${apiBaseUrl}/publishers`, {
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal(listPublishersResponse.status, 200);
  const listPublishersPayload = await listPublishersResponse.json();
  assert.ok(listPublishersPayload.data.length >= 2); // "coreblow" (seed) + "new-org" (claimed)
  assert.ok(listPublishersPayload.data.some((p) => p.handle === "coreblow" && p.status === "verified"));
  assert.ok(listPublishersPayload.data.some((p) => p.handle === "new-org" && p.status === "pending"));

  const duplicateClaimResponse = await fetch(`${apiBaseUrl}/publishers/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:another-user",
    },
    body: JSON.stringify({
      handle: "new-org",
    }),
  });
  assert.equal(duplicateClaimResponse.status, 200);
  assert.equal((await duplicateClaimResponse.json()).data.status, "already_claimed");

  // Pending publisher blocked from submitting packages
  const pendingUploadResponse = await fetch(`${apiBaseUrl}/artifacts/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:new-publisher",
    },
    body: JSON.stringify({
      packageId: "new-plugin",
      version: "0.1.0",
      publisherHandle: "new-org",
      provider: "managed",
      artifact: {
        name: "new-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: 100,
        sha256: "a".repeat(64),
      },
    }),
  });
  assert.equal(pendingUploadResponse.status, 403);
  const pendingUploadError = await pendingUploadResponse.json();
  assert.match(pendingUploadError.error, /is not verified for artifact\.upload\.request/);
  assert.equal(pendingUploadError.errorCode, "forbidden");
  assert.equal(pendingUploadError.status, 403);
  assert.equal(pendingUploadError.message, pendingUploadError.error);

  // Admin verifies publisher
  const verifyResponse = await fetch(`${apiBaseUrl}/publishers/new-org/verify`, {
    method: "POST",
    headers: {
      "x-corehub-user": "github:coreblow-admin",
    },
  });
  assert.equal(verifyResponse.status, 200);
  assert.equal((await verifyResponse.json()).data.publisher.status, "verified");

  // Verified publisher can now submit
  const verifiedUploadResponse = await fetch(`${apiBaseUrl}/artifacts/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:new-publisher",
    },
    body: JSON.stringify({
      packageId: "new-plugin",
      version: "0.1.0",
      publisherHandle: "new-org",
      provider: "managed",
      artifact: {
        name: "new-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: 100,
        sha256: "a".repeat(64),
      },
    }),
  });
  assert.equal(verifiedUploadResponse.status, 201);

  const unauthorizedUploadResponse = await fetch(`${apiBaseUrl}/artifacts/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-corehub-user": "github:outside-user",
    },
    body: JSON.stringify({
      packageId: "plugin-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      provider: "managed",
      artifact: {
        name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: pluginLabArtifactBytes.byteLength,
        sha256: entries[2].versions[0].artifact.sha256,
      },
    }),
  });
  assert.equal(unauthorizedUploadResponse.status, 403);
  const unauthorizedUploadError = await unauthorizedUploadResponse.json();
  assert.match(unauthorizedUploadError.error, /cannot artifact\.upload\.request/);
  assert.equal(unauthorizedUploadError.errorCode, "forbidden");
  assert.equal(unauthorizedUploadError.status, 403);

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
      provider: "managed",
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
  assert.equal(uploadSlot.storage.provider, "managed");

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
    assert.equal(
      openReviewsListPayload.reviews[0].moderationReview.evidence.some((event) => event.type === "artifact_checksum"),
      true,
    );

    const assignReview = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "review",
        "assign",
        remoteSubmitPayload.moderationReview.id,
        "--to",
        "moderator:corehub",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const assignReviewPayload = JSON.parse(assignReview.stdout);
    assert.equal(assignReviewPayload.moderationReview.assignee.id, "moderator:corehub");
    assert.equal(assignReviewPayload.moderationReview.assignedBy.id, "github:coreblow-admin");

    const addReviewEvidence = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "review",
        "evidence",
        "add",
        remoteSubmitPayload.moderationReview.id,
        "--type",
        "manual_note",
        "--summary",
        "Manual moderation evidence added by test.",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const addReviewEvidencePayload = JSON.parse(addReviewEvidence.stdout);
    assert.equal(addReviewEvidencePayload.moderationReview.evidence.some((event) => event.type === "manual_note"), true);

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
    assert.equal(approvedReviewStatusPayload.moderationReview.assignee.id, "moderator:corehub");
    assert.equal(approvedReviewStatusPayload.moderationReview.evidence.length, 3);

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

    apiStorage.publisherAccounts.set("example-org", {
      id: "publisher-example-org",
      handle: "example-org",
      displayName: "Example Org",
      kind: "organization",
      status: "verified",
      source: "https://github.com/example-org",
      contact: "https://github.com/example-org",
      createdAt: "2026-05-21T00:00:00Z",
      verifiedAt: "2026-05-21T00:00:00Z",
    });
    apiStorage.publisherMembers.push({
      id: "member-example-org-owner",
      publisherHandle: "example-org",
      userId: "github:example-owner",
      role: "owner",
      status: "active",
      createdAt: "2026-05-21T00:00:00Z",
    });

    const transferRequest = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "request",
        "plugin-lab",
        "--to",
        "example-org",
        "--registry",
        apiRegistryUrl,
        "--reason",
        "Move plugin-lab to Example Org.",
      ],
      { env: apiAuthEnv },
    );
    const transferRequestPayload = JSON.parse(transferRequest.stdout);
    assert.equal(transferRequestPayload.status, "requested");
    assert.equal(transferRequestPayload.transfer.fromPublisherHandle, "coreblow");
    assert.equal(transferRequestPayload.transfer.toPublisherHandle, "example-org");

    const requestedTransfers = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "list",
        "--status",
        "requested",
        "--package",
        "plugin-lab",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(requestedTransfers.stdout).transfers[0].id, transferRequestPayload.transfer.id);

    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "login",
        "--token",
        "local-dev-token",
        "--user",
        "github:example-owner",
        "--publisher",
        "example-org",
      ],
      { env: apiAuthEnv },
    );
    const transferAccept = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "accept",
        transferRequestPayload.transfer.id,
        "--registry",
        apiRegistryUrl,
        "--notes",
        "Accepted by target publisher.",
      ],
      { env: apiAuthEnv },
    );
    const transferAcceptPayload = JSON.parse(transferAccept.stdout);
    assert.equal(transferAcceptPayload.status, "completed");
    assert.equal(transferAcceptPayload.packageOwnerHandle, "example-org");

    const transferBackRequest = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "request",
        "plugin-lab",
        "--from",
        "example-org",
        "--to",
        "coreblow",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const transferBackPayload = JSON.parse(transferBackRequest.stdout);
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
    const transferReject = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "reject",
        transferBackPayload.transfer.id,
        "--registry",
        apiRegistryUrl,
        "--notes",
        "CoreBlow keeps the package with Example Org.",
      ],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(transferReject.stdout).status, "rejected");

    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "login",
        "--token",
        "local-dev-token",
        "--user",
        "github:example-owner",
        "--publisher",
        "example-org",
      ],
      { env: apiAuthEnv },
    );
    const transferCancelRequest = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "request",
        "plugin-lab",
        "--from",
        "example-org",
        "--to",
        "coreblow",
        "--registry",
        apiRegistryUrl,
        "--reason",
        "Cancelled transfer fixture.",
      ],
      { env: apiAuthEnv },
    );
    const transferCancelPayload = JSON.parse(transferCancelRequest.stdout);
    const transferCancel = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "transfers",
        "cancel",
        transferCancelPayload.transfer.id,
        "--registry",
        apiRegistryUrl,
        "--notes",
        "Cancelled by source publisher.",
      ],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(transferCancel.stdout).status, "cancelled");

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
    assert.equal(reviewAuditListPayload.auditEvents.some((event) => event.action === "review.assign"), true);
    assert.equal(reviewAuditListPayload.auditEvents.some((event) => event.action === "review.evidence.add"), true);
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
    assert.equal(projectedPackagePayload.data.versions[0].artifact.storage.provider, "managed");

    const missingProjectedPackageResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/missing-package`);
    assert.equal(missingProjectedPackageResponse.status, 404);
    assert.match(missingProjectedPackageResponse.headers.get("content-type"), /text\/plain/);
    assert.equal(await missingProjectedPackageResponse.text(), "Not found");

    const missingV2Response = await fetch(`${apiBaseUrl}/missing-route`);
    assert.equal(missingV2Response.status, 404);
    const missingV2Payload = await missingV2Response.json();
    assert.equal(missingV2Payload.error, "Not found");
    assert.equal(missingV2Payload.errorCode, "not_found");
    assert.equal(missingV2Payload.status, 404);

    const missingSessionTokenResponse = await fetch(`${apiBaseUrl}/session/validate?role=admin`);
    assert.equal(missingSessionTokenResponse.status, 401);
    const missingSessionTokenPayload = await missingSessionTokenResponse.json();
    assert.equal(missingSessionTokenPayload.errorCode, "unauthorized");
    assert.equal(missingSessionTokenPayload.status, 401);
    assert.match(missingSessionTokenPayload.error, /Session token is required/);

    const forbiddenAdminStatusResponse = await fetch(`${apiBaseUrl}/admin/status`);
    assert.equal(forbiddenAdminStatusResponse.status, 403);
    const forbiddenAdminStatusPayload = await forbiddenAdminStatusResponse.json();
    assert.equal(forbiddenAdminStatusPayload.errorCode, "forbidden");
    assert.equal(forbiddenAdminStatusPayload.status, 403);

    const projectedPackageFilesResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/files`);
    assert.equal(projectedPackageFilesResponse.status, 200);
    const projectedPackageFilesPayload = await projectedPackageFilesResponse.json();
    assert.equal(projectedPackageFilesPayload.data.files.some((file) => file.path === "README.md"), true);

    const projectedPackageFileResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/file?path=README.md`);
    assert.equal(projectedPackageFileResponse.status, 200);
    assert.match(projectedPackageFileResponse.headers.get("content-type"), /text\/plain/);
    assert.equal(
      projectedPackageFileResponse.headers.get("x-corehub-file-sha256"),
      entries[2].versions[0].artifact.files.find((file) => file.path === "README.md").sha256,
    );
    assert.match(await projectedPackageFileResponse.text(), /Plugin Lab Basic Plugin/);

    const invalidPackageFileResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/file?path=../package.json`);
    assert.equal(invalidPackageFileResponse.status, 400);
    assert.match(await invalidPackageFileResponse.text(), /relative package file path/);

    const projectedVersionsResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/versions`);
    assert.equal(projectedVersionsResponse.status, 200);
    const projectedVersionsPayload = await projectedVersionsResponse.json();
    assert.equal(projectedVersionsPayload.data[0].tag, "latest");
    assert.equal(projectedVersionsPayload.meta.limit, 50);
    assert.equal(projectedVersionsPayload.meta.hasMore, false);
    assert.equal(projectedVersionsPayload.meta.nextCursor, null);

    const packageScanBeforeBackfillResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/scan`);
    assert.equal(packageScanBeforeBackfillResponse.status, 200);
    assert.equal((await packageScanBeforeBackfillResponse.json()).data.scan.scanStatus, "pending");

    const packageScanBackfillResponse = await fetch(`${apiBaseUrl}/package-scans/backfill`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-corehub-user": "github:coreblow-admin",
      },
      body: JSON.stringify({ packageId: "plugin-lab", reason: "Backfill static scan for test." }),
    });
    assert.equal(packageScanBackfillResponse.status, 200);
    const packageScanBackfillPayload = await packageScanBackfillResponse.json();
    assert.equal(packageScanBackfillPayload.data.count, 1);
    assert.equal(packageScanBackfillPayload.data.jobs[0].scanner, "corehub-static");
    assert.equal(packageScanBackfillPayload.data.jobs[0].scanStatus, "clean");
    assert.equal(packageScanBackfillPayload.data.jobs[0].evidence.some((event) => event.type === "artifact_metadata"), true);

    const packageScanRescanResponse = await fetch(`${apiBaseUrl}/packages/plugin-lab/scans/rescan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-corehub-user": "github:coreblow-admin",
      },
      body: JSON.stringify({ version: "0.1.0", source: "rescan", reason: "Rescan static evidence for test." }),
    });
    assert.equal(packageScanRescanResponse.status, 200);
    assert.equal((await packageScanRescanResponse.json()).data.job.scanStatus, "clean");

    const packageScanListResponse = await fetch(`${apiBaseUrl}/package-scans?package=plugin-lab`, {
      headers: { "x-corehub-user": "github:coreblow-admin" },
    });
    assert.equal(packageScanListResponse.status, 200);
    const packageScanListPayload = await packageScanListResponse.json();
    assert.equal(packageScanListPayload.meta.total, 2);
    assert.equal(packageScanListPayload.data.some((job) => job.source === "rescan"), true);

    const packageScanStatusResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/scan`);
    assert.equal(packageScanStatusResponse.status, 200);
    const packageScanStatusPayload = await packageScanStatusResponse.json();
    assert.equal(packageScanStatusPayload.data.scan.scanStatus, "clean");
    assert.equal(packageScanStatusPayload.data.scan.status, "completed");

    const projectedSecurityResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/versions/0.1.0/security`);
    assert.equal(projectedSecurityResponse.status, 200);
    const projectedSecurityPayload = await projectedSecurityResponse.json();
    assert.equal(projectedSecurityPayload.data.package.name, "plugin-lab");
    assert.equal(projectedSecurityPayload.data.release.version, "0.1.0");
    assert.equal(projectedSecurityPayload.data.release.artifactKind, "npm-pack");
    assert.equal(projectedSecurityPayload.data.release.artifactSha256, entries[2].versions[0].artifact.sha256);
    assert.equal(projectedSecurityPayload.data.release.npmIntegrity, entries[2].versions[0].artifact.npm.integrity);
    assert.equal(projectedSecurityPayload.data.release.npmShasum, entries[2].versions[0].artifact.npm.shasum);
    assert.equal(projectedSecurityPayload.data.release.npmFileCount, 5);
    assert.equal(projectedSecurityPayload.data.trust.blockedFromDownload, false);
    assert.equal(projectedSecurityPayload.data.trust.scanStatus, "clean");

    const npmPackumentResponse = await fetch(`${apiRegistryUrl}/api/npm/plugin-lab`);
    assert.equal(npmPackumentResponse.status, 200);
    const npmPackumentPayload = await npmPackumentResponse.json();
    assert.equal(npmPackumentPayload.name, "plugin-lab");
    assert.equal(npmPackumentPayload["dist-tags"].latest, "0.1.0");
    assert.equal(
      npmPackumentPayload.versions["0.1.0"].dist.integrity,
      entries[2].versions[0].artifact.npm.integrity,
    );
    assert.equal(npmPackumentPayload.versions["0.1.0"].dist.shasum, entries[2].versions[0].artifact.npm.shasum);
    assert.equal(npmPackumentPayload.versions["0.1.0"].dist.fileCount, 5);
    assert.equal(npmPackumentPayload.versions["0.1.0"].dist.unpackedSize, 1267);
    assert.equal(npmPackumentPayload.versions["0.1.0"].dist.corehubSha256, entries[2].versions[0].artifact.sha256);
    assert.match(
      npmPackumentPayload.versions["0.1.0"].dist.tarball,
      /\/corehub\/api\/npm\/plugin-lab\/-\/plugin-lab-0\.1\.0\.coreblow-plugin\.tgz$/,
    );

    const scopedNpmPackumentResponse = await fetch(`${apiRegistryUrl}/api/npm/%40coreblow%2Fplugin-lab`);
    assert.equal(scopedNpmPackumentResponse.status, 200);
    assert.equal((await scopedNpmPackumentResponse.json()).versions["0.1.0"].dist.corehubSha256, entries[2].versions[0].artifact.sha256);

    const npmTarballResponse = await fetch(
      `${apiRegistryUrl}/api/npm/plugin-lab/-/plugin-lab-0.1.0.coreblow-plugin.tgz`,
      { redirect: "manual" },
    );
    assert.equal(npmTarballResponse.status, 302);
    assert.match(npmTarballResponse.headers.get("location"), /\/corehub\/api\/v1\/artifacts\/read\?/);
    assert.equal(npmTarballResponse.headers.get("x-corehub-artifact-sha256"), entries[2].versions[0].artifact.sha256);
    assert.equal(
      npmTarballResponse.headers.get("x-corehub-npm-integrity"),
      entries[2].versions[0].artifact.npm.integrity,
    );

    const projectedPluginListResponse = await fetch(`${apiRegistryUrl}/api/v1/plugins?category=dev-tools&executesCode=true`);
    assert.equal(projectedPluginListResponse.status, 200);
    const projectedPluginListPayload = await projectedPluginListResponse.json();
    assert.equal(projectedPluginListPayload.data[0].id, "plugin-lab");
    assert.equal(projectedPluginListPayload.data[0].marketplace.family, "code-plugin");
    assert.equal(projectedPluginListPayload.data[0].versions[0].artifact.kind, "npm-pack");
    assert.equal(projectedPluginListPayload.data[0].versions[0].artifact.npm.fileCount, 5);
    assert.equal(projectedPluginListPayload.meta.total, 1);
    assert.equal(projectedPluginListPayload.meta.limit, 50);
    assert.equal(projectedPluginListPayload.meta.cursor, null);
    assert.equal(projectedPluginListPayload.meta.nextCursor, null);

    const projectedPluginSearchResponse = await fetch(`${apiRegistryUrl}/api/v1/plugins/search?q=plugin&isOfficial=false`);
    assert.equal(projectedPluginSearchResponse.status, 200);
    const projectedPluginSearchPayload = await projectedPluginSearchResponse.json();
    assert.equal(projectedPluginSearchPayload.data[0].id, "plugin-lab");
    assert.equal(projectedPluginSearchPayload.data[0].score > 0, true);
    assert.equal(projectedPluginSearchPayload.meta.total, 1);

    const invalidCursorResponse = await fetch(`${apiRegistryUrl}/api/v1/packages?cursor=not-a-cursor`);
    assert.equal(invalidCursorResponse.status, 400);
    assert.match(invalidCursorResponse.headers.get("content-type"), /text\/plain/);
    assert.match(await invalidCursorResponse.text(), /cursor/);

    const projectedPackageFilterResponse = await fetch(`${apiRegistryUrl}/api/v1/packages?family=code-plugin&capabilityTag=published`);
    assert.equal(projectedPackageFilterResponse.status, 200);
    const projectedPackageFilterPayload = await projectedPackageFilterResponse.json();
    assert.equal(projectedPackageFilterPayload.data[0].id, "plugin-lab");

    const hostedScanQueueResponse = await fetch(`${apiBaseUrl}/package-scans/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-corehub-user": "github:coreblow-admin" },
      body: JSON.stringify({
        packageId: "plugin-lab",
        version: "0.1.0",
        scanner: "corehub-clawscan",
        source: "hosted",
        reason: "Hosted scanner queue fixture.",
      }),
    });
    assert.equal(hostedScanQueueResponse.status, 200);
    const hostedScanQueuePayload = await hostedScanQueueResponse.json();
    assert.equal(hostedScanQueuePayload.data.job.status, "queued");
    assert.equal(hostedScanQueuePayload.data.job.scanStatus, "pending");
    assert.equal(hostedScanQueuePayload.data.job.inputs.fileCount, 5);

    const hostedScanResultResponse = await fetch(`${apiBaseUrl}/package-scans/${hostedScanQueuePayload.data.job.id}/result`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-corehub-user": "github:coreblow-admin" },
      body: JSON.stringify({
        status: "completed",
        llmAnalysis: {
          status: "completed",
          verdict: "malicious",
          summary: "ClawScan detected a blocked fixture payload.",
        },
        vtAnalysis: {
          status: "clean",
          engineStats: { malicious: 0, suspicious: 0, harmless: 10, undetected: 50 },
        },
        staticScan: { status: "suspicious", summary: "Static scanner found risky shell execution." },
        summary: "Hosted scanner marked the release malicious.",
        riskLevel: "high",
        reasonCodes: ["scan:malicious", "clawscan:malicious"],
        evidence: [
          {
            type: "hosted_scan_finding",
            severity: "critical",
            summary: "Fixture malicious scanner finding.",
            metadata: { code: "malicious.fixture" },
          },
        ],
      }),
    });
    assert.equal(hostedScanResultResponse.status, 200);
    const hostedScanResultPayload = await hostedScanResultResponse.json();
    assert.equal(hostedScanResultPayload.data.job.status, "completed");
    assert.equal(hostedScanResultPayload.data.job.scanStatus, "malicious");
    assert.equal(hostedScanResultPayload.data.job.llmAnalysis.verdict, "malicious");

    const hostedSecurityResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/versions/0.1.0/security`);
    assert.equal(hostedSecurityResponse.status, 200);
    const hostedSecurityPayload = await hostedSecurityResponse.json();
    assert.equal(hostedSecurityPayload.data.trust.blockedFromDownload, true);
    assert.equal(hostedSecurityPayload.data.trust.scanStatus, "malicious");
    assert.equal(hostedSecurityPayload.data.trust.reasons.includes("scan:malicious"), true);

    const packageDelete = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "delete",
        "plugin-lab",
        "--yes",
        "--reason",
        "Soft delete fixture.",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageDeletePayload = JSON.parse(packageDelete.stdout);
    assert.equal(packageDeletePayload.status, "deleted");
    assert.equal(packageDeletePayload.packageId, "plugin-lab");
    assert.equal(packageDeletePayload.changedVersions, 1);

    const deletedEntriesResponse = await fetch(`${apiRegistryUrl}/api/v1/entries`);
    assert.equal(deletedEntriesResponse.status, 200);
    assert.equal((await deletedEntriesResponse.json()).data.length, 0);
    const deletedPackageResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab`);
    assert.equal(deletedPackageResponse.status, 404);

    const deletedAdminStatus = await execFileAsync(
      process.execPath,
      [cliPath, "admin", "status", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const deletedAdminStatusPayload = JSON.parse(deletedAdminStatus.stdout);
    assert.equal(deletedAdminStatusPayload.counts.softDeletedPackages, 1);
    assert.equal(deletedAdminStatusPayload.queues.packageLifecycle.deleted, 1);

    const packageUndelete = await execFileAsync(
      process.execPath,
      [cliPath, "package", "undelete", "plugin-lab", "--yes", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const packageUndeletePayload = JSON.parse(packageUndelete.stdout);
    assert.equal(packageUndeletePayload.status, "restored");
    assert.equal(packageUndeletePayload.packageId, "plugin-lab");
    assert.equal(packageUndeletePayload.changedVersions, 1);

    const restoredPackageResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab`);
    assert.equal(restoredPackageResponse.status, 200);

    const trustedPublisherSet = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "trusted-publisher",
        "set",
        "plugin-lab",
        "--repository",
        "coreblow/plugin-lab",
        "--workflow",
        "publish.yml",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const trustedPublisherSetPayload = JSON.parse(trustedPublisherSet.stdout);
    assert.equal(trustedPublisherSetPayload.status, "configured");
    assert.equal(trustedPublisherSetPayload.trustedPublisher.repository, "coreblow/plugin-lab");

    const trustedPublisherGet = await execFileAsync(
      process.execPath,
      [cliPath, "package", "trusted-publisher", "get", "plugin-lab", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const trustedPublisherGetPayload = JSON.parse(trustedPublisherGet.stdout);
    assert.equal(trustedPublisherGetPayload.trustedPublisher.workflowFilename, "publish.yml");

    const publishTokenMint = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "publish-token",
        "mint",
        "plugin-lab",
        "--version",
        "0.2.0",
        "--repository",
        "coreblow/plugin-lab",
        "--workflow",
        "publish.yml",
        "--run-id",
        "12345",
        "--sha",
        "abc123",
        "--ref",
        "refs/heads/main",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const publishTokenMintPayload = JSON.parse(publishTokenMint.stdout);
    assert.equal(publishTokenMintPayload.status, "minted");
    assert.equal(publishTokenMintPayload.publishToken.packageId, "plugin-lab");
    assert.match(publishTokenMintPayload.token, /^corehub_pub_/);

    const publishTokenRevoke = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "publish-token",
        "revoke",
        "plugin-lab",
        "--token-id",
        publishTokenMintPayload.publishToken.id,
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const publishTokenRevokePayload = JSON.parse(publishTokenRevoke.stdout);
    assert.equal(publishTokenRevokePayload.status, "revoked");

    const packageReport = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "report",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--reason",
        "Suspicious package report fixture.",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageReportPayload = JSON.parse(packageReport.stdout);
    assert.equal(packageReportPayload.status, "reported");
    assert.equal(packageReportPayload.report.packageId, "plugin-lab");
    assert.equal(packageReportPayload.report.status, "open");

    const packageReportsList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "reports",
        "list",
        "--status",
        "open",
        "--package",
        "plugin-lab",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageReportsListPayload = JSON.parse(packageReportsList.stdout);
    assert.equal(packageReportsListPayload.reports[0].id, packageReportPayload.report.id);

    const packageReportTriage = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "reports",
        "triage",
        packageReportPayload.report.id,
        "--status",
        "confirmed",
        "--note",
        "Confirmed report fixture.",
        "--action",
        "quarantine",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageReportTriagePayload = JSON.parse(packageReportTriage.stdout);
    assert.equal(packageReportTriagePayload.status, "confirmed");
    assert.equal(packageReportTriagePayload.report.triageNote, "Confirmed report fixture.");
    assert.equal(packageReportTriagePayload.report.finalAction, "quarantine");

    const quarantinedModerationStatus = await execFileAsync(
      process.execPath,
      [cliPath, "package", "moderation-status", "plugin-lab", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const quarantinedModerationStatusPayload = JSON.parse(quarantinedModerationStatus.stdout);
    assert.equal(quarantinedModerationStatusPayload.latestVersion.moderationStatus, "quarantined");
    assert.equal(quarantinedModerationStatusPayload.latestVersion.blockedFromDownload, true);
    assert.equal(quarantinedModerationStatusPayload.latestVersion.reasons.includes("manual:quarantined"), true);

    const quarantinedDownloadResponse = await fetch(`${apiRegistryUrl}/api/v1/packages/plugin-lab/download?redirect=false`);
    assert.equal(quarantinedDownloadResponse.status, 403);
    assert.match(quarantinedDownloadResponse.headers.get("content-type"), /text\/plain/);
    assert.match(await quarantinedDownloadResponse.text(), /Confirmed report fixture|quarantined|blocked|moderation/i);

    const packageAppeal = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "appeal",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--message",
        "Appeal report fixture.",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageAppealPayload = JSON.parse(packageAppeal.stdout);
    assert.equal(packageAppealPayload.status, "open");
    assert.equal(packageAppealPayload.appeal.packageId, "plugin-lab");
    assert.equal(packageAppealPayload.appeal.status, "open");

    const packageAppealsList = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "appeals",
        "list",
        "--status",
        "open",
        "--package",
        "plugin-lab",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageAppealsListPayload = JSON.parse(packageAppealsList.stdout);
    assert.equal(packageAppealsListPayload.appeals[0].id, packageAppealPayload.appeal.id);

    const packageAppealResolve = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "appeals",
        "resolve",
        packageAppealPayload.appeal.id,
        "--status",
        "accepted",
        "--note",
        "Accepted appeal fixture.",
        "--action",
        "approve",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageAppealResolvePayload = JSON.parse(packageAppealResolve.stdout);
    assert.equal(packageAppealResolvePayload.status, "accepted");
    assert.equal(packageAppealResolvePayload.appeal.resolutionNote, "Accepted appeal fixture.");

    const packageModerationQueue = await execFileAsync(
      process.execPath,
      [cliPath, "package", "moderation-queue", "--status", "manual", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const packageModerationQueuePayload = JSON.parse(packageModerationQueue.stdout);
    assert.equal(packageModerationQueuePayload.releases[0].packageId, "plugin-lab");
    assert.equal(packageModerationQueuePayload.releases[0].moderationState, "quarantined");

    const packageDirectModeration = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "moderate",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--state",
        "approved",
        "--reason",
        "Accepted appeal fixture restored release.",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageDirectModerationPayload = JSON.parse(packageDirectModeration.stdout);
    assert.equal(packageDirectModerationPayload.state, "approved");
    assert.equal(packageDirectModerationPayload.blockedFromDownload, false);

    const restoredModerationStatus = await execFileAsync(
      process.execPath,
      [cliPath, "package", "moderation-status", "plugin-lab", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(restoredModerationStatus.stdout).latestVersion.blockedFromDownload, false);

    const packageScansList = await execFileAsync(
      process.execPath,
      [cliPath, "package", "scans", "list", "--package", "plugin-lab", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(packageScansList.stdout).scans[0].packageId, "plugin-lab");

    const packageScanRescan = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "scans",
        "rescan",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--reason",
        "Operator rescan fixture.",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const packageScanRescanPayload = JSON.parse(packageScanRescan.stdout);
    assert.equal(packageScanRescanPayload.status, "completed");
    assert.equal(packageScanRescanPayload.job.source, "manual");

    const packageScanBackfill = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "scans",
        "backfill",
        "--package",
        "plugin-lab",
        "--include-existing",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    assert.equal(JSON.parse(packageScanBackfill.stdout).status, "backfilled");

    const analyticsRecord = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "analytics",
        "record",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--event",
        "installed",
        "--source",
        "cli",
        "--client-id",
        "catalog-test-client",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );
    const analyticsRecordPayload = JSON.parse(analyticsRecord.stdout);
    assert.equal(analyticsRecordPayload.status, "recorded");
    assert.equal(analyticsRecordPayload.installEvent.packageId, "plugin-lab");
    assert.equal(analyticsRecordPayload.installEvent.clientHash.length, 64);
    assert.equal("clientId" in analyticsRecordPayload.installEvent, false);

    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "analytics",
        "record",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--event",
        "verified",
        "--source",
        "coreblow",
        "--registry",
        apiRegistryUrl,
      ],
      { env: apiAuthEnv },
    );

    const skippedAnalytics = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "analytics",
        "record",
        "plugin-lab",
        "--version",
        "0.1.0",
        "--event",
        "installed",
        "--source",
        "cli",
        "--registry",
        apiRegistryUrl,
      ],
      { env: { ...apiAuthEnv, COREHUB_DISABLE_TELEMETRY: "1" } },
    );
    const skippedAnalyticsPayload = JSON.parse(skippedAnalytics.stdout);
    assert.equal(skippedAnalyticsPayload.status, "skipped");
    assert.equal(skippedAnalyticsPayload.reason, "telemetry_disabled");

    const analyticsSummary = await execFileAsync(
      process.execPath,
      [cliPath, "analytics", "summary", "--package", "plugin-lab", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const analyticsSummaryPayload = JSON.parse(analyticsSummary.stdout);
    assert.equal(analyticsSummaryPayload.status, "ok");
    assert.equal(analyticsSummaryPayload.total, 2);
    assert.equal(analyticsSummaryPayload.uniqueClients, 1);
    assert.equal(analyticsSummaryPayload.byEvent.find((item) => item.key === "installed").count, 1);
    assert.equal(analyticsSummaryPayload.bySource.find((item) => item.key === "coreblow").count, 1);
    assert.equal(analyticsSummaryPayload.privacy.rawIpStored, false);

    const adminStatus = await execFileAsync(
      process.execPath,
      [cliPath, "admin", "status", "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const adminStatusPayload = JSON.parse(adminStatus.stdout);
    assert.equal(adminStatusPayload.status, "ok");
    assert.equal(adminStatusPayload.readiness.status, "ready");
    assert.equal(adminStatusPayload.counts.installEvents, 2);
    assert.equal(adminStatusPayload.counts.softDeletedPackages, 0);
    assert.equal(adminStatusPayload.counts.moderatedPackageVersions, 1);
    assert.equal(adminStatusPayload.counts.trustedPublishers, 1);
    assert.equal(adminStatusPayload.counts.activePublishTokens, 0);
    assert.equal(adminStatusPayload.counts.packageReports, 1);
    assert.equal(adminStatusPayload.counts.packageAppeals, 1);
    assert.equal(adminStatusPayload.counts.packageScanJobs, 5);
    assert.equal(adminStatusPayload.queues.reviews.approved, 1);
    assert.equal(adminStatusPayload.queues.packageLifecycle.active, 1);
    assert.equal(adminStatusPayload.queues.packageReleaseModeration.approved, 1);
    assert.equal(adminStatusPayload.queues.publishTokens.revoked, 1);
    assert.equal(adminStatusPayload.queues.packageReports.confirmed, 1);
    assert.equal(adminStatusPayload.queues.packageAppeals.accepted, 1);
    assert.equal(adminStatusPayload.queues.packageScans.completed, 5);
    assert.equal(adminStatusPayload.queues.packageScanResults.clean, 4);
    assert.equal(adminStatusPayload.queues.ownershipTransfers.completed, 1);
    assert.equal(adminStatusPayload.analytics.uniqueClients, 1);
    assert.equal(adminStatusPayload.audit.valid, true);

    const supportBundlePath = join(apiStorageDir, "corehub-support-bundle.json");
    const adminSupportBundle = await execFileAsync(
      process.execPath,
      [cliPath, "admin", "support-bundle", "--limit", "5", "--output", supportBundlePath, "--registry", apiRegistryUrl],
      { env: apiAuthEnv },
    );
    const adminSupportBundlePayload = JSON.parse(adminSupportBundle.stdout);
    assert.equal(adminSupportBundlePayload.status, "exported");
    assert.equal(adminSupportBundlePayload.healthStatus, "ok");
    const supportBundle = JSON.parse(await readFile(supportBundlePath, "utf8"));
    assert.equal(supportBundle.bundle.redaction.secretsIncluded, false);
    assert.equal(supportBundle.counts.installEvents, 2);
    assert.equal(supportBundle.counts.softDeletedPackages, 0);
    assert.equal(supportBundle.counts.moderatedPackageVersions, 1);
    assert.equal(supportBundle.counts.trustedPublishers, 1);
    assert.equal(supportBundle.recent.packageLifecycle[0].packageId, "plugin-lab");
    assert.equal(typeof supportBundle.recent.packageLifecycle[0].restoredAt, "string");
    assert.equal(supportBundle.recent.packageReleaseModeration[0].manualModeration.state, "approved");
    assert.equal(supportBundle.recent.trustedPublishers[0].repository, "coreblow/plugin-lab");
    assert.equal(supportBundle.recent.publishTokens[0].revokedBy.id, "github:coreblow-admin");
    assert.equal(supportBundle.recent.packageReports[0].status, "confirmed");
    assert.equal(supportBundle.recent.packageAppeals[0].status, "accepted");
    assert.equal(supportBundle.recent.packageScanJobs.some((job) => job.scanStatus === "malicious"), true);
    assert.equal(supportBundle.recent.auditEvents.length <= 5, true);

    const persistedState = JSON.parse(await readFile(apiStatePath, "utf8"));
    assert.equal(persistedState.schemaVersion, "corehub.local-state.v1");
    const pluginLabSlot = persistedState.slots.find((s) => s.packageId === "plugin-lab" && s.version === "0.1.0");
    assert.equal(pluginLabSlot.artifactUpload.status, "verified");
    assert.equal(persistedState.submissions[0].submission.status, "approved");
    assert.equal(persistedState.packageVersions[0].status, "available");
    assert.equal(persistedState.packageSearchDigests[0].packageId, "plugin-lab");
    assert.equal(persistedState.packageSearchDigests[0].family, "code-plugin");
    assert.equal(persistedState.packageSearchDigests[0].searchTokens.includes("plugin"), true);
    assert.equal(persistedState.packageSearchDigests[0].entry.id, "plugin-lab");
    assert.equal(persistedState.packageSearchDigests[0].entry.versions[0].artifact.fileCount, 5);
    assert.equal(persistedState.packageSearchDigests[0].entry.versions[0].artifact.npm.shasum, entries[2].versions[0].artifact.npm.shasum);
    assert.equal("softDeletedAt" in persistedState.packageVersions[0], false);
    assert.equal(typeof persistedState.packageVersions[0].restoredAt, "string");
    assert.equal(persistedState.packageVersions[0].manualModeration.state, "approved");
    assert.equal(persistedState.trustedPublishers[0].repository, "coreblow/plugin-lab");
    assert.equal(persistedState.publishTokens[0].revokedAt.length > 0, true);
    assert.equal(persistedState.installEvents.length, 2);
    assert.equal(persistedState.packageReports[0].status, "confirmed");
    assert.equal(persistedState.packageAppeals[0].status, "accepted");
    assert.equal(persistedState.packageScanJobs.length, 5);
    assert.equal(persistedState.packageScanJobs.some((job) => job.llmAnalysis?.verdict === "malicious"), true);
    assert.equal(persistedState.packageScanJobs[0].evidence.some((event) => event.type === "artifact_metadata"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "submission.create"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.scan.complete"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.report.create"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.report.triage"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.appeal.create"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.appeal.resolve"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.delete"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.undelete"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.release.moderate"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.trusted_publisher.set"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.publish_token.mint"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "package.publish_token.revoke"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "install.event.ingest"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "install.analytics.summary"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "audit.list"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "audit.retention.inspect"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "admin.status"), true);
    assert.equal(persistedState.auditEvents.some((event) => event.action === "admin.support_bundle"), true);
    assert.equal(persistedState.auditEvents.every((event) => /^[a-f0-9]{64}$/.test(event.eventHash)), true);

    const reloadedStorage = await CoreHubLocalStorageAdapter.open({
      root: apiStorageDir,
      statePath: apiStatePath,
    });
    const reloadedEntries = reloadedStorage.projectCatalogEntries();
    const reloadedSearchEntries = reloadedStorage.packageSearchEntries();
    assert.equal(reloadedEntries.length, 1);
    assert.equal(reloadedEntries[0].id, "plugin-lab");
    assert.equal(reloadedSearchEntries.length, 1);
    assert.equal(reloadedSearchEntries[0].id, "plugin-lab");
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

const privateStorageDir = await mkdtemp(join(tmpdir(), "corehub-private-storage-"));
const privateStorage = new CoreHubLocalStorageAdapter({ root: privateStorageDir });
const privateServer = createServer(
  createCoreHubApiHandler({
    storage: privateStorage,
    now: () => new Date("2026-05-21T01:30:00Z"),
  }),
);
await new Promise((resolve) => privateServer.listen(0, "127.0.0.1", resolve));
try {
  const actor = { type: "user", id: "github:coreblow-admin" };
  const privateRegistryUrl = `http://127.0.0.1:${privateServer.address().port}/corehub`;
  const privateSlot = await privateStorage.requestUploadSlot(
    {
      packageId: "private-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      provider: "managed",
      artifact: {
        name: "private-lab-0.1.0.coreblow-plugin.tgz",
        mediaType: "application/vnd.coreblow.plugin-archive+gzip",
        size: pluginLabArtifactBytes.byteLength,
        sha256: entries[2].versions[0].artifact.sha256,
      },
    },
    { actor },
  );
  await privateStorage.putObject(
    privateSlot.id,
    pluginLabArtifactBytes,
    { "x-corehub-artifact-sha256": entries[2].versions[0].artifact.sha256 },
    { actor },
  );
  const verifiedPrivateUpload = await privateStorage.verifyUpload(privateSlot.id, { actor });
  const privateSubmission = await privateStorage.createSubmission(
    {
      packageId: "private-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      kind: "plugin",
      channel: "private",
      artifactUploadId: verifiedPrivateUpload.artifactUpload.id,
      source: "https://github.com/coreblow/private-lab",
      changelog: "Private visibility fixture.",
    },
    { actor },
  );
  await privateStorage.decideReview(
    privateSubmission.moderationReview.id,
    "approve",
    { notes: "Approve private visibility fixture." },
    { actor },
  );

  const publicPrivateList = await fetch(`${privateRegistryUrl}/api/v1/packages`);
  assert.equal(publicPrivateList.status, 200);
  assert.equal((await publicPrivateList.json()).data.some((entry) => entry.id === "private-lab"), false);

  const publicPrivatePackage = await fetch(`${privateRegistryUrl}/api/v1/packages/private-lab`);
  assert.equal(publicPrivatePackage.status, 404);

  const authorizedPrivatePackage = await fetch(`${privateRegistryUrl}/api/v1/packages/private-lab`, {
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal(authorizedPrivatePackage.status, 200);
  const authorizedPrivatePackagePayload = await authorizedPrivatePackage.json();
  assert.equal(authorizedPrivatePackagePayload.data.marketplace.channel, "private");

  const authorizedPrivateList = await fetch(`${privateRegistryUrl}/api/v1/packages?channel=private`, {
    headers: { "x-corehub-user": "github:coreblow-admin" },
  });
  assert.equal(authorizedPrivateList.status, 200);
  assert.equal((await authorizedPrivateList.json()).data[0].id, "private-lab");
} finally {
  await new Promise((resolve) => privateServer.close(resolve));
  await rm(privateStorageDir, { recursive: true, force: true });
}

const rateLimitStorageDir = await mkdtemp(join(tmpdir(), "corehub-rate-limit-storage-"));
const rateLimitServer = createServer(
  createCoreHubApiHandler({
    storage: new CoreHubLocalStorageAdapter({ root: rateLimitStorageDir }),
    rateLimit: { limit: 1, windowMs: 60_000 },
  }),
);
await new Promise((resolve) => rateLimitServer.listen(0, "127.0.0.1", resolve));
try {
  const rateLimitUrl = `http://127.0.0.1:${rateLimitServer.address().port}/corehub/api/v1`;
  const firstRateLimited = await fetch(rateLimitUrl, { headers: { "x-corehub-client-id": "rate-limit-test" } });
  assert.equal(firstRateLimited.status, 200);
  assert.equal(firstRateLimited.headers.get("x-ratelimit-limit"), "1");
  assert.equal(firstRateLimited.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(firstRateLimited.headers.get("ratelimit-limit"), "1");
  assert.equal(firstRateLimited.headers.get("ratelimit-remaining"), "0");
  const secondRateLimited = await fetch(rateLimitUrl, { headers: { "x-corehub-client-id": "rate-limit-test" } });
  assert.equal(secondRateLimited.status, 429);
  assert.match(secondRateLimited.headers.get("content-type"), /text\/plain/);
  assert.equal(secondRateLimited.headers.get("retry-after"), "60");
  assert.equal(secondRateLimited.headers.get("x-ratelimit-limit"), "1");
  assert.equal(secondRateLimited.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(secondRateLimited.headers.get("ratelimit-limit"), "1");
  assert.equal(secondRateLimited.headers.get("ratelimit-remaining"), "0");
  assert.equal(secondRateLimited.headers.get("ratelimit-reset"), "60");
  assert.equal(await secondRateLimited.text(), "Rate limit exceeded");
} finally {
  await new Promise((resolve) => rateLimitServer.close(resolve));
  await rm(rateLimitStorageDir, { recursive: true, force: true });
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
      provider: "managed",
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
      execFileAsync(process.execPath, [cliPath, "audit", "incident", "report", "--registry", incidentRegistryUrl], {
        env: { ...process.env, COREHUB_TOKEN: "local-dev-token", COREHUB_USER: "github:coreblow-admin" },
      }),
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
      execFileAsync(
        process.execPath,
        [
          auditIncidentCheckPath,
          "--registry",
          incidentRegistryUrl,
          "--output",
          incidentAutomationOutput,
        ],
        {
          env: { ...process.env, COREHUB_TOKEN: "local-dev-token", COREHUB_USER: "github:coreblow-admin" },
        },
      ),
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

  if (url.pathname === "/corehub/api/v1/packages/search") {
    assert.equal(url.searchParams.get("family"), "code-plugin");
    assert.equal(url.searchParams.get("capabilityTag"), "contract-validation");
    assert.equal(url.searchParams.get("isOfficial"), "true");
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: [{ ...entries[2], marketplace: { family: "code-plugin", channel: "official" }, score: 12 }],
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

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/moderation") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          status: "ok",
          package: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab", publisher: entries[2].publisher },
          review: entries[2].review,
          latestVersion: {
            version: "0.1.0",
            tag: "latest",
            status: "available",
            moderationStatus: "verified",
            blockedFromDownload: false,
            downloadEnabled: true,
            reasons: [],
            moderationReason: entries[2].review.notes,
          },
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/readiness") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          status: "ok",
          ready: true,
          package: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab", latestVersion: "0.1.0", publisher: entries[2].publisher },
          checks: [
            { id: "artifact-download", label: "Artifact download", status: "pass", message: "Latest artifact download is enabled." },
          ],
          blockers: [],
        },
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

  const remotePackageSearch = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "search",
    "plugin",
    "--family",
    "code-plugin",
    "--capability",
    "contract-validation",
    "--official",
    "--registry",
    registryUrl,
  ]);
  assert.match(remotePackageSearch.stdout, /plugin-lab\tplugin\tPlugin Lab code-plugin\/official score=12/);

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

  const remoteVerify = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "verify",
    new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
    "--package",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  const remoteVerifyPayload = JSON.parse(remoteVerify.stdout);
  assert.equal(remoteVerifyPayload.status, "verified");
  assert.equal(remoteVerifyPayload.expected.packageId, "plugin-lab");
  assert.equal(remoteVerifyPayload.verification.checksumMatches, true);

  const remoteModerationStatus = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "moderation-status",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  const remoteModerationStatusPayload = JSON.parse(remoteModerationStatus.stdout);
  assert.equal(remoteModerationStatusPayload.latestVersion.blockedFromDownload, false);
  assert.equal(remoteModerationStatusPayload.review.state, "verified");

  const remoteReadiness = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "readiness",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  const remoteReadinessPayload = JSON.parse(remoteReadiness.stdout);
  assert.equal(remoteReadinessPayload.ready, true);
  assert.equal(remoteReadinessPayload.checks.some((check) => check.id === "artifact-download"), true);

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
  const installHome = await mkdtemp(join(tmpdir(), "corehub-install-home-"));
  const installEnv = { ...process.env, COREHUB_HOME: installHome };
  try {
    const installPath = join(installDir, "plugin-lab.coreblow-plugin.tgz");
    const remoteInstall = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "package",
        "install",
        "plugin-lab",
        "--output",
        installPath,
        "--registry",
        registryUrl,
      ],
      { env: installEnv },
    );
    const plan = JSON.parse(remoteInstall.stdout);
    assert.equal(plan.dryRun, false);
    assert.equal(plan.install.status, "installed");
    assert.equal(plan.download.verified, true);
    assert.equal(plan.download.output.bytes, entries[2].versions[0].artifact.size);
    assert.equal(plan.download.output.sha256, entries[2].versions[0].artifact.sha256);
    assert.equal(plan.plan.find((step) => step.step === "fetch-artifact").status, "complete");
    assert.equal(plan.plan.find((step) => step.step === "install-plugin").status, "complete");
    assert.equal(plan.localState.id, "plugin-lab");
    assert.equal(plan.localState.version, "0.1.0");
    assert.equal(plan.localState.pinned, false);
    assert.deepEqual(await readFile(installPath), pluginLabArtifactBytes);

    const installedList = await execFileAsync(
      process.execPath,
      [cliPath, "package", "installed", "list"],
      { env: installEnv },
    );
    const installedListPayload = JSON.parse(installedList.stdout);
    assert.equal(installedListPayload.packages.length, 1);
    assert.equal(installedListPayload.packages[0].id, "plugin-lab");

    const pin = await execFileAsync(process.execPath, [cliPath, "package", "pin", "plugin-lab"], {
      env: installEnv,
    });
    assert.equal(JSON.parse(pin.stdout).package.pinned, true);

    const pinnedUpdate = await execFileAsync(
      process.execPath,
      [cliPath, "package", "update", "plugin-lab", "--registry", registryUrl],
      { env: installEnv },
    );
    const pinnedUpdatePayload = JSON.parse(pinnedUpdate.stdout);
    assert.equal(pinnedUpdatePayload.status, "skipped");
    assert.equal(pinnedUpdatePayload.reason, "pinned");

    const syncPinned = await execFileAsync(
      process.execPath,
      [cliPath, "package", "sync", "--registry", registryUrl],
      { env: installEnv },
    );
    const syncPinnedPayload = JSON.parse(syncPinned.stdout);
    assert.equal(syncPinnedPayload.results[0].status, "skipped");
    assert.equal(syncPinnedPayload.results[0].reason, "pinned");

    const unpin = await execFileAsync(process.execPath, [cliPath, "package", "unpin", "plugin-lab"], {
      env: installEnv,
    });
    assert.equal(JSON.parse(unpin.stdout).package.pinned, false);

    const update = await execFileAsync(
      process.execPath,
      [cliPath, "package", "update", "plugin-lab", "--registry", registryUrl],
      { env: installEnv },
    );
    assert.equal(JSON.parse(update.stdout).status, "updated");

    const uninstall = await execFileAsync(process.execPath, [cliPath, "package", "uninstall", "plugin-lab"], {
      env: installEnv,
    });
    assert.equal(JSON.parse(uninstall.stdout).status, "uninstalled");

    const emptyInstalledList = await execFileAsync(
      process.execPath,
      [cliPath, "package", "installed", "list"],
      { env: installEnv },
    );
    assert.equal(JSON.parse(emptyInstalledList.stdout).packages.length, 0);
  } finally {
    await rm(installDir, { recursive: true, force: true });
    await rm(installHome, { recursive: true, force: true });
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

  const topInstallHome = await mkdtemp(join(tmpdir(), "corehub-top-install-home-"));
  try {
    const remoteTopLevelInstall = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "install",
        "plugin-lab",
        "--json",
        "--registry",
        registryUrl,
      ],
      { env: { ...process.env, COREHUB_HOME: topInstallHome } },
    );
    const remoteInstallPlan = JSON.parse(remoteTopLevelInstall.stdout);
    assert.equal(remoteInstallPlan.dryRun, false);
    assert.equal(remoteInstallPlan.install.status, "installed");
    assert.equal(remoteInstallPlan.download.verified, true);
    assert.equal(remoteInstallPlan.download.output.bytes, entries[2].versions[0].artifact.size);
    assert.match(remoteInstallPlan.install.message, /recorded local install state/);
  } finally {
    await rm(topInstallHome, { recursive: true, force: true });
  }

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

  // Phase 3 Scoped Name Validation Tests
  const scopedErrors = validateCatalog([
    {
      id: "@coreblow/plugin-lab",
      kind: "plugin",
      name: "Plugin Lab",
      summary: "Compatibility lab fixtures",
      source: "https://github.com/coreblow/corehub",
      publisher: {
        handle: "coreblow",
        displayName: "CoreBlow",
        url: "https://coreblow.com",
        verified: true,
      },
    },
  ]);
  assert.deepEqual(scopedErrors, []);

  const mismatchedScopedErrors = validateCatalog([
    {
      id: "@coreblow/plugin-lab",
      kind: "plugin",
      name: "Plugin Lab",
      summary: "Compatibility lab fixtures",
      source: "https://github.com/coreblow/corehub",
      publisher: {
        handle: "mismatched",
        displayName: "CoreBlow",
        url: "https://coreblow.com",
        verified: true,
      },
    },
  ]);
  assert.ok(
    mismatchedScopedErrors.some((err) =>
      err.includes("scoped package scope 'coreblow' must match publisher handle 'mismatched'")
    )
  );

  // JWT signing and verification tests
  const testPayload = { actor: { id: "github:coreblow-admin", type: "user" } };
  const signingSecret = "corehub-local-development-signing-secret";
  const signedToken = signJwt(testPayload, signingSecret);
  const verifiedPayload = verifyJwt(signedToken, signingSecret);
  assert.deepEqual(verifiedPayload.actor, testPayload.actor);

  // Remote whoami authenticated test utilizing JWT
  const whoamiHome = await mkdtemp(join(tmpdir(), "corehub-whoami-auth-"));
  try {
    const whoamiEnv = { ...process.env, COREHUB_HOME: whoamiHome };
    await execFileAsync(
      process.execPath,
      [
        cliPath,
        "login",
        "--token",
        signedToken,
        "--user",
        "github:coreblow-admin",
        "--publisher",
        "coreblow",
        "--registry",
        registryUrl,
      ],
      { env: whoamiEnv }
    );
    const remoteWhoami = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "whoami",
        "--registry",
        registryUrl,
        "--json",
      ],
      { env: whoamiEnv }
    );
    const whoamiResult = JSON.parse(remoteWhoami.stdout);
    assert.equal(whoamiResult.authenticated, true);
    assert.equal(whoamiResult.actor.id, "github:coreblow-admin");
    assert.equal(whoamiResult.memberships[0].publisherHandle, "coreblow");
  } finally {
    await rm(whoamiHome, { recursive: true, force: true });
  }
} finally {
  await new Promise((resolve) => registryServer.close(resolve));
}

function normalizedMockRows(rows, collection) {
  return [...rows.entries()]
    .filter(([key]) => key.startsWith(`corehub_state_rows:${collection}:`))
    .map(([, row]) => row)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((row) => JSON.parse(row.value));
}

function createMockD1Database(rows) {
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          return { ...this, values };
        },
        async first() {
          if (/^SELECT value FROM corehub_state_meta WHERE key = \?1$/.test(sql)) {
            return rows.get(`corehub_state_meta:${this.values[0]}`) ?? null;
          }
          if (/^SELECT value FROM corehub_state WHERE key = \?1$/.test(sql)) {
            return rows.get(`corehub_state:${this.values[0]}`) ?? rows.get(this.values[0]) ?? null;
          }
          throw new Error(`Unexpected mock D1 query: ${sql}`);
        },
        async all() {
          if (!/^SELECT collection, value FROM corehub_state_rows ORDER BY collection ASC, position ASC, id ASC$/.test(sql)) {
            throw new Error(`Unexpected mock D1 query: ${sql}`);
          }
          return {
            results: [...rows.entries()]
              .filter(([key]) => key.startsWith("corehub_state_rows:"))
              .map(([, row]) => row)
              .sort((left, right) => left.collection.localeCompare(right.collection) || left.position - right.position || left.id.localeCompare(right.id)),
          };
        },
        async run() {
          if (/^DELETE FROM corehub_state_indexes$/.test(sql)) {
            for (const key of [...rows.keys()].filter((key) => key.startsWith("corehub_state_indexes:"))) rows.delete(key);
            return { success: true };
          }
          if (/^DELETE FROM corehub_state_rows$/.test(sql)) {
            for (const key of [...rows.keys()].filter((key) => key.startsWith("corehub_state_rows:"))) rows.delete(key);
            return { success: true };
          }
          if (/^INSERT INTO corehub_state_meta/.test(sql)) {
            rows.set(`corehub_state_meta:${this.values[0]}`, {
              key: this.values[0],
              value: this.values[1],
              updated_at: this.values[2],
            });
            return { success: true };
          }
          if (/^INSERT INTO corehub_state_rows/.test(sql)) {
            rows.set(`corehub_state_rows:${this.values[0]}:${this.values[1]}`, {
              collection: this.values[0],
              id: this.values[1],
              position: this.values[2],
              value: this.values[3],
              updated_at: this.values[4],
            });
            return { success: true };
          }
          if (/^INSERT INTO corehub_state_indexes/.test(sql)) {
            rows.set(`corehub_state_indexes:${this.values[0]}:${this.values[1]}:${this.values[2]}:${this.values[3]}`, {
              collection: this.values[0],
              index_name: this.values[1],
              index_key: this.values[2],
              row_id: this.values[3],
              updated_at: this.values[4],
            });
            return { success: true };
          }
          if (/^INSERT INTO corehub_state/.test(sql)) {
            rows.set(`corehub_state:${this.values[0]}`, {
              key: this.values[0],
              value: this.values[1],
              updated_at: this.values[2],
            });
            rows.set(this.values[0], {
              key: this.values[0],
              value: this.values[1],
              updated_at: this.values[2],
            });
            return { success: true };
          }
          throw new Error(`Unexpected mock D1 mutation: ${sql}`);
        },
      };
    },
  };
}

function createMockManagedBucket(objects) {
  return {
    async put(key, bytes, options = {}) {
      objects.set(key, {
        body: Buffer.from(bytes),
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      });
      return { key };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        ...object,
        async arrayBuffer() {
          return object.body.buffer.slice(
            object.body.byteOffset,
            object.body.byteOffset + object.body.byteLength,
          );
        },
      };
    },
  };
}
