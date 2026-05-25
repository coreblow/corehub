#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_PACKAGE_NAME = "@coreblow/corehub";
const EXPECTED_HOMEPAGE_URL = "https://coreblow.com/corehub";
const EXPECTED_BIN_PATH = "src/cli.mjs";

function parseArgs(argv) {
  const resolved = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--local") {
      resolved.local = true;
      continue;
    }
    if (arg === "--dry-run") {
      resolved.dryRun = true;
      continue;
    }
    if ((arg === "--tag" || arg === "--release-tag") && next) {
      resolved.tag = next;
      index += 1;
      continue;
    }
    if (arg === "--release-sha" && next) {
      resolved.releaseSha = next;
      index += 1;
      continue;
    }
    if (arg === "--release-main-ref" && next) {
      resolved.releaseMainRef = next;
      index += 1;
    }
  }
  return resolved;
}

function readPackageJson() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}

function isStableSemverVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value ?? "").trim());
}

function collectPackageMetadataErrors(pkg) {
  const errors = [];
  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(`package.json name must be "${EXPECTED_PACKAGE_NAME}"; found "${pkg.name ?? ""}".`);
  }
  if (!isStableSemverVersion(pkg.version)) {
    errors.push(`package.json version must be stable semver (X.Y.Z); found "${pkg.version ?? ""}".`);
  }
  if (!String(pkg.description ?? "").trim()) {
    errors.push("package.json description must be non-empty.");
  }
  if (pkg.license !== "MIT") {
    errors.push(`package.json license must be "MIT"; found "${pkg.license ?? ""}".`);
  }
  if (String(pkg.homepage ?? "").replace(/\/+$/, "") !== EXPECTED_HOMEPAGE_URL) {
    errors.push(`package.json homepage must be ${EXPECTED_HOMEPAGE_URL}; found "${pkg.homepage ?? ""}".`);
  }
  if (pkg.bin?.corehub !== EXPECTED_BIN_PATH) {
    errors.push(`package.json bin.corehub must be "${EXPECTED_BIN_PATH}"; found "${pkg.bin?.corehub ?? ""}".`);
  }
  if (!String(pkg.engines?.node ?? "").includes("22")) {
    errors.push(`package.json engines.node must require Node 22+; found "${pkg.engines?.node ?? ""}".`);
  }
  return errors;
}

function collectReleaseTagErrors({ packageVersion, releaseTag, releaseSha, releaseMainRef }) {
  const errors = [];
  const normalizedTag = String(releaseTag ?? "").trim();
  const normalizedVersion = String(packageVersion ?? "").trim();

  if (!normalizedTag) {
    errors.push("Release tag is required.");
    return errors;
  }
  if (!/^v\d+\.\d+\.\d+$/.test(normalizedTag)) {
    errors.push(`Release tag must match vX.Y.Z; found "${normalizedTag}".`);
  }
  if (normalizedTag !== `v${normalizedVersion}`) {
    errors.push(`Release tag ${normalizedTag} does not match package.json version ${normalizedVersion}.`);
  }
  if (releaseSha?.trim() && releaseMainRef?.trim()) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", releaseSha.trim(), releaseMainRef.trim()], {
        stdio: "ignore",
      });
    } catch {
      errors.push(`Tagged commit ${releaseSha.trim()} is not contained in ${releaseMainRef.trim()}.`);
    }
  }

  return errors;
}

function runPublishDryRun(pkg) {
  const tempRoot = mkdtempSync(join(tmpdir(), "corehub-npm-release-dry-run-"));
  let packFile = "";
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const packed = JSON.parse(packOutput);
    const filename = Array.isArray(packed) ? packed[0]?.filename : "";
    if (!filename) {
      throw new Error("npm pack did not return a tarball filename.");
    }
    packFile = filename;

    execFileSync("tar", ["-xzf", filename, "-C", tempRoot], { stdio: "inherit" });
    const packageRoot = join(tempRoot, "package");
    const packageJsonPath = join(packageRoot, "package.json");
    const dryRunPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    delete dryRunPackageJson.private;
    writeFileSync(packageJsonPath, `${JSON.stringify(dryRunPackageJson, null, 2)}\n`);

    console.log(`Running npm publish --dry-run against a temporary public copy of ${pkg.name}@${pkg.version}.`);
    execFileSync("npm", ["publish", packageRoot, "--dry-run", "--ignore-scripts", "--access", "public", "--tag", "latest"], {
      stdio: "inherit",
    });
  } finally {
    if (packFile) rmSync(packFile, { force: true });
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

const args = parseArgs(process.argv.slice(2));
const pkg = readPackageJson();
const releaseTag = args.tag ?? process.env.RELEASE_TAG ?? (args.local ? `v${pkg.version}` : "");
const releaseSha = args.releaseSha ?? process.env.RELEASE_SHA ?? "";
const releaseMainRef = args.releaseMainRef ?? process.env.RELEASE_MAIN_REF ?? "";

const errors = [
  ...collectPackageMetadataErrors(pkg),
  ...collectReleaseTagErrors({
    packageVersion: pkg.version,
    releaseTag,
    releaseSha,
    releaseMainRef,
  }),
];

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

if (pkg.private === true) {
  console.warn("package.json is private; preflight can pack, but the publish job will fail closed until release approval opens npm publishing.");
}

console.log(`Release metadata OK for ${pkg.name}@${pkg.version} (${releaseTag}).`);

if (args.dryRun) {
  runPublishDryRun(pkg);
}
