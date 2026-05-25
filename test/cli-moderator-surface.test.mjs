import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { seedManagedPackage, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const execFileAsync = promisify(execFile);
const cliPath = new URL("../src/cli.mjs", import.meta.url).pathname;
const server = await startCoreHubTestServer();
try {
  await seedManagedPackage(server.storage, { packageId: "surface-cli" });
  const env = {
    ...process.env,
    COREHUB_REGISTRY: server.corehubUrl,
    COREHUB_TOKEN: "surface-cli-token",
    COREHUB_USER: "github:coreblow-admin",
  };

  const enqueue = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "scans",
      "enqueue",
      "surface-cli",
      "--version",
      "0.1.0",
      "--scanner",
      "corehub-clawscan",
      "--reason",
      "CLI surface test.",
    ],
    { env },
  );
  const enqueuePayload = JSON.parse(enqueue.stdout);
  assert.equal(enqueuePayload.registry, server.corehubUrl);
  assert.equal(enqueuePayload.job.status, "queued");
  assert.equal(enqueuePayload.job.packageId, "surface-cli");

  const complete = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "scans",
      "complete",
      enqueuePayload.job.id,
      "--scan-status",
      "clean",
      "--summary",
      "CLI scanner completed.",
    ],
    { env },
  );
  assert.equal(JSON.parse(complete.stdout).job.scanStatus, "clean");

  const list = await execFileAsync(process.execPath, [cliPath, "package", "scans", "list", "--package", "surface-cli"], {
    env,
  });
  const listPayload = JSON.parse(list.stdout);
  assert.equal(listPayload.status, "ok");
  assert.equal(listPayload.scans.some((scan) => scan.packageId === "surface-cli"), true);
} finally {
  await server.close();
}
