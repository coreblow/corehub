#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreHubLocalStorageAdapter } from "../src/api-server.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const tempRoot = await mkdtemp(join(tmpdir(), "corehub-production-drill-"));
const checks = [];

try {
  const statePath = join(tempRoot, "write-side-state.json");
  const backupPath = join(tempRoot, "write-side-state.backup.json");
  const restoredPath = join(tempRoot, "write-side-state.restored.json");

  const storage = new CoreHubLocalStorageAdapter({
    root: join(tempRoot, "storage"),
    statePath,
  });
  await storage.requestUploadSlot({
    packageId: "plugin-lab",
    version: "0.9.0-drill",
    publisherHandle: "coreblow",
    provider: "managed",
    artifact: {
      name: "plugin-lab-0.9.0-drill.coreblow-plugin.tgz",
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: 12,
      sha256: "0".repeat(64),
    },
  });

  runStep("production-finalization", [process.execPath, "scripts/validate-production-finalization.mjs"]);
  runStep("snapshot-export", [
    process.execPath,
    "scripts/persistence-snapshot.mjs",
    "export",
    "--input",
    statePath,
    "--output",
    backupPath,
  ]);
  runStep("snapshot-validate-backup", [process.execPath, "scripts/persistence-snapshot.mjs", "validate", "--input", backupPath]);
  runStep("snapshot-restore-dry-run", [
    process.execPath,
    "scripts/persistence-snapshot.mjs",
    "restore",
    "--input",
    backupPath,
    "--output",
    restoredPath,
    "--dry-run",
  ]);
  runStep("snapshot-restore-apply", [
    process.execPath,
    "scripts/persistence-snapshot.mjs",
    "restore",
    "--input",
    backupPath,
    "--output",
    restoredPath,
    "--apply",
  ]);
  runStep("snapshot-validate-restored", [process.execPath, "scripts/persistence-snapshot.mjs", "validate", "--input", restoredPath]);
  runStep("persistence-migration-smoke", [process.execPath, "scripts/smoke-persistence-migration.mjs"]);
  runStep("worker-local-smoke", [process.execPath, "scripts/smoke-worker-local.mjs"]);

  console.log(JSON.stringify({ status: "ready", rehearsal: "production-drill", checks }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function runStep(name, command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status === 0) {
    checks.push({ name, status: "pass", detail: summarizeOutput(output) });
    return;
  }
  checks.push({ name, status: "fail", detail: summarizeOutput(output) });
  console.error(JSON.stringify({ status: "failed", failedStep: name, checks }, null, 2));
  process.exit(1);
}

function summarizeOutput(output) {
  if (!output) return "";
  return output.split(/\r?\n/).filter(Boolean).slice(-4).join("\n").slice(0, 800);
}
