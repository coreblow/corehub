import assert from "node:assert/strict";
import { adminActor, jsonHeaders, seedManagedPackage, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  await seedManagedPackage(server.storage, { packageId: "portal-hardening", version: "0.1.0" });
  await server.storage.createOrganizationPublisher(
    {
      handle: "portal-target",
      displayName: "Portal Target",
      source: "https://github.com/coreblow/portal-target",
    },
    { actor: adminActor },
  );
  const report = await server.storage.createPackageReport(
    {
      packageId: "portal-hardening",
      version: "0.1.0",
      reason: "Publisher portal report visibility fixture.",
    },
    { actor: { type: "user", id: "github:reporter" } },
  );
  await server.storage.triagePackageReport(
    report.report.id,
    {
      status: "confirmed",
      note: "Confirmed publisher portal report fixture.",
      finalAction: "quarantine",
    },
    { actor: adminActor },
  );
  const appeal = await server.storage.createPackageAppeal(
    {
      packageId: "portal-hardening",
      version: "0.1.0",
      message: "Publisher portal appeal visibility fixture.",
    },
    { actor: adminActor },
  );
  const transfer = await server.storage.requestOwnershipTransfer(
    {
      packageId: "portal-hardening",
      fromPublisherHandle: "coreblow",
      toPublisherHandle: "portal-target",
      reason: "Publisher portal transfer fixture.",
    },
    { actor: adminActor },
  );

  const dashboard = await fetch(`${server.v2Url}/publisher/dashboard`, { headers: jsonHeaders });
  assert.equal(dashboard.status, 200);
  const dashboardPayload = await dashboard.json();
  assert.equal(dashboardPayload.data.counts.openReports, 0);
  assert.equal(dashboardPayload.data.counts.reports, 1);
  assert.equal(dashboardPayload.data.counts.openAppeals, 1);
  assert.equal(dashboardPayload.data.counts.blockedReleases, 1);
  assert.equal(dashboardPayload.data.reports[0].id, report.report.id);
  assert.equal(dashboardPayload.data.appeals[0].id, appeal.appeal.id);
  assert.equal(dashboardPayload.data.moderationStatuses[0].packageId, "portal-hardening");
  assert.equal(dashboardPayload.data.moderationStatuses[0].blockedFromDownload, true);
  assert.equal(dashboardPayload.data.transfers[0].id, transfer.transfer.id);
  assert.equal(dashboardPayload.data.transfers[0].status, "requested");

  const accept = await fetch(`${server.v2Url}/transfers/${encodeURIComponent(transfer.transfer.id)}/accept`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ note: "Accepted through publisher portal hardening test." }),
  });
  assert.equal(accept.status, 200);
  const acceptPayload = await accept.json();
  assert.equal(acceptPayload.data.transfer.status, "completed");
  assert.equal(acceptPayload.data.packageOwnerHandle, "portal-target");
} finally {
  await server.close();
}
