#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { buildAuditAlertPayload, formatAlertForDestination } from "../ops/cloudflare/audit-alert-adapters.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const cliPath = join(repoRoot, "src/cli.mjs");
const args = process.argv.slice(2);

const registry = readOption(args, "--registry") ?? process.env.COREHUB_REGISTRY;
const format = readOption(args, "--format") ?? process.env.COREHUB_AUDIT_INCIDENT_FORMAT ?? "markdown";
const output =
  readOption(args, "--output") ?? process.env.COREHUB_AUDIT_INCIDENT_REPORT ?? ".corehub-audit/corehub-audit-incident.md";
const limit = readOption(args, "--limit") ?? process.env.COREHUB_AUDIT_INCIDENT_LIMIT ?? "50";
const alertDestination = process.env.COREHUB_AUDIT_ALERT_DESTINATION;
const alertWebhook = process.env.COREHUB_AUDIT_ALERT_WEBHOOK;

if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
  printHelp();
  process.exit(0);
}

if (!registry) {
  console.error("audit incident check requires --registry or COREHUB_REGISTRY");
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
    format,
    "--output",
    outputPath,
    "--limit",
    limit,
    "--registry",
    registry,
  ]);
  writePassthrough(result);
} catch (error) {
  writePassthrough(error);
  if (alertWebhook && error.stdout) {
    await sendAlert(error.stdout).catch((alertError) => {
      console.error(alertError instanceof Error ? alertError.message : alertError);
    });
  }
  process.exitCode = typeof error.code === "number" ? error.code : 1;
}

function writePassthrough(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  return values[index + 1];
}

function hasFlag(values, name) {
  return values.includes(name);
}

async function sendAlert(stdout) {
  const payload = JSON.parse(stdout);
  const alert = buildAuditAlertPayload(payload, process.env);
  await fetch(alertWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formatAlertForDestination(alert, alertDestination, process.env)),
  });
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
`);
}
