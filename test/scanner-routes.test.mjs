import assert from "node:assert/strict";
import { jsonHeaders, seedManagedPackage, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  await seedManagedPackage(server.storage, { packageId: "surface-scan" });

  const initialStatus = await fetch(`${server.v1Url}/packages/surface-scan/scan`);
  assert.equal(initialStatus.status, 200);
  assert.equal((await initialStatus.json()).data.scan.scanStatus, "pending");

  const backfill = await fetch(`${server.v2Url}/package-scans/backfill`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ packageId: "surface-scan", reason: "Surface scanner backfill." }),
  });
  assert.equal(backfill.status, 200);
  const backfillPayload = await backfill.json();
  assert.equal(backfillPayload.data.count, 1);
  assert.equal(backfillPayload.data.jobs[0].scanner, "corehub-static");
  assert.equal(backfillPayload.data.jobs[0].scanStatus, "clean");

  const enqueue = await fetch(`${server.v2Url}/package-scans/enqueue`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      packageId: "surface-scan",
      version: "0.1.0",
      scanner: "corehub-clawscan",
      source: "hosted",
      reason: "Surface hosted scanner queue.",
    }),
  });
  assert.equal(enqueue.status, 200);
  const enqueuePayload = await enqueue.json();
  assert.equal(enqueuePayload.data.job.status, "queued");
  assert.equal(enqueuePayload.data.job.inputs.fileCount, 5);

  const result = await fetch(`${server.v2Url}/package-scans/${enqueuePayload.data.job.id}/result`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      status: "completed",
      llmAnalysis: {
        status: "completed",
        verdict: "malicious",
        summary: "Surface fixture is blocked.",
      },
      staticScan: { status: "suspicious", summary: "Static suspicious fixture." },
      summary: "Hosted scanner blocked the release.",
      riskLevel: "high",
      reasonCodes: ["scan:malicious"],
      evidence: [
        {
          type: "hosted_scan_finding",
          severity: "critical",
          summary: "Surface scanner finding.",
          metadata: { fixture: true },
        },
      ],
    }),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).data.job.scanStatus, "malicious");

  const security = await fetch(`${server.v1Url}/packages/surface-scan/versions/0.1.0/security`);
  assert.equal(security.status, 200);
  const securityPayload = await security.json();
  assert.equal(securityPayload.data.trust.blockedFromDownload, true);
  assert.equal(securityPayload.data.trust.scanStatus, "malicious");
  assert.equal(securityPayload.data.trust.reasons.includes("scan:malicious"), true);
} finally {
  await server.close();
}
