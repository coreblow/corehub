#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { deliverAuditAlert } from "../ops/cloudflare/audit-alert-adapters.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(repoRoot, "src/cli.mjs");
const args = process.argv.slice(2);

const registry = readOption(args, "--registry") ?? process.env.COREHUB_REGISTRY;
const format = readOption(args, "--format") ?? process.env.COREHUB_AUDIT_INCIDENT_FORMAT ?? "markdown";
const output =
  readOption(args, "--output") ?? process.env.COREHUB_AUDIT_INCIDENT_REPORT ?? ".corehub-audit/corehub-audit-incident.md";
const limit = readOption(args, "--limit") ?? process.env.COREHUB_AUDIT_INCIDENT_LIMIT ?? "50";
const alertWebhook = process.env.COREHUB_AUDIT_ALERT_WEBHOOK;
const deadLetterPath = process.env.COREHUB_AUDIT_ALERT_DEAD_LETTER_PATH;

if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
  printHelp();
  process.exit(0);
}

if (!registry) {
  console.error("audit incident check requires --registry or COREHUB_REGISTRY");
  process.exit(2);
}

if (!new Set(["json", "markdown"]).has(format)) {
  console.error("audit incident check --format must be json or markdown");
  process.exit(2);
}

const outputPath = resolve(output);
await mkdir(dirname(outputPath), { recursive: true });

try {
  const result = await execFileAsync(process.execPath, [
    cliPath,
    "audit",
    "incident",
    "report",
    "--format",
    "json",
    "--limit",
    limit,
    "--registry",
    registry,
  ]);
  const report = JSON.parse(result.stdout);
  await writeReport(outputPath, format, report);
  writeExportSummary(report);
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  if (alertWebhook && error.stdout) {
    await handleFailedReport(error.stdout).catch((alertError) => {
      console.error(alertError instanceof Error ? alertError.message : alertError);
    });
  } else if (error.stdout) {
    const report = JSON.parse(error.stdout);
    await writeReport(outputPath, format, report);
    writeExportSummary(report);
  }
  process.exitCode = typeof error.code === "number" ? error.code : 1;
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  return values[index + 1];
}

function hasFlag(values, name) {
  return values.includes(name);
}

async function handleFailedReport(stdout) {
  const report = JSON.parse(stdout);
  await writeReport(outputPath, format, report);
  const delivery = await deliverAuditAlert(report, process.env);
  if (delivery.deadLetter) {
    const deadLetter = `${JSON.stringify(delivery.deadLetter, null, 2)}\n`;
    if (deadLetterPath) await writeFile(resolve(deadLetterPath), deadLetter);
    console.error(`CoreHub audit alert delivery failed after ${delivery.attempts} attempts.`);
    console.error(deadLetter);
  }
  writeExportSummary(report, delivery);
}

async function writeReport(path, reportFormat, report) {
  const rendered = reportFormat === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdownReport(report);
  await writeFile(path, rendered);
}

function writeExportSummary(report, alertDelivery) {
  console.log(
    JSON.stringify(
      {
        status: "exported",
        incidentStatus: report.status,
        registry: report.registry,
        format,
        output: outputPath,
        ...(alertDelivery ? { alertDelivery } : {}),
      },
      null,
      2,
    ),
  );
}

function renderMarkdownReport(report) {
  const errors = report.verification?.errors?.length
    ? report.verification.errors.map((error) => `- ${error}`).join("\n")
    : "- none";
  return `# CoreHub Audit Incident Report

Status: ${report.status}
Severity: ${report.severity}
Registry: ${report.registry}
Generated: ${report.generatedAt}

## Verification

- Valid: ${String(report.verification?.valid)}
- Behavior: ${report.verification?.behavior ?? "unknown"}
- Count: ${report.verification?.count ?? 0}
- Head: ${report.verification?.head ?? "unknown"}

## Integrity Errors

${errors}

## Retention

- Status: ${report.retention?.status ?? "unknown"}
- Integrity failure behavior: ${report.retention?.policy?.integrityFailureBehavior ?? "unknown"}

## Recent Audit Events

- Count: ${report.recentAuditEvents?.length ?? 0}
`;
}

function printHelp() {
  console.log(`CoreHub audit incident automation check

Usage:
  npm run audit:incident -- --registry https://coreblow.com/corehub
  COREHUB_REGISTRY=https://coreblow.com/corehub npm run audit:incident

Options:
  --registry <url>   CoreHub registry base URL.
  --output <file>    Incident report path. Defaults to .corehub-audit/corehub-audit-incident.md.
  --format <format>  json or markdown. Defaults to markdown.
  --limit <n>        Recent audit event limit. Defaults to 50.

The command exits non-zero when the audit incident report returns fail_closed.
Set COREHUB_AUDIT_ALERT_WEBHOOK and COREHUB_AUDIT_ALERT_DESTINATION to send fail_closed alerts.
Optional reliability variables:
  COREHUB_AUDIT_ALERT_RETRIES=2
  COREHUB_AUDIT_ALERT_RETRY_DELAY_MS=250
  COREHUB_AUDIT_ALERT_TIMEOUT_MS=5000
  COREHUB_AUDIT_ALERT_DEAD_LETTER_PATH=.corehub-audit/corehub-audit-alert-dead-letter.json
`);
}
