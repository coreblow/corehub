import assert from "node:assert/strict";
import { seedManagedPackage, startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const server = await startCoreHubTestServer();
try {
  await seedManagedPackage(server.storage, { packageId: "surface-alpha" });
  await seedManagedPackage(server.storage, { packageId: "surface-beta" });

  const firstPage = await fetch(`${server.v1Url}/packages?limit=1`);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.headers.get("x-ratelimit-limit"), null);
  const firstPagePayload = await firstPage.json();
  assert.equal(firstPagePayload.meta.limit, 1);
  assert.equal(firstPagePayload.meta.hasMore, true);
  assert.match(firstPagePayload.meta.nextCursor, /^[A-Za-z0-9_-]+$/);

  const secondPage = await fetch(`${server.v1Url}/packages?limit=1&cursor=${firstPagePayload.meta.nextCursor}`);
  assert.equal(secondPage.status, 200);
  const secondPagePayload = await secondPage.json();
  assert.equal(secondPagePayload.meta.cursor, firstPagePayload.meta.nextCursor);
  assert.notEqual(secondPagePayload.data[0].id, firstPagePayload.data[0].id);

  const security = await fetch(`${server.v1Url}/packages/surface-alpha/versions/0.1.0/security`);
  assert.equal(security.status, 200);
  const securityPayload = await security.json();
  assert.equal(securityPayload.data.package.name, "surface-alpha");
  assert.equal(securityPayload.data.release.version, "0.1.0");
  assert.equal(securityPayload.data.release.artifactKind, "npm-pack");
  assert.equal(securityPayload.data.trust.blockedFromDownload, false);
  assert.equal(securityPayload.data.trust.scanStatus, "pending");

  const missingSession = await fetch(`${server.v2Url}/session/validate?role=publisher`);
  assert.equal(missingSession.status, 401, await missingSession.clone().text());
  const missingSessionPayload = await missingSession.json();
  assert.equal(missingSessionPayload.errorCode, "unauthorized");
  assert.equal(missingSessionPayload.status, 401);
  assert.match(missingSessionPayload.error, /Session token is required/);

} finally {
  await server.close();
}

const limitedServer = await startCoreHubTestServer({ rateLimit: { limit: 1, windowMs: 60_000 } });
try {
  await seedManagedPackage(limitedServer.storage, { packageId: "surface-rate" });
  const first = await fetch(`${limitedServer.v1Url}/packages`, { headers: { "x-corehub-client-id": "surface-rate-limit" } });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(first.headers.get("x-ratelimit-limit"), "1");
  assert.equal(first.headers.get("ratelimit-limit"), "1");
  assert.equal(first.headers.get("x-ratelimit-remaining"), "0");

  const second = await fetch(`${limitedServer.v1Url}/packages`, { headers: { "x-corehub-client-id": "surface-rate-limit" } });
  assert.equal(second.status, 429);
  assert.equal(second.headers.get("retry-after"), "60");
  assert.equal(second.headers.get("ratelimit-reset"), "60");
  assert.equal(await second.text(), "Rate limit exceeded");
} finally {
  await limitedServer.close();
}
