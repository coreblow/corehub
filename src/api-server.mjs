import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const defaultApiBasePath = "/corehub/api/v2";
const defaultPublicBaseUrl = "https://coreblow.com/corehub";

export class CoreHubLocalStorageAdapter {
  constructor({ root, publicBaseUrl = defaultPublicBaseUrl } = {}) {
    if (!root) throw new Error("CoreHubLocalStorageAdapter requires root");
    this.root = resolve(root);
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    this.slots = new Map();
  }

  async requestUploadSlot(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizeUploadRequest(input);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const versionSlug = slugVersion(request.version);
    const id = `upload-${request.packageId}-${versionSlug}`;
    const artifactUploadId = `artifact-${request.packageId}-${versionSlug}`;
    const storage = {
      provider: request.provider,
      key: storageKey(request.publisherHandle, request.packageId, request.version, request.artifact.name),
      ...(request.region ? { region: request.region } : {}),
    };
    const upload = createSignedUploadContract({
      uploadSlotId: id,
      storage,
      mediaType: request.artifact.mediaType,
      sha256: request.artifact.sha256,
      size: request.artifact.size,
      maxBytes: request.maxBytes,
      expiresAt,
      publicBaseUrl: this.publicBaseUrl,
    });
    const artifactUpload = {
      id: artifactUploadId,
      packageId: request.packageId,
      version: request.version,
      publisherHandle: request.publisherHandle,
      status: "requested",
      storage,
      upload,
      mediaType: request.artifact.mediaType,
      size: request.artifact.size,
      sha256: request.artifact.sha256,
      uploadedBy: actor,
      createdAt,
    };
    const slot = {
      id,
      packageId: request.packageId,
      version: request.version,
      publisherHandle: request.publisherHandle,
      storage,
      upload,
      expected: {
        mediaType: request.artifact.mediaType,
        size: request.artifact.size,
        sha256: request.artifact.sha256,
      },
      artifactUpload,
    };
    this.slots.set(id, slot);
    return slot;
  }

