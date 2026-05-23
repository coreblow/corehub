import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const ENTRY_KINDS = new Set(["skill", "plugin", "provider", "channel"]);
export const REVIEW_STATES = new Set(["draft", "review", "verified", "deprecated"]);
export const VERSION_STATES = new Set(["metadata-only", "available", "deprecated", "blocked"]);
export const PACKAGE_FAMILIES = new Set(["skill", "code-plugin", "bundle-plugin"]);
export const PACKAGE_CHANNELS = new Set(["official", "community", "private"]);
export const TEXT_FILE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "json5",
  "yaml",
  "yml",
  "toml",
  "js",
  "cjs",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sh",
  "ps1",
  "psm1",
  "psd1",
  "rb",
  "go",
  "rs",
  "swift",
  "kt",
  "java",
  "sql",
  "csv",
  "tsv",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "html",
  "css",
  "scss",
  "sass",
  "svg",
]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SCOPED_NAME_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export class CoreHubEntry {
  constructor(raw) {
    this.raw = raw;
  }

  get id() {
    return this.raw.id;
  }

  get kind() {
    return this.raw.kind;
  }

  get name() {
    return this.raw.name;
  }

  get summary() {
    return this.raw.summary;
  }

  searchableText() {
    const tags = Array.isArray(this.raw.tags) ? this.raw.tags.join(" ") : "";
    const capabilities = Array.isArray(this.raw.capabilities)
      ? this.raw.capabilities.join(" ")
      : "";
    return [
      this.id,
      this.kind,
      this.name,
      this.summary,
      tags,
      capabilities,
      marketplaceFamily(this.raw),
      marketplaceChannel(this.raw),
      pluginCategory(this.raw),
      this.raw.publisher?.handle,
      this.raw.publisher?.displayName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  toPublicRecord() {
    return {
      id: this.raw.id,
      kind: this.raw.kind,
      name: this.raw.name,
      summary: this.raw.summary,
      source: this.raw.source,
      homepage: this.raw.homepage,
      version: this.raw.version,
      tags: this.raw.tags ?? [],
      capabilities: this.raw.capabilities ?? [],
      marketplace: this.raw.marketplace,
      stats: this.raw.stats,
      publisher: this.raw.publisher ?? null,
      versions: this.raw.versions ?? [],
      review: this.raw.review,
      coreblow: this.raw.coreblow,
    };
  }
}

export class CoreHubCatalog {
  constructor(entries) {
    this.entries = entries.map((entry) => new CoreHubEntry(entry));
  }

  static async fromFile(path) {
    const raw = await readFile(path, "utf8");
    return new CoreHubCatalog(JSON.parse(raw));
  }

  validate() {
    return new CoreHubCatalogValidator().validate(this.entries.map((entry) => entry.raw));
  }

  list(options = {}) {
    const { kind, verifiedOnly = false } = options;
    return this.entries
      .filter((entry) => !kind || entry.kind === kind)
      .filter((entry) => !verifiedOnly || entry.raw.review?.state === "verified")
      .map((entry) => entry.toPublicRecord())
      .filter((record) => matchesMarketplaceFilters(record, options))
      .sort((left, right) => compareDiscoveryRecords(left, right, options))
      .map((record) => withDiscoveryMetadata(record));
  }

  plugins(options = {}) {
    return this.list({ ...options, pluginOnly: true });
  }

  findById(id) {
    return this.entries.find((entry) => entry.id === id)?.toPublicRecord() ?? null;
  }

  listPublishers() {
    const publishers = new Map();
    for (const entry of this.entries) {
      const publisher = entry.raw.publisher;
      if (!publisher?.handle) continue;
      const existing = publishers.get(publisher.handle) ?? {
        ...publisher,
        entries: [],
      };
      existing.entries.push({
        id: entry.id,
        kind: entry.kind,
        name: entry.name,
      });
      publishers.set(publisher.handle, existing);
    }
    return [...publishers.values()].sort((a, b) => a.handle.localeCompare(b.handle));
  }

  findPublisher(handle) {
    return this.listPublishers().find((publisher) => publisher.handle === handle) ?? null;
  }

  listVersions(id) {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return null;
    return normalizeVersions(entry.toPublicRecord());
  }

  findVersion(id, requested) {
    const versions = this.listVersions(id);
    if (!versions) return null;
    const target = requested?.trim();
    if (!target || target === "latest") {
      return versions.find((version) => version.tag === "latest") ?? versions[0] ?? null;
    }
    return versions.find((version) => version.version === target || version.tag === target) ?? null;
  }

  search(query, options = {}) {
    return new CoreHubSearchIndex(this.entries).search(query, options);
  }
}

export function searchCatalogRecords(records, query, options = {}) {
  const terms = tokenize(query);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
  if (terms.length === 0) return [];

  return records
    .filter((record) => matchesMarketplaceFilters(record, options))
    .map((record) => ({ record, score: scoreRecord(record, terms) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || compareDiscoveryRecords(a.record, b.record))
    .slice(0, limit)
    .map((result) => ({ score: result.score, ...withDiscoveryMetadata(result.record) }));
}

export function listCatalogRecords(records, options = {}) {
  return records
    .filter((record) => matchesMarketplaceFilters(record, options))
    .sort((left, right) => compareDiscoveryRecords(left, right, options))
    .map((record) => withDiscoveryMetadata(record));
}

export function parseMarketplaceFiltersFromUrl(url, defaults = {}) {
  const filters = { ...defaults };
  const family = url.searchParams.get("family")?.trim();
  if (family) filters.family = family;
  const kind = url.searchParams.get("kind")?.trim();
  if (kind) filters.kind = kind;
  const channel = url.searchParams.get("channel")?.trim();
  if (channel) filters.channel = channel;
  const capabilityTag = url.searchParams.get("capabilityTag")?.trim() ?? url.searchParams.get("capability")?.trim();
  if (capabilityTag) filters.capabilityTag = capabilityTag;
  const category = url.searchParams.get("category")?.trim();
  if (category) filters.category = category;
  const sort = url.searchParams.get("sort")?.trim();
  if (sort) filters.sort = sort;

  const isOfficial = parseOptionalBoolean(url.searchParams, "isOfficial") ?? parseOptionalBoolean(url.searchParams, "official");
  if (isOfficial !== undefined) filters.isOfficial = isOfficial;
  const executesCode = parseOptionalBoolean(url.searchParams, "executesCode");
  if (executesCode !== undefined) filters.executesCode = executesCode;
  const featured = parseOptionalBoolean(url.searchParams, "featured") ?? parseOptionalBoolean(url.searchParams, "highlightedOnly");
  if (featured !== undefined) filters.featured = featured;
  return filters;
}

export function withDiscoveryMetadata(record) {
  const marketplace = marketplaceMetadata(record);
  return {
    ...record,
    marketplace,
  };
}

export function marketplaceMetadata(record) {
  const family = marketplaceFamily(record);
  const channel = marketplaceChannel(record);
  const latestVersion = latestPublicVersion(record);
  const stats = {
    installs: safeNumber(record.stats?.installs ?? record.analytics?.installs),
    downloads: safeNumber(record.stats?.downloads ?? record.analytics?.downloads),
  };
  return {
    family,
    channel,
    isOfficial: marketplaceOfficial(record),
    featured: marketplaceFeatured(record),
    executesCode: marketplaceExecutesCode(record, family),
    category: pluginCategory(record),
    capabilityTags: marketplaceCapabilityTags(record),
    latestVersion: latestVersion?.version ?? record.version ?? null,
    stats,
  };
}

export function matchesMarketplaceFilters(record, options = {}) {
  const marketplace = marketplaceMetadata(record);
  if (options.pluginOnly && !["code-plugin", "bundle-plugin"].includes(marketplace.family)) return false;
  if (options.kind && record.kind !== options.kind) return false;
  if (options.family && marketplace.family !== normalizeFamilyFilter(options.family)) return false;
  if (options.channel && marketplace.channel !== options.channel) return false;
  if (options.isOfficial !== undefined && marketplace.isOfficial !== options.isOfficial) return false;
  if (options.featured !== undefined && marketplace.featured !== options.featured) return false;
  if (options.executesCode !== undefined && marketplace.executesCode !== options.executesCode) return false;
  if (options.capabilityTag && !marketplace.capabilityTags.includes(normalizeDiscoveryToken(options.capabilityTag))) return false;
  if (options.category && marketplace.category !== normalizeDiscoveryToken(options.category)) return false;
  return true;
}

export function compareDiscoveryRecords(left, right, options = {}) {
  const leftMeta = marketplaceMetadata(left);
  const rightMeta = marketplaceMetadata(right);
  if (options.sort === "downloads") {
    return rightMeta.stats.downloads - leftMeta.stats.downloads || left.id.localeCompare(right.id);
  }
  if (options.sort === "installs") {
    return rightMeta.stats.installs - leftMeta.stats.installs || left.id.localeCompare(right.id);
  }
  if (options.sort === "updated") {
    return versionTimestamp(right) - versionTimestamp(left) || left.id.localeCompare(right.id);
  }
  return discoveryPriority(rightMeta) - discoveryPriority(leftMeta) || left.id.localeCompare(right.id);
}

function scoreRecord(record, terms) {
  const haystack = searchableRecordText(record);
  const id = record.id.toLowerCase();
  const name = (record.name ?? "").toLowerCase();
  const summary = (record.summary ?? "").toLowerCase();
  const capabilities = marketplaceCapabilityTags(record);
  const category = pluginCategory(record);
  let score = 0;
  for (const term of terms) {
    if (id === term) score += 24;
    if (name === term) score += 20;
    if (id.includes(term)) score += 10;
    if (name.includes(term)) score += 8;
    if (summary.includes(term)) score += 4;
    if (capabilities.includes(term)) score += 6;
    if (category === term) score += 6;
    if (haystack.includes(term)) score += 2;
  }
  const metadata = marketplaceMetadata(record);
  if (metadata.isOfficial) score += 2;
  if (metadata.featured) score += 1;
  score += Math.min(3, Math.floor(metadata.stats.downloads / 100));
  score += Math.min(3, Math.floor(metadata.stats.installs / 100));
  return score;
}

function searchableRecordText(record) {
  return [
    record.id,
    record.kind,
    record.name,
    record.summary,
    marketplaceFamily(record),
    marketplaceChannel(record),
    pluginCategory(record),
    ...(record.tags ?? []),
    ...(record.capabilities ?? []),
    ...(record.marketplace?.capabilityTags ?? []),
    record.publisher?.handle,
    record.publisher?.displayName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function marketplaceFamily(record) {
  const explicit = normalizeFamilyFilter(record.marketplace?.family ?? record.family);
  if (explicit) return explicit;
  if (record.kind === "skill") return "skill";
  if (record.kind === "plugin") return record.marketplace?.bundle ? "bundle-plugin" : "code-plugin";
  return record.kind;
}

function normalizeFamilyFilter(value) {
  if (value === "plugin") return "code-plugin";
  return PACKAGE_FAMILIES.has(value) ? value : undefined;
}

function marketplaceChannel(record) {
  const explicit = record.marketplace?.channel ?? record.channel ?? latestPublicVersion(record)?.channel;
  if (PACKAGE_CHANNELS.has(explicit)) return explicit;
  return marketplaceOfficial(record) ? "official" : "community";
}

function marketplaceOfficial(record) {
  if (typeof record.marketplace?.isOfficial === "boolean") return record.marketplace.isOfficial;
  if (typeof record.isOfficial === "boolean") return record.isOfficial;
  return Boolean(record.publisher?.verified && record.review?.state === "verified");
}

function marketplaceFeatured(record) {
  if (typeof record.marketplace?.featured === "boolean") return record.marketplace.featured;
  if (typeof record.featured === "boolean") return record.featured;
  return Boolean(marketplaceOfficial(record) && latestPublicVersion(record)?.status === "available");
}

function marketplaceExecutesCode(record, family = marketplaceFamily(record)) {
  if (typeof record.marketplace?.executesCode === "boolean") return record.marketplace.executesCode;
  if (typeof record.executesCode === "boolean") return record.executesCode;
  return family === "code-plugin";
}

function marketplaceCapabilityTags(record) {
  const tags = [
    ...(record.capabilities ?? []),
    ...(record.tags ?? []),
    ...(record.marketplace?.capabilityTags ?? []),
  ].map(normalizeDiscoveryToken).filter(Boolean);
  if (marketplaceExecutesCode(record)) tags.push("executes-code");
  const category = pluginCategory(record);
  if (category) tags.push(category);
  return [...new Set(tags)];
}

function pluginCategory(record) {
  const explicit = record.marketplace?.category ?? record.category;
  if (explicit) return normalizeDiscoveryToken(explicit);
  const text = searchableRecordTextShallow(record);
  if (/\b(channel|telegram|discord|slack|signal|whatsapp|matrix|teams)\b/.test(text)) return "channels";
  if (/\b(security|audit|scan|policy|trust)\b/.test(text)) return "security";
  if (/\b(observability|metrics|logs|monitor|analytics)\b/.test(text)) return "observability";
  if (/\b(deploy|deployment|release|ci|workflow)\b/.test(text)) return "deployment";
  if (/\b(data|storage|database|catalog)\b/.test(text)) return "data";
  if (/\b(automation|queue|scheduled|trigger)\b/.test(text)) return "automation";
  if (/\b(mcp|tooling|tool)\b/.test(text)) return "mcp-tooling";
  return "dev-tools";
}

function searchableRecordTextShallow(record) {
  return [record.id, record.name, record.summary, ...(record.tags ?? []), ...(record.capabilities ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function latestPublicVersion(record) {
  return (record.versions ?? []).find((version) => version.tag === "latest") ?? record.versions?.[0] ?? null;
}

function discoveryPriority(metadata) {
  return (metadata.featured ? 4 : 0) + (metadata.isOfficial ? 2 : 0) + Math.min(2, metadata.stats.downloads + metadata.stats.installs);
}

function versionTimestamp(record) {
  const date = latestPublicVersion(record)?.publishedAt ?? record.updatedAt ?? record.versionPublishedAt;
  const time = date ? Date.parse(date) : 0;
  return Number.isFinite(time) ? time : 0;
}

function safeNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseOptionalBoolean(params, name) {
  if (!params.has(name)) return undefined;
  const value = params.get(name)?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function normalizeDiscoveryToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class CoreHubCatalogValidator {
  validate(entries) {
    if (!Array.isArray(entries)) {
      return ["catalog must be an array"];
    }

    const ids = new Set();
    const errors = [];
    for (const [index, entry] of entries.entries()) {
      const prefix = `entries[${index}]`;
      for (const error of this.validateEntry(entry)) {
        errors.push(`${prefix}: ${error}`);
      }
      if (entry?.id) {
        if (ids.has(entry.id)) {
          errors.push(`${prefix}: duplicate id ${entry.id}`);
        }
        ids.add(entry.id);
      }
    }
    return errors;
  }

  validateEntry(entry) {
    const errors = [];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return ["entry must be an object"];
    }

    if (typeof entry.id !== "string" || (!SLUG_PATTERN.test(entry.id) && !SCOPED_NAME_PATTERN.test(entry.id))) {
      errors.push("id must be kebab-case or @scope/kebab-case");
    }
    if (typeof entry.id === "string" && entry.id.startsWith("@")) {
      const parts = entry.id.slice(1).split("/");
      const scope = parts[0];
      if (entry.publisher?.handle && scope !== entry.publisher.handle) {
        errors.push(`scoped package scope '${scope}' must match publisher handle '${entry.publisher.handle}'`);
      }
    }
    if (!ENTRY_KINDS.has(entry.kind)) {
      errors.push(`kind must be one of ${[...ENTRY_KINDS].join(", ")}`);
    }
    requireText(errors, entry.name, "name");
    requireText(errors, entry.summary, "summary");
    requireGithubUrl(errors, entry.source, "source");
    optionalUrl(errors, entry.homepage, "homepage");
    optionalSemver(errors, entry.version, "version");
    requireStringArray(errors, entry.tags, "tags", { optional: true, slugItems: true });
    requireStringArray(errors, entry.capabilities, "capabilities", { optional: true });
    this.validatePublisher(errors, entry.publisher);
    this.validateVersions(errors, entry);
    this.validateReview(errors, entry.review);
    this.validateCoreBlowMetadata(errors, entry.coreblow);
    return errors;
  }

  validatePublisher(errors, publisher) {
    if (publisher === undefined) return;
    if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) {
      errors.push("publisher must be an object");
      return;
    }
    requireSlug(errors, publisher.handle, "publisher.handle");
    requireText(errors, publisher.displayName, "publisher.displayName");
    optionalUrl(errors, publisher.url, "publisher.url");
    if (publisher.verified !== undefined && typeof publisher.verified !== "boolean") {
      errors.push("publisher.verified must be a boolean");
    }
    optionalUrl(errors, publisher.contact, "publisher.contact");
  }

  validateVersions(errors, entry) {
    if (entry.versions === undefined) return;
    if (!Array.isArray(entry.versions)) {
      errors.push("versions must be an array");
      return;
    }
    for (const [index, version] of entry.versions.entries()) {
      const prefix = `versions[${index}]`;
      if (!version || typeof version !== "object" || Array.isArray(version)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      optionalSemver(errors, version.version, `${prefix}.version`);
      optionalText(errors, version.publishedAt, `${prefix}.publishedAt`);
      if (version.tag !== undefined && !SLUG_PATTERN.test(version.tag)) {
        errors.push(`${prefix}.tag must be kebab-case`);
      }
      if (!VERSION_STATES.has(version.status)) {
        errors.push(`${prefix}.status must be one of ${[...VERSION_STATES].join(", ")}`);
      }
      this.validateVersionPublisher(errors, version.publisher, entry.publisher, prefix);
      this.validateArtifact(errors, version.artifact, prefix);
    }
  }

  validateVersionPublisher(errors, publisher, entryPublisher, prefix) {
    if (!publisher || typeof publisher !== "object" || Array.isArray(publisher)) {
      errors.push(`${prefix}.publisher must be an object`);
      return;
    }
    requireSlug(errors, publisher.handle, `${prefix}.publisher.handle`);
    if (entryPublisher?.handle && publisher.handle !== entryPublisher.handle) {
      errors.push(`${prefix}.publisher.handle must match publisher.handle`);
    }
  }

  validateArtifact(errors, artifact, prefix) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      errors.push(`${prefix}.artifact must be an object`);
      return;
    }
    requireText(errors, artifact.name, `${prefix}.artifact.name`);
    requireText(errors, artifact.mediaType, `${prefix}.artifact.mediaType`);
    requireNonNegativeInteger(errors, artifact.size, `${prefix}.artifact.size`);
    requireSha256(errors, artifact.sha256, `${prefix}.artifact.sha256`);
    if (typeof artifact.downloadEnabled !== "boolean") {
      errors.push(`${prefix}.artifact.downloadEnabled must be a boolean`);
    }
    this.validateStorage(errors, artifact.storage, artifact.downloadEnabled, prefix);
    this.validateProvenance(errors, artifact.provenance, prefix);
    if (!Array.isArray(artifact.files)) {
      errors.push(`${prefix}.artifact.files must be an array`);
      return;
    }
    for (const [index, file] of artifact.files.entries()) {
      this.validateArtifactFile(errors, file, `${prefix}.artifact.files[${index}]`);
    }
  }

  validateStorage(errors, storage, downloadEnabled, prefix) {
    if (storage === undefined) {
      if (downloadEnabled) {
        errors.push(`${prefix}.artifact.storage is required when downloads are enabled`);
      }
      return;
    }
    if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
      errors.push(`${prefix}.artifact.storage must be an object`);
      return;
    }
    if (!["github-raw", "r2", "s3", "external-url"].includes(storage.provider)) {
      errors.push(`${prefix}.artifact.storage.provider must be one of github-raw, r2, s3, external-url`);
    }
    requireText(errors, storage.key, `${prefix}.artifact.storage.key`);
    optionalText(errors, storage.region, `${prefix}.artifact.storage.region`);
    optionalUrl(errors, storage.url, `${prefix}.artifact.storage.url`);
  }

  validateProvenance(errors, provenance, prefix) {
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
      errors.push(`${prefix}.artifact.provenance must be an object`);
      return;
    }
    requireGithubUrl(errors, provenance.source, `${prefix}.artifact.provenance.source`);
    if (!REVIEW_STATES.has(provenance.reviewState)) {
      errors.push(
        `${prefix}.artifact.provenance.reviewState must be one of ${[...REVIEW_STATES].join(", ")}`,
      );
    }
  }

  validateArtifactFile(errors, file, prefix) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    requireText(errors, file.path, `${prefix}.path`);
    requireNonNegativeInteger(errors, file.size, `${prefix}.size`);
    requireSha256(errors, file.sha256, `${prefix}.sha256`);
  }

  validateReview(errors, review) {
    if (review === undefined) return;
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      errors.push("review must be an object");
      return;
    }
    if (!REVIEW_STATES.has(review.state)) {
      errors.push(`review.state must be one of ${[...REVIEW_STATES].join(", ")}`);
    }
    optionalText(errors, review.checkedAt, "review.checkedAt");
    optionalText(errors, review.notes, "review.notes");
  }

  validateCoreBlowMetadata(errors, metadata) {
    if (metadata === undefined) return;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      errors.push("coreblow must be an object");
      return;
    }
    optionalSemver(errors, metadata.minCoreblowVersion, "coreblow.minCoreblowVersion");
    requireStringArray(errors, metadata.requiresEnv, "coreblow.requiresEnv", {
      optional: true,
      envItems: true,
    });
    requireStringArray(errors, metadata.requiresBins, "coreblow.requiresBins", { optional: true });
    requireStringArray(errors, metadata.platforms, "coreblow.platforms", { optional: true });
  }
}

export class CoreHubSearchIndex {
  constructor(entries) {
    this.entries = entries;
  }

  search(query, options = {}) {
    return searchCatalogRecords(
      this.entries.map((entry) => entry.toPublicRecord()),
      query,
      options,
    );
  }
}

export class CoreHubSkillInspector {
  async inspectFolder(folder) {
    const root = resolve(folder);
    const files = await listTextFiles(root);
    const skillFile = files.find((file) => /^skill\.md$/i.test(file.path));
    const manifestFile = files.find((file) => file.path === "corehub.skill.json");
    return {
      root,
      hasSkillFile: Boolean(skillFile),
      hasManifest: Boolean(manifestFile),
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      fingerprint: buildFingerprint(files),
      files,
    };
  }
}

export async function readCatalog(path = new URL("../catalog.json", import.meta.url)) {
  return CoreHubCatalog.fromFile(path);
}

export function validateCatalog(entries) {
  return new CoreHubCatalogValidator().validate(entries);
}

export function validateCatalogEntry(entry) {
  return new CoreHubCatalogValidator().validateEntry(entry);
}

export async function listTextFiles(root) {
  const absRoot = resolve(root);
  const files = [];
  await walk(absRoot, async (path) => {
    const relPath = normalizePath(relative(absRoot, path));
    if (!relPath || hasHiddenSegment(relPath)) return;
    const ext = getExtension(relPath);
    if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) return;
    if (!ext && !(await isLikelyTextFile(path))) return;
    const bytes = await readFile(path);
    files.push({
      path: relPath,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function buildFingerprint(files) {
  const payload = files.map((file) => `${file.path}:${file.sha256}`).join("\n");
  return sha256(Buffer.from(payload));
}

function scoreEntry(entry, terms) {
  const haystack = entry.searchableText();
  let score = 0;
  for (const term of terms) {
    if (entry.id === term) score += 10;
    if (entry.kind === term) score += 5;
    if (haystack.includes(term)) score += 2;
  }
  return score;
}

function tokenize(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function requireSlug(errors, value, field) {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value)) {
    errors.push(`${field} must be kebab-case`);
  }
}

function requireText(errors, value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} is required`);
  }
}

function optionalText(errors, value, field) {
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function optionalSemver(errors, value, field) {
  if (value !== undefined && (typeof value !== "string" || !SEMVER_PATTERN.test(value))) {
    errors.push(`${field} must be semver`);
  }
}

function requireGithubUrl(errors, value, field) {
  if (typeof value !== "string" || !value.startsWith("https://github.com/")) {
    errors.push(`${field} must be a GitHub URL`);
  }
}

function optionalUrl(errors, value, field) {
  if (value !== undefined && (typeof value !== "string" || !/^https?:\/\//.test(value))) {
    errors.push(`${field} must be an HTTP URL`);
  }
}

function requireStringArray(errors, value, field, options = {}) {
  if (value === undefined && options.optional) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${field}[${index}] must be a non-empty string`);
      continue;
    }
    if (options.slugItems && !SLUG_PATTERN.test(item)) {
      errors.push(`${field}[${index}] must be kebab-case`);
    }
    if (options.envItems && !/^[A-Z][A-Z0-9_]*$/.test(item)) {
      errors.push(`${field}[${index}] must be an environment variable name`);
    }
  }
}

function requireNonNegativeInteger(errors, value, field) {
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${field} must be a non-negative integer`);
  }
}

function requireSha256(errors, value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    errors.push(`${field} must be a sha256 hex digest`);
  }
}

function normalizeVersions(record) {
  if (Array.isArray(record.versions) && record.versions.length > 0) {
    return record.versions.map((version) => ({
      id: record.id,
      version: version.version,
      tag: version.tag,
      publishedAt: version.publishedAt,
      publisher: version.publisher,
      status: version.status,
      artifact: version.artifact,
      review: record.review ?? null,
      source: record.source,
    }));
  }

  return [
    {
      id: record.id,
      version: record.version ?? null,
      tag: "latest",
      publishedAt: null,
      publisher: record.publisher ? { handle: record.publisher.handle } : null,
      status: "metadata-only",
      artifact: null,
      review: record.review ?? null,
      source: record.source,
    },
  ];
}

async function walk(dir, onFile) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, onFile);
    } else if (entry.isFile()) {
      await onFile(full);
    }
  }
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function hasHiddenSegment(path) {
  return path.split("/").some((segment) => segment.startsWith("."));
}

function getExtension(path) {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

async function isLikelyTextFile(path) {
  const info = await stat(path);
  if (info.size > 1024 * 1024) return false;
  const bytes = await readFile(path);
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
