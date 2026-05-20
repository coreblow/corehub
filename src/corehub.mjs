import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const ENTRY_KINDS = new Set(["skill", "plugin", "provider", "channel"]);
export const REVIEW_STATES = new Set(["draft", "review", "verified", "deprecated"]);
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
      publisher: this.raw.publisher ?? null,
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
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => entry.toPublicRecord());
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

  search(query, options = {}) {
    return new CoreHubSearchIndex(this.entries).search(query, options);
  }
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

    requireSlug(errors, entry.id, "id");
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
    const terms = tokenize(query);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
    if (terms.length === 0) return [];

    return this.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit)
      .map((result) => ({ score: result.score, ...result.entry.toPublicRecord() }));
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
