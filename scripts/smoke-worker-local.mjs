#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import coreHubWorker from "../src/worker.mjs";

const catalog = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf8"));
const pluginLab = catalog.find((entry) => entry.id === "plugin-lab");
const artifact = pluginLab.versions[0].artifact;
const artifactPath = new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url);
const artifactBytes = await readFile(artifactPath);
const d1Rows = new Map();
const managedObjects = new Map();
const env = {
  COREHUB_STATE_STORE: "d1",
  COREHUB_D1: createMockD1Database(d1Rows),
  COREHUB_MANAGED_OBJECT_STORE: createMockManagedBucket(managedObjects),
  COREHUB_MANAGED_OBJECT_STORE_BUCKET_NAME: "corehub-managed-artifacts-smoke",
  COREHUB_PUBLIC_BASE_URL: "https://coreblow.com/corehub",
  COREHUB_SIGNING_SECRET: "corehub-worker-smoke-signing-secret",
  COREHUB_SIGNING_KEY_ID: "smoke-primary",
  COREHUB_SIGNING_PREVIOUS_SECRETS: "smoke-previous:corehub-worker-smoke-previous-secret",
};

function logStep(message) {
  console.log(`- ${message}`);
}

async function workerJson(path, init = {}) {
  const response = await coreHubWorker.fetch(new Request(`https://coreblow.com${path}`, init), env);
  const payload = await response.json();
  return { response, payload };
}

const health = await workerJson("/healthz");
assert.equal(health.response.status, 200);
assert.equal(health.payload.runtime, "cloudflare-worker");
assert.equal(health.payload.stateStore, "d1");
assert.equal(health.payload.objectStore, "managed");
assert.equal(health.payload.signedReadKeyId, "smoke-primary");
logStep("worker health reports D1 state store and managed object store");

const uploadRequest = await workerJson("/corehub/api/v2/artifacts/uploads", {
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
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
    },
  }),
});
assert.equal(uploadRequest.response.status, 201);
const uploadSlot = uploadRequest.payload.data.uploadSlot;
assert.equal(uploadSlot.id, "upload-plugin-lab-0-1-0");
logStep(`upload slot requested: ${uploadSlot.id}`);

const putResponse = await coreHubWorker.fetch(
  new Request(`https://coreblow.com/corehub/api/v2/artifacts/uploads/${uploadSlot.id}`, {
    method: "PUT",
    headers: {
      "content-type": artifact.mediaType,
      "x-corehub-user": "github:coreblow-admin",
      "x-corehub-artifact-sha256": artifact.sha256,
    },
    body: artifactBytes,
  }),
  env,
);
assert.equal(putResponse.status, 200);
assert.equal(managedObjects.has(uploadSlot.storage.key), true);
logStep("artifact bytes uploaded through Worker fetch to mock managed object storage");

const verify = await workerJson(`/corehub/api/v2/artifacts/uploads/${uploadSlot.id}/verify`, {
  method: "POST",
  headers: { "x-corehub-user": "github:coreblow-admin" },
});
assert.equal(verify.response.status, 200);
assert.equal(verify.payload.data.artifactUpload.status, "verified");
assert.equal(verify.payload.data.verification.checksumMatches, true);
logStep(`artifact verified: ${verify.payload.data.artifactUpload.id}`);

const submission = await workerJson("/corehub/api/v2/submissions", {
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
    artifactUploadId: verify.payload.data.artifactUpload.id,
    source: "https://github.com/coreblow/plugin-lab",
    changelog: "Worker local smoke submission.",
  }),
});
assert.equal(submission.response.status, 201);
assert.equal(submission.payload.data.moderationReview.status, "open");
logStep(`submission created: ${submission.payload.data.submission.id}`);

const approval = await workerJson(`/corehub/api/v2/reviews/${submission.payload.data.moderationReview.id}/approve`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-corehub-user": "github:coreblow-admin",
  },
  body: JSON.stringify({ notes: "Worker local smoke approved." }),
});
assert.equal(approval.response.status, 200);
assert.equal(approval.payload.data.packageVersion.status, "available");
logStep(`review approved: ${approval.payload.data.moderationReview.id}`);

const projectedEntry = await workerJson("/corehub/api/v1/entries/plugin-lab");
assert.equal(projectedEntry.response.status, 200);
assert.equal(projectedEntry.payload.data.id, "plugin-lab");
assert.equal(projectedEntry.payload.data.versions[0].artifact.sha256, artifact.sha256);
logStep("projected v1 entry served from Worker D1 state");

const downloadMeta = await workerJson("/corehub/api/v1/packages/plugin-lab/download?redirect=false");
assert.equal(downloadMeta.response.status, 200);
assert.equal(downloadMeta.payload.data.download.available, true);
assert.equal(downloadMeta.payload.data.download.keyId, "smoke-primary");
assert.match(downloadMeta.payload.data.download.url, /\/corehub\/api\/v1\/artifacts\/read\?/);
logStep("signed download metadata generated");

const redirectResponse = await coreHubWorker.fetch(
  new Request("https://coreblow.com/corehub/api/v1/packages/plugin-lab/download"),
  env,
);
assert.equal(redirectResponse.status, 302);
assert.match(redirectResponse.headers.get("location"), /\/corehub\/api\/v1\/artifacts\/read\?/);
logStep("download endpoint redirects to signed read URL by default");

const signedReadResponse = await coreHubWorker.fetch(new Request(downloadMeta.payload.data.download.url), env);
assert.equal(signedReadResponse.status, 200);
assert.equal(signedReadResponse.headers.get("x-corehub-artifact-sha256"), artifact.sha256);
assert.deepEqual(Buffer.from(await signedReadResponse.arrayBuffer()), artifactBytes);
logStep("signed artifact read returned verified bytes from mock managed object storage");

const snapshot = JSON.parse(d1Rows.get("write-side-state").value);
assert.equal(snapshot.packageVersions.length, 1);
assert.equal(snapshot.auditEvents.some((event) => event.action === "artifact.download.sign"), true);
assert.equal(snapshot.auditEvents.some((event) => event.action === "artifact.download.read"), true);
assert.equal(snapshot.auditEvents.some((event) => event.action === "review.approve"), true);
logStep(`D1 snapshot persisted with ${snapshot.auditEvents.length} audit events`);

console.log("CoreHub Worker local smoke passed.");

function createMockD1Database(rows) {
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          return { ...this, values };
        },
        async first() {
          if (!/^SELECT value FROM corehub_state WHERE key = \?1$/.test(sql)) {
            throw new Error(`Unexpected mock D1 query: ${sql}`);
          }
          return rows.get(this.values[0]) ?? null;
        },
        async run() {
          if (!sql.startsWith("INSERT INTO corehub_state")) {
            throw new Error(`Unexpected mock D1 mutation: ${sql}`);
          }
          rows.set(this.values[0], {
            key: this.values[0],
            value: this.values[1],
            updated_at: this.values[2],
          });
          return { success: true };
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
