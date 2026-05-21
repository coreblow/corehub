import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const defaultApiBasePath = "/corehub/api/v2";
const defaultPublicBaseUrl = "https://coreblow.com/corehub";

export class CoreHubLocalStorageAdapter {
  constructor({ root, publicBaseUrl = defaultPublicBaseUrl, statePath } = {}) {
    if (!root) throw new Error("CoreHubLocalStorageAdapter requires root");
    this.root = resolve(root);
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    this.statePath = statePath ? resolve(statePath) : null;
    this.slots = new Map();
    this.submissions = new Map();
    this.reviews = new Map();
    this.packageVersions = new Map();
  }

  static async open(options = {}) {
    const adapter = new CoreHubLocalStorageAdapter(options);
    await adapter.loadState();
    return adapter;
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
    await this.persistState();
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
    await this.persistState();
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
    await this.persistState();
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

  async createSubmission(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizeSubmissionRequest(input);
    const artifactUpload = this.findArtifactUpload(request.artifactUploadId);
    if (!artifactUpload) throw httpError(404, "Verified artifact upload not found");
    if (artifactUpload.status !== "verified") {
      throw httpError(409, "Artifact upload must be verified before submission");
    }
    if (
      artifactUpload.packageId !== request.packageId ||
      artifactUpload.version !== request.version ||
      artifactUpload.publisherHandle !== request.publisherHandle
    ) {
      throw httpError(400, "Submission package, version, or publisher does not match artifact upload");
    }
    const versionSlug = slugVersion(request.version);
    const submittedAt = now.toISOString();
    const id = `submission-${request.packageId}-${versionSlug}`;
    const reviewId = `review-${request.packageId}-${versionSlug}`;
    const submission = {
      id,
      packageId: request.packageId,
      kind: request.kind,
      publisherHandle: request.publisherHandle,
      version: request.version,
      status: "pending_review",
      artifactUploadId: request.artifactUploadId,
      ...(request.source ? { source: request.source } : {}),
      changelog: request.changelog,
      submittedBy: actor,
      submittedAt,
      reviewId,
    };
    const packageVersionPreview = {
      id: `version-${request.packageId}-${versionSlug}`,
      packageId: request.packageId,
      version: request.version,
      tag: "latest",
      publisherHandle: request.publisherHandle,
      status: "pending_review",
      artifactUploadId: request.artifactUploadId,
      submissionId: id,
      createdAt: submittedAt,
      moderationStatus: "pending",
    };
    const moderationReview = {
      id: reviewId,
      targetType: "submission",
      targetId: id,
      status: "open",
      decision: "none",
      reviewedBy: actor,
      createdAt: submittedAt,
    };
    this.submissions.set(id, { submission, packageVersionPreview, artifactUploadId: request.artifactUploadId });
    this.reviews.set(reviewId, moderationReview);
    await this.persistState();
    return { submission, artifactUpload, packageVersionPreview, moderationReview };
  }

  async decideReview(reviewId, decision, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    if (!["approve", "block"].includes(decision)) throw httpError(400, "Review decision must be approve or block");
    const review = this.reviews.get(reviewId);
    if (!review) throw httpError(404, "Moderation review not found");
    if (review.targetType !== "submission") throw httpError(400, "Only submission reviews are supported");
    const record = this.submissions.get(review.targetId);
    if (!record) throw httpError(404, "Submission not found");
    if (record.submission.status !== "pending_review") {
      throw httpError(409, "Submission is not pending review");
    }

    const decidedAt = now.toISOString();
    const status = decision === "approve" ? "approved" : "blocked";
    const submissionStatus = decision === "approve" ? "approved" : "rejected";
    const packageVersionStatus = decision === "approve" ? "available" : "blocked";
    const moderationStatus = decision === "approve" ? "approved" : "blocked";
    const moderationReview = {
      ...review,
      status,
      decision,
      reviewedBy: actor,
      ...(typeof input.notes === "string" && input.notes.trim().length > 0 ? { notes: input.notes.trim() } : {}),
      decidedAt,
    };
    const submission = {
      ...record.submission,
      status: submissionStatus,
    };
    const packageVersion = {
      ...record.packageVersionPreview,
      status: packageVersionStatus,
      moderationStatus,
      ...(decision === "approve" ? { publishedAt: decidedAt } : {}),
      createdAt: record.packageVersionPreview.createdAt,
    };
    this.reviews.set(reviewId, moderationReview);
    this.submissions.set(record.submission.id, {
      ...record,
      submission,
      packageVersionPreview: packageVersion,
    });
    this.packageVersions.set(packageVersion.id, packageVersion);
    await this.persistState();
    return {
      moderationReview,
      submission,
      artifactUpload: this.findArtifactUpload(record.artifactUploadId),
      packageVersion,
    };
  }

  projectCatalogEntries() {
    const entries = [];
    for (const version of this.packageVersions.values()) {
      if (version.status !== "available") continue;
      const submissionRecord = this.submissions.get(version.submissionId);
      if (!submissionRecord) continue;
      const artifactUpload = this.findArtifactUpload(version.artifactUploadId);
      if (!artifactUpload || artifactUpload.status !== "verified") continue;
      const submission = submissionRecord.submission;
      const source = submission.source ?? `https://github.com/${version.publisherHandle}/${version.packageId}`;
      entries.push({
        id: version.packageId,
        kind: submission.kind,
        name: titleizeHandle(version.packageId),
        summary: `CoreHub projected ${submission.kind} package ${version.packageId}.`,
        source,
        homepage: source,
        version: version.version,
        tags: [submission.kind, "published"],
        capabilities: [],
        publisher: {
          handle: version.publisherHandle,
          displayName: titleizeHandle(version.publisherHandle),
          url: `https://github.com/${version.publisherHandle}`,
          verified: true,
        },
        review: {
          state: "verified",
          checkedAt: version.publishedAt ?? version.createdAt,
          notes: "Projected from approved CoreHub write-side review.",
        },
        coreblow: {
          minCoreblowVersion: "1.0.0",
          platforms: ["linux", "macos", "windows"],
        },
        versions: [
          {
            version: version.version,
            tag: version.tag ?? "latest",
            publishedAt: version.publishedAt ?? version.createdAt,
            publisher: {
              handle: version.publisherHandle,
            },
            status: "available",
            artifact: {
              name: artifactUpload.storage.key.split("/").at(-1) ?? `${version.packageId}-${version.version}.artifact`,
              mediaType: artifactUpload.mediaType ?? "application/octet-stream",
              size: artifactUpload.size,
              sha256: artifactUpload.sha256,
              downloadEnabled: true,
              storage: artifactUpload.storage,
              provenance: {
                source,
                reviewState: "verified",
              },
              files: [],
            },
          },
        ],
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  snapshotState({ savedAt = new Date().toISOString() } = {}) {
    return {
      schemaVersion: "corehub.local-state.v1",
      savedAt,
      publicBaseUrl: this.publicBaseUrl,
      slots: [...this.slots.values()],
      submissions: [...this.submissions.values()],
      reviews: [...this.reviews.values()],
      packageVersions: [...this.packageVersions.values()],
    };
  }

  restoreState(state) {
    if (!state || state.schemaVersion !== "corehub.local-state.v1") {
      throw new Error("Unsupported CoreHub local state file");
    }
    this.publicBaseUrl = state.publicBaseUrl ?? this.publicBaseUrl;
    this.slots = new Map((state.slots ?? []).map((slot) => [slot.id, slot]));
    this.submissions = new Map((state.submissions ?? []).map((record) => [record.submission.id, record]));
    this.reviews = new Map((state.reviews ?? []).map((review) => [review.id, review]));
    this.packageVersions = new Map((state.packageVersions ?? []).map((version) => [version.id, version]));
  }

  async saveState(path = this.statePath) {
    if (!path) throw new Error("CoreHub local state path is not configured");
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const snapshot = this.snapshotState();
    await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot;
  }

  async loadState(path = this.statePath) {
    if (!path) return false;
    const target = resolve(path);
    const raw = await readFile(target, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!raw) return false;
    this.restoreState(JSON.parse(raw));
    return true;
  }

  async persistState() {
    if (!this.statePath) return;
    await this.saveState();
  }

  requireSlot(uploadSlotId) {
    const slot = this.slots.get(uploadSlotId);
    if (!slot) throw httpError(404, "Upload slot not found");
    return slot;
  }

  findArtifactUpload(artifactUploadId) {
    for (const slot of this.slots.values()) {
      if (slot.artifactUpload.id === artifactUploadId) return slot.artifactUpload;
    }
    return null;
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
      const v1Segments = trimBasePath(url.pathname, "/corehub/api/v1");
      if (v1Segments) {
        const result = handleProjectedRegistryV1(storage, request, url, v1Segments);
        if (result) return json(response, result.statusCode, result.payload);
      }

      const segments = trimBasePath(url.pathname, basePath);
      if (!segments) return json(response, 404, { error: "Not found" });

      if (request.method === "POST" && segments.join("/") === "artifacts/uploads") {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const uploadSlot = await storage.requestUploadSlot(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: { uploadSlot } });
      }

      if (request.method === "POST" && segments.join("/") === "submissions") {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.createSubmission(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "reviews" &&
        ["approve", "block"].includes(segments[2]) &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.decideReview(decodeURIComponent(segments[1]), segments[2], body, {
          actor,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
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

function handleProjectedRegistryV1(storage, request, url, segments) {
  if (request.method !== "GET") return null;
  const entries = storage.projectCatalogEntries();

  if (segments.length === 0) {
    return dataResponse({
      name: "CoreHub Registry API",
      entries: "/corehub/api/v1/entries",
      packages: "/corehub/api/v1/packages",
    });
  }

  if (segments[0] === "catalog" && segments.length === 1) return dataResponse(entries, entries.length);
  if (segments[0] === "entries" && segments.length === 1) {
    const kind = url.searchParams.get("kind");
    const filtered = kind ? entries.filter((entry) => entry.kind === kind) : entries;
    return dataResponse(filtered, filtered.length);
  }
  if (segments[0] === "entries" && segments.length === 2) {
    const entry = findProjectedEntry(entries, segments[1]);
    return entry ? dataResponse(entry) : dataResponse(null, 0, 404);
  }
  if (segments[0] === "packages" && segments.length === 1) return dataResponse(entries, entries.length);
  if (segments[0] === "packages" && segments[1] === "search" && segments.length === 2) {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    const results = entries
      .filter((entry) => JSON.stringify(entry).toLowerCase().includes(query))
      .map((entry) => ({ ...entry, score: query ? 1 : 0 }));
    return dataResponse(results, results.length);
  }
  if (segments[0] === "packages" && segments.length >= 2) {
    const entry = findProjectedEntry(entries, segments[1]);
    if (!entry) return dataResponse(null, 0, 404);
    if (segments.length === 2) return dataResponse(entry);
    if (segments[2] === "versions" && segments.length === 3) return dataResponse(entry.versions, entry.versions.length);
    if (segments[2] === "artifact" && segments.length === 3) {
      const version = entry.versions.find((item) => item.tag === "latest") ?? entry.versions[0];
      return dataResponse({
        package: { id: entry.id, kind: entry.kind, name: entry.name },
        version: version.version,
        publisher: entry.publisher,
        artifact: version.artifact,
        files: version.artifact.files,
        download: { available: false, reason: "Projected local storage does not expose signed downloads yet." },
      });
    }
    if (segments[2] === "download" && segments.length === 3) {
      const version = entry.versions.find((item) => item.tag === "latest") ?? entry.versions[0];
      return dataResponse({
        package: { id: entry.id, kind: entry.kind, name: entry.name },
        version: version.version,
        publisher: entry.publisher,
        artifact: version.artifact,
        download: { available: false, reason: "Projected local storage does not expose signed downloads yet." },
      });
    }
  }
  return null;
}

function findProjectedEntry(entries, id) {
  const decoded = decodeURIComponent(id);
  return entries.find((entry) => entry.id === decoded) ?? null;
}

function dataResponse(data, count = data === null ? 0 : 1, statusCode = data === null ? 404 : 200) {
  return {
    statusCode,
    payload: {
      apiVersion: "v1",
      data,
      meta: { count },
    },
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

function normalizeSubmissionRequest(input) {
  const packageId = normalizeRequiredString(input?.packageId, "packageId");
  const version = normalizeRequiredString(input?.version, "version");
  const publisherHandle = normalizeRequiredString(input?.publisherHandle, "publisherHandle");
  const kind = normalizeRequiredString(input?.kind, "kind");
  if (!["skill", "plugin", "provider", "channel"].includes(kind)) {
    throw httpError(400, "kind must be skill, plugin, provider, or channel");
  }
  const artifactUploadId = normalizeRequiredString(input?.artifactUploadId, "artifactUploadId");
  const changelog = normalizeRequiredString(input?.changelog ?? "CoreHub package submission.", "changelog");
  const source = typeof input?.source === "string" && input.source.trim().length > 0 ? input.source.trim() : undefined;
  return {
    packageId,
    version,
    publisherHandle,
    kind,
    artifactUploadId,
    source,
    changelog,
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

function titleizeHandle(handle) {
  return handle
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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
