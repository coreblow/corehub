#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repoRoot, "fixtures/plugin-lab-plugin");
const outputPath = join(repoRoot, "artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz");

const files = await listFiles(sourceRoot);
const entries = [];
for (const path of files) {
  const bytes = await readFile(join(sourceRoot, path));
  entries.push({
    path,
    bytes,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const tar = buildTar(entries);
const archive = gzipSync(tar, { mtime: 0 });
await writeFile(outputPath, archive);

const output = {
  name: "plugin-lab-0.1.0.coreblow-plugin.tgz",
  mediaType: "application/vnd.coreblow.plugin-archive+gzip",
  size: archive.byteLength,
  sha256: createHash("sha256").update(archive).digest("hex"),
  files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
};

console.log(JSON.stringify(output, null, 2));

async function listFiles(root) {
  const result = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        result.push(relative(root, path).split("\\").join("/"));
      }
    }
  }
  await walk(root);
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
