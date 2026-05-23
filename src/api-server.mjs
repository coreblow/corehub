import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const defaultApiBasePath = "/corehub/api/v2";
const defaultPublicBaseUrl = "https://coreblow.com/corehub";
const defaultAuditRetentionDays = 365;
const localStateSchemaVersion = "corehub.local-state.v1";
const signedReadTtlMs = 5 * 60 * 1000;
const defaultSignedReadKeyId = "local-dev";
const defaultSignedReadSecret = "corehub-local-development-signing-secret";
const defaultAdminActorIds = ["github:coreblow-admin", "moderator:corehub"];
const defaultAnalyticsSalt = "corehub-local-analytics-salt";
const publisherWriteRoles = new Set(["owner", "admin", "maintainer"]);
const adminRoles = new Set(["admin", "moderator"]);

export class CoreHubLocalJsonStateStore {
  constructor({ statePath } = {}) {
    if (!statePath) throw new Error("CoreHubLocalJsonStateStore requires statePath");
    this.statePath = resolve(statePath);
    this.kind = "local-json";
  }

  async load() {
    const raw = await readFile(this.statePath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    return raw ? JSON.parse(raw) : null;
  }

  async save(snapshot) {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    return snapshot;
  }
}

export class CoreHubSnapshotStateStore {
  constructor({ kind = "snapshot", loadSnapshot, saveSnapshot } = {}) {
    if (typeof loadSnapshot !== "function") throw new Error("CoreHubSnapshotStateStore requires loadSnapshot");
    if (typeof saveSnapshot !== "function") throw new Error("CoreHubSnapshotStateStore requires saveSnapshot");
    this.kind = kind;
    this.loadSnapshot = loadSnapshot;
    this.saveSnapshot = saveSnapshot;
  }

  async load() {
    return this.loadSnapshot();
  }