  async putObject(uploadSlotId, bytes, headers = {}) {
    const slot = this.requireSlot(uploadSlotId);
    if (bytes.byteLength > slot.upload.maxBytes) {
      throw httpError(413, "Artifact exceeds upload slot maxBytes");
    }
    const declaredSha256 = getHeader(headers, "x-corehub-artifact-sha256");
    if (declaredSha256 && declaredSha256 !== slot.expected.sha256) {
      throw httpError(400, "Artifact SHA-256 header does not match upload slot");
    }
    const path = this.storagePath(slot.storage.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    slot.uploaded = {
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploadedAt: new Date().toISOString(),
    };
    slot.artifactUpload.status = "uploaded";
    return {
      uploadSlotId,
      storage: slot.storage,
      uploaded: slot.uploaded,
      artifactUpload: slot.artifactUpload,
    };
  }

  async verifyUpload(uploadSlotId, { actor = defaultActor(), now = new Date() } = {}) {
    const slot = this.requireSlot(uploadSlotId);
    const path = this.storagePath(slot.storage.key);
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) throw httpError(404, "Uploaded artifact bytes not found");
    const actual = {
      uploadSlotId,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const expected = {
      uploadSlotId,
      size: slot.expected.size,
      sha256: slot.expected.sha256,
    };
    const checksumMatches = actual.sha256 === expected.sha256;
    const sizeMatches = actual.size === expected.size;
    const status = checksumMatches && sizeMatches ? "verified" : "rejected";
    const artifactUpload = {
      ...slot.artifactUpload,
      status,
      uploadedBy: actor,
      verifiedAt: now.toISOString(),
    };
    slot.artifactUpload = artifactUpload;
    return {
      status,
      uploadSlotId,
      artifactUpload,
      verification: {
        checksumMatches,
        sizeMatches,
        expected,
        actual,
      },
    };
  }

  requireSlot(uploadSlotId) {
    const slot = this.slots.get(uploadSlotId);
    if (!slot) throw httpError(404, "Upload slot not found");
    return slot;
  }

  storagePath(key) {
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}/`) && path !== this.root) {
      throw httpError(400, "Storage key escapes local storage root");
    }
    return path;
  }
}

export function createCoreHubApiHandler({
  storage,
  basePath = defaultApiBasePath,
  now = () => new Date(),
} = {}) {
  if (!storage) throw new Error("createCoreHubApiHandler requires storage");
  return async function coreHubApiHandler(request, response) {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const segments = trimBasePath(url.pathname, basePath);
      if (!segments) return json(response, 404, { error: "Not found" });

      if (request.method === "POST" && segments.join("/") === "artifacts/uploads") {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const uploadSlot = await storage.requestUploadSlot(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: { uploadSlot } });
      }

      if (
        request.method === "PUT" &&
        segments[0] === "artifacts" &&
        segments[1] === "uploads" &&
        segments.length === 3
      ) {
        const bytes = await readBytes(request);
        const result = await storage.putObject(decodeURIComponent(segments[2]), bytes, request.headers);
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "artifacts" &&
        segments[1] === "uploads" &&
        segments[3] === "verify" &&
        segments.length === 4
      ) {
        const actor = actorFromRequest(request);
        const result = await storage.verifyUpload(decodeURIComponent(segments[2]), { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, error.statusCode ?? 500, {
        error: error instanceof Error ? error.message : "CoreHub API error",
      });
    }
  };
}

function normalizeUploadRequest(input) {
  const packageId = normalizeRequiredString(input?.packageId, "packageId");
  const version = normalizeRequiredString(input?.version, "version");
  const publisherHandle = normalizeRequiredString(input?.publisherHandle, "publisherHandle");
  const artifact = input?.artifact;
  if (!artifact || typeof artifact !== "object") throw httpError(400, "artifact is required");
  const name = normalizeRequiredString(artifact.name, "artifact.name");
  const mediaType = normalizeRequiredString(artifact.mediaType, "artifact.mediaType");
  const sha256 = normalizeRequiredString(artifact.sha256, "artifact.sha256");
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw httpError(400, "artifact.sha256 must be a SHA-256 hex digest");
  const size = artifact.size;
  if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, "artifact.size must be a non-negative integer");
  const provider = input.provider ?? "r2";
  if (!["r2", "s3"].includes(provider)) throw httpError(400, "provider must be r2 or s3");
  const maxBytes = input.maxBytes ?? 104857600;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < size) {
    throw httpError(400, "maxBytes must be greater than or equal to artifact.size");
  }
  return {
    packageId,
    version,
    publisherHandle,
    provider,
    region: typeof input.region === "string" && input.region ? input.region : undefined,
    maxBytes,
    artifact: {
      name,
      mediaType,
      size,
      sha256: sha256.toLowerCase(),
    },
  };
}

function normalizeRequiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw httpError(400, `${name} is required`);
  }
  return value.trim();
}

function trimBasePath(pathname, basePath) {
  const normalizedBase = basePath.replace(/\/$/, "");
  if (pathname !== normalizedBase && !pathname.startsWith(`${normalizedBase}/`)) return null;
  const rest = pathname.slice(normalizedBase.length).replace(/^\/+/, "");
  return rest ? rest.split("/").filter(Boolean) : [];
}

async function readJsonBody(request) {
  const bytes = await readBytes(request);
  if (bytes.byteLength === 0) return {};
  return JSON.parse(bytes.toString("utf8"));
}

async function readBytes(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function actorFromRequest(request) {
  const actorId = request.headers["x-corehub-user"] ?? "local-api-user";
  return {
    type: "user",
    id: Array.isArray(actorId) ? actorId[0] : actorId,
  };
}

function defaultActor() {
  return { type: "user", id: "local-api-user" };
}

function getHeader(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function createSignedUploadContract({ uploadSlotId, storage, mediaType, sha256, size, maxBytes, expiresAt, publicBaseUrl }) {
  const url = `${publicBaseUrl}/api/v2/artifacts/uploads/${uploadSlotId}`;
  const headers = [
    { name: "content-type", value: mediaType },
    { name: "x-corehub-artifact-sha256", value: sha256 },
    { name: "x-corehub-artifact-size", value: String(size) },
  ];
  const signature = createHash("sha256")
    .update([uploadSlotId, storage.provider, storage.key, mediaType, sha256, size, maxBytes, expiresAt].join("\n"))
    .digest("hex");
  return {
    method: "PUT",
    url,
    expiresAt,
    maxBytes,
    headers,
    signature,
  };
}

function storageKey(publisherHandle, packageId, version, artifactName) {
  return join("uploads", publisherHandle, packageId, version, artifactName).replaceAll("\\", "/");
}

function slugVersion(version) {
  return version.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function json(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json;charset=UTF-8");
  response.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
