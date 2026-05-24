#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const registry = normalizeRegistry(readOption("--registry") ?? process.env.COREHUB_REGISTRY ?? "https://coreblow.com/corehub");
const packageId = readOption("--package") ?? readOption("--id") ?? process.env.COREHUB_SEED_PACKAGE ?? "plugin-lab";
const requestedVersion = readOption("--version") ?? process.env.COREHUB_SEED_VERSION;
const catalogPath = readOption("--catalog") ?? "catalog.json";
const actor = readOption("--user") ?? process.env.COREHUB_USER ?? "github:coreblow-admin";
const token = readOption("--token") ?? process.env.COREHUB_TOKEN;
const dryRun = args.includes("--dry-run");
const planOnly = args.includes("--plan-only");
const force = args.includes("--force");

try {
  const plan = await buildSeedPlan();
  if (planOnly) {
    console.log(JSON.stringify({ status: "planned", dryRun: true, plan }, null, 2));
    process.exit(0);
  }

  const existing = await readExistingPackage(plan.packageId).catch((error) => {
    if (error.statusCode === 404) return null;
    throw error;
  });
  const existingVersion = existing?.versions?.find((version) => version.version === plan.version) ?? null;
  if (existingVersion && !force) {
    console.log(
      JSON.stringify(
        {
          status: "already_seeded",
          dryRun,
          registry,
          packageId: plan.packageId,
          version: plan.version,
          existing: {
            status: existingVersion.status,
            moderationStatus: existingVersion.moderationStatus,
          },
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          status: existingVersion ? "would_reseed" : "would_seed",
          dryRun: true,
          registry,
          actor,
          plan,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (!token) throw new Error("Production seed requires COREHUB_TOKEN or --token.");

  const upload = await writeJson("/api/v2/artifacts/uploads", {
    packageId: plan.packageId,
    version: plan.version,
    publisherHandle: plan.publisherHandle,
    provider: plan.provider,
    artifact: plan.artifact,
  });
  const uploadSlot = upload.data.uploadSlot;

  const submission = await writeJson("/api/v2/submissions", {
    packageId: plan.packageId,
    kind: plan.kind,
    publisherHandle: plan.publisherHandle,
    version: plan.version,
    artifactUploadId: uploadSlot.artifactUpload.id,
    source: plan.source,
    changelog: plan.changelog,
  });
  const reviewId = submission.data.moderationReview.id;

  const approval = await writeJson(`/api/v2/reviews/${encodeURIComponent(reviewId)}/approve`, {
    notes: `Approved production seed for ${plan.packageId}@${plan.version}.`,
  });
  const seeded = await readExistingPackage(plan.packageId);

  console.log(
    JSON.stringify(
      {
        status: "seeded",
        dryRun: false,
        registry,
        actor,
        packageId: plan.packageId,
        version: plan.version,
        uploadSlot: uploadSlot.id,
        artifactUpload: uploadSlot.artifactUpload.id,
        submission: submission.data.submission.id,
        review: reviewId,
        packageVersion: approval.data.packageVersion.id,
        packageStatus: approval.data.packageVersion.status,
        verification: {
          visible: seeded.id === plan.packageId,
          versions: seeded.versions.length,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function buildSeedPlan() {
  const catalog = JSON.parse(await readFile(resolve(catalogPath), "utf8"));
  const entry = catalog.find((item) => item.id === packageId);
  if (!entry) throw new Error(`Catalog package not found: ${packageId}`);
  const version =
    (requestedVersion ? entry.versions?.find((item) => item.version === requestedVersion) : entry.versions?.[0]) ?? null;
  if (!version) throw new Error(`Catalog package ${packageId} has no matching version`);
  const artifact = version.artifact;
  if (!artifact?.storage?.url) {
    throw new Error(`Catalog package ${packageId}@${version.version} must use an external artifact URL for production seed`);
  }
  const provider = normalizeExternalProvider(artifact.storage.provider);
  return {
    registry,
    packageId: entry.id,
    version: version.version,
    kind: normalizeSubmissionKind(entry.kind ?? entry.family),
    publisherHandle: version.publisher?.handle ?? entry.publisher?.handle ?? "coreblow",
    provider,
    source: artifact.provenance?.source ?? entry.source ?? entry.repository ?? artifact.storage.url,
    changelog: `Production seed for ${entry.id}@${version.version}.`,
    artifact: {
      name: artifact.name,
      mediaType: artifact.mediaType,
      size: artifact.size,
      sha256: artifact.sha256,
      url: artifact.storage.url,
    },
  };
}

async function readExistingPackage(id) {
  const payload = await readJson(`/api/v1/packages/${encodeURIComponent(id)}`);
  return payload.data;
}

async function readJson(path) {
  return requestJson(path, { method: "GET" });
}

async function writeJson(path, body) {
  return requestJson(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function requestJson(path, init = {}) {
  const response = await fetch(`${registry}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token
        ? {
            authorization: `Bearer ${token}`,
            "x-corehub-token": token,
          }
        : {}),
      "x-corehub-user": actor,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Expected JSON from ${registry}${path}, got ${response.status}: ${text.slice(0, 300)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    const error = new Error(`Request failed for ${registry}${path}: ${response.status} ${JSON.stringify(payload)}`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function normalizeRegistry(value) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("registry URL is required");
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeExternalProvider(provider) {
  if (provider === "github-raw" || provider === "external-url") return provider;
  return "external-url";
}

function normalizeSubmissionKind(kind) {
  if (["skill", "plugin", "provider", "channel"].includes(kind)) return kind;
  if (kind === "code-plugin" || kind === "bundle-plugin") return "plugin";
  return "plugin";
}

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
