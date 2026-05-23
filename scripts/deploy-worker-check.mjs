#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const config = readOption("--config") ?? "ops/cloudflare/wrangler.corehub-api.persistence.example.toml";
const mode = args.includes("--template") ? "template" : "production";
const skipWrangler = args.includes("--skip-wrangler");
const requireWrangler = args.includes("--require-wrangler");
const wranglerAvailable = commandAvailable("wrangler");
const checks = [];

runStep("readiness", [
  process.execPath,
  "scripts/validate-worker-deploy-readiness.mjs",
  mode === "production" ? "--production" : "--template",
  "--config",
  config,
]);

runStep("persistence-migration-smoke", [process.execPath, "scripts/smoke-persistence-migration.mjs"]);

runStep("worker-local-smoke", [process.execPath, "scripts/smoke-worker-local.mjs"]);

if (skipWrangler) {
  checks.push({ name: "wrangler-dry-run", status: "skipped", detail: "skipped by --skip-wrangler" });
} else if (wranglerAvailable) {
  runStep("wrangler-dry-run", ["wrangler", "deploy", "--dry-run", "--config", config]);
} else if (requireWrangler) {
  fail("wrangler-dry-run", "wrangler is required but was not found on PATH");
} else {
  checks.push({ name: "wrangler-dry-run", status: "skipped", detail: "wrangler not found on PATH" });
}

console.log(JSON.stringify({ status: "ready", mode, config, checks }, null, 2));

function runStep(name, command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: resolve(new URL("..", import.meta.url).pathname),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status === 0) {
    checks.push({ name, status: "pass", detail: command.join(" ") });
    return;
  }
  fail(name, `command failed with exit code ${result.status ?? "unknown"}: ${command.join(" ")}`);
}

function fail(name, detail) {
  console.error(JSON.stringify({ status: "failed", mode, config, failedStep: name, detail, checks }, null, 2));
  process.exit(1);
}

function readOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}
