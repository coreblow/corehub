#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { formatAuditAlertDeliveryMetricsJsonl } from "../ops/cloudflare/audit-alert-adapters.mjs";
import { runAuditIncidentCheck } from "../ops/cloudflare/audit-incident-worker.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(repoRoot, "src/cli.mjs");
const tempRoot = await mkdtemp(join(tmpdir(), "corehub-audit-alert-pipeline-"));
const metricsPath = join(tempRoot, "corehub-audit-alert-delivery-metrics.jsonl");
const summaryPath = join(tempRoot, "corehub-audit-alert-delivery-summary.md");

function logStep(message) {
  console.log(`- ${message}`);
}

async function runCoreHub(args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: repoRoot });
  return result.stdout.trim();
}

const originalFetch = globalThis.fetch;

try {
  let alertAttempts = 0;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/corehub/api/v2/audit/verify") {
      return Response.json({
        apiVersion: "v2",
        data: {
          valid: false,
          behavior: "fail_closed",
          count: 1,
          head: "c".repeat(64),
          errors: ["smoke tamper fixture"],
        },
      });
    }
    if (parsed.pathname === "/corehub/api/v2/audit/retention") {
      return Response.json({
        apiVersion: "v2",
        data: { status: "blocked", policy: { integrityFailureBehavior: "fail_closed" } },
      });
    }
    if (parsed.pathname === "/corehub/api/v2/audit/events") {
      return Response.json({
        apiVersion: "v2",
        data: [{ sequence: 1, action: "audit.verify", targetType: "audit", targetId: "smoke" }],
        meta: { count: 1 },
      });
    }
    if (parsed.pathname === "/alert") {
      alertAttempts += 1;
      if (alertAttempts === 1) {
        return new Response("temporary alert outage", { status: 503, statusText: "Service Unavailable" });
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };

  const report = await runAuditIncidentCheck({
    COREHUB_REGISTRY: "https://coreblow.com/corehub",
    COREHUB_AUDIT_ALERT_WEBHOOK: "https://alerts.example.invalid/alert",
    COREHUB_AUDIT_ALERT_DESTINATION: "webhook",
    COREHUB_AUDIT_ALERT_RETRIES: "1",
    COREHUB_AUDIT_ALERT_RETRY_DELAY_MS: "0",
  });
  assert.equal(report.status, "fail_closed");
  assert.equal(report.alertDelivery.status, "delivered");
  assert.equal(report.alertDelivery.attempts, 2);
  logStep("fail_closed report delivered after retry");

  await writeFile(metricsPath, `${formatAuditAlertDeliveryMetricsJsonl(report.alertDelivery.metrics)}\n`);
  assert.match(await readFile(metricsPath, "utf8"), /alert\.delivery\.final/);
  logStep("alert delivery metrics exported");

  const summary = JSON.parse(await runCoreHub(["audit", "alert-metrics", "summarize", metricsPath]));
  assert.equal(summary.finalStatusCounts.delivered, 1);
  assert.equal(summary.attemptStatusCounts.retry, 1);
  assert.equal(summary.rates.deadLetter, 0);
  logStep("alert delivery metrics summarized");

  const assertion = JSON.parse(
    await runCoreHub([
      "audit",
      "alert-metrics",
      "assert",
      metricsPath,
      "--max-dead-letter-rate",
      "0",
      "--max-retry-rate",
      "0.5",
    ]),
  );
  assert.equal(assertion.status, "passed");
  logStep("alert delivery metrics threshold passed");

  const markdownExport = JSON.parse(
    await runCoreHub(["audit", "alert-metrics", "summarize", metricsPath, "--format", "markdown", "--output", summaryPath]),
  );
  assert.equal(markdownExport.status, "exported");
  assert.match(await readFile(summaryPath, "utf8"), /Retry Rate: 50\.00%/);
  logStep("alert delivery summary markdown exported");

  console.log("CoreHub audit alert pipeline smoke passed.");
} finally {
  globalThis.fetch = originalFetch;
  await rm(tempRoot, { recursive: true, force: true });
}
