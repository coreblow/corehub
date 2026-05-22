#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const registry = normalizeRegistry(readOption("--registry") ?? process.env.COREHUB_REGISTRY ?? "https://coreblow.com/corehub");
const packageId = readOption("--package") ?? readOption("--id") ?? process.env.COREHUB_SMOKE_PACKAGE ?? "plugin-lab";
const verifyRead = args.includes("--verify-read");
const userAgent = "corehub-post-deploy-smoke";

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function normalizeRegistry(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("registry URL is required");
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function apiUrl(path) {
  return `${registry}${path}`;
}

function healthUrl() {
  return new URL("/healthz", registry).toString();
}

function logStep(message) {
  console.log(`- ${message}`);
}

async function readJson(url, init = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": userAgent,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  let payload;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${url}, got status ${response.status}: ${body.slice(0, 300)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${JSON.stringify(payload)}`);
  }
  return { response, payload };
}

function assertCatalogEnvelope(payload, label) {
  assert.equal(payload.apiVersion, "v1", `${label} should use v1 response envelope`);
  assert.ok(payload.data, `${label} should include data`);
}

const health = await readJson(healthUrl());
assert.equal(health.payload.ok, true);
assert.equal(health.payload.service, "corehub-api");
logStep(`health ok at ${healthUrl()}`);

const registryInfo = await readJson(apiUrl("/api/v1"));
assertCatalogEnvelope(registryInfo.payload, "registry info");
assert.equal(registryInfo.payload.data.name, "CoreHub Registry API");
logStep("v1 registry discovery document returned");

const packageResponse = await readJson(apiUrl(`/api/v1/packages/${encodeURIComponent(packageId)}`));
assertCatalogEnvelope(packageResponse.payload, "package");
assert.equal(packageResponse.payload.data.id, packageId);
const versions = Array.isArray(packageResponse.payload.data.versions) ? packageResponse.payload.data.versions : [];
assert.ok(versions.length > 0, `package ${packageId} should expose at least one version`);
logStep(`package read ok for ${packageId}`);

const downloadMeta = await readJson(apiUrl(`/api/v1/packages/${encodeURIComponent(packageId)}/download?redirect=false`));
assertCatalogEnvelope(downloadMeta.payload, "download metadata");
const { artifact, download } = downloadMeta.payload.data;
assert.equal(download.available, true);
assert.equal(download.method, "GET");
assert.equal(typeof download.url, "string");
assert.match(download.url, /\/corehub\/api\/v1\/artifacts\/read\?/);
assert.equal(typeof artifact.sha256, "string");
assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
assert.equal(Number.isSafeInteger(artifact.size), true);
assert.ok(artifact.size > 0);
logStep(`signed download metadata ok for ${artifact.name ?? packageId}`);

const redirectResponse = await fetch(apiUrl(`/api/v1/packages/${encodeURIComponent(packageId)}/download`), {
  redirect: "manual",
  headers: {
    accept: "application/json",
    "user-agent": userAgent,
  },
});
assert.ok([301, 302, 303, 307, 308].includes(redirectResponse.status), `expected redirect, got ${redirectResponse.status}`);
const location = redirectResponse.headers.get("location");
assert.equal(typeof location, "string");
assert.match(location, /\/corehub\/api\/v1\/artifacts\/read\?/);
logStep("default download endpoint returns signed redirect");

let readVerification = { enabled: false };
if (verifyRead) {
  const signedReadResponse = await fetch(download.url, {
    headers: {
      accept: artifact.mediaType ?? "application/octet-stream",
      "user-agent": userAgent,
    },
  });
  assert.equal(signedReadResponse.status, 200);
  const bytes = Buffer.from(await signedReadResponse.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(bytes.byteLength, artifact.size);
  assert.equal(sha256, artifact.sha256);
  readVerification = {
    enabled: true,
    bytes: bytes.byteLength,
    sha256,
  };
  logStep("signed read fetched and checksum verified");
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      registry,
      packageId,
      health: {
        runtime: health.payload.runtime,
        stateStore: health.payload.stateStore,
        objectStore: health.payload.objectStore,
        signedReadKeyId: health.payload.signedReadKeyId,
      },
      download: {
        keyId: download.keyId,
        expiresAt: download.expiresAt,
        artifact: {
          name: artifact.name,
          size: artifact.size,
          sha256: artifact.sha256,
          storage: artifact.storage,
        },
      },
      readVerification,
    },
    null,
    2,
  ),
);
