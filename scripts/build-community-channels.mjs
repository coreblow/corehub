#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreblowRoot = resolve(repoRoot, "../../coreblow");
const artifactsDir = join(repoRoot, "artifacts");
const catalogPath = join(repoRoot, "catalog.json");

const COMMUNITY_CHANNELS = [
  "discord",
  "matrix",
  "twitch",
  "feishu",
  "line",
  "zalo",
  "zalouser",
  "qqbot",
  "mattermost",
  "nextcloud-talk",
  "synology-chat",
  "tlon",
  "nostr",
  "irc",
  "msteams",
];

const STATEFUL_CHANNELS = new Set([
  "discord",
  "matrix",
  "twitch",
  "zalouser",
  "tlon",
  "nostr",
  "irc",
]);

async function listExtensionFiles(dir) {
  const result = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.name === "node_modules" || entry.name === ".DS_Store" || entry.name === ".git") {
        continue;
      }
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.js")) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(dir, fullPath).split("\\").join("/");
        result.push(rel);
      }
    }
  }
  await walk(dir);
  return result.sort((a, b) => a.localeCompare(b));
}

function buildTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    if (name.byteLength > 100) {
      throw new Error(`tar path is too long for ustar header: ${entry.path}`);
    }
    const header = Buffer.alloc(512, 0);
    writeString(header, entry.path, 0, 100);
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.bytes.byteLength, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, "ustar", 257, 6);
    writeString(header, "00", 263, 2);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    writeOctal(header, checksum, 148, 8);
    chunks.push(header, entry.bytes, Buffer.alloc(padding(entry.bytes.byteLength), 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function writeString(buffer, value, offset, length) {
  buffer.write(value, offset, length, "utf8");
}

function writeOctal(buffer, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function padding(size) {
  return (512 - (size % 512)) % 512;
}

console.log(`Packaging ${COMMUNITY_CHANNELS.length} community channels from ${coreblowRoot}/extensions/...`);

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const catalogMap = new Map(catalog.map((entry) => [entry.id, entry]));

for (const channel of COMMUNITY_CHANNELS) {
  const extDir = join(coreblowRoot, "extensions", channel);
  if (!existsSync(extDir)) {
    throw new Error(`Extension directory not found: ${extDir}`);
  }

  const pkgJsonPath = join(extDir, "package.json");
  const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf8"));
  const hotReloadSafe = !STATEFUL_CHANNELS.has(channel);

  const fileList = await listExtensionFiles(extDir);
  const entries = [];

  for (const relPath of fileList) {
    if (relPath === "corehub.artifact.json") continue;
    const bytes = await readFile(join(extDir, relPath));
    entries.push({
      path: relPath,
      bytes,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  // Generate deterministic corehub.artifact.json
  const artifactManifest = {
    schemaVersion: "corehub.plugin-artifact.v1",
    id: `@coreblow/${channel}`,
    version: "1.0.0",
    minGatewayVersion: ">=1.0.0",
    capabilities: ["network", "credentials", "webhook"],
    publisher: {
      name: "CoreBlow",
      handle: "coreblow",
      url: "https://coreblow.com/corehub",
    },
    hotReloadSafe,
    package: {
      id: `@coreblow/${channel}`,
      version: "1.0.0",
      kind: "channel",
    },
    install: {
      packageManifest: "package.json",
      pluginManifest: existsSync(join(extDir, "coreblow.plugin.json"))
        ? "coreblow.plugin.json"
        : "package.json",
      entry: pkgJson.main || "index.ts",
    },
  };

  const artifactBytes = Buffer.from(JSON.stringify(artifactManifest, null, 2), "utf8");
  entries.push({
    path: "corehub.artifact.json",
    bytes: artifactBytes,
    size: artifactBytes.byteLength,
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
  });

  // Sort entries deterministically
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // Build tar & gzip
  const tarBuffer = buildTar(entries);
  const archive = gzipSync(tarBuffer, { mtime: 0 });
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");

  const tgzFileName = `${channel}-1.0.0.coreblow-plugin.tgz`;
  const manifestFileName = `${channel}-1.0.0.corehub-manifest.json`;

  const tgzPath = join(artifactsDir, tgzFileName);
  const manifestPath = join(artifactsDir, manifestFileName);

  await writeFile(tgzPath, archive);

  const corehubManifest = {
    schemaVersion: "corehub.artifact.v1",
    package: {
      id: `@coreblow/${channel}`,
      version: "1.0.0",
      kind: "channel",
    },
    publisher: {
      handle: "coreblow",
    },
    source: "https://github.com/coreblow/coreblow",
    artifact: {
      name: tgzFileName,
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: archive.byteLength,
      sha256: archiveSha256,
      files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    },
  };

  await writeFile(manifestPath, `${JSON.stringify(corehubManifest, null, 2)}\n`, "utf8");

  // Construct catalog entry
  const catalogEntry = {
    id: `@coreblow/${channel}`,
    kind: "channel",
    name: `@coreblow/${channel}`,
    summary: `Official CoreBlow ${channel} community channel plugin.`,
    source: "https://github.com/coreblow/coreblow",
    homepage: "https://coreblow.com/corehub",
    version: "1.0.0",
    tags: ["channel", channel, "community"],
    capabilities: ["network", "credentials", "webhook"],
    publisher: {
      handle: "coreblow",
      displayName: "CoreBlow",
      url: "https://coreblow.com/corehub",
      verified: true,
      contact: "https://github.com/coreblow/coreblow/security/policy",
    },
    review: {
      state: "verified",
      checkedAt: "2026-11-02",
      notes: `Official verified CoreHub community channel for ${channel}.`,
    },
    coreblow: {
      minCoreblowVersion: "1.0.0",
      platforms: ["linux", "macos", "windows"],
    },
    versions: [
      {
        version: "1.0.0",
        tag: "latest",
        publishedAt: "2026-11-02",
        publisher: {
          handle: "coreblow",
        },
        status: "available",
        artifact: {
          name: tgzFileName,
          mediaType: "application/vnd.coreblow.plugin-archive+gzip",
          size: archive.byteLength,
          sha256: archiveSha256,
          kind: "npm-pack",
          artifactKind: "npm-pack",
          artifactSha256: archiveSha256,
          format: "tgz",
          packageName: `@coreblow/${channel}`,
          version: "1.0.0",
          downloadEnabled: true,
          storage: {
            provider: "github-raw",
            key: `artifacts/${tgzFileName}`,
            url: `https://raw.githubusercontent.com/coreblow/corehub/main/artifacts/${tgzFileName}`,
          },
          provenance: {
            source: "https://github.com/coreblow/coreblow",
            reviewState: "verified",
          },
          capabilities: {
            executesCode: true,
            runtimeId: "coreblow",
            pluginKind: "channel",
            hostTargets: ["linux", "macos", "windows"],
            capabilityTags: [
              "channel",
              "published",
              "executes-code",
              "host:linux",
              "host:macos",
              "host:windows",
              "artifact-manifest",
            ],
          },
          files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
        },
      },
    ],
  };

  catalogMap.set(catalogEntry.id, catalogEntry);
  console.log(`  ✓ Built ${channel}: ${tgzFileName} (${archive.byteLength} bytes, sha256: ${archiveSha256.slice(0, 12)}...)`);
}

// Write updated catalog.json
const updatedCatalog = Array.from(catalogMap.values());
await writeFile(catalogPath, `${JSON.stringify(updatedCatalog, null, 2)}\n`, "utf8");
console.log(`\nSuccessfully updated ${catalogPath} with ${COMMUNITY_CHANNELS.length} community channels.`);
