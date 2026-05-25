import { Buffer } from "node:buffer";
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { listCatalogRecords, parseMarketplaceFiltersFromUrl, searchCatalogRecords } from "./corehub.mjs";

const defaultApiBasePath = "/corehub/api/v2";
const defaultPublicBaseUrl = "https://coreblow.com/corehub";
const defaultAuditRetentionDays = 365;
const localStateSchemaVersion = "corehub.local-state.v1";
const signedReadTtlMs = 5 * 60 * 1000;
const defaultSignedReadKeyId = "local-dev";
const defaultSignedReadSecret = "corehub-local-development-signing-secret";
const defaultAdminActorIds = ["github:coreblow-admin", "moderator:corehub"];
const defaultAnalyticsSalt = "corehub-local-analytics-salt";
const githubOidcIssuer = "https://token.actions.githubusercontent.com";
const defaultGitHubOidcAudience = "corehub-publish-token";
const defaultGitHubOidcJwksUrl = "https://token.actions.githubusercontent.com/.well-known/jwks";
const publisherWriteRoles = new Set(["owner", "admin", "maintainer"]);
const adminRoles = new Set(["admin", "moderator"]);
const PUBLISHER_HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const rateLimitBucketStores = new Map();

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
    const tablePrefix = normalizeSqlIdentifier(table, "table");
    const metaTable = `${tablePrefix}_meta`;
    const rowsTable = `${tablePrefix}_rows`;
    const indexesTable = `${tablePrefix}_indexes`;
    super({
      kind: "d1-normalized",
      loadSnapshot: async () => {
        const manifest = await database
          .prepare(`SELECT value FROM ${metaTable} WHERE key = ?1`)
          .bind("manifest")
          .first();
        if (manifest?.value) {
          const snapshot = JSON.parse(manifest.value);
          for (const collection of normalizedD1Collections) snapshot[collection] = [];
          const result = await database
            .prepare(`SELECT collection, value FROM ${rowsTable} ORDER BY collection ASC, position ASC, id ASC`)
            .all();
          for (const row of result?.results ?? []) {
            if (!Array.isArray(snapshot[row.collection])) snapshot[row.collection] = [];
            snapshot[row.collection].push(JSON.parse(row.value));
          }
          return snapshot;
        }
        const row = await database
          .prepare(`SELECT value FROM ${tablePrefix} WHERE key = ?1`)
          .bind(key)
          .first();
        return row?.value ? JSON.parse(row.value) : null;
      },
      saveSnapshot: async (snapshot) => {
        const savedAt = snapshot.savedAt ?? new Date().toISOString();
        const normalized = normalizeCoreHubD1Snapshot(snapshot, savedAt);
        await database.prepare(`DELETE FROM ${indexesTable}`).run();
        await database.prepare(`DELETE FROM ${rowsTable}`).run();
        await database
          .prepare(
            `INSERT INTO ${metaTable} (key, value, updated_at) VALUES (?1, ?2, ?3) ` +
              `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind("manifest", JSON.stringify(normalized.manifest), savedAt)
          .run();
        for (const row of normalized.rows) {
          await database
            .prepare(
              `INSERT INTO ${rowsTable} (collection, id, position, value, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ` +
                `ON CONFLICT(collection, id) DO UPDATE SET position = excluded.position, value = excluded.value, updated_at = excluded.updated_at`,
            )
            .bind(row.collection, row.id, row.position, JSON.stringify(row.value), savedAt)
            .run();
        }
        for (const index of normalized.indexes) {
          await database
            .prepare(
              `INSERT INTO ${indexesTable} (collection, index_name, index_key, row_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ` +
                `ON CONFLICT(collection, index_name, index_key, row_id) DO UPDATE SET updated_at = excluded.updated_at`,
            )
            .bind(index.collection, index.indexName, index.indexKey, index.rowId, savedAt)
            .run();
        }
        await database
          .prepare(
            `INSERT INTO ${tablePrefix} (key, value, updated_at) VALUES (?1, ?2, ?3) ` +
              `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(`${key}:legacy-backup`, JSON.stringify(snapshot), savedAt)
          .run();
      },
    });
    this.database = database;
    this.key = key;
    this.table = tablePrefix;
    this.metaTable = metaTable;
    this.rowsTable = rowsTable;
    this.indexesTable = indexesTable;
  }

  static migrationSql({ table = "corehub_state" } = {}) {
    const tablePrefix = normalizeSqlIdentifier(table, "table");
    const metaTable = `${tablePrefix}_meta`;
    const rowsTable = `${tablePrefix}_rows`;
    const indexesTable = `${tablePrefix}_indexes`;
    return `CREATE TABLE IF NOT EXISTS ${tablePrefix} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${metaTable} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${rowsTable} (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS ${rowsTable}_collection_position
  ON ${rowsTable} (collection, position);

CREATE TABLE IF NOT EXISTS ${indexesTable} (
  collection TEXT NOT NULL,
  index_name TEXT NOT NULL,
  index_key TEXT NOT NULL,
  row_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, index_name, index_key, row_id)
);

CREATE INDEX IF NOT EXISTS ${indexesTable}_lookup
  ON ${indexesTable} (collection, index_name, index_key);`;
  }
}

const normalizedD1Collections = [
  "authSessions",
  "publisherClaims",
  "publisherAccounts",
  "publisherMembers",
  "slots",
  "submissions",
  "reviews",
  "packageVersions",
  "packageSearchDigests",
  "packageReports",
  "packageAppeals",
  "packageScanJobs",
  "trustedPublishers",
  "publishTokens",
  "ownershipTransfers",
  "installEvents",
  "auditEvents",
  "auditCheckpoints",
];

function normalizeCoreHubD1Snapshot(snapshot, savedAt) {
  const manifest = {
    schemaVersion: snapshot.schemaVersion,
    savedAt,
    ...(snapshot.publicBaseUrl ? { publicBaseUrl: snapshot.publicBaseUrl } : {}),
  };
  const rows = [];
  const indexes = [];
  for (const collection of normalizedD1Collections) {
    const items = Array.isArray(snapshot[collection]) ? snapshot[collection] : [];
    items.forEach((item, position) => {
      const id = normalizedD1RowId(collection, item, position);
      rows.push({ collection, id, position, value: item });
      indexes.push(...normalizedD1Indexes(collection, item, id, position));
    });
  }
  return { manifest, rows, indexes };
}

function normalizedD1RowId(collection, item, position) {
  if (collection === "submissions") return item?.submission?.id ?? `submission-${position}`;
  return item?.id ?? `${collection}-${position}`;
}

function normalizedD1Indexes(collection, item, rowId, position) {
  const indexes = [{ collection, indexName: "by_position", indexKey: String(position).padStart(10, "0"), rowId }];
  const push = (indexName, value) => {
    if (value === undefined || value === null || value === "") return;
    indexes.push({ collection, indexName, indexKey: String(value), rowId });
  };

  if (collection === "publisherAccounts") {
    push("by_handle", item.handle);
    push("by_status", item.status);
  } else if (collection === "publisherMembers") {
    push("by_publisher", item.publisherHandle);
    push("by_user", item.userId);
    push("by_publisher_user", item.publisherHandle && item.userId ? `${item.publisherHandle}\u0000${item.userId}` : null);
  } else if (collection === "slots") {
    push("by_package_version", item.packageId && item.version ? `${item.packageId}\u0000${item.version}` : null);
    push("by_publisher", item.publisherHandle);
    push("by_status", item.artifactUpload?.status ?? item.upload?.status);
  } else if (collection === "submissions") {
    push("by_package", item.submission?.packageId);
    push("by_publisher", item.submission?.publisherHandle);
    push("by_status", item.submission?.status);
  } else if (collection === "reviews") {
    push("by_status", item.status);
    push("by_target", item.targetType && item.targetId ? `${item.targetType}\u0000${item.targetId}` : null);
  } else if (collection === "packageVersions") {
    push("by_package", item.packageId);
    push("by_package_version", item.packageId && item.version ? `${item.packageId}\u0000${item.version}` : null);
    push("by_publisher", item.publisherHandle);
    push("by_status", item.status);
    push("by_channel", item.channel);
  } else if (collection === "packageSearchDigests") {
    push("by_package", item.packageId);
    push("by_family", item.family);
    push("by_channel", item.channel);
    push("by_official", item.isOfficial);
    push("by_executes_code", item.executesCode);
    push("by_category", item.category);
    push("by_publisher", item.publisherHandle);
    push("by_scan_status", item.scanStatus);
    push("by_moderation_state", item.moderationState);
    push("by_latest_version", item.latestVersion);
    for (const token of item.capabilityTags ?? []) push("by_capability_tag", token);
    for (const token of item.searchTokens ?? []) push("by_search_token", token);
  } else if (collection === "packageReports") {
    push("by_package", item.packageId);
    push("by_status", item.status);
    push("by_package_version", item.packageId && item.version ? `${item.packageId}\u0000${item.version}` : null);
  } else if (collection === "packageAppeals") {
    push("by_package", item.packageId);
    push("by_status", item.status);
    push("by_package_version", item.packageId && item.version ? `${item.packageId}\u0000${item.version}` : null);
  } else if (collection === "packageScanJobs") {
    push("by_package", item.packageId);
    push("by_package_version", item.packageId && item.version ? `${item.packageId}\u0000${item.version}` : null);
    push("by_status", item.status);
    push("by_scan_status", item.scanStatus);
  } else if (collection === "trustedPublishers") {
    push("by_package", item.packageId);
    push("by_repository", item.repository);
  } else if (collection === "publishTokens") {
    push("by_package", item.packageId);
    push("by_status", item.status);
    push("by_token_hash", item.tokenHash);
  } else if (collection === "ownershipTransfers") {
    push("by_package", item.packageId);
    push("by_status", item.status);
    push("by_from_publisher", item.fromPublisherHandle);
    push("by_to_publisher", item.toPublisherHandle);
  } else if (collection === "installEvents") {
    push("by_package", item.packageId);
    push("by_package_version", item.packageId && item.version ? `${item.packageId}\u0000${item.version}` : null);
    push("by_day", item.day);
    push("by_event", item.event);
  } else if (collection === "auditEvents") {
    push("by_sequence", item.sequence === undefined ? null : String(item.sequence).padStart(10, "0"));
    push("by_action", item.action);
    push("by_target", item.targetType && item.targetId ? `${item.targetType}\u0000${item.targetId}` : null);
  }
  return indexes;
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

export class CoreHubManagedObjectStore {
  constructor({ bucket, bucketName = "COREHUB_MANAGED_OBJECT_STORE" } = {}) {
    if (!bucket || typeof bucket.put !== "function" || typeof bucket.get !== "function") {
      throw new Error("CoreHubManagedObjectStore requires a managed object storage bucket binding");
    }
    this.bucket = bucket;
    this.bucketName = bucketName;
    this.kind = "managed";
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
    throw new Error("managed object body is not readable");
  }
}

export class CoreHubExternalUrlObjectStore {
  constructor() {
    this.kind = "external-url";
  }

  async put() {
    throw httpError(409, "Managed artifact uploads are local-test only; use external artifact URL publishing");
  }

  async get() {
    return null;
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
    githubOidcJwks,
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
    this.githubOidcJwks = githubOidcJwks ?? null;
    this.authSessions = [];
    this.publisherClaims = [];
    this.publisherAccounts = new Map(defaultPublisherAccounts().map((publisher) => [publisher.handle, publisher]));
    this.publisherMembers = defaultPublisherMembers();
    this.slots = new Map();
    this.submissions = new Map();
    this.reviews = new Map();
    this.packageVersions = new Map();
    this.packageSearchDigests = new Map();
    this.packageReports = [];
    this.packageAppeals = [];
    this.packageScanJobs = [];
    this.trustedPublishers = new Map();
    this.publishTokens = new Map();
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
      ...(request.artifact.url ? { url: request.artifact.url } : {}),
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
      status: isExternalArtifactProvider(request.provider) ? "verified" : "requested",
      storage,
      upload,
      mediaType: request.artifact.mediaType,
      size: request.artifact.size,
      sha256: request.artifact.sha256,
      files: request.artifact.files,
      ...(request.artifact.npm ? { npm: request.artifact.npm } : {}),
      uploadedBy: actor,
      createdAt,
      ...(isExternalArtifactProvider(request.provider) ? { verifiedAt: createdAt } : {}),
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
      files: status === "verified" ? await packageArtifactFiles(this, slot.artifactUpload) : slot.artifactUpload.files,
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
    const externalUrl = artifact?.storage?.url;
    if (artifact?.downloadEnabled === false || artifact?.trust?.blockedFromDownload) {
      return {
        available: false,
        blocked: true,
        reason: artifact?.trust?.moderationReason ?? "Package release is blocked by moderation.",
        trust: artifact?.trust ?? null,
      };
    }
    if (!key || !artifact?.sha256 || !Number.isSafeInteger(artifact?.size)) {
      return { available: false, reason: "Artifact storage locator or checksum metadata is incomplete." };
    }
    if (externalUrl && isExternalArtifactProvider(artifact.storage.provider)) {
      this.recordAuditEvent({
        actor,
        action: "artifact.download.external_redirect",
        targetType: "artifact",
        targetId: key,
        metadata: {
          key,
          provider: artifact.storage.provider,
          sha256: artifact.sha256,
          size: artifact.size,
        },
        createdAt: now.toISOString(),
      });
      await this.persistState();
      return {
        available: true,
        method: "GET",
        url: externalUrl,
        redirect: "external-url",
        sha256: artifact.sha256,
        size: artifact.size,
      };
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
    if (artifact.downloadEnabled === false || artifact.trust?.blockedFromDownload) {
      throw httpError(403, artifact.trust?.moderationReason ?? "Package release is blocked by moderation");
    }
    if (isExternalArtifactProvider(artifact.storage?.provider)) {
      throw httpError(400, "External artifact URLs are read directly from their storage URL");
    }
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
    const publishToken = request.publishTokenId ? this.requirePublishToken(request.publishTokenId, request, now) : null;
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
    const trustedPublisher = this.trustedPublishers.get(request.packageId);
    if (trustedPublisher && !publishToken && !request.manualOverrideReason && !this.hasAdminPermission(actor)) {
      throw httpError(403, "Manual publishes for packages with trusted publisher config require manualOverrideReason");
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
      channel: request.channel,
      status: "pending_review",
      artifactUploadId: request.artifactUploadId,
      ...(request.source ? { source: request.source } : {}),
      changelog: request.changelog,
      submittedBy: actor,
      submittedAt,
      reviewId,
      ...(request.publishTokenId ? { publishTokenId: request.publishTokenId } : {}),
      ...(request.manualOverrideReason ? { manualOverrideReason: request.manualOverrideReason } : {}),
    };
    const packageVersionPreview = {
      id: `version-${request.packageId}-${versionSlug}`,
      packageId: request.packageId,
      version: request.version,
      tag: "latest",
      channel: request.channel,
      publisherHandle: request.publisherHandle,
      status: "pending_review",
      artifactUploadId: request.artifactUploadId,
      submissionId: id,
      createdAt: submittedAt,
      moderationStatus: "pending",
    };
    if (request.channel === "official" && !this.hasAdminPermission(actor) && !publishToken) {
      throw httpError(403, "Official channel submissions require admin or trusted publisher token");
    }
    if (publishToken) {
      publishToken.usedAt = submittedAt;
      publishToken.usedBy = actor;
      this.recordAuditEvent({
        actor,
        action: "package.publish_token.use",
        targetType: "publishToken",
        targetId: publishToken.id,
        metadata: {
          packageId: request.packageId,
          version: request.version,
          channel: request.channel,
        },
        createdAt: submittedAt,
      });
    }
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
      softDeletedPackages: this.softDeletedPackageCount(),
      moderatedPackageVersions: this.moderatedPackageVersionCount(),
      packageReports: this.packageReports.length,
      packageAppeals: this.packageAppeals.length,
      packageScanJobs: this.packageScanJobs.length,
      trustedPublishers: this.trustedPublishers.size,
      activePublishTokens: [...this.publishTokens.values()].filter((token) => !token.revokedAt && new Date(token.expiresAt).getTime() > now.getTime()).length,
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
        packageLifecycle: countByStatus([...this.packageVersions.values()].map((version) => (version.softDeletedAt ? "deleted" : "active"))),
        packageReleaseModeration: countByStatus(
          [...this.packageVersions.values()].map((version) => version.manualModeration?.state ?? version.moderationStatus ?? "unknown"),
        ),
        publishTokens: countByStatus([...this.publishTokens.values()].map((token) => token.revokedAt ? "revoked" : "active")),
        packageReports: countByStatus(this.packageReports.map((report) => report.status)),
        packageAppeals: countByStatus(this.packageAppeals.map((appeal) => appeal.status)),
        packageScans: countByStatus(this.packageScanJobs.map((job) => job.status)),
        packageScanResults: countByStatus(this.packageScanJobs.map((job) => job.scanStatus)),
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
        packageLifecycle: latestItems(
          [...this.packageVersions.values()].filter((version) => version.softDeletedAt || version.restoredAt),
          limit,
        ),
        packageReleaseModeration: latestItems(
          [...this.packageVersions.values()].filter((version) => version.manualModeration),
          limit,
        ),
        trustedPublishers: latestItems([...this.trustedPublishers.values()], limit),
        publishTokens: latestItems([...this.publishTokens.values()], limit),
        packageReports: latestItems(this.packageReports, limit),
        packageAppeals: latestItems(this.packageAppeals, limit),
        packageScanJobs: latestItems(this.packageScanJobs, limit),
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

  async setTrustedPublisher(packageId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    const ownerHandle = this.packageOwnerHandle(packageId);
    if (!ownerHandle) throw httpError(404, "Package not found");
    this.requirePackageLifecyclePermission(actor, ownerHandle, "package.trusted_publisher.set");
    const request = normalizeTrustedPublisherRequest(input);
    const configuredAt = now.toISOString();
    const trustedPublisher = {
      id: `trusted-publisher-${slugId(packageId)}`,
      packageId,
      provider: "github-actions",
      repository: request.repository,
      repositoryId: request.repositoryId,
      repositoryOwner: request.repositoryOwner,
      repositoryOwnerId: request.repositoryOwnerId,
      workflowFilename: request.workflowFilename,
      ...(request.environment ? { environment: request.environment } : {}),
      configuredBy: actor,
      configuredAt,
    };
    this.trustedPublishers.set(packageId, trustedPublisher);
    this.recordAuditEvent({
      actor,
      action: "package.trusted_publisher.set",
      targetType: "package",
      targetId: packageId,
      metadata: {
        packageId,
        repository: trustedPublisher.repository,
        workflowFilename: trustedPublisher.workflowFilename,
        environment: trustedPublisher.environment ?? null,
      },
      createdAt: configuredAt,
    });
    await this.persistState();
    return { status: "configured", trustedPublisher };
  }

  getTrustedPublisher(packageId, { actor = defaultActor() } = {}) {
    const trustedPublisher = this.trustedPublishers.get(packageId) ?? null;
    if (!trustedPublisher) return { status: "missing", trustedPublisher: null };
    const ownerHandle = this.packageOwnerHandle(packageId);
    if (ownerHandle && !this.hasAdminPermission(actor) && !this.hasPublisherMembership(actor, ownerHandle)) {
      throw httpError(403, `Actor ${actor.id} cannot package.trusted_publisher.get for package ${packageId}`);
    }
    return { status: "configured", trustedPublisher };
  }

  async deleteTrustedPublisher(packageId, { actor = defaultActor(), now = new Date() } = {}) {
    const ownerHandle = this.packageOwnerHandle(packageId);
    if (!ownerHandle) throw httpError(404, "Package not found");
    this.requirePackageLifecyclePermission(actor, ownerHandle, "package.trusted_publisher.delete");
    const deleted = this.trustedPublishers.delete(packageId);
    const deletedAt = now.toISOString();
    this.recordAuditEvent({
      actor,
      action: "package.trusted_publisher.delete",
      targetType: "package",
      targetId: packageId,
      metadata: { packageId, deleted },
      createdAt: deletedAt,
    });
    await this.persistState();
    return { ok: true, status: deleted ? "deleted" : "missing", packageId };
  }

  async mintPublishToken(packageId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    const trustedPublisher = this.trustedPublishers.get(packageId);
    if (!trustedPublisher) throw httpError(403, "Trusted publisher config is not set for this package");
    const ownerHandle = this.packageOwnerHandle(packageId);
    if (ownerHandle) this.requirePackageLifecyclePermission(actor, ownerHandle, "package.publish_token.mint");
    const request = await resolvePublishTokenMintRequest(input, trustedPublisher, { now, jwks: this.githubOidcJwks });
    const mintedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    const token = `corehub_pub_${randomBytes(24).toString("base64url")}`;
    const id = `publish-token-${slugId(packageId)}-${slugVersion(request.version)}-${String(this.publishTokens.size + 1).padStart(6, "0")}`;
    const publishToken = {
      id,
      packageId,
      version: request.version,
      tokenPrefix: token.slice(0, 18),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      provider: "github-actions",
      repository: request.repository,
      repositoryId: trustedPublisher.repositoryId,
      repositoryOwner: trustedPublisher.repositoryOwner,
      repositoryOwnerId: trustedPublisher.repositoryOwnerId,
      workflowFilename: request.workflowFilename,
      ...(trustedPublisher.environment ? { environment: trustedPublisher.environment } : {}),
      runId: request.runId,
      runAttempt: request.runAttempt,
      sha: request.sha,
      ref: request.ref,
      ...(request.oidc ? { oidc: request.oidc } : {}),
      mintedBy: actor,
      mintedAt,
      expiresAt,
    };
    this.publishTokens.set(id, publishToken);
    this.recordAuditEvent({
      actor,
      action: "package.publish_token.mint",
      targetType: "publishToken",
      targetId: id,
      metadata: {
        packageId,
        version: request.version,
        repository: request.repository,
        workflowFilename: request.workflowFilename,
        runId: request.runId,
        sha: request.sha,
        ref: request.ref,
        oidcVerified: Boolean(request.oidc),
        ...(request.oidc ? { oidc: request.oidc } : {}),
      },
      createdAt: mintedAt,
    });
    await this.persistState();
    return { status: "minted", token, expiresAt, publishToken };
  }

  async revokePublishToken(packageId, tokenId, { actor = defaultActor(), now = new Date() } = {}) {
    const publishToken = this.publishTokens.get(tokenId);
    if (!publishToken || publishToken.packageId !== packageId) throw httpError(404, "Publish token not found");
    const ownerHandle = this.packageOwnerHandle(packageId);
    if (ownerHandle) this.requirePackageLifecyclePermission(actor, ownerHandle, "package.publish_token.revoke");
    publishToken.revokedAt = now.toISOString();
    publishToken.revokedBy = actor;
    this.recordAuditEvent({
      actor,
      action: "package.publish_token.revoke",
      targetType: "publishToken",
      targetId: publishToken.id,
      metadata: { packageId, version: publishToken.version },
      createdAt: publishToken.revokedAt,
    });
    await this.persistState();
    return { ok: true, status: "revoked", publishToken };
  }

  requirePublishToken(tokenId, request, now) {
    const publishToken = this.publishTokens.get(tokenId);
    if (!publishToken) throw httpError(403, "Publish token is not active");
    if (publishToken.revokedAt) throw httpError(403, "Publish token is revoked");
    if (new Date(publishToken.expiresAt).getTime() <= now.getTime()) throw httpError(403, "Publish token is expired");
    if (publishToken.packageId !== request.packageId || publishToken.version !== request.version) {
      throw httpError(403, "Publish token package or version does not match submission");
    }
    const trustedPublisher = this.trustedPublishers.get(request.packageId);
    if (!trustedPublisher || trustedPublisher.repository !== publishToken.repository || trustedPublisher.workflowFilename !== publishToken.workflowFilename) {
      throw httpError(403, "Publish token no longer matches trusted publisher config");
    }
    return publishToken;
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

  async createPackageReport(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizePackageReportRequest(input);
    const version = this.projectedVersionForPackage(request.packageId, request.version ?? "latest");
    if (!version) throw httpError(404, "Package version not found for report");
    const reportedAt = now.toISOString();
    const packageVersion = request.version ?? version.version;
    const report = {
      id: `package-report-${slugId(request.packageId)}-${slugVersion(packageVersion)}-${String(this.packageReports.length + 1).padStart(6, "0")}`,
      packageId: request.packageId,
      version: packageVersion,
      publisherHandle: version.publisherHandle,
      reason: request.reason,
      status: "open",
      reportedBy: actor,
      reportedAt,
    };
    this.packageReports.push(report);
    this.recordAuditEvent({
      actor,
      action: "package.report.create",
      targetType: "packageReport",
      targetId: report.id,
      metadata: {
        packageId: report.packageId,
        version: report.version,
        publisherHandle: report.publisherHandle,
      },
      createdAt: reportedAt,
    });
    await this.persistState();
    return { status: "reported", report };
  }

  listPackageReports(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "package.report.list");
    const status = options.status ?? "open";
    const reports = this.packageReports
      .filter((report) => status === "all" || report.status === status)
      .filter((report) => !options.packageId || report.packageId === options.packageId)
      .sort((left, right) => right.reportedAt.localeCompare(left.reportedAt));
    return paginate(reports, options);
  }

  async triagePackageReport(reportId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "package.report.triage");
    const report = this.packageReports.find((item) => item.id === reportId);
    if (!report) throw httpError(404, "Package report not found");
    const triage = normalizePackageReportTriageRequest(input);
    const triagedAt = now.toISOString();
    report.status = triage.status;
    report.triagedBy = actor;
    report.triagedAt = triagedAt;
    if (triage.note) report.triageNote = triage.note;
    if (triage.finalAction) report.finalAction = triage.finalAction;
    const releaseModeration =
      report.status === "confirmed" && triage.finalAction && triage.finalAction !== "none"
        ? this.applyReleaseModerationForReport(report, triage, { actor, now: triagedAt })
        : null;
    this.recordAuditEvent({
      actor,
      action: "package.report.triage",
      targetType: "packageReport",
      targetId: report.id,
      metadata: {
        packageId: report.packageId,
        version: report.version,
        status: report.status,
        finalAction: report.finalAction ?? null,
        releaseModeration,
      },
      createdAt: triagedAt,
    });
    await this.persistState();
    return { status: report.status, report };
  }

  listPackageModerationQueue(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "package.moderation.queue");
    const status = options.status ?? "open";
    if (!["open", "blocked", "manual", "all"].includes(status)) {
      throw httpError(400, "package moderation queue status must be open, blocked, manual, or all");
    }
    const records = [...this.packageVersions.values()]
      .filter((version) => version.status === "available" && !version.softDeletedAt)
      .map((version) => this.packageModerationQueueItem(version))
      .filter((item) => {
        if (status === "all") return true;
        if (status === "manual") return Boolean(item.manualModeration);
        if (status === "blocked") return item.blockedFromDownload || item.scanStatus === "malicious";
        return item.reasons.length > 0 || item.scanStatus === "suspicious" || item.scanStatus === "malicious";
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.packageId.localeCompare(right.packageId));
    return paginate(records, options);
  }

  packageModerationQueueItem(version) {
    const trust = packageReleaseTrust(version);
    const scan = this.latestPackageScanSummary(version.packageId, version.version);
    const reports = this.packageReports.filter(
      (report) => report.packageId === version.packageId && report.version === version.version && report.status === "open",
    );
    const submission = this.submissions.get(version.submissionId)?.submission;
    const reasons = [...trust.reasons];
    if (scan.scanStatus === "malicious") reasons.push("scan:malicious");
    if (scan.scanStatus === "suspicious") reasons.push("scan:suspicious");
    if (reports.length > 0) reasons.push(`reports:${reports.length}`);
    return {
      packageId: version.packageId,
      name: version.packageId,
      version: version.version,
      publisherHandle: version.publisherHandle,
      family: submission?.kind === "skill" ? "skill" : "code-plugin",
      channel: submission?.channel ?? version.channel ?? "community",
      isOfficial: (submission?.channel ?? version.channel) === "official",
      scanStatus: scan.scanStatus,
      scan,
      moderationState: trust.moderationState,
      moderationReason: trust.moderationReason,
      blockedFromDownload: trust.blockedFromDownload,
      manualModeration: trust.manualModeration,
      reportCount: reports.length,
      reasons,
      updatedAt: version.manualModeration?.moderatedAt ?? version.publishedAt ?? version.createdAt,
    };
  }

  async moderatePackageRelease(packageId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "package.release.moderate");
    const request = normalizePackageReleaseModerationRequest(input);
    const version = this.projectedVersionForPackage(packageId, request.version);
    if (!version) throw httpError(404, "Package version not found for release moderation");
    const moderatedAt = now.toISOString();
    version.manualModeration = {
      state: request.state,
      reason: request.reason,
      moderatedBy: actor,
      moderatedAt,
    };
    version.moderationStatus = request.state;
    version.artifact = version.artifact
      ? { ...version.artifact, downloadEnabled: request.state === "approved" }
      : version.artifact;
    this.recordAuditEvent({
      actor,
      action: "package.release.moderate",
      targetType: "packageVersion",
      targetId: version.id,
      metadata: {
        packageId: version.packageId,
        version: version.version,
        state: request.state,
        direct: true,
      },
      createdAt: moderatedAt,
    });
    await this.persistState();
    return {
      status: "moderated",
      state: request.state,
      scanStatus: this.latestPackageScanSummary(version.packageId, version.version).scanStatus,
      packageVersion: version,
      blockedFromDownload: request.state === "quarantined" || request.state === "revoked",
    };
  }

  applyReleaseModerationForReport(report, triage, { actor, now }) {
    const version = this.packageVersions.get(`version-${report.packageId}-${slugVersion(report.version)}`);
    if (!version || version.status !== "available" || version.softDeletedAt) {
      throw httpError(404, "Package version not found for release moderation");
    }
    const state = triage.finalAction === "quarantine" ? "quarantined" : "revoked";
    const reason = triage.note ?? `Report ${report.id} ${state} this release.`;
    version.manualModeration = {
      state,
      reason,
      reportId: report.id,
      moderatedBy: actor,
      moderatedAt: now,
    };
    version.moderationStatus = state;
    version.artifact = version.artifact ? { ...version.artifact, downloadEnabled: false } : version.artifact;
    this.recordAuditEvent({
      actor,
      action: "package.release.moderate",
      targetType: "packageVersion",
      targetId: version.id,
      metadata: {
        packageId: version.packageId,
        version: version.version,
        state,
        reportId: report.id,
        finalAction: triage.finalAction,
      },
      createdAt: now,
    });
    return { packageVersionId: version.id, state, blockedFromDownload: true };
  }

  async softDeletePackage(packageId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    const versions = this.packageVersionsForPackage(packageId);
    if (versions.length === 0) throw httpError(404, "Package not found");
    const ownerHandle = this.packageOwnerHandle(packageId) ?? versions[0]?.publisherHandle;
    this.requirePackageLifecyclePermission(actor, ownerHandle, "package.delete");
    const deletedAt = now.toISOString();
    const reason = typeof input?.reason === "string" && input.reason.trim().length > 0 ? input.reason.trim() : undefined;
    let changedVersions = 0;
    for (const version of versions) {
      if (version.softDeletedAt) continue;
      version.softDeletedAt = deletedAt;
      version.deletedBy = actor;
      if (reason) version.deleteReason = reason;
      version.artifact = version.artifact ? { ...version.artifact, downloadEnabled: false } : version.artifact;
      changedVersions += 1;
    }
    this.recordAuditEvent({
      actor,
      action: "package.delete",
      targetType: "package",
      targetId: packageId,
      metadata: {
        packageId,
        publisherHandle: ownerHandle,
        versions: versions.length,
        changedVersions,
        reason: reason ?? null,
      },
      createdAt: deletedAt,
    });
    await this.persistState();
    return { ok: true, status: "deleted", packageId, versions: versions.length, changedVersions, deletedAt };
  }

  async undeletePackage(packageId, { actor = defaultActor(), now = new Date() } = {}) {
    const versions = this.packageVersionsForPackage(packageId);
    if (versions.length === 0) throw httpError(404, "Package not found");
    const ownerHandle = this.packageOwnerHandle(packageId) ?? versions[0]?.publisherHandle;
    this.requirePackageLifecyclePermission(actor, ownerHandle, "package.undelete");
    const restoredAt = now.toISOString();
    let changedVersions = 0;
    for (const version of versions) {
      if (!version.softDeletedAt) continue;
      delete version.softDeletedAt;
      delete version.deletedBy;
      delete version.deleteReason;
      version.restoredAt = restoredAt;
      version.restoredBy = actor;
      version.artifact = version.artifact ? { ...version.artifact, downloadEnabled: true } : version.artifact;
      changedVersions += 1;
    }
    this.recordAuditEvent({
      actor,
      action: "package.undelete",
      targetType: "package",
      targetId: packageId,
      metadata: {
        packageId,
        publisherHandle: ownerHandle,
        versions: versions.length,
        changedVersions,
      },
      createdAt: restoredAt,
    });
    await this.persistState();
    return { ok: true, status: "restored", packageId, versions: versions.length, changedVersions, restoredAt };
  }

  async createPackageAppeal(input, { actor = defaultActor(), now = new Date() } = {}) {
    const request = normalizePackageAppealRequest(input);
    const version = this.projectedVersionForPackage(request.packageId, request.version);
    if (!version) throw httpError(404, "Package version not found for appeal");
    this.requirePublisherPermission(actor, version.publisherHandle, "package.appeal.create");
    const appealedAt = now.toISOString();
    const appeal = {
      id: `package-appeal-${slugId(request.packageId)}-${slugVersion(request.version)}-${String(this.packageAppeals.length + 1).padStart(6, "0")}`,
      packageId: request.packageId,
      version: request.version,
      publisherHandle: version.publisherHandle,
      message: request.message,
      status: "open",
      appealedBy: actor,
      appealedAt,
    };
    this.packageAppeals.push(appeal);
    this.recordAuditEvent({
      actor,
      action: "package.appeal.create",
      targetType: "packageAppeal",
      targetId: appeal.id,
      metadata: {
        packageId: appeal.packageId,
        version: appeal.version,
        publisherHandle: appeal.publisherHandle,
      },
      createdAt: appealedAt,
    });
    await this.persistState();
    return { status: "open", appeal };
  }

  listPackageAppeals(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "package.appeal.list");
    const status = options.status ?? "open";
    const appeals = this.packageAppeals
      .filter((appeal) => status === "all" || appeal.status === status)
      .filter((appeal) => !options.packageId || appeal.packageId === options.packageId)
      .sort((left, right) => right.appealedAt.localeCompare(left.appealedAt));
    return paginate(appeals, options);
  }

  async resolvePackageAppeal(appealId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "package.appeal.resolve");
    const appeal = this.packageAppeals.find((item) => item.id === appealId);
    if (!appeal) throw httpError(404, "Package appeal not found");
    const resolution = normalizePackageAppealResolveRequest(input);
    const resolvedAt = now.toISOString();
    appeal.status = resolution.status;
    appeal.resolvedBy = actor;
    appeal.resolvedAt = resolvedAt;
    if (resolution.note) appeal.resolutionNote = resolution.note;
    if (resolution.finalAction) appeal.finalAction = resolution.finalAction;
    this.recordAuditEvent({
      actor,
      action: "package.appeal.resolve",
      targetType: "packageAppeal",
      targetId: appeal.id,
      metadata: {
        packageId: appeal.packageId,
        version: appeal.version,
        status: appeal.status,
        finalAction: appeal.finalAction ?? null,
      },
      createdAt: resolvedAt,
    });
    await this.persistState();
    return { status: appeal.status, appeal };
  }

  listPackageScanJobs(options = {}) {
    this.requireAdminPermission(options.authActor ?? defaultActor(), "package.scan.list");
    const status = options.status ?? "all";
    const jobs = this.packageScanJobs
      .filter((job) => status === "all" || job.status === status)
      .filter((job) => !options.packageId || job.packageId === options.packageId)
      .filter((job) => !options.version || job.version === options.version)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
    return paginate(jobs, options);
  }

  async rescanPackageVersion(packageId, input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "package.scan.rescan");
    const version = this.projectedVersionForPackage(packageId, input.version ?? "latest");
    if (!version) throw httpError(404, "Package version not found for scan");
    const job = this.runStaticPackageScan(version, {
      actor,
      now,
      source: normalizePackageScanSource(input.source ?? "manual"),
      reason: input.reason ?? "Operator requested package rescan.",
    });
    await this.persistState();
    return { status: job.status, job };
  }

  async backfillPackageScans(input = {}, { actor = defaultActor(), now = new Date() } = {}) {
    this.requireAdminPermission(actor, "package.scan.backfill");
    const includeExisting = input.includeExisting === true;
    const packageId = typeof input.packageId === "string" && input.packageId.trim() ? input.packageId.trim() : null;
    const versions = [...this.packageVersions.values()]
      .filter((version) => version.status === "available" && !version.softDeletedAt)
      .filter((version) => !packageId || version.packageId === packageId);
    const jobs = [];
    for (const version of versions) {
      if (!includeExisting && this.latestPackageScanJob(version.packageId, version.version)) continue;
      jobs.push(
        this.runStaticPackageScan(version, {
          actor,
          now,
          source: "backfill",
          reason: input.reason ?? "Backfill missing CoreHub static scan evidence.",
        }),
      );
    }
    await this.persistState();
    return { status: "backfilled", count: jobs.length, jobs };
  }

  runStaticPackageScan(version, { actor, now, source, reason }) {
    const requestedAt = now.toISOString();
    const artifactUpload = this.findArtifactUpload(version.artifactUploadId);
    const evidence = createStaticScanEvidence({ version, artifactUpload, actor, createdAt: requestedAt });
    const scanStatus = evidence.some((item) => item.severity === "high" || item.severity === "critical")
      ? "malicious"
      : evidence.some((item) => item.severity === "medium")
        ? "suspicious"
        : "clean";
    const job = {
      id: `scan-${slugId(version.packageId)}-${slugVersion(version.version)}-${String(this.packageScanJobs.length + 1).padStart(6, "0")}`,
      packageId: version.packageId,
      version: version.version,
      packageVersionId: version.id,
      artifactUploadId: version.artifactUploadId,
      scanner: "corehub-static",
      source,
      status: "completed",
      scanStatus,
      reason,
      requestedBy: actor,
      requestedAt,
      startedAt: requestedAt,
      completedAt: requestedAt,
      evidence,
    };
    this.packageScanJobs.push(job);
    version.scanStatus = scanStatus;
    version.latestScanJobId = job.id;
    version.scannedAt = requestedAt;
    this.recordAuditEvent({
      actor,
      action: "package.scan.complete",
      targetType: "packageScanJob",
      targetId: job.id,
      metadata: {
        packageId: job.packageId,
        version: job.version,
        scanner: job.scanner,
        source: job.source,
        scanStatus: job.scanStatus,
        evidenceCount: job.evidence.length,
      },
      createdAt: requestedAt,
    });
    return job;
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

  publisherDashboard(actor = defaultActor()) {
    const identity = this.publisherIdentity(actor);
    const handles = new Set(identity.memberships.map((membership) => membership.publisherHandle));
    const packages = this.projectCatalogEntries()
      .filter((entry) => handles.has(entry.publisher?.handle))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        version: entry.version,
        publisher: entry.publisher,
        marketplace: entry.marketplace,
        review: entry.review,
        latestVersion: entry.versions?.[0] ?? null,
        trustedPublisher: this.trustedPublishers.get(entry.id) ?? null,
      }));
    const submissions = [...this.submissions.values()]
      .filter((record) => handles.has(record.submission.publisherHandle))
      .map((record) => this.submissionInspection(record))
      .sort((left, right) => right.submission.submittedAt.localeCompare(left.submission.submittedAt));
    const transfers = [...this.ownershipTransfers.values()]
      .filter((transfer) => handles.has(transfer.fromPublisherHandle) || handles.has(transfer.toPublisherHandle))
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
    const uploadSlots = [...this.slots.values()]
      .filter((slot) => handles.has(slot.publisherHandle))
      .map((slot) => ({
        id: slot.id,
        packageId: slot.packageId,
        version: slot.version,
        publisherHandle: slot.publisherHandle,
        status: slot.artifactUpload.status,
        artifactUploadId: slot.artifactUpload.id,
        createdAt: slot.artifactUpload.createdAt,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      identity,
      packages,
      submissions,
      transfers,
      uploadSlots,
      counts: {
        publishers: handles.size,
        packages: packages.length,
        submissions: submissions.length,
        pendingSubmissions: submissions.filter((item) => item.submission.status === "pending_review").length,
        transfers: transfers.length,
        uploadSlots: uploadSlots.length,
      },
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

  claimPublisher(body, { actor, now }) {
    const handle = String(body.handle ?? "").trim().toLowerCase();
    if (!handle) throw httpError(400, "Publisher handle is required");
    if (!PUBLISHER_HANDLE_RE.test(handle)) {
      throw httpError(400, "Handle must be lowercase kebab-case, 2-40 characters");
    }

    const existing = this.publisherAccounts.get(handle);
    if (existing) {
      return { status: "already_claimed", publisher: existing };
    }

    const claimId = `claim-${handle}`;
    const claim = {
      id: claimId,
      handle,
      displayName: (body.displayName || "").trim() || handle,
      kind: body.kind || "organization",
      status: "pending",
      source: body.source || `https://github.com/${handle}`,
      contact: body.contact || `https://github.com/${handle}`,
      requestedBy: actor,
      requestedAt: now.toISOString(),
    };
    this.publisherClaims.push(claim);

    const publisherId = `publisher-${handle}`;
    const publisher = {
      id: publisherId,
      handle,
      displayName: claim.displayName,
      kind: claim.kind,
      status: "pending",
      source: claim.source,
      contact: claim.contact,
      createdAt: now.toISOString(),
    };
    this.publisherAccounts.set(handle, publisher);

    const memberId = `member-${handle}-${actor.id.replace(/[^a-zA-Z0-9]/g, "-")}`;
    const membership = {
      id: memberId,
      publisherHandle: handle,
      userId: actor.id,
      role: "owner",
      status: "active",
      createdAt: now.toISOString(),
    };
    this.publisherMembers.push(membership);

    this.recordAuditEvent({
      actor,
      action: "publisher.claim",
      targetType: "publisher",
      targetId: handle,
      metadata: { claimId, kind: claim.kind },
      createdAt: now.toISOString(),
    });

    return { status: "claimed", claim, publisher, membership };
  }

  verifyPublisher(handle, { actor, now }) {
    this.requireAdminPermission(actor, "publisher.verify");
    const publisher = this.publisherAccounts.get(handle);
    if (!publisher) throw httpError(404, `Publisher ${handle} not found`);
    if (publisher.status === "verified") {
      return { status: "already_verified", publisher };
    }
    
    publisher.status = "verified";
    publisher.verifiedAt = now.toISOString();
    
    const claim = this.publisherClaims.find((c) => c.handle === handle);
    if (claim) claim.status = "approved";
    
    this.recordAuditEvent({
      actor,
      action: "publisher.verify",
      targetType: "publisher",
      targetId: handle,
      metadata: {},
      createdAt: now.toISOString(),
    });
    
    return { status: "verified", publisher };
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

  requirePackageLifecyclePermission(actor, publisherHandle, action) {
    if (this.hasAdminPermission(actor)) return;
    this.requirePublisherPermission(actor, publisherHandle, action);
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

  packageVersionsForPackage(packageId) {
    return [...this.packageVersions.values()]
      .filter((version) => version.packageId === packageId)
      .sort((left, right) => (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt));
  }

  softDeletedPackageCount() {
    const packageIds = new Set();
    for (const version of this.packageVersions.values()) {
      if (version.softDeletedAt) packageIds.add(version.packageId);
    }
    return packageIds.size;
  }

  moderatedPackageVersionCount() {
    return [...this.packageVersions.values()].filter((version) => version.manualModeration).length;
  }

  projectedVersionForPackage(packageId, version) {
    const versions = [...this.packageVersions.values()]
      .filter((item) => item.packageId === packageId && item.status === "available")
      .filter((item) => !item.softDeletedAt)
      .filter((item) => item.version === version || (version === "latest" && (item.tag === "latest" || !item.tag)))
      .sort((left, right) => (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt));
    return versions.at(0) ?? null;
  }

  latestPackageScanJob(packageId, version) {
    return this.packageScanJobs
      .filter((job) => job.packageId === packageId && job.version === version)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
      .at(0) ?? null;
  }

  latestPackageScanSummary(packageId, version) {
    const job = this.latestPackageScanJob(packageId, version);
    return job
      ? {
          scanner: job.scanner,
          status: job.status,
          scanStatus: job.scanStatus,
          jobId: job.id,
          completedAt: job.completedAt ?? null,
          evidenceCount: job.evidence?.length ?? 0,
        }
      : {
          scanner: "corehub-static",
          status: "missing",
          scanStatus: "pending",
          jobId: null,
          completedAt: null,
          evidenceCount: 0,
        };
  }

  latestPackageScanTrust(packageId, version) {
    const summary = this.latestPackageScanSummary(packageId, version);
    return {
      scanStatus: summary.scanStatus,
      scanner: summary.scanner,
      status: summary.status,
      jobId: summary.jobId,
      pending: summary.status === "missing" || summary.status === "queued" || summary.status === "running",
      stale: false,
    };
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
      if (version.softDeletedAt) continue;
      const submissionRecord = this.submissions.get(version.submissionId);
      if (!submissionRecord) continue;
      const artifactUpload = this.findArtifactUpload(version.artifactUploadId);
      if (!artifactUpload || artifactUpload.status !== "verified") continue;
      const trust = packageReleaseTrust(version);
      const submission = submissionRecord.submission;
      const source = submission.source ?? `https://github.com/${version.publisherHandle}/${version.packageId}`;
      const installStats = this.installEvents.filter((event) => event.packageId === version.packageId);
      const artifact = createProjectedArtifactMetadata({
        artifactUpload,
        packageId: version.packageId,
        version: version.version,
        kind: submission.kind,
        source,
        trust,
        security: this.latestPackageScanTrust(version.packageId, version.version),
      });
      const capabilitySummary = createPackageCapabilitySummary({
        kind: submission.kind,
        artifact,
        platforms: ["linux", "macos", "windows"],
      });
      entries.push({
        id: version.packageId,
        kind: submission.kind,
        name: titleizeHandle(version.packageId),
        summary: `CoreHub projected ${submission.kind} package ${version.packageId}.`,
        source,
        homepage: source,
        version: version.version,
        tags: [submission.kind, "published"],
        capabilities: capabilitySummary.capabilityTags,
        stats: {
          installs: installStats.filter((event) => event.event === "installed").length,
          downloads: installStats.filter((event) => event.event === "downloaded").length,
        },
        marketplace: {
          family: submission.kind === "skill" ? "skill" : "code-plugin",
          channel: submission.channel ?? version.channel ?? "community",
          isOfficial: (submission.channel ?? version.channel) === "official",
          featured: false,
          executesCode: submission.kind === "plugin",
          category: "dev-tools",
          capabilityTags: capabilitySummary.capabilityTags,
        },
        scanner: this.latestPackageScanSummary(version.packageId, version.version),
        publisher: {
          handle: version.publisherHandle,
          displayName: titleizeHandle(version.publisherHandle),
          url: `https://github.com/${version.publisherHandle}`,
          verified: true,
        },
        trustedPublisher: this.trustedPublishers.get(version.packageId) ?? null,
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
            moderationState: trust.moderationState,
            capabilities: capabilitySummary,
            compatibility: createPackageCompatibilitySummary(),
            verification: createPackageVerificationSummary({ source, scanStatus: artifact.security.scanStatus }),
            artifact,
          },
        ],
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  rebuildPackageSearchDigests({ updatedAt } = {}) {
    const next = new Map();
    for (const entry of this.projectCatalogEntries()) {
      const digest = createPackageSearchDigest(entry, { updatedAt });
      next.set(digest.id, digest);
    }
    this.packageSearchDigests = next;
    return [...next.values()].sort((left, right) => left.packageId.localeCompare(right.packageId));
  }

  packageSearchEntries() {
    this.rebuildPackageSearchDigests();
    const entries = [...this.packageSearchDigests.values()].map(packageSearchDigestToEntry).filter(Boolean);
    return entries.length > 0 ? entries.sort((a, b) => a.id.localeCompare(b.id)) : this.projectCatalogEntries();
  }

  snapshotState({ savedAt = new Date().toISOString() } = {}) {
    this.rebuildPackageSearchDigests({ updatedAt: savedAt });
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
      packageSearchDigests: [...this.packageSearchDigests.values()],
      packageReports: this.packageReports,
      packageAppeals: this.packageAppeals,
      packageScanJobs: this.packageScanJobs,
      trustedPublishers: [...this.trustedPublishers.values()],
      publishTokens: [...this.publishTokens.values()],
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
    this.packageSearchDigests = new Map((state.packageSearchDigests ?? []).map((digest) => [digest.id, digest]));
    this.packageReports = state.packageReports ?? [];
    this.packageAppeals = state.packageAppeals ?? [];
    this.packageScanJobs = state.packageScanJobs ?? [];
    this.trustedPublishers = new Map((state.trustedPublishers ?? []).map((trustedPublisher) => [trustedPublisher.packageId, trustedPublisher]));
    this.publishTokens = new Map((state.publishTokens ?? []).map((token) => [token.id, token]));
    this.ownershipTransfers = new Map((state.ownershipTransfers ?? []).map((transfer) => [transfer.id, transfer]));
    this.installEvents = state.installEvents ?? [];
    this.auditEvents = state.auditEvents ?? [];
    this.auditCheckpoints = state.auditCheckpoints ?? [];
    if (this.packageSearchDigests.size === 0) this.rebuildPackageSearchDigests();
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
  rateLimit,
  sessionTokens,
} = {}) {
  if (!storage) throw new Error("createCoreHubApiHandler requires storage");
  const limiter = createRateLimiter(rateLimit);
  const sessionAuth = createSessionAuth(sessionTokens);
  return async function coreHubApiHandler(request, response) {
    let errorMode = "v2";
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      errorMode = errorModeForPath(url.pathname, basePath);
      const rateLimitResult = limiter?.check(request, now());
      if (rateLimitResult) applyRateLimitHeaders(response, rateLimitResult);
      if (rateLimitResult?.limited) {
        response.setHeader("Retry-After", String(rateLimitResult.retryAfterSeconds));
        return sendError(response, 429, "Rate limit exceeded", { mode: errorMode, retryAfterSeconds: rateLimitResult.retryAfterSeconds });
      }
      if (request.method === "GET" && ["/corehub/admin", "/corehub/admin/"].includes(url.pathname)) {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html;charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(renderCoreHubAdminHtml());
        return;
      }

      if (request.method === "GET" && ["/corehub/publisher", "/corehub/publisher/"].includes(url.pathname)) {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html;charset=UTF-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(renderCoreHubPublisherHtml());
        return;
      }

      const npmSegments = trimBasePath(url.pathname, "/corehub/api/npm");
      if (npmSegments) {
        const result = await handleNpmMirror(storage, request, url, npmSegments, {
          actor: actorFromRequest(request, storage),
          now: now(),
        });
        if (result) return sendApiResult(response, result);
      }

      const v1Segments = trimBasePath(url.pathname, "/corehub/api/v1");
      if (v1Segments) {
        const result = await handleProjectedRegistryV1(storage, request, url, v1Segments, {
          actor: actorFromRequest(request, storage),
          now: now(),
        });
        if (result) return sendApiResult(response, result);
      }

      const segments = trimBasePath(url.pathname, basePath);
      if (!segments) return sendError(response, 404, "Not found", { mode: errorMode });

      if (request.method === "GET" && segments[0] === "session" && segments[1] === "validate" && segments.length === 2) {
        const result = validateSessionRequest(storage, request, url.searchParams.get("role") ?? "publisher", sessionAuth);
        await storage.auditRead({
          actor: result.actor,
          action: "session.validate",
          targetType: "session",
          targetId: result.role,
          metadata: {
            tokenType: result.token.type,
            admin: result.permissions.admin,
            membershipCount: result.memberships.length,
          },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "publishers" && segments[1] === "me" && segments.length === 2) {
        const actor = actorFromRequest(request, storage);
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

      if (request.method === "GET" && segments[0] === "publisher" && segments[1] === "dashboard" && segments.length === 2) {
        const actor = actorFromRequest(request, storage);
        const result = storage.publisherDashboard(actor);
        await storage.auditRead({
          actor,
          action: "publisher.dashboard",
          targetType: "publisher",
          targetId: result.identity.defaultPublisher?.handle ?? actor.id,
          metadata: {
            packageCount: result.packages.length,
            submissionCount: result.submissions.length,
            transferCount: result.transfers.length,
          },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "publishers" && segments.length === 1) {
        const actor = actorFromRequest(request, storage);
        storage.requireAdminPermission(actor, "publisher.list");
        const result = Array.from(storage.publisherAccounts.values());
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "publishers" && segments[1] === "claim" && segments.length === 2) {
        const actor = actorFromRequest(request, storage);
        const body = await readJsonBody(request);
        const result = storage.claimPublisher(body, { actor, now: now() });
        return json(response, result.status === "already_claimed" ? 200 : 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "publishers" && segments[2] === "verify" && segments.length === 3) {
        const actor = actorFromRequest(request, storage);
        const handle = decodeURIComponent(segments[1]);
        const result = storage.verifyPublisher(handle, { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "admin" && ["status", "health"].includes(segments[1]) && segments.length === 2) {
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
        const uploadSlot = await storage.requestUploadSlot(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: { uploadSlot } });
      }

      if (request.method === "POST" && segments.join("/") === "submissions") {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.createSubmission(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "package-reports" && segments.length === 1) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.createPackageReport(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "package-reports" && segments.length === 1) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request, storage);
        options.authActor = actor;
        options.status = url.searchParams.get("status") ?? "open";
        options.packageId = url.searchParams.get("package") ?? undefined;
        const result = storage.listPackageReports(options);
        await storage.auditRead({
          actor,
          action: "package.report.list",
          targetType: "packageReport",
          targetId: options.status === "all" ? "all" : `status:${options.status}`,
          metadata: { total: result.meta.total },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (
        request.method === "POST" &&
        segments[0] === "package-reports" &&
        segments[2] === "triage" &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.triagePackageReport(decodeURIComponent(segments[1]), body, { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "package-moderation" && segments[1] === "queue" && segments.length === 2) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request, storage);
        options.authActor = actor;
        options.status = url.searchParams.get("status") ?? "open";
        const result = storage.listPackageModerationQueue(options);
        await storage.auditRead({
          actor,
          action: "package.moderation.queue",
          targetType: "packageVersion",
          targetId: options.status,
          metadata: { total: result.meta.total },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (
        request.method === "POST" &&
        segments[0] === "packages" &&
        segments[2] === "versions" &&
        segments[4] === "moderation" &&
        segments.length === 5
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.moderatePackageRelease(
          decodeURIComponent(segments[1]),
          { ...body, version: decodeURIComponent(segments[3]) },
          { actor, now: now() },
        );
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "package-appeals" && segments.length === 1) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.createPackageAppeal(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "package-appeals" && segments.length === 1) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request, storage);
        options.authActor = actor;
        options.status = url.searchParams.get("status") ?? "open";
        options.packageId = url.searchParams.get("package") ?? undefined;
        const result = storage.listPackageAppeals(options);
        await storage.auditRead({
          actor,
          action: "package.appeal.list",
          targetType: "packageAppeal",
          targetId: options.status === "all" ? "all" : `status:${options.status}`,
          metadata: { total: result.meta.total },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (
        request.method === "POST" &&
        segments[0] === "package-appeals" &&
        segments[2] === "resolve" &&
        segments.length === 3
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.resolvePackageAppeal(decodeURIComponent(segments[1]), body, { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "DELETE" && segments[0] === "packages" && segments.length === 2) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.softDeletePackage(decodeURIComponent(segments[1]), body, { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "packages" && segments[2] === "undelete" && segments.length === 3) {
        const actor = actorFromRequest(request, storage);
        const result = await storage.undeletePackage(decodeURIComponent(segments[1]), { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (segments[0] === "packages" && segments[2] === "trusted-publisher" && segments.length === 3) {
        const actor = actorFromRequest(request, storage);
        const packageId = decodeURIComponent(segments[1]);
        if (request.method === "GET") {
          const result = storage.getTrustedPublisher(packageId, { actor });
          return json(response, 200, { apiVersion: "v2", data: result });
        }
        if (request.method === "PUT") {
          const body = await readJsonBody(request);
          const result = await storage.setTrustedPublisher(packageId, body, { actor, now: now() });
          return json(response, 200, { apiVersion: "v2", data: result });
        }
        if (request.method === "DELETE") {
          const result = await storage.deleteTrustedPublisher(packageId, { actor, now: now() });
          return json(response, 200, { apiVersion: "v2", data: result });
        }
      }

      if (request.method === "POST" && segments[0] === "packages" && segments[2] === "publish-tokens" && segments.length === 3) {
        const actor = actorFromRequest(request, storage);
        const body = await readJsonBody(request);
        const result = await storage.mintPublishToken(decodeURIComponent(segments[1]), body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "packages" &&
        segments[2] === "publish-tokens" &&
        segments[4] === "revoke" &&
        segments.length === 5
      ) {
        const actor = actorFromRequest(request, storage);
        const result = await storage.revokePublishToken(decodeURIComponent(segments[1]), decodeURIComponent(segments[3]), {
          actor,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "submissions" && segments.length === 1) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
        const result = await storage.requestOwnershipTransfer(body, { actor, now: now() });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "transfers" && segments.length === 1) {
        const options = readListOptions(url);
        options.packageId = url.searchParams.get("package") ?? undefined;
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
        const result = await storage.decideOwnershipTransfer(decodeURIComponent(segments[1]), segments[2], body, {
          actor,
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "POST" && segments[0] === "install-events" && segments.length === 1) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.recordInstallEvent(body, {
          actor,
          now: now(),
        });
        return json(response, 201, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "install-events" && segments[1] === "summary" && segments.length === 2) {
        const actor = actorFromRequest(request, storage);
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

      if (request.method === "GET" && segments[0] === "package-scans" && segments.length === 1) {
        const options = readListOptions(url);
        const actor = actorFromRequest(request, storage);
        options.authActor = actor;
        options.status = url.searchParams.get("status") ?? "all";
        options.packageId = url.searchParams.get("package") ?? undefined;
        options.version = url.searchParams.get("version") ?? undefined;
        const result = storage.listPackageScanJobs(options);
        await storage.auditRead({
          actor,
          action: "package.scan.list",
          targetType: "packageScanJob",
          targetId: options.packageId ?? options.status,
          metadata: { total: result.meta.total },
          now: now(),
        });
        return json(response, 200, { apiVersion: "v2", data: result.items, meta: result.meta });
      }

      if (request.method === "POST" && segments[0] === "package-scans" && segments[1] === "backfill" && segments.length === 2) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.backfillPackageScans(body, { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (
        request.method === "POST" &&
        segments[0] === "packages" &&
        segments[2] === "scans" &&
        segments[3] === "rescan" &&
        segments.length === 4
      ) {
        const body = await readJsonBody(request);
        const actor = actorFromRequest(request, storage);
        const result = await storage.rescanPackageVersion(decodeURIComponent(segments[1]), body, { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      if (request.method === "GET" && segments[0] === "audit" && segments[1] === "events" && segments.length === 2) {
        const options = readAuditListOptions(url);
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
          actor: actorFromRequest(request, storage),
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
        const actor = actorFromRequest(request, storage);
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
          actor: actorFromRequest(request, storage),
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
        const actor = actorFromRequest(request, storage);
        const result = await storage.verifyUpload(decodeURIComponent(segments[2]), { actor, now: now() });
        return json(response, 200, { apiVersion: "v2", data: result });
      }

      return sendError(response, 404, "Not found", { mode: errorMode });
    } catch (error) {
      return sendError(response, error.statusCode ?? 500, error instanceof Error ? error.message : "CoreHub API error", {
        mode: errorMode,
        code: error.code,
        details: error.details,
      });
    }
  };
}

function errorModeForPath(pathname, basePath) {
  if (trimBasePath(pathname, "/corehub/api/v1") || trimBasePath(pathname, "/corehub/api/npm")) return "public-v1";
  if (trimBasePath(pathname, basePath)) return "v2";
  return "v2";
}

async function handleProjectedRegistryV1(storage, request, url, segments, { actor = defaultActor(), now = new Date() } = {}) {
  if (request.method !== "GET") return null;
  const entries = storage.packageSearchEntries();
  const visibleEntries = entries.filter((entry) => canViewProjectedEntry(storage, actor, entry));
  const baseUrl = requestBaseUrl(request, url);

  if (segments.length === 0) {
    return dataResponse({
      name: "CoreHub Registry API",
      entries: "/corehub/api/v1/entries",
      packages: "/corehub/api/v1/packages",
    });
  }

  if (segments[0] === "catalog" && segments.length === 1) return dataResponse(visibleEntries, visibleEntries.length);
  if (segments[0] === "entries" && segments.length === 1) {
    const filtered = listCatalogRecords(visibleEntries, parseMarketplaceFiltersFromUrl(url));
    return paginatedDataResponse(filtered, url);
  }
  if (segments[0] === "entries" && segments.length === 2) {
    const entry = findProjectedEntry(visibleEntries, segments[1]);
    return entry ? dataResponse(entry) : dataResponse(null, 0, 404);
  }
  if (segments[0] === "search" && segments.length === 1) {
    const query = url.searchParams.get("q") ?? "";
    const results = searchCatalogRecords(visibleEntries, query, {
      ...parseMarketplaceFiltersFromUrl(url),
      limit: Number.MAX_SAFE_INTEGER,
    });
    return paginatedDataResponse(results, url, results.length > 0 || query.trim().length > 0 ? 200 : 400);
  }
  if (segments[0] === "download" && segments.length === 1) {
    const entry = findProjectedEntry(visibleEntries, url.searchParams.get("id"));
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
  if (segments[0] === "packages" && segments.length === 1) {
    const filtered = listCatalogRecords(visibleEntries, parseMarketplaceFiltersFromUrl(url));
    return paginatedDataResponse(filtered, url);
  }
  if (segments[0] === "packages" && segments[1] === "search" && segments.length === 2) {
    const query = url.searchParams.get("q") ?? "";
    const results = searchCatalogRecords(visibleEntries, query, {
      ...parseMarketplaceFiltersFromUrl(url),
      limit: Number.MAX_SAFE_INTEGER,
    });
    return paginatedDataResponse(results, url);
  }
  if (segments[0] === "plugins" && segments.length === 1) {
    const filtered = listCatalogRecords(visibleEntries, parseMarketplaceFiltersFromUrl(url, { pluginOnly: true }));
    return paginatedDataResponse(filtered, url);
  }
  if (segments[0] === "plugins" && segments[1] === "search" && segments.length === 2) {
    const query = url.searchParams.get("q") ?? "";
    const results = searchCatalogRecords(visibleEntries, query, {
      ...parseMarketplaceFiltersFromUrl(url, { pluginOnly: true }),
      limit: Number.MAX_SAFE_INTEGER,
    });
    return paginatedDataResponse(results, url);
  }
  if (segments[0] === "code-plugins" && segments.length === 1) {
    const filtered = listCatalogRecords(visibleEntries, parseMarketplaceFiltersFromUrl(url, { family: "code-plugin" }));
    return paginatedDataResponse(filtered, url);
  }
  if (segments[0] === "bundle-plugins" && segments.length === 1) {
    const filtered = listCatalogRecords(visibleEntries, parseMarketplaceFiltersFromUrl(url, { family: "bundle-plugin" }));
    return paginatedDataResponse(filtered, url);
  }
  if (segments[0] === "packages" && segments.length >= 2) {
    const entry = findProjectedEntry(visibleEntries, segments[1]);
    if (!entry) return dataResponse(null, 0, 404);
    if (segments.length === 2) return dataResponse(entry);
    if (segments[2] === "versions" && segments.length === 3) return paginatedDataResponse(entry.versions, url);
    if (segments[2] === "versions" && segments[4] === "security" && segments.length === 5) {
      const version = findProjectedVersion(entry, segments[3]);
      return version ? dataResponse(createPackageSecuritySummary(entry, version)) : dataResponse(null, 0, 404);
    }
    if (segments[2] === "files" && segments.length === 3) {
      const version = selectPackageVersionForRead(entry, url);
      if (!version) return dataResponse(null, 0, 404);
      const files = await packageArtifactFiles(storage, version.artifact);
      return dataResponse({
        package: { id: entry.id, kind: entry.kind, name: entry.name },
        version: version.version,
        files,
      });
    }
    if (segments[2] === "file" && segments.length === 3) {
      return packageFileResponse(storage, entry, url);
    }
    if (segments[2] === "scan" && segments.length === 3) return dataResponse(createPackageScanStatus(entry, url));
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

async function handleNpmMirror(storage, request, url, segments, { actor = defaultActor(), now = new Date() } = {}) {
  if (request.method !== "GET") return null;
  const parsed = parseNpmMirrorSegments(segments);
  if (!parsed) return null;
  const entries = storage.projectCatalogEntries();
  const visibleEntries = entries.filter((entry) => canViewProjectedEntry(storage, actor, entry));
  const entry = findNpmMirrorEntry(visibleEntries, parsed.packageName);
  if (!entry) return npmErrorResponse("Package not found", 404);
  if (parsed.kind === "packument") {
    const packument = createNpmPackument(request, entry);
    if (Object.keys(packument.versions).length === 0) return npmErrorResponse("Package has no npm-compatible versions", 404);
    return {
      statusCode: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
      },
      payload: packument,
    };
  }
  const version = findVersionForTarball(entry, parsed.tarballName);
  if (!version) return npmErrorResponse("Package tarball not found", 404);
  const artifact = version.artifact;
  if (artifact?.downloadEnabled === false || artifact?.trust?.blockedFromDownload) {
    return npmErrorResponse(artifact?.trust?.moderationReason ?? "Package release is blocked by moderation.", 403);
  }
  const download = await storage.createArtifactDownload(artifact, {
    actor,
    baseUrl: requestBaseUrl(request, url),
    now,
  });
  if (!download.available) return npmErrorResponse(download.reason ?? "Package tarball is unavailable", download.blocked ? 403 : 404);
  return {
    statusCode: 302,
    headers: {
      Location: download.url,
      "Content-Type": artifact.mediaType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${npmTarballName(entry, version)}"`,
      "X-CoreHub-Artifact-SHA256": artifact.sha256,
      ...(npmIntegrity(artifact) ? { "X-CoreHub-NPM-Integrity": npmIntegrity(artifact) } : {}),
      ...(npmShasum(artifact) ? { "X-CoreHub-NPM-Shasum": npmShasum(artifact) } : {}),
    },
    body: "",
  };
}

async function projectedDownloadResponse(storage, request, url, entry, { actor, baseUrl, now }) {
  const version = entry.versions.find((item) => item.tag === "latest") ?? entry.versions[0];
  if (version.artifact?.downloadEnabled === false || version.artifact?.trust?.blockedFromDownload) {
    return textResponse(version.artifact?.trust?.moderationReason ?? "Package release is blocked by moderation.", 403);
  }
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

async function packageFileResponse(storage, entry, url) {
  const version = selectPackageVersionForRead(entry, url);
  if (!version) return textResponse("Package version not found", 404);
  const artifact = version.artifact;
  if (artifact?.downloadEnabled === false || artifact?.trust?.blockedFromDownload) {
    return textResponse(artifact?.trust?.moderationReason ?? "Package release is blocked by moderation.", 403);
  }
  const requestedPath = normalizePackageFilePath(url.searchParams.get("path"));
  if (isExternalArtifactProvider(artifact?.storage?.provider)) {
    return textResponse("Package file reads require managed artifact bytes", 409);
  }
  const files = await packageArtifactFiles(storage, artifact);
  const manifestFile = files.find((file) => normalizePackageFilePath(file.path) === requestedPath);
  if (!manifestFile) return textResponse("Package file not found", 404);
  if (!Number.isSafeInteger(manifestFile.size) || manifestFile.size > 200 * 1024) {
    return textResponse("Package file is too large to read through the public file endpoint", 413);
  }
  const key = artifact?.storage?.key;
  if (!key) return textResponse("Package artifact storage key is missing", 404);
  const archive = await storage.objectStore.get(key);
  if (!archive) return textResponse("Package artifact object not found", 404);
  const content = readTarGzTextFile(archive, requestedPath, manifestFile);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Cache-Control": "public, max-age=60",
      "X-CoreHub-Package-File": requestedPath,
      "X-CoreHub-Package-Version": version.version,
      "X-CoreHub-File-SHA256": manifestFile.sha256,
    },
    body: content,
  };
}

async function packageArtifactFiles(storage, artifact) {
  if (Array.isArray(artifact?.files) && artifact.files.length > 0) return artifact.files;
  if (isExternalArtifactProvider(artifact?.storage?.provider)) return [];
  const key = artifact?.storage?.key;
  if (!key) return [];
  const archive = await storage.objectStore.get(key);
  if (!archive) return [];
  return listTarGzFiles(archive);
}

function listTarGzFiles(archive) {
  const tar = gunzipSync(archive);
  const files = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = normalizePackageFilePath(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const typeflag = readTarString(header, 156, 1);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (typeflag === "" || typeflag === "0") {
      const bytes = tar.subarray(dataStart, dataEnd);
      files.push({
        path,
        size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readTarGzTextFile(archive, requestedPath, manifestFile) {
  const tar = gunzipSync(archive);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = normalizePackageFilePath(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const typeflag = readTarString(header, 156, 1);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (path === requestedPath && (typeflag === "" || typeflag === "0")) {
      const bytes = tar.subarray(dataStart, dataEnd);
      if (bytes.length !== manifestFile.size) throw httpError(409, "Package file size does not match artifact manifest");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== manifestFile.sha256) throw httpError(409, "Package file checksum does not match artifact manifest");
      const text = bytes.toString("utf8");
      if (text.includes("\uFFFD") || bytes.includes(0)) throw httpError(415, "Package file is not UTF-8 text");
      return text;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw httpError(404, "Package file not found in artifact");
}

function readTarString(buffer, offset, length) {
  const raw = buffer.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? raw.length : nul).toString("utf8").trim();
}

function normalizePackageFilePath(value) {
  const path = normalizeRequiredString(value, "path").replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw httpError(400, "path must be a relative package file path");
  }
  return path;
}

function findProjectedEntry(entries, id) {
  const decoded = decodeURIComponent(id);
  return entries.find((entry) => entry.id === decoded) ?? null;
}

function canViewProjectedEntry(storage, actor, entry) {
  if (entry.marketplace?.channel !== "private") return true;
  if (storage.hasAdminPermission(actor)) return true;
  return storage.publisherMembers.some(
    (member) =>
      member.userId === actor.id &&
      member.publisherHandle === entry.publisher?.handle &&
      member.status === "active",
  );
}

function packageReleaseTrust(version) {
  const manualState = version.manualModeration?.state ?? null;
  const moderationState = manualState ?? version.moderationStatus ?? "approved";
  const blockedFromDownload = manualState === "quarantined" || manualState === "revoked";
  const reasons = [];
  if (manualState && manualState !== "approved") reasons.push(`manual:${manualState}`);
  return {
    moderationState,
    blockedFromDownload,
    reasons,
    moderationReason: version.manualModeration?.reason ?? null,
    manualModeration: version.manualModeration ?? null,
  };
}

function createProjectedArtifactMetadata({ artifactUpload, packageId, version, kind, source, trust, security }) {
  const name = artifactUpload.storage.key.split("/").at(-1) ?? `${packageId}-${version}.artifact`;
  const files = Array.isArray(artifactUpload.files) ? artifactUpload.files : [];
  const artifactKind = inferArtifactKind(name, artifactUpload.mediaType);
  const fileCount = files.length;
  const unpackedSize = files.reduce((sum, file) => sum + (Number.isSafeInteger(file.size) ? file.size : 0), 0);
  const npm = {
    ...createNpmArtifactMetadata({ name, sha256: artifactUpload.sha256, fileCount, unpackedSize }),
    ...(artifactUpload.npm ?? {}),
  };
  return {
    name,
    mediaType: artifactUpload.mediaType ?? "application/octet-stream",
    size: artifactUpload.size,
    sha256: artifactUpload.sha256,
    kind: artifactKind,
    artifactKind,
    artifactSha256: artifactUpload.sha256,
    format: inferArtifactFormat(name, artifactUpload.mediaType),
    packageName: packageId,
    version,
    downloadEnabled: !trust.blockedFromDownload,
    trust,
    security,
    npm,
    npmIntegrity: npm.integrity,
    npmShasum: npm.shasum,
    npmTarballName: npm.tarballName,
    npmUnpackedSize: npm.unpackedSize,
    npmFileCount: npm.fileCount,
    unpackedSize,
    fileCount,
    storage: artifactUpload.storage,
    provenance: {
      source,
      reviewState: "verified",
    },
    capabilities: createPackageCapabilitySummary({
      kind,
      artifact: { fileCount },
      platforms: ["linux", "macos", "windows"],
    }),
    files,
  };
}

function inferArtifactKind(name, mediaType) {
  if (String(name ?? "").endsWith(".tgz") || String(mediaType ?? "").includes("gzip")) return "npm-pack";
  return "legacy-zip";
}

function inferArtifactFormat(name, mediaType) {
  if (String(name ?? "").endsWith(".tgz") || String(mediaType ?? "").includes("gzip")) return "tgz";
  if (String(name ?? "").endsWith(".zip") || String(mediaType ?? "").includes("zip")) return "zip";
  if (String(mediaType ?? "").includes("json")) return "json";
  return "binary";
}

function createNpmArtifactMetadata({ name, sha256, fileCount, unpackedSize }) {
  return {
    integrity: sha256 ? `sha256-${Buffer.from(sha256, "hex").toString("base64")}` : null,
    shasum: null,
    tarballName: name,
    unpackedSize,
    fileCount,
  };
}

function createPackageCapabilitySummary({ kind, artifact, platforms = [] } = {}) {
  const executesCode = kind === "plugin";
  const capabilityTags = [
    kind,
    "published",
    executesCode ? "executes-code" : "content-only",
    ...(platforms ?? []).map((platform) => `host:${platform}`),
    artifact?.fileCount > 0 ? "artifact-manifest" : "artifact-reference",
  ];
  return {
    executesCode,
    runtimeId: "coreblow",
    pluginKind: kind === "plugin" ? "coreblow-plugin" : undefined,
    hostTargets: platforms,
    capabilityTags,
  };
}

function createPackageCompatibilitySummary() {
  return {
    pluginApiRange: ">=1.0.0",
    pluginSdkVersion: "1.0.0",
    minGatewayVersion: "1.0.0",
  };
}

function createPackageVerificationSummary({ source, scanStatus }) {
  return {
    tier: "source-linked",
    scope: "artifact-only",
    summary: "Approved through CoreHub review with artifact checksum and source provenance.",
    sourceRepo: source,
    hasProvenance: true,
    scanStatus,
  };
}

function createPackageModerationStatus(entry) {
  const latest = selectLatestPackageVersion(entry);
  const reviewState = entry.review?.state ?? "unknown";
  const trust = latest?.artifact?.trust ?? null;
  const blocked =
    latest?.status === "blocked" ||
    reviewState === "blocked" ||
    latest?.artifact?.downloadEnabled === false ||
    Boolean(trust?.blockedFromDownload);
  const reasons = trust?.reasons ? [...trust.reasons] : [];
  if (!latest) reasons.push("latest-version-missing");
  if (latest?.status && latest.status !== "available") reasons.push(`version-${latest.status}`);
  if (reviewState !== "verified") reasons.push(`review-${reviewState}`);
  if (latest?.artifact?.downloadEnabled === false && !reasons.includes("download-disabled")) reasons.push("download-disabled");
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
          moderationStatus: trust?.moderationState ?? latest.moderationState ?? reviewState,
          blockedFromDownload: blocked,
          downloadEnabled: Boolean(latest.artifact?.downloadEnabled),
          reasons,
          moderationReason: trust?.moderationReason ?? entry.review?.notes ?? null,
          trust,
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
    entry.review?.state === "verified" && latest?.status === "available" && latest?.artifact?.trust?.blockedFromDownload !== true
      ? "pass"
      : "fail",
    entry.review?.state === "verified" && latest?.status === "available" && latest?.artifact?.trust?.blockedFromDownload !== true
      ? "Package is verified and latest version is available."
      : latest?.artifact?.trust?.blockedFromDownload
        ? latest.artifact.trust.moderationReason
        : `Review state is ${entry.review?.state ?? "unknown"} and latest status is ${latest?.status ?? "missing"}.`,
  );
  const scan = latestProjectedScan(entry, latest);
  add(
    "static-scan",
    "Static scan",
    scan?.scanStatus === "malicious" || scan?.scanStatus === "suspicious" ? "fail" : scan?.jobId ? "pass" : "warn",
    scan?.jobId
      ? `Static scan ${scan.jobId} completed with ${scan.scanStatus}.`
      : "Static scan evidence is missing for the latest package version.",
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

function createPackageScanStatus(entry, url) {
  const version = selectPackageVersionForRead(entry, url);
  const scan = latestProjectedScan(entry, version);
  return {
    status: "ok",
    package: {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      latestVersion: version?.version ?? null,
      publisher: entry.publisher ?? null,
    },
    scan,
  };
}

function latestProjectedScan(entry, version) {
  if (!version) return null;
  return (
    version.artifact?.security ??
    entry.scanner ??
    {
      scanner: "corehub-static",
      status: "missing",
      scanStatus: "pending",
      jobId: null,
      completedAt: null,
      evidenceCount: 0,
    }
  );
}

function selectLatestPackageVersion(entry) {
  return (
    entry.versions?.find((version) => version.tag === "latest") ??
    entry.versions?.toSorted((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? ""))).at(0) ??
    null
  );
}

function selectPackageVersionForRead(entry, url) {
  const version = url.searchParams.get("version");
  if (version) return findProjectedVersion(entry, version);
  const tag = url.searchParams.get("tag");
  if (tag) return entry.versions?.find((item) => item.tag === tag) ?? null;
  return selectLatestPackageVersion(entry);
}

function createPackageSecuritySummary(entry, version) {
  const trust = version.artifact?.trust ?? packageReleaseTrust(version);
  const security = version.artifact?.security ?? {};
  const scanStatus = trust.blockedFromDownload
    ? trust.moderationState === "revoked" || trust.moderationState === "quarantined"
      ? "malicious"
      : "blocked"
    : security.scanStatus ?? "clean";
  const scanBlocked = scanStatus === "malicious";
  const reasons = Array.isArray(trust.reasons) ? [...trust.reasons] : [];
  if (scanBlocked && !reasons.includes("scan:malicious")) reasons.push("scan:malicious");
  return {
    package: {
      name: entry.id,
      displayName: entry.name,
      family: entry.marketplace?.family ?? entry.family ?? (entry.kind === "plugin" ? "code-plugin" : entry.kind),
    },
    release: {
      releaseId: version.id ?? `${entry.id}@${version.version}`,
      version: version.version,
      artifactKind: version.artifact?.kind ?? version.artifact?.storage?.provider ?? null,
      artifactSha256: version.artifact?.sha256 ?? null,
      npmIntegrity: version.artifact?.npm?.integrity ?? version.artifact?.integrity ?? null,
      npmShasum: version.artifact?.npm?.shasum ?? version.artifact?.shasum ?? null,
      npmTarballName: version.artifact?.npm?.tarballName ?? version.artifact?.name ?? null,
      npmUnpackedSize: version.artifact?.npm?.unpackedSize ?? version.artifact?.unpackedSize ?? null,
      npmFileCount: version.artifact?.npm?.fileCount ?? version.artifact?.fileCount ?? null,
      createdAt: version.publishedAt ?? version.createdAt ?? null,
    },
    trust: {
      scanStatus,
      moderationState: trust.moderationState ?? null,
      blockedFromDownload: Boolean(trust.blockedFromDownload || scanBlocked),
      reasons,
      pending: Boolean(trust.pending || security.pending),
      stale: Boolean(trust.stale || security.stale),
    },
  };
}

function createNpmPackument(request, entry) {
  const versions = {};
  const time = {};
  let latest = null;
  for (const version of entry.versions ?? []) {
    if (!isNpmMirrorVersion(version)) continue;
    const npmVersion = createNpmVersionDocument(request, entry, version);
    versions[version.version] = npmVersion;
    if (version.publishedAt) time[version.version] = version.publishedAt;
    if (!latest || version.tag === "latest") latest = version;
  }
  const versionDates = Object.values(time).filter(Boolean).sort();
  if (versionDates[0]) time.created = versionDates[0];
  if (versionDates.at(-1)) time.modified = versionDates.at(-1);
  return {
    _id: npmPackageName(entry),
    name: npmPackageName(entry),
    description: entry.summary ?? "",
    homepage: entry.homepage ?? entry.source ?? defaultPublicBaseUrl,
    "dist-tags": latest ? { latest: latest.version } : {},
    versions,
    time,
  };
}

function createNpmVersionDocument(request, entry, version) {
  const artifact = version.artifact;
  return {
    name: npmPackageName(entry),
    version: version.version,
    description: entry.summary ?? "",
    homepage: entry.homepage ?? entry.source ?? defaultPublicBaseUrl,
    dist: {
      tarball: npmTarballUrl(request, entry, version),
      integrity: npmIntegrity(artifact),
      shasum: npmShasum(artifact),
      corehubSha256: artifact.sha256,
      fileCount: artifact.npm?.fileCount ?? artifact.fileCount ?? (Array.isArray(artifact.files) ? artifact.files.length : undefined),
      unpackedSize: artifact.npm?.unpackedSize ?? artifact.unpackedSize ?? undefined,
    },
    corehub: {
      packageId: entry.id,
      kind: entry.kind,
      family: entry.marketplace?.family ?? entry.family ?? (entry.kind === "plugin" ? "code-plugin" : entry.kind),
      publisher: entry.publisher ?? null,
      artifactName: artifact.name,
      artifactSize: artifact.size,
      artifactSha256: artifact.sha256,
      storageProvider: artifact.storage?.provider ?? null,
    },
  };
}

function isNpmMirrorVersion(version) {
  return (
    version?.status === "available" &&
    version.artifact?.downloadEnabled !== false &&
    version.artifact?.trust?.blockedFromDownload !== true &&
    typeof version.artifact?.name === "string" &&
    version.artifact.name.endsWith(".tgz") &&
    typeof version.artifact?.sha256 === "string"
  );
}

function parseNpmMirrorSegments(segments) {
  if (segments.length === 0) return null;
  const first = decodeURIComponent(segments[0]);
  let packageName;
  let rest;
  if (first.startsWith("@") && segments[1] && segments[1] !== "-") {
    packageName = `${first}/${decodeURIComponent(segments[1])}`;
    rest = segments.slice(2);
  } else {
    packageName = first;
    rest = segments.slice(1);
  }
  if (!packageName) return null;
  if (rest.length === 0) return { kind: "packument", packageName };
  if (rest.length === 2 && rest[0] === "-") {
    return { kind: "tarball", packageName, tarballName: decodeURIComponent(rest[1]) };
  }
  return null;
}

function findNpmMirrorEntry(entries, packageName) {
  return (
    entries.find((entry) => npmPackageName(entry) === packageName) ??
    entries.find((entry) => entry.id === packageName) ??
    entries.find((entry) => entry.publisher?.handle && `@${entry.publisher.handle}/${entry.id}` === packageName) ??
    null
  );
}

function findVersionForTarball(entry, tarballName) {
  return (
    entry.versions?.find((version) => isNpmMirrorVersion(version) && npmTarballName(entry, version) === tarballName) ??
    null
  );
}

function npmPackageName(entry) {
  return entry.npm?.name ?? entry.package?.name ?? entry.marketplace?.npmName ?? entry.id;
}

function npmTarballName(entry, version) {
  return (
    version.artifact?.npm?.tarballName ??
    version.artifact?.npmTarballName ??
    version.artifact?.name ??
    `${npmPackageName(entry).replace(/^@/, "").replace("/", "-")}-${version.version}.tgz`
  );
}

function npmTarballUrl(request, entry, version) {
  const packagePath = npmPackageName(entry).startsWith("@")
    ? npmPackageName(entry).split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(npmPackageName(entry));
  return `${requestBaseUrl(request, new URL(request.url, "http://127.0.0.1")).replace(/\/$/, "")}/api/npm/${packagePath}/-/${encodeURIComponent(npmTarballName(entry, version))}`;
}

function npmIntegrity(artifact) {
  if (artifact?.npm?.integrity) return artifact.npm.integrity;
  if (artifact?.integrity) return artifact.integrity;
  return artifact?.sha256 ? `sha256-${Buffer.from(artifact.sha256, "hex").toString("base64")}` : null;
}

function npmShasum(artifact) {
  return artifact?.npm?.shasum ?? artifact?.shasum ?? artifact?.sha1 ?? null;
}

function npmErrorResponse(error, statusCode) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Cache-Control": "no-store",
    },
    body: error,
  };
}

function findProjectedVersion(entry, target) {
  const decoded = decodeURIComponent(target);
  return entry.versions?.find((version) => version.version === decoded || version.tag === decoded) ?? null;
}

function paginatedDataResponse(items, url, statusCode = 200) {
  const page = paginateV1(items, url);
  return dataResponse(page.items, page.meta.count, statusCode, page.meta);
}

function paginateV1(items, url) {
  const limit = parseV1PositiveInteger(url.searchParams.get("limit"), "limit", 50);
  const cursor = decodeV1Cursor(url.searchParams.get("cursor"));
  const offset = cursor?.offset ?? parseNonNegativeInteger(url.searchParams.get("offset"), "offset", 0);
  const end = offset + limit;
  const pageItems = items.slice(offset, end);
  const nextOffset = end < items.length ? end : null;
  return {
    items: pageItems,
    meta: {
      count: pageItems.length,
      total: items.length,
      limit,
      offset,
      cursor: url.searchParams.get("cursor") ?? null,
      nextCursor: nextOffset === null ? null : encodeV1Cursor({ offset: nextOffset }),
      hasMore: nextOffset !== null,
    },
  };
}

function encodeV1Cursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeV1Cursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!decoded || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error("invalid cursor");
    }
    return { offset: decoded.offset };
  } catch {
    throw httpError(400, "cursor must be a valid CoreHub pagination cursor");
  }
}

function parseV1PositiveInteger(value, name, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw httpError(400, `${name} must be a positive integer`);
  return parsed;
}

function dataResponse(data, count = data === null ? 0 : 1, statusCode = data === null ? 404 : 200, meta = undefined) {
  if (statusCode >= 400) {
    return textResponse(typeof data?.error === "string" ? data.error : "Not found", statusCode);
  }
  return {
    statusCode,
    payload: {
      apiVersion: "v1",
      data,
      meta: meta ?? { count },
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

function textResponse(body, statusCode = 200, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      ...headers,
    },
    body,
  };
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

function sendError(response, statusCode, message, { mode = "v2", code, details, retryAfterSeconds } = {}) {
  const text = String(message || "CoreHub API error");
  if (mode === "public-v1") {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "text/plain;charset=UTF-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(text);
    return;
  }
  return json(response, statusCode, createErrorEnvelope(statusCode, text, { code, details, retryAfterSeconds }));
}

function createErrorEnvelope(statusCode, message, { code, details, retryAfterSeconds } = {}) {
  const envelope = {
    apiVersion: "v2",
    error: message,
    errorCode: code ?? errorCodeForStatus(statusCode, message),
    status: statusCode,
    message,
  };
  if (retryAfterSeconds !== undefined) envelope.retryAfterSeconds = retryAfterSeconds;
  if (details !== undefined) envelope.details = details;
  return envelope;
}

function errorCodeForStatus(statusCode, message = "") {
  const normalized = String(message).toLowerCase();
  if (statusCode === 400) return normalized.includes("cursor") ? "invalid_cursor" : "bad_request";
  if (statusCode === 401) return "unauthorized";
  if (statusCode === 403) {
    if (normalized.includes("blocked") || normalized.includes("moderation") || normalized.includes("quarantined") || normalized.includes("revoked")) {
      return "blocked_download";
    }
    return "forbidden";
  }
  if (statusCode === 404) return "not_found";
  if (statusCode === 409) return "conflict";
  if (statusCode === 413) return "payload_too_large";
  if (statusCode === 415) return "unsupported_media_type";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 503) return "unavailable";
  return statusCode >= 500 ? "internal_error" : "request_failed";
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
  const files = normalizeArtifactFiles(artifact.files);
  const npm = normalizeArtifactNpmMetadata(artifact.npm);
  const provider = input.provider ?? "managed";
  if (!["managed", "github-raw", "external-url"].includes(provider)) {
    throw httpError(400, "provider must be managed, github-raw, or external-url");
  }
  const url = typeof artifact.url === "string" && artifact.url.trim().length > 0 ? artifact.url.trim() : undefined;
  if (isExternalArtifactProvider(provider) && !url) {
    throw httpError(400, "artifact.url is required for external artifact URL providers");
  }
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
      files,
      ...(npm ? { npm } : {}),
      ...(url ? { url } : {}),
    },
  };
}

function normalizeArtifactFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw httpError(400, "artifact.files must be an array");
  return files.map((file, index) => {
    if (!file || typeof file !== "object") throw httpError(400, `artifact.files[${index}] must be an object`);
    const path = normalizePackageFilePath(file.path);
    const size = file.size;
    if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, `artifact.files[${index}].size must be a non-negative integer`);
    const sha256 = normalizeRequiredString(file.sha256, `artifact.files[${index}].sha256`).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw httpError(400, `artifact.files[${index}].sha256 must be a SHA-256 hex digest`);
    return { path, size, sha256 };
  });
}

function normalizeArtifactNpmMetadata(npm) {
  if (npm === undefined) return null;
  if (!npm || typeof npm !== "object" || Array.isArray(npm)) throw httpError(400, "artifact.npm must be an object");
  const shasum = typeof npm.shasum === "string" && npm.shasum.trim() ? npm.shasum.trim().toLowerCase() : null;
  if (shasum && !/^[a-f0-9]{40}$/.test(shasum)) throw httpError(400, "artifact.npm.shasum must be a SHA-1 hex digest");
  return {
    ...(typeof npm.integrity === "string" && npm.integrity.trim() ? { integrity: npm.integrity.trim() } : {}),
    ...(shasum ? { shasum } : {}),
    ...(typeof npm.tarballName === "string" && npm.tarballName.trim() ? { tarballName: npm.tarballName.trim() } : {}),
    ...(Number.isSafeInteger(npm.unpackedSize) && npm.unpackedSize >= 0 ? { unpackedSize: npm.unpackedSize } : {}),
    ...(Number.isSafeInteger(npm.fileCount) && npm.fileCount >= 0 ? { fileCount: npm.fileCount } : {}),
  };
}

function isExternalArtifactProvider(provider) {
  return provider === "github-raw" || provider === "external-url";
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
  const channel = typeof input?.channel === "string" && input.channel.trim().length > 0 ? input.channel.trim() : "stable";
  if (!["stable", "beta", "official", "private"].includes(channel)) {
    throw httpError(400, "channel must be stable, beta, official, or private");
  }
  const publishTokenId =
    typeof input?.publishTokenId === "string" && input.publishTokenId.trim().length > 0 ? input.publishTokenId.trim() : undefined;
  const manualOverrideReason =
    typeof input?.manualOverrideReason === "string" && input.manualOverrideReason.trim().length > 0
      ? input.manualOverrideReason.trim()
      : undefined;
  return {
    packageId,
    version,
    publisherHandle,
    kind,
    artifactUploadId,
    source,
    changelog,
    channel,
    publishTokenId,
    manualOverrideReason,
  };
}

function normalizeTrustedPublisherRequest(input) {
  const repository = normalizeRequiredString(input?.repository, "repository").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) throw httpError(400, "repository must be owner/name");
  const [repositoryOwner] = repository.split("/");
  const workflowFilename = normalizeRequiredString(input?.workflowFilename, "workflowFilename");
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowFilename)) {
    throw httpError(400, "workflowFilename must be a GitHub Actions YAML filename");
  }
  const environment = typeof input?.environment === "string" && input.environment.trim().length > 0 ? input.environment.trim() : undefined;
  return {
    repository,
    repositoryId:
      typeof input?.repositoryId === "string" && input.repositoryId.trim().length > 0
        ? input.repositoryId.trim()
        : createHash("sha256").update(repository).digest("hex").slice(0, 12),
    repositoryOwner,
    repositoryOwnerId:
      typeof input?.repositoryOwnerId === "string" && input.repositoryOwnerId.trim().length > 0
        ? input.repositoryOwnerId.trim()
        : createHash("sha256").update(repositoryOwner).digest("hex").slice(0, 12),
    workflowFilename,
    environment,
  };
}

async function resolvePublishTokenMintRequest(input, trustedPublisher, { now = new Date(), jwks } = {}) {
  if (typeof input?.oidcToken === "string" && input.oidcToken.trim().length > 0) {
    return normalizePublishTokenMintRequestFromOidc(input, trustedPublisher, { now, jwks });
  }
  return normalizePublishTokenMintRequest(input, trustedPublisher);
}

async function normalizePublishTokenMintRequestFromOidc(input, trustedPublisher, { now, jwks }) {
  const version = normalizeRequiredString(input?.version, "version");
  const audience = defaultGitHubOidcAudience;
  const { payload } = await verifyGitHubActionsOidcToken(input.oidcToken, {
    audience,
    jwks,
    now,
  });
  const repository = normalizeRequiredString(payload.repository, "oidc.repository").toLowerCase();
  const workflowFilename = workflowFilenameFromOidcClaims(payload);
  const environment = typeof payload.environment === "string" && payload.environment.trim().length > 0 ? payload.environment.trim() : undefined;
  if (repository !== trustedPublisher.repository) throw httpError(403, "OIDC repository does not match trusted publisher config");
  if (workflowFilename !== trustedPublisher.workflowFilename) throw httpError(403, "OIDC workflow does not match trusted publisher config");
  if ((environment ?? undefined) !== (trustedPublisher.environment ?? undefined)) {
    throw httpError(403, "OIDC environment does not match trusted publisher config");
  }
  return {
    version,
    repository,
    workflowFilename,
    runId: normalizeRequiredString(payload.run_id, "oidc.run_id"),
    runAttempt: normalizeRequiredString(payload.run_attempt ?? "1", "oidc.run_attempt"),
    sha: normalizeRequiredString(payload.sha, "oidc.sha"),
    ref: normalizeRequiredString(payload.ref, "oidc.ref"),
    oidc: {
      issuer: payload.iss,
      audience,
      subject: payload.sub,
      jobWorkflowRef: payload.job_workflow_ref,
      jobWorkflowSha: payload.job_workflow_sha,
      workflowRef: payload.workflow_ref,
      repositoryId: payload.repository_id,
      runId: String(payload.run_id),
    },
  };
}

function normalizePublishTokenMintRequest(input, trustedPublisher) {
  const version = normalizeRequiredString(input?.version, "version");
  const repository = normalizeRequiredString(input?.repository ?? trustedPublisher.repository, "repository").toLowerCase();
  const workflowFilename = normalizeRequiredString(input?.workflowFilename ?? trustedPublisher.workflowFilename, "workflowFilename");
  const environment = typeof input?.environment === "string" && input.environment.trim().length > 0 ? input.environment.trim() : undefined;
  if (repository !== trustedPublisher.repository) throw httpError(403, "Repository does not match trusted publisher config");
  if (workflowFilename !== trustedPublisher.workflowFilename) throw httpError(403, "Workflow does not match trusted publisher config");
  if ((environment ?? undefined) !== (trustedPublisher.environment ?? undefined)) {
    throw httpError(403, "Environment does not match trusted publisher config");
  }
  return {
    version,
    repository,
    workflowFilename,
    runId: normalizeRequiredString(input?.runId, "runId"),
    runAttempt: normalizeRequiredString(input?.runAttempt ?? "1", "runAttempt"),
    sha: normalizeRequiredString(input?.sha, "sha"),
    ref: normalizeRequiredString(input?.ref, "ref"),
  };
}

async function verifyGitHubActionsOidcToken(token, { audience = defaultGitHubOidcAudience, jwks, now = new Date() } = {}) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw httpError(403, "GitHub OIDC token must be a JWT");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtJson(encodedHeader, "header");
  const payload = decodeJwtJson(encodedPayload, "payload");
  if (header.alg !== "RS256") throw httpError(403, "GitHub OIDC token must use RS256");
  if (payload.iss !== githubOidcIssuer) throw httpError(403, "GitHub OIDC issuer is not trusted");
  if (!jwtAudienceMatches(payload.aud, audience)) throw httpError(403, "GitHub OIDC audience does not match CoreHub publish-token audience");
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(payload.exp)) throw httpError(403, "GitHub OIDC token expiry is missing");
  if (Number.isFinite(payload.nbf) && payload.nbf > nowSeconds + 60) throw httpError(403, "GitHub OIDC token is not valid yet");
  if (payload.exp <= nowSeconds - 60) throw httpError(403, "GitHub OIDC token is expired");
  const keySet = jwks ?? await fetchGitHubOidcJwks();
  const jwk = (keySet.keys ?? []).find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw httpError(403, "GitHub OIDC signing key was not found");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const valid = verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), decodeBase64Url(encodedSignature));
  if (!valid) throw httpError(403, "GitHub OIDC token signature is invalid");
  return { header, payload };
}

async function fetchGitHubOidcJwks() {
  const response = await fetch(defaultGitHubOidcJwksUrl, {
    headers: { accept: "application/json", "user-agent": "corehub-oidc-verifier" },
  });
  if (!response.ok) throw httpError(503, `GitHub OIDC JWKS fetch failed: ${response.status}`);
  return response.json();
}

function workflowFilenameFromOidcClaims(payload) {
  const ref = normalizeRequiredString(payload.job_workflow_ref ?? payload.workflow_ref, "oidc.job_workflow_ref");
  const marker = "/.github/workflows/";
  const index = ref.indexOf(marker);
  if (index === -1) throw httpError(403, "GitHub OIDC workflow ref is missing workflow path");
  return ref.slice(index + marker.length).split("@")[0].split("/").at(-1);
}

function jwtAudienceMatches(actual, expected) {
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

function decodeJwtJson(value, label) {
  try {
    return JSON.parse(decodeBase64Url(value).toString("utf8"));
  } catch (error) {
    throw httpError(403, `GitHub OIDC token ${label} is invalid`, { cause: error });
  }
}

function decodeBase64Url(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function normalizePackageReportRequest(input) {
  const packageId = normalizeRequiredString(input?.packageId, "packageId");
  const version = typeof input?.version === "string" && input.version.trim().length > 0 ? input.version.trim() : undefined;
  const reason = normalizeRequiredString(input?.reason, "reason");
  return { packageId, version, reason };
}

function normalizePackageReportTriageRequest(input) {
  const status = normalizeRequiredString(input?.status, "status");
  if (!["open", "confirmed", "dismissed"].includes(status)) {
    throw httpError(400, "package report status must be open, confirmed, or dismissed");
  }
  const note = typeof input?.note === "string" && input.note.trim().length > 0 ? input.note.trim() : undefined;
  const finalAction =
    typeof input?.finalAction === "string" && input.finalAction.trim().length > 0 ? input.finalAction.trim() : undefined;
  if (finalAction && !["none", "quarantine", "revoke"].includes(finalAction)) {
    throw httpError(400, "package report finalAction must be none, quarantine, or revoke");
  }
  return { status, note, finalAction };
}

function normalizePackageReleaseModerationRequest(input) {
  const version = normalizeRequiredString(input?.version, "version");
  const state = normalizeRequiredString(input?.state, "state");
  if (!["approved", "quarantined", "revoked"].includes(state)) {
    throw httpError(400, "package release moderation state must be approved, quarantined, or revoked");
  }
  const reason = normalizeRequiredString(input?.reason, "reason");
  return { version, state, reason };
}

function normalizePackageAppealRequest(input) {
  const packageId = normalizeRequiredString(input?.packageId, "packageId");
  const version = normalizeRequiredString(input?.version, "version");
  const message = normalizeRequiredString(input?.message, "message");
  return { packageId, version, message };
}

function normalizePackageAppealResolveRequest(input) {
  const status = normalizeRequiredString(input?.status, "status");
  if (!["open", "accepted", "rejected"].includes(status)) {
    throw httpError(400, "package appeal status must be open, accepted, or rejected");
  }
  const note = typeof input?.note === "string" && input.note.trim().length > 0 ? input.note.trim() : undefined;
  const finalAction =
    typeof input?.finalAction === "string" && input.finalAction.trim().length > 0 ? input.finalAction.trim() : undefined;
  if (finalAction && !["none", "approve"].includes(finalAction)) {
    throw httpError(400, "package appeal finalAction must be none or approve");
  }
  return { status, note, finalAction };
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

function createStaticScanEvidence({ version, artifactUpload, actor, createdAt }) {
  const evidence = [
    {
      id: `scan-evidence-${slugId(version.packageId)}-${slugVersion(version.version)}-artifact`,
      type: "artifact_metadata",
      severity: artifactUpload?.status === "verified" ? "info" : "medium",
      summary: artifactUpload?.status === "verified" ? "Artifact upload is verified." : "Artifact upload is not verified.",
      metadata: {
        artifactUploadId: version.artifactUploadId,
        status: artifactUpload?.status ?? "missing",
        size: artifactUpload?.size ?? null,
        sha256: artifactUpload?.sha256 ?? null,
        storageProvider: artifactUpload?.storage?.provider ?? null,
      },
      createdBy: actor,
      createdAt,
    },
    {
      id: `scan-evidence-${slugId(version.packageId)}-${slugVersion(version.version)}-size`,
      type: "artifact_size",
      severity: artifactUpload?.size && artifactUpload.size <= 100 * 1024 * 1024 ? "info" : "medium",
      summary: artifactUpload?.size && artifactUpload.size <= 100 * 1024 * 1024
        ? "Artifact size is within the CoreHub static scan limit."
        : "Artifact size is missing or exceeds the CoreHub static scan limit.",
      metadata: {
        size: artifactUpload?.size ?? null,
        maxBytes: 100 * 1024 * 1024,
      },
      createdBy: actor,
      createdAt,
    },
  ];
  if (version.channel === "official") {
    evidence.push({
      id: `scan-evidence-${slugId(version.packageId)}-${slugVersion(version.version)}-official`,
      type: "official_channel",
      severity: "info",
      summary: "Official channel release is recorded for operator policy review.",
      metadata: {
        channel: version.channel,
        publisherHandle: version.publisherHandle,
      },
      createdBy: actor,
      createdAt,
    });
  }
  return evidence;
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

function normalizePackageScanSource(value) {
  const source = normalizeRequiredString(value, "source");
  if (!["manual", "backfill", "submission", "rescan"].includes(source)) {
    throw httpError(400, "source must be manual, backfill, submission, or rescan");
  }
  return source;
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

function createPackageSearchDigest(entry, { updatedAt } = {}) {
  const marketplace = entry.marketplace ?? {};
  const latest = entry.versions?.[0] ?? null;
  const artifact = latest?.artifact ?? null;
  const searchText = packageSearchText(entry);
  const digestUpdatedAt = updatedAt ?? latest?.publishedAt ?? latest?.createdAt ?? new Date(0).toISOString();
  return {
    id: `package-search-digest-${slugId(entry.id)}`,
    packageId: entry.id,
    name: entry.name,
    normalizedName: normalizeSearchText(entry.name ?? entry.id),
    displayName: entry.name,
    family: marketplace.family ?? (entry.kind === "skill" ? "skill" : "code-plugin"),
    channel: marketplace.channel ?? "community",
    isOfficial: Boolean(marketplace.isOfficial),
    executesCode: Boolean(marketplace.executesCode),
    category: marketplace.category ?? "dev-tools",
    publisherHandle: entry.publisher?.handle ?? null,
    summary: entry.summary ?? "",
    latestVersion: latest?.version ?? entry.version ?? null,
    capabilityTags: marketplace.capabilityTags ?? entry.tags ?? [],
    scanStatus: artifact?.security?.scanStatus ?? entry.scanner?.scanStatus ?? "unknown",
    moderationState: artifact?.trust?.moderationState ?? "available",
    downloadEnabled: artifact?.downloadEnabled !== false && !artifact?.trust?.blockedFromDownload,
    stats: marketplace.stats ?? entry.stats ?? { installs: 0, downloads: 0 },
    searchText,
    searchTokens: [...new Set(tokenizeSearchText(searchText))].slice(0, 64),
    entry: JSON.parse(JSON.stringify(entry)),
    updatedAt: digestUpdatedAt,
  };
}

function packageSearchDigestToEntry(digest) {
  return digest?.entry ?? null;
}

function packageSearchText(entry) {
  return [
    entry.id,
    entry.name,
    entry.summary,
    entry.source,
    entry.homepage,
    entry.kind,
    entry.publisher?.handle,
    entry.publisher?.displayName,
    entry.marketplace?.family,
    entry.marketplace?.channel,
    entry.marketplace?.category,
    ...(entry.tags ?? []),
    ...(entry.capabilities ?? []),
    ...(entry.marketplace?.capabilityTags ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeSearchText(value) {
  return tokenizeSearchText(value).join("-");
}

function tokenizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((term) => term.trim())
    .filter(Boolean);
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

function actorFromRequest(request, storage) {
  const authHeader = request.headers["authorization"] ?? request.headers["Authorization"];
  const signingSecret = storage?.signedReadKeys?.get(storage?.signedReadKeyId) ?? defaultSignedReadSecret;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const payload = verifyJwt(token, signingSecret);
    if (payload && payload.actor) {
      return payload.actor;
    }
  }
  const actorId = request.headers["x-corehub-user"] ?? "local-api-user";
  return {
    type: "user",
    id: Array.isArray(actorId) ? actorId[0] : actorId,
  };
}

function validateSessionRequest(storage, request, role, sessionAuth = createSessionAuth()) {
  const token = authTokenFromRequest(request);
  if (!token) throw httpError(401, "Session token is required");
  const normalizedRole = role === "admin" ? "admin" : "publisher";
  const tokenValidation = validateSessionToken(storage, token, normalizedRole, sessionAuth);
  const actor = actorFromRequest(request, storage);
  if (normalizedRole === "admin") {
    storage.requireAdminPermission(actor, "session.validate");
  }
  const identity = storage.publisherIdentity(actor);
  if (normalizedRole === "publisher" && identity.memberships.length === 0) {
    throw httpError(403, `Actor ${actor.id} has no active publisher membership`);
  }
  return {
    valid: true,
    role: normalizedRole,
    actor,
    token: {
      present: true,
      type: tokenValidation.type,
      verified: tokenValidation.verified,
      verifier: tokenValidation.verifier,
    },
    permissions: identity.permissions,
    memberships: identity.memberships,
    defaultPublisher: identity.defaultPublisher,
  };
}

function validateSessionToken(storage, token, role, sessionAuth) {
  if (jwtPayloadFromToken(storage, token)) {
    return { type: "jwt", verified: true, verifier: "signed-jwt" };
  }
  if (!sessionAuth.enforceOpaqueTokens) {
    return { type: "opaque", verified: false, verifier: "local-dev" };
  }
  const acceptedHashes = role === "admin" ? sessionAuth.adminTokenHashes : sessionAuth.publisherTokenHashes;
  if (acceptedHashes.some((hash) => tokenMatchesSha256(token, hash))) {
    return { type: "opaque", verified: true, verifier: "configured-sha256" };
  }
  throw httpError(401, "Session token is not valid for this role");
}

function createSessionAuth(config = {}) {
  const sharedTokenHashes = normalizeTokenHashes(config.sharedTokenHashes ?? config.tokenHashes);
  return {
    enforceOpaqueTokens: Boolean(config.enforceOpaqueTokens ?? config.enforce ?? sharedTokenHashes.length > 0),
    adminTokenHashes: [
      ...sharedTokenHashes,
      ...normalizeTokenHashes(config.adminTokenHashes),
    ],
    publisherTokenHashes: [
      ...sharedTokenHashes,
      ...normalizeTokenHashes(config.publisherTokenHashes),
    ],
  };
}

function normalizeTokenHashes(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values.map((hash) => String(hash).trim().toLowerCase()).filter((hash) => /^[a-f0-9]{64}$/.test(hash));
}

function tokenMatchesSha256(token, expectedHash) {
  const actual = Buffer.from(createHash("sha256").update(token).digest("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authTokenFromRequest(request) {
  const authHeader = request.headers["authorization"] ?? request.headers["Authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  return getHeader(request.headers, "x-corehub-token") ?? "";
}

function jwtPayloadFromToken(storage, token) {
  const signingSecret = storage?.signedReadKeys?.get(storage?.signedReadKeyId) ?? defaultSignedReadSecret;
  return verifyJwt(token, signingSecret);
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

function createRateLimiter(config) {
  if (!config) return null;
  const limit = Number(config.limit ?? 0);
  const windowMs = Number(config.windowMs ?? 0);
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("rateLimit requires positive integer limit and windowMs");
  }
  const bucketKey = config.bucketKey ?? `${limit}:${windowMs}`;
  const buckets = rateLimitBucketStores.get(bucketKey) ?? new Map();
  rateLimitBucketStores.set(bucketKey, buckets);
  return {
    check(request, now) {
      const key = rateLimitKey(request);
      const timestamp = now.getTime();
      const current = buckets.get(key);
      if (!current || timestamp >= current.resetAt) {
        const resetAt = timestamp + windowMs;
        buckets.set(key, { count: 1, resetAt });
        return {
          limited: false,
          limit,
          remaining: Math.max(0, limit - 1),
          resetAt,
          resetAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)),
        };
      }
      current.count += 1;
      const resetAfterSeconds = Math.max(1, Math.ceil((current.resetAt - timestamp) / 1000));
      if (current.count <= limit) {
        return {
          limited: false,
          limit,
          remaining: Math.max(0, limit - current.count),
          resetAt: current.resetAt,
          resetAfterSeconds,
        };
      }
      return {
        limited: true,
        limit,
        remaining: 0,
        resetAt: current.resetAt,
        resetAfterSeconds,
        retryAfterSeconds: resetAfterSeconds,
      };
    },
  };
}

function applyRateLimitHeaders(response, result) {
  const resetEpochSeconds = Math.ceil(result.resetAt / 1000);
  response.setHeader("X-RateLimit-Limit", String(result.limit));
  response.setHeader("X-RateLimit-Remaining", String(result.remaining));
  response.setHeader("X-RateLimit-Reset", String(resetEpochSeconds));
  response.setHeader("RateLimit-Limit", String(result.limit));
  response.setHeader("RateLimit-Remaining", String(result.remaining));
  response.setHeader("RateLimit-Reset", String(result.resetAfterSeconds));
}

function rateLimitKey(request) {
  return (
    getHeader(request.headers, "x-corehub-client-id") ??
    getHeader(request.headers, "cf-connecting-ip") ??
    getHeader(request.headers, "x-forwarded-for")?.split(",")[0]?.trim() ??
    request.socket?.remoteAddress ??
    "unknown"
  );
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
  if (statusCode >= 400) response.setHeader("Cache-Control", "no-store");
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
      <button class="secondary" id="validateSessionButton" type="button">Validate</button>
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
    nodes.validateSessionButton.addEventListener("click", () => validateSession("admin").then((session) => renderSessionValidated(session)).catch((error) => showLoginError(error.message)));
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
        const session = await validateSession("admin");
        const [status, bundle, submissions, reviews] = await Promise.all([
          api("/admin/status"),
          api("/admin/support-bundle?limit=5"),
          api("/submissions?status=pending_review&limit=25"),
          api("/reviews?status=open&limit=25"),
        ]);
        renderDashboard(status.data, bundle.data, submissions, reviews, session);
      } catch (error) {
        showLoginError(error.message || "Unable to load CoreHub admin status.");
        renderSignedOut(false);
      }
    }

    async function validateSession(role) {
      const payload = await api("/session/validate?role=" + encodeURIComponent(role));
      if (!payload.data?.valid) throw new Error("CoreHub session validation failed.");
      return payload.data;
    }

    function renderSessionValidated(session) {
      nodes.sessionLabel.textContent = session.actor.id + " validated " + session.role;
      nodes.readinessPill.textContent = "validated";
      nodes.readinessPill.className = "status good";
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

    function renderDashboard(status, bundle, submissions, reviews, session) {
      nodes.loginPanel.classList.add("hidden");
      nodes.dashboard.classList.remove("hidden");
      nodes.sessionLabel.textContent = (session?.actor?.id || state.session.actor) + " validated admin";
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

function renderCoreHubPublisherHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CoreHub Publisher Portal</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
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
      min-height: 64px;
      padding: 14px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 18px; }
    h2 { font-size: 15px; margin-bottom: 10px; }
    h3 { font-size: 13px; color: var(--muted); }
    main { width: min(1280px, 100%); margin: 0 auto; padding: 20px 24px 40px; }
    section, .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    section { padding: 16px; margin-bottom: 14px; }
    .metric { padding: 14px; min-height: 92px; }
    .metric strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 8px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
    .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .muted { color: var(--muted); }
    .hidden { display: none !important; }
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
    .split-toolbar { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; }
    .stack { display: grid; gap: 8px; }
    .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button, input, select, textarea {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 0 10px;
      font: inherit;
    }
    input, select { height: 36px; width: 100%; }
    textarea { min-height: 72px; padding-top: 8px; resize: vertical; width: 100%; }
    button {
      height: 36px;
      background: var(--accent);
      color: var(--accent-ink);
      border-color: var(--accent);
      cursor: pointer;
      font-weight: 650;
    }
    button:disabled, input:disabled, select:disabled, textarea:disabled {
      opacity: 0.58;
      cursor: not-allowed;
    }
    button.secondary { background: #fff; color: var(--ink); border-color: var(--line); }
    form { display: grid; gap: 10px; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    label { display: grid; gap: 6px; font-size: 12px; color: var(--muted); }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 12px; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { font-size: 12px; color: var(--muted); }
    .error, .notice { margin-top: 12px; padding: 10px 12px; border-radius: 8px; }
    .error { border: 1px solid #fecaca; color: var(--bad); background: #fef2f2; }
    .notice { border: 1px solid #bbf7d0; color: var(--good); background: #f0fdf4; }
    .warning { border-color: #fed7aa; color: var(--warn); background: #fff7ed; }
    @media (max-width: 900px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      .grid, .two, .form-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>CoreHub Publisher Portal</h1>
      <p class="muted" id="sessionLabel">Not connected</p>
    </div>
    <div class="toolbar">
      <span class="status" id="rolePill">signed out</span>
      <button class="secondary" id="validateSessionButton" type="button">Validate</button>
      <button class="secondary" id="refreshButton" type="button">Refresh</button>
      <button class="secondary" id="signOutButton" type="button">Sign out</button>
    </div>
  </header>
  <main>
    <section id="loginPanel">
      <h2>Publisher Session</h2>
      <p class="muted">Use a CoreHub token and actor id with publisher membership.</p>
      <form id="sessionForm">
        <div class="form-grid">
          <label>Actor
            <input id="actorInput" autocomplete="username" placeholder="github:coreblow-admin" value="github:coreblow-admin">
          </label>
          <label>Token
            <input id="tokenInput" autocomplete="current-password" placeholder="publisher token" type="password">
          </label>
        </div>
        <button type="submit">Connect</button>
      </form>
      <div class="error hidden" id="loginError"></div>
    </section>

    <div id="portal" class="hidden">
      <div class="grid">
        <div class="metric"><h3>Publishers</h3><strong id="metricPublishers">0</strong><p class="muted">memberships</p></div>
        <div class="metric"><h3>Packages</h3><strong id="metricPackages">0</strong><p class="muted">owned listings</p></div>
        <div class="metric"><h3>Pending</h3><strong id="metricPending">0</strong><p class="muted">submissions</p></div>
        <div class="metric"><h3>Transfers</h3><strong id="metricTransfers">0</strong><p class="muted">requests</p></div>
      </div>

      <div class="two">
        <section>
          <h2>Whoami</h2>
          <p class="muted" id="permissionSummary">No publisher permissions loaded.</p>
          <div id="whoamiRows"></div>
        </section>
        <section>
          <h2>Claim Publisher</h2>
          <form id="claimForm">
            <div class="form-grid">
              <label>Handle<input id="claimHandle" placeholder="example-org"></label>
              <label>Display name<input id="claimDisplayName" placeholder="Example Org"></label>
            </div>
            <button type="submit">Claim</button>
          </form>
          <div class="notice hidden" id="claimNotice"></div>
        </section>
      </div>

      <section>
        <div class="toolbar"><h2>Owned Packages</h2><span class="status" id="packageCount">0</span></div>
        <table>
          <thead><tr><th>Package</th><th>Version</th><th>Publisher</th><th>Channel</th><th>Trusted Publisher</th></tr></thead>
          <tbody id="packagesTable"></tbody>
        </table>
      </section>

      <section>
        <h2>Upload Artifact and Submit Package</h2>
        <form id="publishForm">
          <div class="form-grid">
            <label>Artifact file<input id="artifactFile" type="file"></label>
            <label>Artifact URL<input id="artifactUrlInput" placeholder="https://github.com/org/repo/releases/download/v0.2.0/plugin.tgz"></label>
            <label>Publisher<select id="publisherSelect"></select></label>
            <label>Package id<input id="packageIdInput" placeholder="plugin-lab" required></label>
            <label>Version<input id="versionInput" placeholder="0.2.0" required></label>
            <label>Artifact name<input id="artifactNameInput" placeholder="plugin-lab-0.2.0.coreblow-plugin.tgz"></label>
            <label>Artifact media type<input id="artifactMediaTypeInput" placeholder="application/vnd.coreblow.plugin-archive+gzip"></label>
            <label>Artifact size<input id="artifactSizeInput" inputmode="numeric" placeholder="736"></label>
            <label>Artifact SHA-256<input id="artifactSha256Input" placeholder="64 hex characters"></label>
            <label>Kind
              <select id="kindInput"><option value="plugin">plugin</option><option value="skill">skill</option><option value="provider">provider</option><option value="channel">channel</option></select>
            </label>
            <label>Channel
              <select id="channelInput"><option value="stable">stable</option><option value="beta">beta</option><option value="official">official</option></select>
            </label>
          </div>
          <label>Source<input id="sourceInput" placeholder="https://github.com/coreblow/plugin-lab"></label>
          <label>Changelog<textarea id="changelogInput">CoreHub publisher portal submission.</textarea></label>
          <button type="submit">Upload and submit</button>
        </form>
        <div class="notice hidden" id="publishNotice"></div>
        <div class="error hidden" id="publishError"></div>
      </section>

      <div class="two">
        <section>
          <div class="split-toolbar">
            <h2>Submission Status</h2>
            <div class="controls">
              <select id="submissionFilter">
                <option value="all">all</option>
                <option value="pending_review">pending</option>
                <option value="approved">approved</option>
                <option value="rejected">rejected</option>
              </select>
              <span class="status" id="submissionCount">0</span>
            </div>
          </div>
          <table>
            <thead><tr><th>Submission</th><th>Package</th><th>Status</th><th>Review</th></tr></thead>
            <tbody id="submissionsTable"></tbody>
          </table>
        </section>
        <section>
          <h2>Ownership Transfer</h2>
          <form id="transferForm">
            <div class="form-grid">
              <label>Package id<input id="transferPackage" placeholder="plugin-lab"></label>
              <label>From publisher<select id="transferFrom"></select></label>
              <label>To publisher<input id="transferTo" placeholder="example-org"></label>
              <label>Reason<input id="transferReason" placeholder="Move package ownership"></label>
            </div>
            <button type="submit">Request transfer</button>
          </form>
          <div class="notice hidden" id="transferNotice"></div>
          <div class="error hidden" id="transferError"></div>
          <table>
            <thead><tr><th>Transfer</th><th>Package</th><th>Route</th><th>Status</th></tr></thead>
            <tbody id="transfersTable"></tbody>
          </table>
        </section>
      </div>

      <section>
        <div class="split-toolbar"><h2>Artifact Uploads</h2><span class="status" id="uploadCount">0</span></div>
        <table>
          <thead><tr><th>Upload</th><th>Package</th><th>Publisher</th><th>Status</th></tr></thead>
          <tbody id="uploadsTable"></tbody>
        </table>
      </section>
    </div>
  </main>

  <script>
    const sessionKey = "corehub.publisher.session.v1";
    const state = { session: readSession(), dashboard: null };
    const nodes = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));

    nodes.sessionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const actor = nodes.actorInput.value.trim();
      const token = nodes.tokenInput.value.trim();
      if (!actor || !token) return showError("Actor and token are required.");
      state.session = { actor, token };
      sessionStorage.setItem(sessionKey, JSON.stringify(state.session));
      await loadPortal();
    });
    nodes.validateSessionButton.addEventListener("click", () => validateSession("publisher").then((session) => renderSessionValidated(session)).catch((error) => showError(error.message)));
    nodes.refreshButton.addEventListener("click", () => loadPortal());
    nodes.signOutButton.addEventListener("click", () => {
      sessionStorage.removeItem(sessionKey);
      state.session = null;
      renderSignedOut();
    });
    nodes.claimForm.addEventListener("submit", claimPublisher);
    nodes.publishForm.addEventListener("submit", uploadAndSubmit);
    nodes.transferForm.addEventListener("submit", requestTransfer);
    nodes.artifactFile.addEventListener("change", hydrateArtifactFieldsFromFile);
    nodes.artifactUrlInput.addEventListener("input", updatePublishMode);
    nodes.submissionFilter.addEventListener("change", () => state.dashboard && renderPortal(state.dashboard));

    if (state.session) {
      nodes.actorInput.value = state.session.actor;
      loadPortal();
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

    async function loadPortal() {
      if (!state.session) return renderSignedOut();
      try {
        const session = await validateSession("publisher");
        const payload = await api("/publisher/dashboard");
        state.dashboard = payload.data;
        renderPortal(payload.data, session);
      } catch (error) {
        showError(error.message || "Unable to load publisher dashboard.");
        renderSignedOut(false);
      }
    }

    async function validateSession(role) {
      const payload = await api("/session/validate?role=" + encodeURIComponent(role));
      if (!payload.data?.valid) throw new Error("CoreHub session validation failed.");
      return payload.data;
    }

    function renderSessionValidated(session) {
      nodes.sessionLabel.textContent = session.actor.id + " validated " + session.role;
      nodes.rolePill.textContent = session.permissions.admin ? "admin publisher" : "publisher";
      nodes.rolePill.className = "status good";
    }

    async function claimPublisher(event) {
      event.preventDefault();
      const handle = nodes.claimHandle.value.trim();
      if (!handle) return showNotice(nodes.claimNotice, "Handle is required.");
      try {
        setFormBusy(nodes.claimForm, true);
        const payload = await api("/publishers/claim", {
          method: "POST",
          body: {
            handle,
            displayName: nodes.claimDisplayName.value.trim() || handle,
            kind: "organization",
          },
        });
        showNotice(nodes.claimNotice, "Publisher " + payload.data.publisher.handle + " " + payload.data.status + ".");
        await loadPortal();
      } catch (error) {
        showNotice(nodes.claimNotice, error.message || "Publisher claim failed.", "warning");
      } finally {
        setFormBusy(nodes.claimForm, false);
      }
    }

    async function uploadAndSubmit(event) {
      event.preventDefault();
      const file = nodes.artifactFile.files[0];
      const packageId = nodes.packageIdInput.value.trim();
      const version = nodes.versionInput.value.trim();
      const publisherHandle = nodes.publisherSelect.value;
      const artifactUrl = nodes.artifactUrlInput.value.trim();
      if (!packageId || !version || !publisherHandle) return showPublishError("Package, version, and publisher are required.");
      try {
        const metadata = await readArtifactMetadata(file, artifactUrl);
        if (!metadata) return showPublishError("Choose an artifact file or provide artifact URL metadata.");
        setFormBusy(nodes.publishForm, true);
        hideNode(nodes.publishError);
        showNotice(nodes.publishNotice, "Preparing artifact upload contract.");
        const upload = await api("/artifacts/uploads", {
          method: "POST",
          body: {
            packageId,
            version,
            publisherHandle,
            provider: artifactUrl ? "external-url" : "managed",
            maxBytes: Math.max(metadata.size, 104857600),
            artifact: {
              name: metadata.name,
              mediaType: metadata.mediaType,
              size: metadata.size,
              sha256: metadata.sha256,
              ...(artifactUrl ? { url: artifactUrl } : {}),
            },
          },
        });
        const slot = upload.data.uploadSlot;
        let artifactUpload = slot.artifactUpload;
        if (!artifactUrl) {
          showNotice(nodes.publishNotice, "Uploading artifact bytes.");
          await apiRaw("/artifacts/uploads/" + encodeURIComponent(slot.id), {
            method: "PUT",
            headers: {
              "content-type": metadata.mediaType,
              "x-corehub-artifact-sha256": metadata.sha256,
            },
            body: metadata.bytes,
          });
          const verified = await api("/artifacts/uploads/" + encodeURIComponent(slot.id) + "/verify", { method: "POST" });
          artifactUpload = verified.data.artifactUpload;
        }
        const submission = await api("/submissions", {
          method: "POST",
          body: {
            packageId,
            version,
            publisherHandle,
            kind: nodes.kindInput.value,
            channel: nodes.channelInput.value,
            artifactUploadId: artifactUpload.id,
            source: nodes.sourceInput.value.trim() || "https://github.com/" + publisherHandle + "/" + packageId,
            changelog: nodes.changelogInput.value.trim() || "CoreHub publisher portal submission.",
          },
        });
        showNotice(nodes.publishNotice, "Submitted " + submission.data.submission.id + " for review.");
        nodes.publishForm.reset();
        nodes.changelogInput.value = "CoreHub publisher portal submission.";
        await loadPortal();
      } catch (error) {
        showPublishError(error.message || "Package submission failed.");
      } finally {
        setFormBusy(nodes.publishForm, false);
        updatePublishMode();
      }
    }

    async function requestTransfer(event) {
      event.preventDefault();
      const packageId = nodes.transferPackage.value.trim();
      const toPublisherHandle = nodes.transferTo.value.trim();
      if (!packageId || !toPublisherHandle) return showTransferError("Package id and target publisher are required.");
      try {
        setFormBusy(nodes.transferForm, true);
        hideNode(nodes.transferError);
        await api("/transfers", {
          method: "POST",
          body: {
            packageId,
            fromPublisherHandle: nodes.transferFrom.value,
            toPublisherHandle,
            reason: nodes.transferReason.value.trim() || undefined,
          },
        });
        showNotice(nodes.transferNotice, "Transfer requested.");
        await loadPortal();
      } catch (error) {
        showTransferError(error.message || "Transfer request failed.");
      } finally {
        setFormBusy(nodes.transferForm, false);
      }
    }

    async function api(path, options = {}) {
      const response = await apiRaw(path, {
        ...options,
        headers: {
          "accept": "application/json",
          ...(options.body && !(options.body instanceof ArrayBuffer) ? { "content-type": "application/json" } : {}),
          ...(options.headers || {}),
        },
        body: options.body && !(options.body instanceof ArrayBuffer) ? JSON.stringify(options.body) : options.body,
      });
      return response.json();
    }

    async function apiRaw(path, options = {}) {
      const response = await fetch("/corehub/api/v2" + path, {
        ...options,
        headers: {
          "authorization": "Bearer " + state.session.token,
          "x-corehub-user": state.session.actor,
          "x-corehub-token": state.session.token,
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "CoreHub API request failed.");
      }
      return response;
    }

    function renderSignedOut(clearError = true) {
      nodes.portal.classList.add("hidden");
      nodes.loginPanel.classList.remove("hidden");
      nodes.rolePill.textContent = "signed out";
      nodes.rolePill.className = "status";
      nodes.sessionLabel.textContent = "Not connected";
      if (clearError) nodes.loginError.classList.add("hidden");
    }

    function renderPortal(dashboard, session) {
      nodes.loginPanel.classList.add("hidden");
      nodes.portal.classList.remove("hidden");
      const identity = dashboard.identity;
      nodes.sessionLabel.textContent = (session?.actor?.id || identity.actor.id) + " validated publisher";
      nodes.rolePill.textContent = identity.permissions.admin ? "admin publisher" : "publisher";
      nodes.rolePill.className = "status good";
      const canPublish = identity.memberships.some((membership) => membership.permissions?.includes("submission.create"));
      const canTransfer = dashboard.packages.length > 0 && identity.memberships.some((membership) => ["owner", "admin"].includes(membership.role));
      nodes.publishForm.querySelector("button[type=submit]").disabled = !canPublish;
      nodes.transferForm.querySelector("button[type=submit]").disabled = !canTransfer;
      nodes.permissionSummary.textContent = canPublish
        ? "Active publisher membership can upload artifacts and create submissions."
        : "No active publishing permission is available for this actor.";
      nodes.metricPublishers.textContent = String(dashboard.counts.publishers);
      nodes.metricPackages.textContent = String(dashboard.counts.packages);
      nodes.metricPending.textContent = String(dashboard.counts.pendingSubmissions);
      nodes.metricTransfers.textContent = String(dashboard.counts.transfers);
      nodes.whoamiRows.innerHTML = identity.memberships.map((membership) =>
        row(membership.publisherHandle, membership.role, (membership.publisher?.status || "unknown") + " · " + (membership.permissions || []).join(", "))
      ).join("") || '<p class="muted">No publisher memberships.</p>';
      renderPublisherOptions(identity.memberships);
      renderTable(nodes.packagesTable, dashboard.packages, (item) => [
        item.id,
        item.latestVersion?.version || item.version,
        item.publisher?.handle,
        item.marketplace?.channel,
        item.trustedPublisher?.repository || "not configured",
      ]);
      const filteredSubmissions = nodes.submissionFilter.value === "all"
        ? dashboard.submissions
        : dashboard.submissions.filter((item) => item.submission.status === nodes.submissionFilter.value);
      renderTable(nodes.submissionsTable, filteredSubmissions, (item) => [
        item.submission.id,
        item.submission.packageId + "@" + item.submission.version,
        statusBadge(item.submission.status),
        item.moderationReview?.id || "pending",
      ]);
      renderTable(nodes.transfersTable, dashboard.transfers, (item) => [
        item.id,
        item.packageId,
        item.fromPublisherHandle + " -> " + item.toPublisherHandle,
        statusBadge(item.status),
      ]);
      renderTable(nodes.uploadsTable, dashboard.uploadSlots, (item) => [
        item.id,
        item.packageId + "@" + item.version,
        item.publisherHandle,
        statusBadge(item.status),
      ]);
      nodes.packageCount.textContent = String(dashboard.packages.length);
      nodes.submissionCount.textContent = String(filteredSubmissions.length);
      nodes.uploadCount.textContent = String(dashboard.uploadSlots.length);
      updatePublishMode();
    }

    function renderPublisherOptions(memberships) {
      const options = memberships.map((membership) => '<option value="' + escapeHtml(membership.publisherHandle) + '">' + escapeHtml(membership.publisherHandle) + '</option>').join("");
      nodes.publisherSelect.innerHTML = options;
      nodes.transferFrom.innerHTML = options;
    }

    function renderTable(target, items, cellsFor) {
      target.innerHTML = (items || []).map((item) => "<tr>" + cellsFor(item).map((cell) => "<td>" + renderCell(cell) + "</td>").join("") + "</tr>").join("") || "<tr><td colspan=\\"5\\" class=\\"muted\\">No records</td></tr>";
    }

    function row(label, status, detail) {
      return "<div class=\\"toolbar\\" style=\\"justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0\\"><span>" + escapeHtml(label) + "</span><span><span class=\\"status " + statusClass(detail || status) + "\\">" + escapeHtml(status) + "</span> <span class=\\"muted\\">" + escapeHtml(detail || "") + "</span></span></div>";
    }

    function statusClass(value) {
      if (["active", "owner", "admin", "maintainer", "verified", "approved", "available"].includes(String(value))) return "good";
      if (["pending", "pending_review", "requested"].includes(String(value))) return "warn";
      if (["blocked", "rejected", "revoked"].includes(String(value))) return "bad";
      return "";
    }

    function showError(message) {
      nodes.loginError.textContent = message;
      nodes.loginError.classList.remove("hidden");
    }

    function showNotice(target, message, kind = "notice") {
      target.textContent = message;
      target.className = kind === "notice" ? "notice" : "notice warning";
      target.classList.remove("hidden");
    }

    function showPublishError(message) {
      nodes.publishError.textContent = message;
      nodes.publishError.classList.remove("hidden");
    }

    function showTransferError(message) {
      nodes.transferError.textContent = message;
      nodes.transferError.classList.remove("hidden");
    }

    function hideNode(node) {
      node.classList.add("hidden");
    }

    function setFormBusy(form, busy) {
      [...form.querySelectorAll("button, input, select, textarea")].forEach((node) => {
        node.disabled = busy;
      });
    }

    async function hydrateArtifactFieldsFromFile() {
      const file = nodes.artifactFile.files[0];
      if (!file) return;
      nodes.artifactNameInput.value = file.name;
      nodes.artifactMediaTypeInput.value = file.type || "application/octet-stream";
      nodes.artifactSizeInput.value = String(file.size);
      const bytes = await file.arrayBuffer();
      nodes.artifactSha256Input.value = await sha256Hex(bytes);
    }

    function updatePublishMode() {
      const external = Boolean(nodes.artifactUrlInput.value.trim());
      nodes.artifactFile.required = !external;
      nodes.artifactNameInput.required = external;
      nodes.artifactMediaTypeInput.required = external;
      nodes.artifactSizeInput.required = external;
      nodes.artifactSha256Input.required = external;
    }

    async function readArtifactMetadata(file, artifactUrl) {
      if (file) {
        const bytes = await file.arrayBuffer();
        const size = Number.parseInt(nodes.artifactSizeInput.value.trim() || String(file.size), 10);
        const sha256 = nodes.artifactSha256Input.value.trim() || await sha256Hex(bytes);
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Artifact size must be a positive integer.");
        if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Artifact SHA-256 must be 64 lowercase hex characters.");
        return {
          name: nodes.artifactNameInput.value.trim() || file.name,
          mediaType: nodes.artifactMediaTypeInput.value.trim() || file.type || "application/octet-stream",
          size,
          sha256,
          bytes,
        };
      }
      if (!artifactUrl) return null;
      const size = Number.parseInt(nodes.artifactSizeInput.value.trim(), 10);
      const sha256 = nodes.artifactSha256Input.value.trim().toLowerCase();
      if (!nodes.artifactNameInput.value.trim()) throw new Error("Artifact name is required for external URL submissions.");
      if (!nodes.artifactMediaTypeInput.value.trim()) throw new Error("Artifact media type is required for external URL submissions.");
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Artifact size must be a positive integer.");
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Artifact SHA-256 must be 64 lowercase hex characters.");
      return {
        name: nodes.artifactNameInput.value.trim(),
        mediaType: nodes.artifactMediaTypeInput.value.trim(),
        size,
        sha256,
      };
    }

    function statusBadge(value) {
      return { __html: '<span class="status ' + statusClass(value) + '">' + escapeHtml(value || "-") + '</span>' };
    }

    function renderCell(value) {
      if (value && typeof value === "object" && "__html" in value) return value.__html;
      return escapeHtml(value || "-");
    }

    async function sha256Hex(buffer) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
  </script>
</body>
</html>`;
}

function httpError(statusCode, message, options = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (options.code) error.code = options.code;
  if (options.details !== undefined) error.details = options.details;
  return error;
}

export function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const base64UrlHeader = base64UrlEncode(JSON.stringify(header));
  const base64UrlPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${base64UrlHeader}.${base64UrlPayload}`)
    .digest();
  const base64UrlSignature = base64UrlEncodeBytes(signature);
  return `${base64UrlHeader}.${base64UrlPayload}.${base64UrlSignature}`;
}

export function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const expectedSignature = createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const expectedSignatureB64 = base64UrlEncodeBytes(expectedSignature);
    if (signatureB64 !== expectedSignatureB64) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function base64UrlEncode(str) {
  return Buffer.from(str).toString("base64url");
}

function base64UrlEncodeBytes(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
