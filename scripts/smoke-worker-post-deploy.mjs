#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const registry = normalizeRegistry(readOption("--registry") ?? process.env.COREHUB_REGISTRY ?? "https://coreblow.com/corehub");
const packageId = readOption("--package") ?? readOption("--id") ?? process.env.COREHUB_SMOKE_PACKAGE ?? "plugin-lab";
const verifyRead = args.includes("--verify-read");
const webUrl = normalizeWebUrl(readOption("--web-url") ?? process.env.COREHUB_WEB_URL ?? `${registry}/`);
const verifyWeb = args.includes("--verify-web") || webUrl === "https://coreblow.com/corehub/";
const adminSupportBundleOutput = readOption("--admin-support-bundle-output");
const verifyAdmin = args.includes("--verify-admin") || Boolean(process.env.COREHUB_TOKEN) || Boolean(adminSupportBundleOutput);
const adminLimit = readNonNegativeInteger(readOption("--admin-limit") ?? process.env.COREHUB_ADMIN_SMOKE_LIMIT ?? "20", "admin limit");
const authToken = readOption("--token") ?? process.env.COREHUB_TOKEN;
const authUser = readOption("--user") ?? process.env.COREHUB_USER ?? "github:coreblow-admin";
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

function normalizeWebUrl(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("web URL is required");
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString();
}

function apiUrl(path) {
  return `${registry}${path}`;
}

function apiV2Url(path) {
  return `${registry}/api/v2${path}`;
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

async function readText(url, init = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    ...init,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": userAgent,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Request failed for ${url}: ${response.status} ${body.slice(0, 300)}`);
  return { response, body };
}

async function readHealth() {
  try {
    const result = await readJson(healthUrl());
    return {
      ...result,
      source: "healthz",
    };
  } catch (error) {
    const fallback = await readJson(apiUrl("/api/v1"));
    assertCatalogEnvelope(fallback.payload, "registry health fallback");
    assert.equal(fallback.payload.data.name, "CoreHub Registry API");
    return {
      ...fallback,
      source: "registry-discovery",
      error: error instanceof Error ? error.message : "healthz unavailable",
      payload: {
        ok: true,
        service: "corehub-api",
        runtime: null,
        stateStore: null,
        objectStore: null,
        signedReadKeyId: null,
      },
    };
  }
}

async function readAdminJson(url) {
  if (!authToken) throw new Error("--verify-admin requires --token or COREHUB_TOKEN");
  return readJson(url, {
    headers: {
      authorization: `Bearer ${authToken}`,
      "x-corehub-user": authUser,
    },
  });
}

function readNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

async function writeTextOutput(outputPath, text) {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
}

function assertCatalogEnvelope(payload, label) {
  assert.equal(payload.apiVersion, "v1", `${label} should use v1 response envelope`);
  assert.ok(payload.data, `${label} should include data`);
}

const health = await readHealth();
assert.equal(health.payload.ok, true);
assert.equal(health.payload.service, "corehub-api");
logStep(`health ok from ${health.source}`);

let web = { enabled: false };
if (verifyWeb) {
  const webResponse = await readText(webUrl);
  const contentType = webResponse.response.headers.get("content-type") ?? "";
  assert.match(contentType, /text\/html/);
  assert.match(webResponse.body, /<title>CoreHub \| CoreBlow Skill and Plugin Directory<\/title>/);
  assert.match(webResponse.body, /CoreHub/);
  assert.match(webResponse.body, /CoreBlow/);
  assert.match(webResponse.body, /CoreHub Directory Metadata/);
  assert.match(webResponse.body, /plugin-lab/);
  assert.match(webResponse.body, /github\.com\/coreblow\/corehub/);
  web = {
    enabled: true,
    url: webUrl,
    contentType,
    bytes: Buffer.byteLength(webResponse.body),
  };
  logStep(`web surface ok at ${webUrl}`);
}

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
if (download.method !== undefined) assert.equal(download.method, "GET");
assert.equal(typeof download.url, "string");
assertDownloadUrl(download);
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
assertDownloadUrl({ ...download, url: location });
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

let adminVisibility = { enabled: false };
if (verifyAdmin) {
  const adminStatus = await readAdminJson(apiV2Url("/admin/status"));
  assert.equal(adminStatus.payload.apiVersion, "v2");
  assert.equal(adminStatus.payload.data.status, "ok");
  assert.equal(adminStatus.payload.data.readiness.status, "ready");
  assert.equal(adminStatus.payload.data.audit.valid, true);
  assert.equal(typeof adminStatus.payload.data.runtime.stateStore.kind, "string");
  assert.equal(typeof adminStatus.payload.data.runtime.objectStore.kind, "string");
  logStep(`admin status ready with ${adminStatus.payload.data.counts.auditEvents} audit events`);

  let supportBundle = { enabled: false };
  if (adminSupportBundleOutput) {
    const supportBundleResponse = await readAdminJson(apiV2Url(`/admin/support-bundle?limit=${adminLimit}`));
    assert.equal(supportBundleResponse.payload.apiVersion, "v2");
    assert.equal(supportBundleResponse.payload.data.status, "ok");
    assert.equal(supportBundleResponse.payload.data.bundle.redaction.secretsIncluded, false);
    assert.equal(supportBundleResponse.payload.data.bundle.redaction.rawClientIdentifiersIncluded, false);
    const output = await writeTextOutput(adminSupportBundleOutput, `${JSON.stringify(supportBundleResponse.payload.data, null, 2)}\n`);
    supportBundle = {
      enabled: true,
      output,
      recentAuditEvents: supportBundleResponse.payload.data.recent.auditEvents.length,
    };
    logStep(`admin support bundle exported: ${output}`);
  }

  adminVisibility = {
    enabled: true,
    actor: authUser,
    status: adminStatus.payload.data.status,
    readiness: adminStatus.payload.data.readiness.status,
    stateStore: adminStatus.payload.data.runtime.stateStore.kind,
    objectStore: adminStatus.payload.data.runtime.objectStore.kind,
    audit: {
      valid: adminStatus.payload.data.audit.valid,
      count: adminStatus.payload.data.audit.count,
      behavior: adminStatus.payload.data.audit.behavior,
    },
    counts: adminStatus.payload.data.counts,
    supportBundle,
  };
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      registry,
      packageId,
      health: {
        source: health.source,
        runtime: health.payload.runtime,
        stateStore: health.payload.stateStore,
        objectStore: health.payload.objectStore,
        signedReadKeyId: health.payload.signedReadKeyId,
      },
      web,
      download: {
        keyId: download.keyId,
        expiresAt: download.expiresAt ?? download.expires,
        artifact: {
          name: artifact.name,
          size: artifact.size,
          sha256: artifact.sha256,
          storage: artifact.storage,
        },
      },
      readVerification,
      adminVisibility,
    },
    null,
    2,
  ),
);

function assertDownloadUrl(download) {
  const value = download.url;
  const url = new URL(value);
  if (download.redirect === "external-url") {
    assert.ok(/^https?:$/.test(url.protocol), `expected external artifact URL, got ${value}`);
    return;
  }
  const signedCoreHubRead = /\/corehub\/api\/v1\/artifacts\/read$/.test(url.pathname);
  const signedArtifactUrl = url.searchParams.has("corehub_signature") || url.searchParams.has("sig");
  assert.ok(signedCoreHubRead || signedArtifactUrl, `expected signed artifact URL, got ${value}`);
}