  async save(snapshot) {
    await this.saveSnapshot(snapshot);
    return snapshot;
  }
}

export class CoreHubD1StateStore extends CoreHubSnapshotStateStore {
  constructor({ database, key = "write-side-state", table = "corehub_state" } = {}) {
    if (!database) throw new Error("CoreHubD1StateStore requires database");
    const tableName = normalizeSqlIdentifier(table, "table");
    super({
      kind: "d1-snapshot",
      loadSnapshot: async () => {
        const row = await database
          .prepare(`SELECT value FROM ${tableName} WHERE key = ?1`)
          .bind(key)
          .first();
        return row?.value ? JSON.parse(row.value) : null;
      },
      saveSnapshot: async (snapshot) => {
        await database
          .prepare(
            `INSERT INTO ${tableName} (key, value, updated_at) VALUES (?1, ?2, ?3) ` +
              `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(key, JSON.stringify(snapshot), snapshot.savedAt ?? new Date().toISOString())
          .run();
      },
    });
    this.database = database;
    this.key = key;
    this.table = tableName;
  }

  static migrationSql({ table = "corehub_state" } = {}) {
    const tableName = normalizeSqlIdentifier(table, "table");
    return `CREATE TABLE IF NOT EXISTS ${tableName} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
  }
}

export class CoreHubLocalObjectStore {
  constructor({ root } = {}) {
    if (!root) throw new Error("CoreHubLocalObjectStore requires root");
    this.root = resolve(root);
    this.kind = "local-fs";
  }

  async put(key, bytes) {
    const path = this.storagePath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { key, path, store: this.kind };
  }

  async get(key) {
    return readFile(this.storagePath(key)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
  }

  storagePath(key) {
    const path = resolve(this.root, key);
    if (!path.startsWith(`${this.root}/`) && path !== this.root) {
      throw httpError(400, "Storage key escapes local storage root");
    }
    return path;
  }
}

export class CoreHubR2ObjectStore {
  constructor({ bucket, bucketName = "COREHUB_R2" } = {}) {
    if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function") {
      throw new Error("CoreHubR2ObjectStore requires an R2 bucket binding");
    }
    this.bucket = bucket;
    this.bucketName = bucketName;
    this.kind = "r2";
  }

  async put(key, bytes, metadata = {}) {
    await this.bucket.put(key, bytes, {
      httpMetadata: metadata.mediaType ? { contentType: metadata.mediaType } : undefined,
      customMetadata: {
        ...(metadata.sha256 ? { sha256: metadata.sha256 } : {}),
        ...(metadata.uploadSlotId ? { uploadSlotId: metadata.uploadSlotId } : {}),
      },
    });
    return { key, bucket: this.bucketName, store: this.kind };
  }

  async get(key) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    if (typeof object.arrayBuffer === "function") return Buffer.from(await object.arrayBuffer());
    if (object.body && typeof object.body.arrayBuffer === "function") {
      return Buffer.from(await object.body.arrayBuffer());
    }
    if (object.body instanceof Uint8Array) return Buffer.from(object.body);
    throw new Error("R2 object body is not readable");
  }
}

export class CoreHubLocalStorageAdapter {
  constructor({
    root,
    publicBaseUrl = defaultPublicBaseUrl,
    statePath,
    stateStore,
    objectStore,
    signedReadSecret = defaultSignedReadSecret,
    signedReadKeyId = defaultSignedReadKeyId,
    signedReadKeys,
    auditRetentionDays = defaultAuditRetentionDays,
    adminActorIds = defaultAdminActorIds,
    analyticsSalt = defaultAnalyticsSalt,
  } = {}) {
    if (!root && !objectStore) throw new Error("CoreHubLocalStorageAdapter requires root or objectStore");
    this.root = root ? resolve(root) : null;
    this.objectStore = objectStore ?? new CoreHubLocalObjectStore({ root: this.root });
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
    this.stateStore = stateStore ?? (statePath ? new CoreHubLocalJsonStateStore({ statePath }) : null);
    this.statePath = this.stateStore?.statePath ?? (statePath ? resolve(statePath) : null);
    this.signedReadKeyId = normalizeSigningKeyId(signedReadKeyId);
    this.signedReadKeys = normalizeSigningKeys({ signedReadSecret, signedReadKeyId: this.signedReadKeyId, signedReadKeys });
    this.auditRetentionDays = normalizeAuditRetentionDays(auditRetentionDays);
    this.adminActorIds = new Set(normalizeActorIdList(adminActorIds, "adminActorIds"));
    this.analyticsSalt = normalizeAnalyticsSalt(analyticsSalt);
    this.authSessions = [];
    this.publisherClaims = [];
    this.publisherAccounts = new Map(defaultPublisherAccounts().map((publisher) => [publisher.handle, publisher]));
    this.publisherMembers = defaultPublisherMembers();
    this.slots = new Map();
    this.submissions = new Map();
    this.reviews = new Map();
    this.packageVersions = new Map();
    this.ownershipTransfers = new Map();
    this.installEvents = [];
    this.auditEvents = [];
    this.auditCheckpoints = [];
  }

  static async open(options = {}) {
    const adapter = new CoreHubLocalStorageAdapter(options);
    await adapter.loadState();
    return adapter;
  }

  async requestUploadSlot(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizeUploadRequest(input);
    this.requirePublisherPermission(actor, request.publisherHandle, "artifact.upload.request");
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
    this.recordAuditEvent({
      actor,
      action: "artifact.upload.request",
      targetType: "artifactUpload",
      targetId: artifactUploadId,
      metadata: {
        uploadSlotId: id,
        packageId: request.packageId,
        version: request.version,
        publisherHandle: request.publisherHandle,
        storage,
        sha256: request.artifact.sha256,
        size: request.artifact.size,
      },
      createdAt,
    });
    await this.persistState();
    return slot;
  }

  async putObject(uploadSlotId, bytes, headers = {}, { actor = defaultActor(), now = new Date() } = {}) {
    const slot = this.requireSlot(uploadSlotId);
    if (bytes.byteLength > slot.upload.maxBytes) {
      throw httpError(413, "Artifact exceeds upload slot maxBytes");
    }
    const declaredSha256 = getHeader(headers, "x-corehub-artifact-sha256");
    if (declaredSha256 && declaredSha256 !== slot.expected.sha256) {
      throw httpError(400, "Artifact SHA-256 header does not match upload slot");
    }
    const stored = await this.objectStore.put(slot.storage.key, bytes, {
      mediaType: slot.expected.mediaType,
      sha256: slot.expected.sha256,
      uploadSlotId,
    });
    slot.uploaded = {
      ...stored,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploadedAt: new Date().toISOString(),
    };
    slot.artifactUpload.status = "uploaded";
    this.recordAuditEvent({
      actor,
      action: "artifact.upload.put",
      targetType: "artifactUpload",
      targetId: slot.artifactUpload.id,
      metadata: {
        uploadSlotId,
        packageId: slot.packageId,
        version: slot.version,
        publisherHandle: slot.publisherHandle,
        storage: slot.storage,
        size: slot.uploaded.size,
        sha256: slot.uploaded.sha256,
      },
      createdAt: now.toISOString(),
    });
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
    this.requirePublisherPermission(actor, slot.publisherHandle, "artifact.upload.verify");
    const bytes = await this.objectStore.get(slot.storage.key);
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
    this.recordAuditEvent({
      actor,
      action: "artifact.upload.verify",
      targetType: "artifactUpload",
      targetId: artifactUpload.id,
      metadata: {
        uploadSlotId,
        packageId: artifactUpload.packageId,
        version: artifactUpload.version,
        publisherHandle: artifactUpload.publisherHandle,
        status,
        checksumMatches,
        sizeMatches,
      },
      createdAt: now.toISOString(),
    });
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

  async createArtifactDownload(artifact, { actor = defaultActor(), baseUrl = this.publicBaseUrl, now = new Date() } = {}) {
    const key = artifact?.storage?.key;
    if (!key || !artifact?.sha256 || !Number.isSafeInteger(artifact?.size)) {
      return { available: false, reason: "Artifact storage locator or checksum metadata is incomplete." };
    }
    const expiresAt = new Date(now.getTime() + signedReadTtlMs).toISOString();
    const keyId = this.signedReadKeyId;
    const signature = signArtifactRead({
      key,
      sha256: artifact.sha256,
      size: artifact.size,
      expiresAt,
      keyId,
      secret: this.requireSigningSecret(keyId),
    });
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/api/v1/artifacts/read`);
    url.searchParams.set("key", key);
    url.searchParams.set("expires", expiresAt);
    url.searchParams.set("keyId", keyId);
    url.searchParams.set("signature", signature);
    this.recordAuditEvent({
      actor,
      action: "artifact.download.sign",
      targetType: "artifact",
      targetId: key,
      metadata: {
        key,
        keyId,
        sha256: artifact.sha256,
        size: artifact.size,
        expiresAt,
      },
      createdAt: now.toISOString(),
    });
    await this.persistState();
    return {
      available: true,
      method: "GET",
      url: url.toString(),
      redirect: "signed-read",
      expiresAt,
      keyId,
      signature,
    };
  }

  async readSignedArtifact(url, { actor = defaultActor(), now = new Date() } = {}) {
    const key = normalizeRequiredString(url.searchParams.get("key"), "key");
    const expiresAt = normalizeRequiredString(url.searchParams.get("expires"), "expires");
    const keyId = normalizeSigningKeyId(url.searchParams.get("keyId") ?? this.signedReadKeyId);
    const signature = normalizeRequiredString(url.searchParams.get("signature"), "signature");
    const artifact = this.findProjectedArtifactByStorageKey(key);
    if (!artifact) throw httpError(404, "Artifact storage key not found");
    if (new Date(expiresAt).getTime() < now.getTime()) throw httpError(403, "Artifact read signature expired");
    const expected = signArtifactRead({
      key,
      sha256: artifact.sha256,
      size: artifact.size,
      expiresAt,
      keyId,
      secret: this.requireSigningSecret(keyId),
    });
    if (signature !== expected) throw httpError(403, "Artifact read signature is invalid");
    const bytes = await this.objectStore.get(key);
    if (!bytes) throw httpError(404, "Artifact object not found");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256 || bytes.byteLength !== artifact.size) {
      throw httpError(409, "Artifact object does not match projected checksum metadata");
    }
    this.recordAuditEvent({
      actor,
      action: "artifact.download.read",
      targetType: "artifact",
      targetId: key,
      metadata: {
        key,
        keyId,
        sha256: artifact.sha256,
        size: artifact.size,
        bytes: bytes.byteLength,
      },
      createdAt: now.toISOString(),
    });
    await this.persistState();
    return { artifact, bytes };
  }

  requireSigningSecret(keyId) {
    const secret = this.signedReadKeys.get(keyId);
    if (!secret) throw httpError(403, "Artifact read signing key is not active");
    return secret;
  }

  async createSubmission(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizeSubmissionRequest(input);
    this.requirePublisherPermission(actor, request.publisherHandle, "submission.create");
    const currentOwner = this.packageOwnerHandle(request.packageId);
    if (currentOwner && currentOwner !== request.publisherHandle) {
      throw httpError(409, `Package ${request.packageId} is owned by ${currentOwner}, not ${request.publisherHandle}`);
    }
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
      evidence: createSubmissionReviewEvidence({ submission, artifactUpload, actor, createdAt: submittedAt }),
      createdAt: submittedAt,
    };
    this.submissions.set(id, { submission, packageVersionPreview, artifactUploadId: request.artifactUploadId });
    this.reviews.set(reviewId, moderationReview);
    this.recordAuditEvent({
      actor,
      action: "submission.create",
      targetType: "submission",
      targetId: id,
      metadata: {
        packageId: request.packageId,
        version: request.version,
        publisherHandle: request.publisherHandle,
        artifactUploadId: request.artifactUploadId,
        reviewId,
      },
      createdAt: submittedAt,
    });
    await this.persistState();
    return { submission, artifactUpload, packageVersionPreview, moderationReview };
  }

  async decideReview(reviewId, decision, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    if (!["approve", "block"].includes(decision)) throw httpError(400, "Review decision must be approve or block");
    this.requireAdminPermission(actor, `review.${decision}`);
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
    this.recordAuditEvent({
      actor,
      action: `review.${decision}`,
      targetType: "review",
      targetId: reviewId,
      metadata: {
        submissionId: submission.id,
        packageVersionId: packageVersion.id,
        packageId: packageVersion.packageId,
        version: packageVersion.version,
        publisherHandle: packageVersion.publisherHandle,
        submissionStatus,
        packageVersionStatus,
        notes: moderationReview.notes ?? null,
      },
      createdAt: decidedAt,
    });
    await this.persistState();
    return {
      moderationReview,
      submission,
      artifactUpload: this.findArtifactUpload(record.artifactUploadId),
      packageVersion,
    };
  }

  async assignReview(reviewId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "review.assign");
    const review = this.reviews.get(reviewId);
    if (!review) throw httpError(404, "Moderation review not found");
    if (review.status !== "open" && review.status !== "held") {
      throw httpError(409, "Only open or held reviews can be assigned");
    }
    const assignee = normalizeActorInput(input?.assignee ?? input?.assigneeId, "assignee");
    const assignedAt = now.toISOString();
    const moderationReview = {
      ...review,
      assignee,
      assignedBy: actor,
      assignedAt,
    };
    this.reviews.set(reviewId, moderationReview);
    this.recordAuditEvent({
      actor,
      action: "review.assign",
      targetType: "review",
      targetId: reviewId,
      metadata: {
        assignee,
        targetType: review.targetType,
        targetId: review.targetId,
      },
      createdAt: assignedAt,
    });
    await this.persistState();
    return this.reviewInspection(moderationReview);
  }

  async addReviewEvidence(reviewId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "review.evidence.add");
    const review = this.reviews.get(reviewId);
    if (!review) throw httpError(404, "Moderation review not found");
    if (!["open", "held"].includes(review.status)) {
      throw httpError(409, "Evidence can only be added to open or held reviews");
    }
    const evidence = normalizeReviewEvidence(input, {
      id: `evidence-${slugId(reviewId)}-${String((review.evidence?.length ?? 0) + 1).padStart(2, "0")}`,
      actor,
      createdAt: now.toISOString(),
    });
    const moderationReview = {
      ...review,
      evidence: [...(review.evidence ?? []), evidence],
    };
    this.reviews.set(reviewId, moderationReview);
    this.recordAuditEvent({
      actor,
      action: "review.evidence.add",
      targetType: "review",
      targetId: reviewId,
      metadata: {
        evidenceId: evidence.id,
        evidenceType: evidence.type,
        summary: evidence.summary,
      },
      createdAt: evidence.createdAt,
    });
    await this.persistState();
    return this.reviewInspection(moderationReview);
  }

  async requestOwnershipTransfer(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizeOwnershipTransferRequest(input);
    this.requirePublisherPermission(actor, request.fromPublisherHandle, "ownership.transfer.request");
    const currentOwner = this.packageOwnerHandle(request.packageId);
    if (!currentOwner) throw httpError(404, "Package ownership source not found");
    if (currentOwner !== request.fromPublisherHandle) {
      throw httpError(409, `Package ${request.packageId} is owned by ${currentOwner}, not ${request.fromPublisherHandle}`);
    }
    this.requireVerifiedPublisher(request.toPublisherHandle, "ownership.transfer.request");
    const baseId = `transfer-${request.packageId}-${request.fromPublisherHandle}-to-${request.toPublisherHandle}`;
    if ([...this.ownershipTransfers.values()].some((transfer) => transfer.id.startsWith(baseId) && transfer.status === "requested")) {
      throw httpError(409, "Ownership transfer is already requested");
    }
    const existingCount = [...this.ownershipTransfers.values()].filter((transfer) => transfer.id.startsWith(baseId)).length;
    const id = existingCount === 0 ? baseId : `${baseId}-${existingCount + 1}`;
    const requestedAt = now.toISOString();
    const transfer = {
      id,
      packageId: request.packageId,
      fromPublisherHandle: request.fromPublisherHandle,
      toPublisherHandle: request.toPublisherHandle,
      status: "requested",
      requestedBy: actor,
      requestedAt,
      ...(request.reason ? { reason: request.reason } : {}),
    };
    this.ownershipTransfers.set(id, transfer);
    this.recordAuditEvent({
      actor,
      action: "ownership.transfer.request",
      targetType: "ownershipTransfer",
      targetId: id,
      metadata: {
        packageId: transfer.packageId,
        fromPublisherHandle: transfer.fromPublisherHandle,
        toPublisherHandle: transfer.toPublisherHandle,
      },
      createdAt: requestedAt,
    });
    await this.persistState();
    return { transfer };
  }

  async decideOwnershipTransfer(transferId, decision, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    if (!["accept", "reject", "cancel"].includes(decision)) {
      throw httpError(400, "Ownership transfer decision must be accept, reject, or cancel");
    }
    const transfer = this.ownershipTransfers.get(transferId);
    if (!transfer) throw httpError(404, "Ownership transfer not found");
    if (transfer.status !== "requested") {
      throw httpError(409, "Ownership transfer is not pending");
    }
    if (decision === "accept") {
      this.requirePublisherPermission(actor, transfer.toPublisherHandle, "ownership.transfer.accept");
    } else if (decision === "cancel") {
      this.requirePublisherPermission(actor, transfer.fromPublisherHandle, "ownership.transfer.cancel");
    } else {
      this.requireTransferDecisionPermission(actor, transfer, "ownership.transfer.reject");
    }
    const decidedAt = now.toISOString();
    const status = decision === "accept" ? "completed" : decision === "reject" ? "rejected" : "cancelled";
    const updated = {
      ...transfer,
      status,
      ...(decision === "accept"
        ? {
            acceptedBy: actor,
            acceptedAt: decidedAt,
            completedAt: decidedAt,
          }
        : {}),
      ...(decision === "reject" ? { rejectedBy: actor, rejectedAt: decidedAt } : {}),
      ...(decision === "cancel" ? { cancelledBy: actor, cancelledAt: decidedAt } : {}),
      ...(typeof input.notes === "string" && input.notes.trim().length > 0 ? { notes: input.notes.trim() } : {}),
    };
    this.ownershipTransfers.set(transferId, updated);
    this.recordAuditEvent({
      actor,
      action: `ownership.transfer.${decision}`,
      targetType: "ownershipTransfer",
      targetId: transferId,
      metadata: {
        packageId: transfer.packageId,
        fromPublisherHandle: transfer.fromPublisherHandle,
        toPublisherHandle: transfer.toPublisherHandle,
        status,
        notes: updated.notes ?? null,
      },
      createdAt: decidedAt,
    });
    await this.persistState();
    return { transfer: updated, packageOwnerHandle: this.packageOwnerHandle(transfer.packageId) };
  }

  listSubmissions(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "submission.list");
    const records = [...this.submissions.values()]
      .map((record) => this.submissionInspection(record))
      .filter((record) => !options.status || record.submission.status === options.status)
      .sort((left, right) => right.submission.submittedAt.localeCompare(left.submission.submittedAt));
    return paginate(records, options);
  }

  inspectSubmission(submissionId, options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "submission.inspect");
    const record = this.submissions.get(submissionId);
    if (!record) throw httpError(404, "Submission not found");
    return this.submissionInspection(record);
  }

  listReviews(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "review.list");
    const records = [...this.reviews.values()]
      .filter((review) => !options.status || review.status === options.status)
      .map((review) => this.reviewInspection(review))
      .sort((left, right) => right.moderationReview.createdAt.localeCompare(left.moderationReview.createdAt));
    return paginate(records, options);
  }

  inspectReview(reviewId, options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "review.inspect");
    const moderationReview = this.reviews.get(reviewId);
    if (!moderationReview) throw httpError(404, "Moderation review not found");
    return this.reviewInspection(moderationReview);
  }

  listOwnershipTransfers(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "ownership.transfer.list");
    const records = [...this.ownershipTransfers.values()]
      .filter((transfer) => !options.status || transfer.status === options.status)
      .filter((transfer) => !options.packageId || transfer.packageId === options.packageId)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
    return paginate(records, options);
  }

  inspectOwnershipTransfer(transferId, options = {}) {
    const transfer = this.ownershipTransfers.get(transferId);
    if (!transfer) throw httpError(404, "Ownership transfer not found");
    this.requireTransferReadPermission(options.authActor ?? defaultActor(), transfer, "ownership.transfer.inspect");
    return { transfer, packageOwnerHandle: this.packageOwnerHandle(transfer.packageId) };
  }

  async recordInstallEvent(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizeInstallEventRequest(input);
    const projectedVersion = this.projectedVersionForPackage(request.packageId, request.version);
    if (!projectedVersion) throw httpError(404, "Install analytics package version not found");
    const createdAt = now.toISOString();
    const day = createdAt.slice(0, 10);
    const id = `install-${slugId(request.packageId)}-${slugVersion(request.version)}-${request.event}-${String(this.installEvents.length + 1).padStart(6, "0")}`;
    const installEvent = {
      id,
      packageId: request.packageId,
      version: request.version,
      publisherHandle: projectedVersion.publisherHandle,
      event: request.event,
      source: request.source,
      day,
      ...(request.clientId ? { clientHash: hashAnalyticsClient(request.clientId, this.analyticsSalt) } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      createdAt,
    };
    this.installEvents.push(installEvent);
    this.recordAuditEvent({
      actor,
      action: "install.event.ingest",
      targetType: "installEvent",
      targetId: id,
      metadata: {
        packageId: installEvent.packageId,
        version: installEvent.version,
        publisherHandle: installEvent.publisherHandle,
        event: installEvent.event,
        source: installEvent.source,
        day,
        clientHashPresent: Boolean(installEvent.clientHash),
      },
      createdAt,
    });
    await this.persistState();
    return { installEvent };
  }

  installAnalyticsSummary(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "install.analytics.summary");
    const events = this.installEvents
      .filter((event) => !options.packageId || event.packageId === options.packageId)
      .filter((event) => !options.version || event.version === options.version)
      .filter((event) => !options.event || event.event === options.event)
      .filter((event) => !options.source || event.source === options.source)
      .filter((event) => !options.since || event.createdAt >= options.since)
      .filter((event) => !options.until || event.createdAt <= options.until);
    const uniqueClientHashes = new Set(events.map((event) => event.clientHash).filter(Boolean));
    return {
      total: events.length,
      uniqueClients: uniqueClientHashes.size,
      byPackage: aggregateInstallEvents(events, (event) => event.packageId),
      byVersion: aggregateInstallEvents(events, (event) => `${event.packageId}@${event.version}`),
      byEvent: aggregateInstallEvents(events, (event) => event.event),
      bySource: aggregateInstallEvents(events, (event) => event.source),
      byDay: aggregateInstallEvents(events, (event) => event.day),
      filters: {
        packageId: options.packageId ?? null,
        version: options.version ?? null,
        event: options.event ?? null,
        source: options.source ?? null,
        since: options.since ?? null,
        until: options.until ?? null,
      },
      privacy: {
        rawIpStored: false,
        rawUserAgentStored: false,
        clientHash: "sha256(salt + clientId), only when clientId is provided",
      },
    };
  }

  adminStatus({ actor = defaultActor(), now = new Date(), runtime = {} } = {}) {
    this.requireAdminPermission(actor, "admin.status");
    const generatedAt = now.toISOString();
    const analytics = this.installAnalyticsSummary({ authActor: actor });
    const audit = this.verifyAuditEvents();
    const retention = this.auditRetentionPlan({ actor, now });
    const counts = {
      publishers: this.publisherAccounts.size,
      publisherMembers: this.publisherMembers.length,
      artifactUploads: this.slots.size,
      submissions: this.submissions.size,
      reviews: this.reviews.size,
      packageVersions: this.packageVersions.size,
      ownershipTransfers: this.ownershipTransfers.size,
      installEvents: this.installEvents.length,
      auditEvents: this.auditEvents.length,
      auditCheckpoints: this.auditCheckpoints.length,
    };
    const readinessChecks = [
      { id: "state-store", status: this.stateStore ? "ready" : "local-memory", detail: this.stateStore?.kind ?? "memory" },
      { id: "object-store", status: this.objectStore ? "ready" : "missing", detail: this.objectStore?.kind ?? null },
      { id: "signed-read", status: this.signedReadKeys.size > 0 ? "ready" : "missing", detail: this.signedReadKeyId },
      { id: "admin-actors", status: this.adminActorIds.size > 0 ? "ready" : "missing", detail: this.adminActorIds.size },
      { id: "audit-integrity", status: audit.valid ? "ready" : "fail_closed", detail: audit.head },
    ];
    return {
      status: readinessChecks.some((check) => check.status === "missing" || check.status === "fail_closed") ? "degraded" : "ok",
      service: "corehub-api",
      generatedAt,
      actor,
      runtime: {
        stateStore: {
          kind: runtime.stateStoreKind ?? this.stateStore?.kind ?? "memory",
          path: this.statePath ?? null,
          key: this.stateStore?.key ?? null,
          table: this.stateStore?.table ?? null,
        },
        objectStore: {
          kind: runtime.objectStoreKind ?? this.objectStore?.kind ?? "unknown",
          root: this.objectStore?.root ?? null,
          bucket: this.objectStore?.bucketName ?? null,
        },
        publicBaseUrl: this.publicBaseUrl,
        signedReadKeyId: this.signedReadKeyId,
      },
      counts,
      queues: {
        submissions: countByStatus([...this.submissions.values()].map((record) => record.submission.status)),
        reviews: countByStatus([...this.reviews.values()].map((review) => review.status)),
        ownershipTransfers: countByStatus([...this.ownershipTransfers.values()].map((transfer) => transfer.status)),
      },
      analytics,
      audit: {
        valid: audit.valid,
        behavior: audit.behavior,
        count: audit.count,
        head: audit.head,
        checkpoint: audit.checkpoint,
        errors: audit.errors,
        retention: {
          status: retention.status,
          policy: retention.policy,
          cutoff: retention.cutoff,
          pruneableCount: retention.pruneableCount,
          retainedCount: retention.retainedCount,
          requiresExportBeforePrune: retention.requiresExportBeforePrune,
        },
      },
      readiness: {
        status: readinessChecks.every((check) => check.status === "ready") ? "ready" : "attention_required",
        checks: readinessChecks,
      },
    };
  }

  adminSupportBundle({ actor = defaultActor(), now = new Date(), runtime = {}, limit = 20 } = {}) {
    const status = this.adminStatus({ actor, now, runtime });
    const recentAudit = this.listAuditEvents({ authActor: actor, limit, offset: 0 });
    return {
      ...status,
      bundle: {
        kind: "corehub-admin-support-bundle",
        generatedAt: status.generatedAt,
        redaction: {
          secretsIncluded: false,
          rawClientIdentifiersIncluded: false,
          signingSecretsIncluded: false,
        },
      },
      recent: {
        submissions: latestItems([...this.submissions.values()].map((record) => record.submission), limit),
        reviews: latestItems([...this.reviews.values()], limit),
        ownershipTransfers: latestItems([...this.ownershipTransfers.values()], limit),
        auditEvents: recentAudit.items,
      },
    };
  }

  reviewInspection(moderationReview) {
    const record = moderationReview.targetType === "submission" ? this.submissions.get(moderationReview.targetId) : null;
    return {
      moderationReview,
      ...(record ? this.submissionInspection(record) : {}),
    };
  }

  submissionInspection(record) {
    const packageVersion = this.packageVersions.get(record.packageVersionPreview.id) ?? null;
    return {
      submission: record.submission,
      artifactUpload: this.findArtifactUpload(record.artifactUploadId),
      packageVersionPreview: record.packageVersionPreview,
      packageVersion,
      moderationReview: this.reviews.get(record.submission.reviewId) ?? null,
    };
  }

  listAuditEvents(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "audit.list");
    const records = this.auditEvents
      .filter((event) => !options.actor || event.actor?.id === options.actor)
      .filter((event) => !options.action || event.action === options.action)
      .filter((event) => !options.target || event.targetId === options.target || `${event.targetType}:${event.targetId}` === options.target)
      .filter((event) => !options.targetType || event.targetType === options.targetType)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return paginate(records, options);
  }

  verifyAuditEvents() {
    const events = [...this.auditEvents].sort((left, right) => left.sequence - right.sequence);
    const checkpoint = this.latestAuditCheckpoint();
    let previousHash = checkpoint?.head ?? "0".repeat(64);
    let expectedSequence = (checkpoint?.sequence ?? 0) + 1;
    const errors = [];
    for (const event of events) {
      if (event.sequence !== expectedSequence) {
        errors.push(`${event.id}.sequence expected ${expectedSequence}`);
      }
      if (event.previousHash !== previousHash) {
        errors.push(`${event.id}.previousHash expected ${previousHash}`);
      }
      const eventHash = hashAuditEvent({ ...event, previousHash, eventHash: undefined });
      if (event.eventHash !== eventHash) {
        errors.push(`${event.id}.eventHash expected ${eventHash}`);
      }
      previousHash = event.eventHash ?? "";
      expectedSequence = event.sequence + 1;
    }
    const valid = errors.length === 0;
    return {
      valid,
      count: events.length,
      head: previousHash,
      errors,
      checkpoint: checkpoint ?? null,
      behavior: valid ? "proceed" : "fail_closed",
      recommendation: valid
        ? "Audit chain is valid. Operator reads and retention actions can proceed."
        : "Audit chain is invalid. Stop retention pruning, export the current state, and escalate before trusting write-side evidence.",
    };
  }

  auditRetentionPlan({ actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "audit.retention.inspect");
    const verification = this.verifyAuditEvents();
    const cutoff = new Date(now.getTime() - this.auditRetentionDays * 24 * 60 * 60 * 1000);
    const events = [...this.auditEvents].sort((left, right) => left.sequence - right.sequence);
    const pruneableEvents = [];
    for (const event of events) {
      if (new Date(event.createdAt) >= cutoff) break;
      pruneableEvents.push(event);
    }
    const lastPruneable = pruneableEvents.at(-1);
    const status = !verification.valid ? "blocked" : pruneableEvents.length === 0 ? "noop" : "ready";
    return {
      status,
      policy: {
        retentionDays: this.auditRetentionDays,
        mode: "export-before-prune",
        pruneStrategy: "prefix-checkpoint",
        integrityFailureBehavior: "fail_closed",
      },
      cutoff: cutoff.toISOString(),
      total: events.length,
      pruneableCount: pruneableEvents.length,
      retainedCount: events.length - pruneableEvents.length,
      pruneThroughSequence: lastPruneable?.sequence ?? null,
      pruneThroughHash: lastPruneable?.eventHash ?? null,
      pruneThroughCreatedAt: lastPruneable?.createdAt ?? null,
      requiresExportBeforePrune: pruneableEvents.length > 0,
      verification,
      recommendation: retentionRecommendation(status),
    };
  }

  async pruneAuditEvents({
    actor = defaultActor(),
    dryRun = true,
    exportHash,
    exportedAt,
    exportedCount,
    now = new Date(),
  } = {}) {
    this.requireAdminPermission(actor, "audit.retention.prune");
    const plan = this.auditRetentionPlan({ actor, now });
    if (plan.status === "blocked") return plan;
    if (dryRun || plan.status === "noop") return { ...plan, dryRun: true };
    if (!/^[a-f0-9]{64}$/.test(String(exportHash ?? ""))) {
      throw httpError(409, "Audit retention prune requires an exportHash from an operator-held export");
    }

    const events = [...this.auditEvents].sort((left, right) => left.sequence - right.sequence);
    const pruned = events.slice(0, plan.pruneableCount);
    const retained = events.slice(plan.pruneableCount);
    const lastPruned = pruned.at(-1);
    const checkpoint = {
      id: `audit-checkpoint-${String(lastPruned.sequence).padStart(6, "0")}`,
      sequence: lastPruned.sequence,
      head: lastPruned.eventHash,
      prunedCount: pruned.length,
      prunedThroughSequence: lastPruned.sequence,
      prunedThroughHash: lastPruned.eventHash,
      prunedThroughCreatedAt: lastPruned.createdAt,
      exportHash,
      exportedAt: exportedAt ?? now.toISOString(),
      exportedCount: exportedCount ?? pruned.length,
      createdAt: now.toISOString(),
    };
    this.auditEvents = retained;
    this.auditCheckpoints.push(checkpoint);
    this.recordAuditEvent({
      actor,
      action: "audit.retention.prune",
      targetType: "audit",
      targetId: checkpoint.id,
      metadata: {
        exportHash,
        exportedAt: checkpoint.exportedAt,
        exportedCount: checkpoint.exportedCount,
        prunedCount: pruned.length,
        prunedThroughSequence: checkpoint.prunedThroughSequence,
        prunedThroughHash: checkpoint.prunedThroughHash,
      },
      createdAt: now.toISOString(),
    });
    await this.persistState();
    return {
      ...this.auditRetentionPlan({ actor, now }),
      status: "pruned",
      dryRun: false,
      checkpoint,
      prunedCount: pruned.length,
    };
  }

  async auditRead({ actor = defaultActor(), action, targetType, targetId, metadata = {}, now = new Date() }) {
    this.recordAuditEvent({
      actor,
      action,
      targetType,
      targetId,
      metadata,
      createdAt: now.toISOString(),
    });
    await this.persistState();
  }

  publisherIdentity(actor = defaultActor()) {
    const memberships = this.publisherMembers
      .filter((member) => member.userId === actor.id && member.status === "active")
      .map((member) => ({
        ...member,
        publisher: this.publisherAccounts.get(member.publisherHandle) ?? null,
        permissions: publisherPermissionsForRole(member.role),
      }))
      .sort((left, right) => left.publisherHandle.localeCompare(right.publisherHandle));
    return {
      actor,
      memberships,
      permissions: {
        admin: this.hasAdminPermission(actor),
      },
      defaultPublisher: memberships[0]?.publisher ?? null,
    };
  }

  requirePublisherPermission(actor, publisherHandle, action) {
    const publisher = this.publisherAccounts.get(publisherHandle);
    if (!publisher || publisher.status !== "verified") {
      throw httpError(403, `Publisher ${publisherHandle} is not verified for ${action}`);
    }
    const membership = this.publisherMembers.find(
      (member) =>
        member.userId === actor.id &&
        member.publisherHandle === publisherHandle &&
        member.status === "active" &&
        publisherWriteRoles.has(member.role),
    );
    if (!membership) {
      throw httpError(403, `Actor ${actor.id} cannot ${action} for publisher ${publisherHandle}`);
    }
    return membership;
  }

  requireAdminPermission(actor, action) {
    if (!this.hasAdminPermission(actor)) {
      throw httpError(403, `Actor ${actor.id} cannot ${action}`);
    }
  }

  hasAdminPermission(actor) {
    if (this.adminActorIds.has(actor.id)) return true;
    return this.publisherMembers.some(
      (member) => member.userId === actor.id && member.status === "active" && adminRoles.has(member.role),
    );
  }

  requireVerifiedPublisher(publisherHandle, action) {
    const publisher = this.publisherAccounts.get(publisherHandle);
    if (!publisher || publisher.status !== "verified") {
      throw httpError(403, `Publisher ${publisherHandle} is not verified for ${action}`);
    }
    return publisher;
  }

  requireTransferReadPermission(actor, transfer, action) {
    if (this.hasAdminPermission(actor)) return;
    if (this.hasPublisherMembership(actor, transfer.fromPublisherHandle) || this.hasPublisherMembership(actor, transfer.toPublisherHandle)) {
      return;
    }
    throw httpError(403, `Actor ${actor.id} cannot ${action}`);
  }

  requireTransferDecisionPermission(actor, transfer, action) {
    if (this.hasAdminPermission(actor)) return;
    if (this.hasPublisherMembership(actor, transfer.toPublisherHandle)) return;
    throw httpError(403, `Actor ${actor.id} cannot ${action}`);
  }

  hasPublisherMembership(actor, publisherHandle) {
    return this.publisherMembers.some(
      (member) =>
        member.userId === actor.id &&
        member.publisherHandle === publisherHandle &&
        member.status === "active" &&
        publisherWriteRoles.has(member.role),
    );
  }

  packageOwnerHandle(packageId) {
    const completedTransfer = [...this.ownershipTransfers.values()]
      .filter((transfer) => transfer.packageId === packageId && transfer.status === "completed")
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .at(0);
    if (completedTransfer) return completedTransfer.toPublisherHandle;
    const versions = [...this.packageVersions.values()]
      .filter((version) => version.packageId === packageId && version.status === "available")
      .sort((left, right) => (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt));
    return versions.at(0)?.publisherHandle ?? null;
  }

  projectedVersionForPackage(packageId, version) {
    const versions = [...this.packageVersions.values()]
      .filter((item) => item.packageId === packageId && item.status === "available")
      .filter((item) => item.version === version || (version === "latest" && (item.tag === "latest" || !item.tag)))
      .sort((left, right) => (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt));
    return versions.at(0) ?? null;
  }

  recordAuditEvent({ actor, action, targetType, targetId, metadata = {}, createdAt }) {
    const checkpoint = this.latestAuditCheckpoint();
    const previousHash = this.auditEvents.at(-1)?.eventHash ?? checkpoint?.head ?? "0".repeat(64);
    const sequence = (this.auditEvents.at(-1)?.sequence ?? checkpoint?.sequence ?? 0) + 1;
    const event = {
      id: `audit-${String(sequence).padStart(6, "0")}-${slugId(action)}-${slugId(targetId).slice(0, 48)}`,
      sequence,
      actor,
      action,
      targetType,
      targetId,
      metadata,
      createdAt,
      previousHash,
    };
    event.eventHash = hashAuditEvent(event);
    this.auditEvents.push(event);
    return event;
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
      schemaVersion: localStateSchemaVersion,
      savedAt,
      publicBaseUrl: this.publicBaseUrl,
      authSessions: this.authSessions,
      publisherClaims: this.publisherClaims,
      publisherAccounts: [...this.publisherAccounts.values()],
      publisherMembers: this.publisherMembers,
      slots: [...this.slots.values()],
      submissions: [...this.submissions.values()],
      reviews: [...this.reviews.values()],
      packageVersions: [...this.packageVersions.values()],
      ownershipTransfers: [...this.ownershipTransfers.values()],
      installEvents: this.installEvents,
      auditEvents: this.auditEvents,
      auditCheckpoints: this.auditCheckpoints,
    };
  }

  restoreState(state) {
    if (!state || state.schemaVersion !== localStateSchemaVersion) {
      throw new Error("Unsupported CoreHub local state file");
    }
    this.publicBaseUrl = state.publicBaseUrl ?? this.publicBaseUrl;
    this.authSessions = state.authSessions ?? [];
    this.publisherClaims = state.publisherClaims ?? [];
    this.publisherAccounts = new Map(
      (state.publisherAccounts ?? defaultPublisherAccounts()).map((publisher) => [publisher.handle, publisher]),
    );
    this.publisherMembers = state.publisherMembers ?? defaultPublisherMembers();
    this.slots = new Map((state.slots ?? []).map((slot) => [slot.id, slot]));
    this.submissions = new Map((state.submissions ?? []).map((record) => [record.submission.id, record]));
    this.reviews = new Map((state.reviews ?? []).map((review) => [review.id, review]));
    this.packageVersions = new Map((state.packageVersions ?? []).map((version) => [version.id, version]));
    this.ownershipTransfers = new Map((state.ownershipTransfers ?? []).map((transfer) => [transfer.id, transfer]));
    this.installEvents = state.installEvents ?? [];
    this.auditEvents = state.auditEvents ?? [];
    this.auditCheckpoints = state.auditCheckpoints ?? [];
  }

  async saveState(path = this.statePath) {
    const snapshot = this.snapshotState();
    if (path === this.statePath && this.stateStore) return this.stateStore.save(snapshot);
    if (!path) throw new Error("CoreHub local state path is not configured");
    await new CoreHubLocalJsonStateStore({ statePath: path }).save(snapshot);
    return snapshot;
  }

  async loadState(path = this.statePath) {
    const state =
      path === this.statePath && this.stateStore
        ? await this.stateStore.load()
        : path
          ? await new CoreHubLocalJsonStateStore({ statePath: path }).load()
          : null;
    if (!state) return false;
    this.restoreState(state);
    return true;
  }

  async persistState() {
    if (!this.stateStore && !this.statePath) return;
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

  findProjectedArtifactByStorageKey(key) {
    for (const entry of this.projectCatalogEntries()) {
      for (const version of entry.versions ?? []) {
        if (version.artifact?.storage?.key === key) return version.artifact;
      }
    }
    return null;
  }

  latestAuditCheckpoint() {
    return this.auditCheckpoints.reduce((latest, checkpoint) => {
      if (!latest || checkpoint.sequence > latest.sequence) return checkpoint;
      return latest;
    }, null);
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
      if (request.method === "GET" && ["/corehub/admin", "/corehub/admin/"].includes(url.pathname)) {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html;charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(renderCoreHubAdminHtml());
        return;
      }

      const v1Segments = trimBasePath(url.pathname, "/corehub/api/v1");
      if (v1Segments) {
        const result = await handleProjectedRegistryV1(storage, request, url, v1Segments, {
          actor: actorFromRequest(request),
          now: now(),
        });
        if (result) return sendApiResult(response, result);
      }

      const segments = trimBasePath(url.pathname, basePath);
      if (!segments) return json(response, 404, { error: "Not found" });

      if (request.method === "GET" && segments[0] === "publishers" && segments[1] === "me" && segments.length === 2) {
        const actor = actorFromRequest(request);
        const result = storage.publisherIdentity(actor);
        await storage.auditRead({
          actor,
          action: "publisher.whoami",
          targetType: "publisher",
          targetId: result.defaultPublisher?.handle ?? actor.id,
          metadata: { membershipCount: result.memberships.length },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "admin" && ["status", "health"].includes(segments[1]) && segments.length === 2) {
        const actor = actorFromRequest(request);
        const result = storage.adminStatus({ actor, now: now() });
        await storage.auditRead({
          actor,
          action: "admin.status",
          targetType: "admin",
          targetId: result.status,
          metadata: {
            status: result.status,
            readiness: result.readiness.status,
            auditValid: result.audit.valid,
          },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "admin" && segments[1] === "support-bundle" && segments.length === 2) {
        const actor = actorFromRequest(request);
        const result = storage.adminSupportBundle({
          actor,
          now: now(),
          limit: parseNonNegativeInteger(url.searchParams.get("limit"), "limit", 20),
        });
        await storage.auditRead({
          actor,
          action: "admin.support_bundle",
          targetType: "admin",
          targetId: result.status,
          metadata: {
            status: result.status,
            readiness: result.readiness.status,
            recentAuditCount: result.recent.auditEvents.length,
          },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

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

      if (request.method === "GET" && segments[0] === "submissions" && segments.length === 1) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request);
        options.authActor = actor;
        const result = storage.listSubmissions(options);
        await storage.auditRead({
          actor,
          action: "submission.list",
          targetType: "submission",
          targetId: options.status ? `status:${options.status}` : "all",
          metadata: options,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (request.method === "GET" && segments[0] === "submissions" && segments.length === 2) {
        const submissionId = decodeURIComponent(segments[1]);
        const actor = actorFromRequest(request);
        const result = storage.inspectSubmission(submissionId, { authActor: actor });
        await storage.auditRead({
          actor,
          action: "submission.inspect",
          targetType: "submission",
          targetId: submissionId,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "reviews" && segments.length === 1) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request);
        options.authActor = actor;
        const result = storage.listReviews(options);
        await storage.auditRead({
          actor,
          action: "review.list",
          targetType: "review",
          targetId: options.status ? `status:${options.status}` : "all",
          metadata: options,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (request.method === "GET" && segments[0] === "reviews" && segments.length === 2) {
        const reviewId = decodeURIComponent(segments[1]);
        const actor = actorFromRequest(request);
        const result = storage.inspectReview(reviewId, { authActor: actor });
        await storage.auditRead({
          actor,
          action: "review.inspect",
          targetType: "review",
          targetId: reviewId,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "transfers" && segments.length === 1) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.requestOwnershipTransfer(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "transfers" && segments.length === 1) {
        const options = readListOptions(url);
        options.packageId = url.searchParams.get("package") ?? undefined;
        const actor = actorFromRequest(request);
        options.authActor = actor;
        const result = storage.listOwnershipTransfers(options);
        await storage.auditRead({
          actor,
          action: "ownership.transfer.list",
          targetType: "ownershipTransfer",
          targetId: options.packageId ?? options.status ?? "all",
          metadata: options,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (request.method === "GET" && segments[0] === "transfers" && segments.length === 2) {
        const transferId = decodeURIComponent(segments[1]);
        const actor = actorFromRequest(request);
        const result = storage.inspectOwnershipTransfer(transferId, { authActor: actor });
        await storage.auditRead({
          actor,
          action: "ownership.transfer.inspect",
          targetType: "ownershipTransfer",
          targetId: transferId,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "transfers" &&
        ["accept", "reject", "cancel"].includes(segments[2]) &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.decideOwnershipTransfer(decodeURIComponent(segments[1]), segments[2], body, {
          actor,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "install-events" && segments.length === 1) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.recordInstallEvent(body, {
          actor,
          now: now(),
        });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "install-events" && segments[1] === "summary" && segments.length === 2) {
        const actor = actorFromRequest(request);
        const options = readInstallAnalyticsOptions(url);
        options.authActor = actor;
        const result = storage.installAnalyticsSummary(options);
        await storage.auditRead({
          actor,
          action: "install.analytics.summary",
          targetType: "installEvent",
          targetId: options.packageId ?? options.event ?? "all",
          metadata: options,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "audit" && segments[1] === "events" && segments.length === 2) {
        const options = readAuditListOptions(url);
        const actor = actorFromRequest(request);
        options.authActor = actor;
        const result = storage.listAuditEvents(options);
        await storage.auditRead({
          actor,
          action: "audit.list",
          targetType: "audit",
          targetId: options.target ?? options.action ?? "all",
          metadata: options,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (request.method === "GET" && segments[0] === "audit" && segments[1] === "verify" && segments.length === 2) {
        const actor = actorFromRequest(request);
        storage.requireAdminPermission(actor, "audit.verify");
        const result = storage.verifyAuditEvents();
        await storage.auditRead({
          actor,
          action: "audit.verify",
          targetType: "audit",
          targetId: result.head,
          metadata: { count: result.count, valid: result.valid },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "audit" && segments[1] === "retention" && segments.length === 2) {
        const actor = actorFromRequest(request);
        const result = storage.auditRetentionPlan({ actor, now: now() });
        await storage.auditRead({
          actor,
          action: "audit.retention.inspect",
          targetType: "audit",
          targetId: result.status,
          metadata: {
            retentionDays: result.policy.retentionDays,
            pruneableCount: result.pruneableCount,
            retainedCount: result.retainedCount,
            valid: result.verification.valid,
          },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "audit" &&
        segments[1] === "retention" &&
        segments[2] === "prune" &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const result = await storage.pruneAuditEvents({
          actor: actorFromRequest(request),
          dryRun: body.dryRun !== false,
          exportHash: body.exportHash,
          exportedAt: body.exportedAt,
          exportedCount: body.exportedCount,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
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
        request.method === "POST" &&
        segments[0] === "reviews" &&
        segments[2] === "assign" &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.assignReview(decodeURIComponent(segments[1]), body, {
          actor,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "reviews" &&
        segments[2] === "evidence" &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request);
        const result = await storage.addReviewEvidence(decodeURIComponent(segments[1]), body, {
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
        const result = await storage.putObject(decodeURIComponent(segments[2]), bytes, request.headers, {
          actor: actorFromRequest(request),
          now: now(),
        });
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

async function handleProjectedRegistryV1(storage, request, url, segments, { actor = defaultActor(), now = new Date() } = {}) {
  if (request.method !== "GET") return null;
  const entries = storage.projectCatalogEntries();
  const baseUrl = requestBaseUrl(request, url);

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
  if (segments[0] === "download" && segments.length === 1) {
    const entry = findProjectedEntry(entries, url.searchParams.get("id"));
    return entry ? projectedDownloadResponse(storage, request, url, entry, { actor, baseUrl, now }) : dataResponse(null, 0, 404);
  }
  if (segments[0] === "artifacts" && segments[1] === "read" && segments.length === 2) {
    const result = await storage.readSignedArtifact(url, { actor, now });
    return binaryResponse(result.bytes, {
      "Content-Type": result.artifact.mediaType ?? "application/octet-stream",
      "Content-Length": String(result.bytes.byteLength),
      "X-CoreHub-Artifact-SHA256": result.artifact.sha256,
    });
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
    if (segments[2] === "moderation" && segments.length === 3) return dataResponse(createPackageModerationStatus(entry));
    if (segments[2] === "readiness" && segments.length === 3) return dataResponse(createPackageReadiness(entry));
    if (segments[2] === "artifact" && segments.length === 3) {
      const version = entry.versions.find((item) => item.tag === "latest") ?? entry.versions[0];
      const download = await storage.createArtifactDownload(version.artifact, { actor, baseUrl, now });
      return dataResponse({
        package: { id: entry.id, kind: entry.kind, name: entry.name },
        version: version.version,
        publisher: entry.publisher,
        artifact: version.artifact,
        files: version.artifact.files,
        download,
      });
    }
    if (segments[2] === "download" && segments.length === 3) {
      return projectedDownloadResponse(storage, request, url, entry, { actor, baseUrl, now });
    }
  }
  return null;
}

async function projectedDownloadResponse(storage, request, url, entry, { actor, baseUrl, now }) {
  const version = entry.versions.find((item) => item.tag === "latest") ?? entry.versions[0];
  const download = await storage.createArtifactDownload(version.artifact, { actor, baseUrl, now });
  if (download.available && url.searchParams.get("redirect") !== "false") {
    return redirectResponse(download.url);
  }
  return dataResponse({
    package: { id: entry.id, kind: entry.kind, name: entry.name },
    version: version.version,
    publisher: entry.publisher,
    artifact: version.artifact,
    download,
  });
}

function findProjectedEntry(entries, id) {
  const decoded = decodeURIComponent(id);
  return entries.find((entry) => entry.id === decoded) ?? null;
}

function createPackageModerationStatus(entry) {
  const latest = selectLatestPackageVersion(entry);
  const reviewState = entry.review?.state ?? "unknown";
  const blocked = latest?.status === "blocked" || reviewState === "blocked" || latest?.artifact?.downloadEnabled === false;
  const reasons = [];
  if (!latest) reasons.push("latest-version-missing");
  if (latest?.status && latest.status !== "available") reasons.push(`version-${latest.status}`);
  if (reviewState !== "verified") reasons.push(`review-${reviewState}`);
  if (latest?.artifact?.downloadEnabled === false) reasons.push("download-disabled");
  return {
    status: "ok",
    package: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      publisher: entry.publisher ?? null,
    },
    review: entry.review ?? null,
    latestVersion: latest
      ? {
          version: latest.version,
          tag: latest.tag ?? null,
          status: latest.status ?? "unknown",
          moderationStatus: reviewState,
          blockedFromDownload: blocked,
          downloadEnabled: Boolean(latest.artifact?.downloadEnabled),
          reasons,
          moderationReason: entry.review?.notes ?? null,
        }
      : null,
  };
}

function createPackageReadiness(entry) {
  const latest = selectLatestPackageVersion(entry);
  const checks = [];
  const add = (id, label, status, message) => checks.push({ id, label, status, message });
  add(
    "publisher",
    "Verified publisher",
    entry.publisher?.verified ? "pass" : "fail",
    entry.publisher?.verified ? `Publisher ${entry.publisher.handle} is verified.` : "Package publisher is not verified.",
  );
  add(
    "latest-version",
    "Latest version",
    latest ? "pass" : "fail",
    latest ? `Latest version is ${latest.version}.` : "No latest package version is available.",
  );
  add(
    "artifact-digest",
    "Artifact digest",
    latest?.artifact?.sha256 ? "pass" : "fail",
    latest?.artifact?.sha256 ? "Latest artifact has a SHA-256 digest." : "Latest artifact digest is missing.",
  );
  add(
    "artifact-download",
    "Artifact download",
    latest?.artifact?.downloadEnabled ? "pass" : "fail",
    latest?.artifact?.downloadEnabled ? "Latest artifact download is enabled." : "Latest artifact download is not enabled.",
  );
  add(
    "source",
    "Source provenance",
    entry.source || latest?.artifact?.provenance?.source ? "pass" : "fail",
    entry.source || latest?.artifact?.provenance?.source
      ? `Source is ${entry.source ?? latest.artifact.provenance.source}.`
      : "Source provenance is missing.",
  );
  add(
    "coreblow-compatibility",
    "CoreBlow compatibility",
    entry.coreblow?.minCoreblowVersion && Array.isArray(entry.coreblow?.platforms) && entry.coreblow.platforms.length > 0
      ? "pass"
      : "fail",
    entry.coreblow?.minCoreblowVersion
      ? `minCoreblowVersion=${entry.coreblow.minCoreblowVersion}.`
      : "CoreBlow compatibility metadata is missing.",
  );
  add(
    "moderation",
    "Moderation state",
    entry.review?.state === "verified" && latest?.status === "available" ? "pass" : "fail",
    entry.review?.state === "verified" && latest?.status === "available"
      ? "Package is verified and latest version is available."
      : `Review state is ${entry.review?.state ?? "unknown"} and latest status is ${latest?.status ?? "missing"}.`,
  );
  const blockers = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return {
    status: "ok",
    ready: blockers.length === 0,
    package: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      latestVersion: latest?.version ?? null,
      publisher: entry.publisher ?? null,
    },
    checks,
    blockers,
  };
}

function selectLatestPackageVersion(entry) {
  return (
    entry.versions?.find((version) => version.tag === "latest") ??
    entry.versions?.toSorted((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? ""))).at(0) ??
    null
  );
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

function redirectResponse(location, statusCode = 302) {
  return {
    statusCode,
    headers: { Location: location },
    body: "",
  };
}

function binaryResponse(body, headers = {}, statusCode = 200) {
  return { statusCode, headers, body };
}

function sendApiResult(response, result) {
  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    response.setHeader(name, value);
  }
  if (result.body !== undefined) {
    response.end(result.body);
    return;
  }
  return json(response, result.statusCode, result.payload);
}

function requestBaseUrl(request, url) {
  const host = getHeader(request.headers, "x-forwarded-host") ?? getHeader(request.headers, "host");
  if (!host) return `${url.origin}/corehub`;
  const proto = getHeader(request.headers, "x-forwarded-proto") ?? (url.protocol === "https:" ? "https" : "http");
  return `${proto}://${host}/corehub`;
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

function normalizeSigningKeyId(value) {
  const keyId = normalizeRequiredString(value, "signedReadKeyId");
  if (!/^[a-zA-Z0-9._-]+$/.test(keyId)) throw new Error("signedReadKeyId must use letters, numbers, dot, underscore, or dash");
  return keyId;
}

function normalizeSigningKeys({ signedReadSecret, signedReadKeyId, signedReadKeys } = {}) {
  const keys = new Map();
  if (signedReadKeys) {
    for (const [keyId, secret] of signedReadKeys instanceof Map ? signedReadKeys.entries() : Object.entries(signedReadKeys)) {
      const normalizedKeyId = normalizeSigningKeyId(keyId);
      if (typeof secret !== "string" || secret.length < 12) {
        throw new Error(`Signing secret for ${normalizedKeyId} must be at least 12 characters`);
      }
      keys.set(normalizedKeyId, secret);
    }
  }
  if (typeof signedReadSecret !== "string" || signedReadSecret.length < 12) {
    throw new Error("COREHUB_SIGNING_SECRET must be at least 12 characters");
  }
  keys.set(signedReadKeyId, signedReadSecret);
  return keys;
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

function normalizeOwnershipTransferRequest(input) {
  const packageId = normalizeRequiredString(input?.packageId, "packageId");
  const fromPublisherHandle = normalizeRequiredString(input?.fromPublisherHandle, "fromPublisherHandle");
  const toPublisherHandle = normalizeRequiredString(input?.toPublisherHandle, "toPublisherHandle");
  if (fromPublisherHandle === toPublisherHandle) {
    throw httpError(400, "Ownership transfer requires different source and target publishers");
  }
  const reason = typeof input?.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : undefined;
  return { packageId, fromPublisherHandle, toPublisherHandle, reason };
}

function normalizeInstallEventRequest(input) {
  const packageId = normalizeRequiredString(input?.packageId, "packageId");
  const version = normalizeRequiredString(input?.version ?? "latest", "version");
  const event = normalizeRequiredString(input?.event, "event");
  if (!["resolved", "downloaded", "verified", "installed", "blocked", "failed"].includes(event)) {
    throw httpError(400, "install event must be resolved, downloaded, verified, installed, blocked, or failed");
  }
  const source = normalizeRequiredString(input?.source ?? "api", "source");
  if (!["cli", "coreblow", "api", "ci"].includes(source)) {
    throw httpError(400, "install source must be cli, coreblow, api, or ci");
  }
  const clientId = typeof input?.clientId === "string" && input.clientId.trim().length > 0 ? input.clientId.trim() : undefined;
  const reason = typeof input?.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : undefined;
  return { packageId, version, event, source, clientId, reason };
}

function createSubmissionReviewEvidence({ submission, artifactUpload, actor, createdAt }) {
  const source = submission.source ?? `https://github.com/${submission.publisherHandle}/${submission.packageId}`;
  return [
    {
      id: `evidence-${slugId(submission.reviewId)}-artifact`,
      type: "artifact_checksum",
      summary: "Verified artifact metadata is attached to the submission.",
      metadata: {
        artifactUploadId: artifactUpload.id,
        storage: artifactUpload.storage,
        size: artifactUpload.size,
        sha256: artifactUpload.sha256,
      },
      createdBy: actor,
      createdAt,
    },
    {
      id: `evidence-${slugId(submission.reviewId)}-source`,
      type: "source_attribution",
      summary: "Submission source attribution is available for moderation review.",
      metadata: {
        source,
        publisherHandle: submission.publisherHandle,
        packageId: submission.packageId,
        version: submission.version,
      },
      createdBy: actor,
      createdAt,
    },
  ];
}

function normalizeReviewEvidence(input, { id, actor, createdAt }) {
  const type = normalizeRequiredString(input?.type ?? "manual_note", "type");
  if (!/^[a-z][a-z0-9_.-]*$/.test(type)) throw httpError(400, "evidence type must be a lowercase identifier");
  const summary = normalizeRequiredString(input?.summary ?? input?.notes, "summary");
  const metadata = input?.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {};
  return {
    id,
    type,
    summary,
    metadata,
    createdBy: actor,
    createdAt,
  };
}

function normalizeActorInput(value, name) {
  const actorId =
    typeof value === "string"
      ? value
      : typeof value?.id === "string"
        ? value.id
        : undefined;
  return {
    type: typeof value?.type === "string" && value.type.trim() ? value.type.trim() : "user",
    id: normalizeRequiredString(actorId, name),
  };
}

function normalizeRequiredString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw httpError(400, `${name} is required`);
  }
  return value.trim();
}

function readListOptions(url) {
  return {
    status: url.searchParams.get("status") ?? undefined,
    limit: parseNonNegativeInteger(url.searchParams.get("limit"), "limit", 50),
    offset: parseNonNegativeInteger(url.searchParams.get("offset"), "offset", 0),
  };
}

function readAuditListOptions(url) {
  return {
    actor: url.searchParams.get("actor") ?? undefined,
    action: url.searchParams.get("action") ?? undefined,
    target: url.searchParams.get("target") ?? undefined,
    targetType: url.searchParams.get("targetType") ?? undefined,
    limit: parseNonNegativeInteger(url.searchParams.get("limit"), "limit", 50),
    offset: parseNonNegativeInteger(url.searchParams.get("offset"), "offset", 0),
  };
}

function readInstallAnalyticsOptions(url) {
  return {
    packageId: url.searchParams.get("package") ?? url.searchParams.get("packageId") ?? undefined,
    version: url.searchParams.get("version") ?? undefined,
    event: url.searchParams.get("event") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    until: url.searchParams.get("until") ?? undefined,
  };
}

function normalizeAuditRetentionDays(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("auditRetentionDays must be a non-negative integer");
  }
  return parsed;
}

function normalizeAnalyticsSalt(value) {
  if (typeof value !== "string" || value.length < 12) {
    throw new Error("analyticsSalt must be at least 12 characters");
  }
  return value;
}

function hashAnalyticsClient(clientId, salt) {
  return createHash("sha256").update(`${salt}:${clientId}`).digest("hex");
}

function aggregateInstallEvents(events, keyForEvent) {
  const counts = new Map();
  for (const event of events) {
    const key = keyForEvent(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function countByStatus(statuses) {
  return statuses.reduce((counts, status) => {
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function latestItems(items, limit) {
  if (limit <= 0) return [];
  return items.slice(-limit).reverse();
}

function normalizeSqlIdentifier(value, name) {
  const text = String(value ?? "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new Error(`${name} must be a safe SQL identifier`);
  }
  return text;
}

function retentionRecommendation(status) {
  if (status === "blocked") {
    return "Retention is blocked because audit integrity verification failed. Export current state and escalate.";
  }
  if (status === "noop") {
    return "No audit events are older than the retention cutoff. No prune is required.";
  }
  return "Export pruneable audit events before pruning. Store the export hash with the checkpoint.";
}

function paginate(items, { limit = 50, offset = 0 } = {}) {
  return {
    items: items.slice(offset, offset + limit),
    meta: {
      count: Math.min(Math.max(items.length - offset, 0), limit),
      total: items.length,
      limit,
      offset,
    },
  };
}

function parseNonNegativeInteger(value, name, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw httpError(400, `${name} must be a non-negative integer`);
  return parsed;
}

function slugId(value) {
  return String(value ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function hashAuditEvent(event) {
  const canonical = {
    id: event.id,
    sequence: event.sequence,
    actor: event.actor,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: event.metadata ?? {},
    createdAt: event.createdAt,
    previousHash: event.previousHash,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) return undefined;
  return JSON.stringify(value);
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
  return { type: "user", id: "github:coreblow-admin" };
}

function defaultPublisherAccounts() {
  return [
    {
      id: "publisher-coreblow",
      handle: "coreblow",
      displayName: "CoreBlow",
      kind: "organization",
      status: "verified",
      source: "https://github.com/coreblow",
      contact: "https://github.com/coreblow/corehub/security/policy",
      createdAt: "2026-05-21T00:00:00Z",
      verifiedAt: "2026-05-21T00:00:00Z",
    },
  ];
}

function defaultPublisherMembers() {
  return [
    {
      id: "member-coreblow-owner",
      publisherHandle: "coreblow",
      userId: "github:coreblow-admin",
      role: "owner",
      status: "active",
      createdAt: "2026-05-21T00:00:00Z",
    },
  ];
}

function publisherPermissionsForRole(role) {
  const permissions = [];
  if (publisherWriteRoles.has(role)) {
    permissions.push("artifact.upload", "submission.create");
  }
  if (adminRoles.has(role)) {
    permissions.push("review.decide", "admin.read");
  }
  return permissions;
}

function normalizeActorIdList(value, label) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(",");
  const normalized = items.map((item) => String(item).trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error(`${label} must include at least one actor id`);
  return normalized;
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

function signArtifactRead({ key, sha256, size, expiresAt, keyId, secret }) {
  return createHmac("sha256", secret)
    .update([key, sha256, size, expiresAt, keyId, "corehub-artifact-read.v1"].join("\n"))
    .digest("hex");
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

function renderCoreHubAdminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CoreHub Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #172026;
      --muted: #66727f;
      --line: #dce1e7;
      --accent: #0f766e;
      --accent-ink: #ffffff;
      --warn: #9a3412;
      --bad: #b91c1c;
      --good: #15803d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 18px; font-weight: 700; }
    h2 { font-size: 15px; font-weight: 700; }
    h3 { font-size: 13px; font-weight: 700; color: var(--muted); }
    main {
      width: min(1280px, 100%);
      margin: 0 auto;
      padding: 20px 24px 40px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .wide-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    section, .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    section { padding: 16px; margin-bottom: 14px; }
    .metric { padding: 14px; min-height: 92px; }
    .metric strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 8px; }
    .muted { color: var(--muted); }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 12px;
      background: #f9fafb;
      white-space: nowrap;
    }
    .status.good { color: var(--good); border-color: #bbf7d0; background: #f0fdf4; }
    .status.warn { color: var(--warn); border-color: #fed7aa; background: #fff7ed; }
    .status.bad { color: var(--bad); border-color: #fecaca; background: #fef2f2; }
    button, input, select {
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 0 10px;
      font: inherit;
    }
    button {
      background: var(--accent);
      color: var(--accent-ink);
      border-color: var(--accent);
      cursor: pointer;
      font-weight: 650;
    }
    button.secondary {
      background: #fff;
      color: var(--ink);
      border-color: var(--line);
    }
    form {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(180px, 1fr) auto;
      gap: 10px;
      margin-top: 14px;
    }
    label {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    label input { width: 100%; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin-top: 12px;
    }
    th, td {
      padding: 9px 8px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th {
      font-size: 12px;
      color: var(--muted);
      font-weight: 700;
    }
    .hidden { display: none !important; }
    .error {
      margin-top: 12px;
      padding: 10px 12px;
      border: 1px solid #fecaca;
      border-radius: 8px;
      color: var(--bad);
      background: #fef2f2;
    }
    .checks {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }
    .check-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 0;
      border-bottom: 1px solid var(--line);
    }
    @media (max-width: 860px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      .grid, .wide-grid, form { grid-template-columns: 1fr; }
      .toolbar { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>CoreHub Admin</h1>
      <p class="muted" id="sessionLabel">Not connected</p>
    </div>
    <div class="toolbar">
      <span class="status" id="readinessPill">signed out</span>
      <button class="secondary" id="refreshButton" type="button">Refresh</button>
      <button class="secondary" id="signOutButton" type="button">Sign out</button>
    </div>
  </header>
  <main>
    <section id="loginPanel">
      <h2>Admin Session</h2>
      <p class="muted">Use an operator token and actor id allowed by CoreHub admin policy.</p>
      <form id="sessionForm">
        <label>Actor
          <input id="actorInput" autocomplete="username" placeholder="github:coreblow-admin" value="github:coreblow-admin">
        </label>
        <label>Token
          <input id="tokenInput" autocomplete="current-password" placeholder="operator token" type="password">
        </label>
        <button type="submit">Connect</button>
      </form>
      <div class="error hidden" id="loginError"></div>
    </section>

    <div id="dashboard" class="hidden">
      <div class="grid">
        <div class="metric"><h3>Readiness</h3><strong id="metricReadiness">-</strong><p class="muted" id="metricStatus">-</p></div>
        <div class="metric"><h3>Submissions</h3><strong id="metricSubmissions">0</strong><p class="muted">write queue</p></div>
        <div class="metric"><h3>Reviews</h3><strong id="metricReviews">0</strong><p class="muted">moderation queue</p></div>
        <div class="metric"><h3>Audit</h3><strong id="metricAudit">-</strong><p class="muted" id="metricAuditCount">0 events</p></div>
      </div>

      <div class="wide-grid">
        <section>
          <h2>Deploy Readiness</h2>
          <div class="checks" id="readinessChecks"></div>
        </section>
        <section>
          <h2>Support Bundle Summary</h2>
          <div class="checks" id="supportSummary"></div>
        </section>
      </div>

      <section>
        <div class="toolbar">
          <h2>Pending Submissions</h2>
          <span class="status" id="submissionCount">0</span>
        </div>
        <table>
          <thead><tr><th>Submission</th><th>Package</th><th>Publisher</th><th>Status</th><th>Submitted</th></tr></thead>
          <tbody id="submissionsTable"></tbody>
        </table>
      </section>

      <section>
        <div class="toolbar">
          <h2>Open Reviews</h2>
          <span class="status" id="reviewCount">0</span>
        </div>
        <table>
          <thead><tr><th>Review</th><th>Target</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead>
          <tbody id="reviewsTable"></tbody>
        </table>
      </section>
    </div>
  </main>

  <script>
    const sessionKey = "corehub.admin.session.v1";
    const state = { session: readSession() };
    const nodes = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));

    nodes.sessionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const actor = nodes.actorInput.value.trim();
      const token = nodes.tokenInput.value.trim();
      if (!actor || !token) return showLoginError("Actor and token are required.");
      state.session = { actor, token };
      sessionStorage.setItem(sessionKey, JSON.stringify(state.session));
      await loadDashboard();
    });
    nodes.refreshButton.addEventListener("click", () => loadDashboard());
    nodes.signOutButton.addEventListener("click", () => {
      sessionStorage.removeItem(sessionKey);
      state.session = null;
      renderSignedOut();
    });

    if (state.session) {
      nodes.actorInput.value = state.session.actor;
      loadDashboard();
    } else {
      renderSignedOut();
    }

    function readSession() {
      try {
        const parsed = JSON.parse(sessionStorage.getItem(sessionKey) || "null");
        return parsed?.actor && parsed?.token ? parsed : null;
      } catch {
        return null;
      }
    }

    async function loadDashboard() {
      if (!state.session) return renderSignedOut();
      nodes.loginError.classList.add("hidden");
      try {
        const [status, bundle, submissions, reviews] = await Promise.all([
          api("/admin/status"),
          api("/admin/support-bundle?limit=5"),
          api("/submissions?status=pending_review&limit=25"),
          api("/reviews?status=open&limit=25"),
        ]);
        renderDashboard(status.data, bundle.data, submissions, reviews);
      } catch (error) {
        showLoginError(error.message || "Unable to load CoreHub admin status.");
        renderSignedOut(false);
      }
    }

    async function api(path) {
      const response = await fetch("/corehub/api/v2" + path, {
        headers: {
          "accept": "application/json",
          "authorization": "Bearer " + state.session.token,
          "x-corehub-user": state.session.actor,
          "x-corehub-token": state.session.token,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "CoreHub API request failed.");
      return payload;
    }

    function renderSignedOut(clearError = true) {
      nodes.dashboard.classList.add("hidden");
      nodes.loginPanel.classList.remove("hidden");
      nodes.readinessPill.textContent = "signed out";
      nodes.readinessPill.className = "status";
      nodes.sessionLabel.textContent = "Not connected";
      if (clearError) nodes.loginError.classList.add("hidden");
    }

    function renderDashboard(status, bundle, submissions, reviews) {
      nodes.loginPanel.classList.add("hidden");
      nodes.dashboard.classList.remove("hidden");
      nodes.sessionLabel.textContent = state.session.actor;
      const readinessClass = status.readiness.status === "ready" ? "good" : status.status === "degraded" ? "warn" : "bad";
      nodes.readinessPill.textContent = status.readiness.status;
      nodes.readinessPill.className = "status " + readinessClass;
      nodes.metricReadiness.textContent = status.readiness.status;
      nodes.metricStatus.textContent = status.status;
      nodes.metricSubmissions.textContent = String(status.counts.submissions || 0);
      nodes.metricReviews.textContent = String(status.counts.reviews || 0);
      nodes.metricAudit.textContent = status.audit.valid ? "valid" : "invalid";
      nodes.metricAuditCount.textContent = String(status.audit.count || 0) + " events";
      nodes.readinessChecks.innerHTML = status.readiness.checks.map((check) => row(check.id, check.status, check.detail)).join("");
      nodes.supportSummary.innerHTML = [
        row("state store", status.runtime.stateStore.kind, status.runtime.stateStore.table || status.runtime.stateStore.path || "memory"),
        row("object store", status.runtime.objectStore.kind, status.runtime.objectStore.bucket || status.runtime.objectStore.root || "unknown"),
        row("support bundle", bundle.bundle.kind, bundle.bundle.redaction.secretsIncluded ? "contains secrets" : "redacted"),
        row("analytics", String(status.analytics.total || 0), "events"),
        row("retention", status.audit.retention.status, String(status.audit.retention.pruneableCount || 0) + " pruneable"),
      ].join("");
      renderTable(nodes.submissionsTable, submissions.data, (item) => [
        item.submission?.id,
        [item.submission?.packageId, item.submission?.version].filter(Boolean).join("@"),
        item.submission?.publisherHandle,
        item.submission?.status,
        item.submission?.submittedAt,
      ]);
      renderTable(nodes.reviewsTable, reviews.data, (item) => {
        const review = item.moderationReview || item;
        return [
          review.id,
          [review.targetType, review.targetId].filter(Boolean).join(":"),
          review.status,
          review.assignee?.id || "unassigned",
          review.updatedAt || review.createdAt,
        ];
      });
      nodes.submissionCount.textContent = String(submissions.meta?.total ?? submissions.data.length);
      nodes.reviewCount.textContent = String(reviews.meta?.total ?? reviews.data.length);
    }

    function renderTable(target, items, cellsFor) {
      target.innerHTML = (items || []).map((item) => "<tr>" + cellsFor(item).map((cell) => "<td>" + escapeHtml(cell || "-") + "</td>").join("") + "</tr>").join("") || "<tr><td colspan=\\"5\\" class=\\"muted\\">No records</td></tr>";
    }

    function row(label, status, detail) {
      return "<div class=\\"check-row\\"><span>" + escapeHtml(label) + "</span><span><span class=\\"status " + statusClass(status) + "\\">" + escapeHtml(status) + "</span> <span class=\\"muted\\">" + escapeHtml(detail ?? "") + "</span></span></div>";
    }

    function statusClass(value) {
      if (["ready", "ok", "valid", "redacted"].includes(String(value))) return "good";
      if (["missing", "degraded", "attention_required", "held"].includes(String(value))) return "warn";
      if (["fail_closed", "invalid", "blocked", "rejected"].includes(String(value))) return "bad";
      return "";
    }

    function showLoginError(message) {
      nodes.loginError.textContent = message;
      nodes.loginError.classList.remove("hidden");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
  </script>
</body>
</html>`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
