#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CoreHubSkillInspector, readCatalog } from "./corehub.mjs";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);
const defaultRegistry = process.env.COREHUB_REGISTRY ?? "";
const authSchemaVersion = "corehub.auth.v1";
const execFileAsync = promisify(execFile);

async function main() {
  if (command === "validate") {
    const catalog = await readCatalog();
    const errors = catalog.validate();
    if (errors.length > 0) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
    } else {
      console.log("CoreHub catalog is valid.");
    }
  } else if (command === "list" || command === "explore") {
    const registry = readOption(args, "--registry") ?? defaultRegistry;
    const kind = readOption(args, "--kind");
    printRecords(await listRecords({ registry, kind }));
  } else if (command === "search") {
    const registry = readOption(args, "--registry") ?? defaultRegistry;
    const query = positionalArgs(args).join(" ").trim();
    if (!query) throw new Error("search requires a query");
    printRecords(await searchRecords(query, { registry }));
  } else if (command === "install") {
    await runInstallCommand(args);
  } else if (command === "login" || (command === "auth" && args[0] === "login")) {
    await runLoginCommand(command === "auth" ? args.slice(1) : args);
  } else if (command === "logout" || (command === "auth" && args[0] === "logout")) {
    await runLogoutCommand();
  } else if (command === "whoami") {
    await runWhoamiCommand(args);
  } else if (command === "package") {
    await runPackageCommand(args);
  } else if (command === "publishers" || command === "publisher") {
    await runPublisherCommand(args);
  } else if (command === "registry") {
    await runRegistryCommand(args);
  } else if (command === "submission" || command === "submissions") {
    await runSubmissionCommand(args);
  } else if (command === "review" || command === "reviews") {
    await runReviewCommand(args);
  } else if (command === "skill") {
    await runSkillCommand(args);
  } else if (command === "inspect") {
    await runInspect(args);
  } else {
    printHelp();
  }
}

async function runInstallCommand(values) {
  const registry = readOption(values, "--registry") ?? defaultRegistry;
  const id = positionalArgs(values)[0];
  if (!id) throw new Error("install requires a package id");
  const output = readOption(values, "--output");
  const dryRun = hasFlag(values, "--dry-run");
  const json = hasFlag(values, "--json");
  const result = await createPackageInstallPlan(id, {
    output,
    registry,
    dryRun,
    fetchForApply: !dryRun,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printInstallResult(result);
  }
}

async function runPublisherCommand(values) {
  const subcommand = values[0] ?? "list";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "whoami") {
    await runWhoamiCommand(args);
    return;
  }

  if (subcommand === "claim") {
    await runPublisherClaimCommand(args);
    return;
  }

  if (subcommand === "list") {
    console.log(JSON.stringify(await listPublishers({ registry }), null, 2));
    return;
  }

  if (subcommand === "inspect") {
    const handle = positionalArgs(args)[0];
    if (!handle) throw new Error("publisher inspect requires a handle");
    console.log(JSON.stringify(await inspectPublisher(handle, { registry }), null, 2));
    return;
  }

  printPublisherHelp();
}

async function runLoginCommand(values) {
  const token = readOption(values, "--token") ?? process.env.COREHUB_TOKEN;
  if (!token) {
    throw new Error("CoreHub login requires --token or COREHUB_TOKEN until browser login lands.");
  }
  const actorId = readOption(values, "--user") ?? "local-user";
  const publisherHandle = normalizeHandle(readOption(values, "--publisher"));
  const auth = {
    schemaVersion: authSchemaVersion,
    token,
    actor: {
      type: "user",
      id: actorId,
    },
    defaultPublisherHandle: publisherHandle,
    createdAt: new Date().toISOString(),
  };
  await writeAuthState(auth);
  const result = await createWhoamiResult(auth);
  if (hasFlag(values, "--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Logged in as ${result.actor.id}.`);
    if (result.defaultPublisher) console.log(`Default publisher: ${result.defaultPublisher.handle}`);
  }
}

async function runLogoutCommand() {
  await rm(authStatePath(), { force: true });
  console.log("Logged out of CoreHub.");
}

async function runWhoamiCommand(values = []) {
  const auth = await requireAuthState();
  const result = await createWhoamiResult(auth);
  if (hasFlag(values, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`User: ${result.actor.id}`);
  console.log(`Token: ${result.tokenPreview}`);
  if (result.defaultPublisher) {
    console.log(`Default publisher: ${result.defaultPublisher.handle}`);
  }
  if (result.memberships.length === 0) {
    console.log("Publisher memberships: none");
  } else {
    console.log("Publisher memberships:");
    for (const membership of result.memberships) {
      console.log(`  ${membership.publisherHandle}\t${membership.role}\t${membership.status}`);
    }
  }
}

async function runPublisherClaimCommand(values) {
  const handle = normalizeHandle(positionalArgs(values)[0]);
  if (!handle) throw new Error("publisher claim requires a handle");
  const dryRun = hasFlag(values, "--dry-run");
  if (!dryRun) {
    throw new Error("publisher claim is a dry-run contract in this phase. Re-run with --dry-run.");
  }
  const auth = await requireAuthState();
  const existing = await findWriteSidePublisher(handle);
  const kind = readOption(values, "--kind") ?? "organization";
  if (!new Set(["user", "organization"]).has(kind)) {
    throw new Error("--kind must be user or organization");
  }
  const displayName = readOption(values, "--display-name") ?? titleizeHandle(handle);
  const result = {
    dryRun: true,
    status: existing ? "already_claimed" : "planned",
    actor: auth.actor,
    claim: {
      handle,
      displayName,
      kind,
      status: "pending",
      source: readOption(values, "--source") ?? `https://github.com/${handle}`,
      contact: readOption(values, "--contact") ?? `https://github.com/${handle}`,
    },
    nextStep: existing
      ? `Publisher ${handle} already exists in CoreHub write-side state.`
      : "Submit this claim to the future authenticated publisher API for verification.",
  };
  console.log(JSON.stringify(result, null, 2));
}

async function runPackageCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "explore" || subcommand === "list") {
    printRecords(await listRecords({ registry, kind: readOption(args, "--kind") }));
    return;
  }

  if (subcommand === "inspect") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package inspect requires an entry id");
    await printRecord(id, { registry, packageRoute: true });
    return;
  }

  if (subcommand === "versions") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package versions requires an entry id");
    printVersions(await readPackageVersions(id, { registry }));
    return;
  }

  if (subcommand === "files") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package files requires an entry id");
    console.log(JSON.stringify(await readPackageFiles(id, { registry }), null, 2));
    return;
  }

  if (subcommand === "artifact") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package artifact requires an entry id");
    console.log(JSON.stringify(await readPackageArtifact(id, { registry }), null, 2));
    return;
  }

  if (subcommand === "download") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package download requires an entry id");
    const output = readOption(args, "--output");
    const download = await readPackageDownload(id, { registry });
    if (output) {
      console.log(JSON.stringify(await writeVerifiedDownload(download, output), null, 2));
    } else {
      console.log(JSON.stringify(download, null, 2));
    }
    return;
  }

  if (subcommand === "install") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package install requires an entry id");
    const output = readOption(args, "--output");
    const dryRun = hasFlag(args, "--dry-run");
    console.log(JSON.stringify(await createPackageInstallPlan(id, { output, registry, dryRun }), null, 2));
    return;
  }

  if (subcommand === "submit") {
    const source = positionalArgs(args)[0];
    if (!source) throw new Error("package submit requires an artifact file or folder");
    const dryRun = hasFlag(args, "--dry-run");
    if (!dryRun) {
      throw new Error("package submit is a dry-run contract in this phase. Re-run with --dry-run.");
    }
    const result = registry
      ? await createPackageSubmissionViaRegistry(source, args, registry)
      : await createPackageSubmissionDryRun(source, args);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "upload") {
    await runPackageUploadCommand(args);
    return;
  }

  if (subcommand === "search") {
    const query = positionalArgs(args).join(" ").trim();
    if (!query) throw new Error("package search requires a query");
    printRecords(await searchRecords(query, { registry, packageRoute: true }));
    return;
  }

  if (subcommand === "publish") {
    printPlannedCommand("corehub package publish", "Registry-backed package publishing");
    return;
  }

  printPackageHelp();
}

async function runRegistryCommand(values) {
  const subcommand = values[0] ?? "info";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;
  if (!registry) throw new Error("registry info requires --registry or COREHUB_REGISTRY");

  if (subcommand === "info") {
    console.log(JSON.stringify(await new CoreHubRegistryClient(registry).info(), null, 2));
    return;
  }

  printRegistryHelp();
}

async function runReviewCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "list") {
    if (!registry) throw new Error("review list requires --registry or COREHUB_REGISTRY");
    const result = await new CoreHubRegistryClient(registry).reviews(readQueueListOptions(args));
    console.log(
      JSON.stringify(
        {
          status: "ok",
          registry: normalizeRegistry(registry),
          ...result.meta,
          reviews: result.data,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "status" || subcommand === "inspect") {
    if (!registry) throw new Error(`review ${subcommand} requires --registry or COREHUB_REGISTRY`);
    const reviewId = positionalArgs(args)[0];
    if (!reviewId) throw new Error(`review ${subcommand} requires a review id`);
    const result = await new CoreHubRegistryClient(registry).review(reviewId);
    console.log(
      JSON.stringify(
        {
          status: result.moderationReview.status,
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "approve" || subcommand === "block") {
    if (!registry) throw new Error(`review ${subcommand} requires --registry or COREHUB_REGISTRY`);
    const reviewId = positionalArgs(args)[0];
    if (!reviewId) throw new Error(`review ${subcommand} requires a review id`);
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).decideReview(
      reviewId,
      subcommand,
      { notes: readOption(args, "--notes") },
      { auth },
    );
    console.log(
      JSON.stringify(
        {
          status: subcommand === "approve" ? "approved" : "blocked",
          registry: normalizeRegistry(registry),
          actor: auth.actor,
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  printReviewHelp();
}

async function runSubmissionCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "list") {
    if (!registry) throw new Error("submissions list requires --registry or COREHUB_REGISTRY");
    const result = await new CoreHubRegistryClient(registry).submissions(readQueueListOptions(args));
    console.log(
      JSON.stringify(
        {
          status: "ok",
          registry: normalizeRegistry(registry),
          ...result.meta,
          submissions: result.data,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "inspect" || subcommand === "status") {
    if (!registry) throw new Error(`submissions ${subcommand} requires --registry or COREHUB_REGISTRY`);
    const submissionId = positionalArgs(args)[0];
    if (!submissionId) throw new Error(`submissions ${subcommand} requires a submission id`);
    const result = await new CoreHubRegistryClient(registry).submission(submissionId);
    console.log(
      JSON.stringify(
        {
          status: result.submission.status,
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  printSubmissionHelp();
}

async function runSkillCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);

  if (subcommand === "publish") {
    const folder = args[0];
    if (!folder) throw new Error("skill publish requires a folder");
    const result = await new CoreHubSkillInspector().inspectFolder(folder);
    console.log(JSON.stringify({ dryRun: true, registryPublish: "planned", ...result }, null, 2));
    return;
  }

  printSkillHelp();
}

async function runInspect(values) {
  const registry = readOption(values, "--registry") ?? defaultRegistry;
  const target = positionalArgs(values)[0];
  if (!target) throw new Error("inspect requires a catalog id or skill folder");

  if (await isDirectory(target)) {
    const result = await new CoreHubSkillInspector().inspectFolder(target);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await printRecord(target, { registry });
}

async function listRecords(options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).list({ kind: options.kind });
  }

  const catalog = await readCatalog();
  return catalog.list({ kind: options.kind });
}

async function listPublishers(options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).publishers();
  }

  const catalog = await readCatalog();
  return catalog.listPublishers();
}

async function inspectPublisher(handle, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).publisher(handle);
  }

  const catalog = await readCatalog();
  const publisher = catalog.findPublisher(handle);
  if (!publisher) throw new Error(`CoreHub publisher not found: ${handle}`);
  return publisher;
}

async function searchRecords(query, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).search(query, {
      packageRoute: options.packageRoute,
    });
  }

  const catalog = await readCatalog();
  return catalog.search(query);
}

async function printRecord(id, options = {}) {
  if (options.registry) {
    const record = await new CoreHubRegistryClient(options.registry).inspect(id, {
      packageRoute: options.packageRoute,
    });
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  const catalog = await readCatalog();
  printCatalogRecord(catalog, id);
}

async function readPackageVersions(id, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).versions(id);
  }

  const catalog = await readCatalog();
  const record = catalog.findById(id);
  if (!record) throw new Error(`CoreHub package not found: ${id}`);
  return catalog.listVersions(id);
}

async function readPackageFiles(id, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).files(id);
  }

  const catalog = await readCatalog();
  const version = readCatalogPackageVersion(catalog, id);
  const record = catalog.findById(id);
  return {
    package: { id: record.id, kind: record.kind, name: record.name },
    version: version.version ?? null,
    publisher: version.publisher ?? null,
    files: version.artifact?.files ?? [],
    artifact: version.artifact ?? null,
  };
}

async function readPackageArtifact(id, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).artifact(id);
  }

  const catalog = await readCatalog();
  const version = readCatalogPackageVersion(catalog, id);
  const record = catalog.findById(id);
  return {
    package: { id: record.id, kind: record.kind, name: record.name },
    version: version.version ?? null,
    publisher: version.publisher ?? null,
    artifact: version.artifact ?? null,
    files: version.artifact?.files ?? [],
    download: {
      available: Boolean(version.artifact?.downloadEnabled),
      reason: version.artifact?.downloadEnabled
        ? null
        : "CoreHub artifact manifests are available, but binary downloads are not enabled yet.",
    },
  };
}

async function readPackageDownload(id, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).download(id);
  }

  const artifact = await readPackageArtifact(id, options);
  if (artifact.artifact?.downloadEnabled && artifact.artifact.storage?.url) {
    return {
      package: artifact.package,
      version: artifact.version,
      publisher: artifact.publisher ?? null,
      artifact: artifact.artifact,
      download: {
        available: true,
        url: artifact.artifact.storage.url,
        redirect: "storage",
      },
    };
  }

  return {
    error: "not_implemented",
    message: "CoreHub file downloads require storage-backed artifacts and download policy enforcement.",
    package: artifact.package,
    version: artifact.version,
    publisher: artifact.publisher ?? null,
    artifact: artifact.artifact ?? null,
  };
}

async function writeVerifiedDownload(download, outputPath) {
  const artifact = download.artifact;
  const url = download.download?.url ?? artifact?.storage?.url;
  if (!download.download?.available || !artifact || !url) {
    throw new Error("CoreHub package download is not available for this artifact");
  }

  const response = await fetch(url, {
    headers: { Accept: artifact.mediaType ?? "*/*", "User-Agent": "corehub-cli" },
  });
  if (!response.ok) {
    throw new Error(`CoreHub artifact download failed: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (Number.isInteger(artifact.size) && bytes.byteLength !== artifact.size) {
    throw new Error(
      `CoreHub artifact size mismatch: expected ${artifact.size}, received ${bytes.byteLength}`,
    );
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (artifact.sha256 && digest !== artifact.sha256) {
    throw new Error(`CoreHub artifact checksum mismatch: expected ${artifact.sha256}, received ${digest}`);
  }

  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);

  return {
    ...download,
    output: {
      path,
      bytes: bytes.byteLength,
      sha256: digest,
      verified: true,
    },
  };
}

async function createPackageInstallPlan(id, options = {}) {
  const download = await readPackageDownload(id, { registry: options.registry });
  const artifact = download.artifact ?? null;
  const shouldFetchForApply =
    Boolean(options.fetchForApply) && !options.dryRun && download.download?.available;
  const outputPath =
    options.output ??
    (shouldFetchForApply && artifact?.name
      ? join(await mkdtemp(join(tmpdir(), "corehub-install-")), artifact.name)
      : null);
  const output = outputPath ? await writeVerifiedDownload(download, outputPath) : null;
  const verified = output?.output ?? null;
  const dryRun = Boolean(options.dryRun);
  const installable = isCoreBlowPluginArchive(artifact);
  const applyBlockedReason =
    installable && verified?.verified
      ? "CoreHub verified an installable CoreBlow plugin archive. CoreBlow installer boundary wiring is the next phase."
      : installable
      ? "CoreHub resolved an installable CoreBlow plugin archive. Run corehub install or provide --output to fetch and verify it before installer handoff."
      : artifact?.mediaType === "application/vnd.coreblow.corehub.manifest+json"
      ? "CoreHub resolved a registry manifest, but this version does not yet provide an installable CoreBlow plugin archive."
      : "CoreHub install apply is blocked until the CoreBlow plugin installer boundary is wired.";

  return {
    dryRun,
    install: {
      status: dryRun ? "planned" : "blocked",
      action: "install-plugin",
      writesCoreblowState: false,
      message: dryRun
        ? "CoreHub install preview only. Re-run without --dry-run when installable plugin artifacts are available."
        : applyBlockedReason,
    },
    package: download.package ?? { id },
    version: download.version ?? null,
    publisher: download.publisher ?? null,
    artifact,
    download: {
      available: Boolean(download.download?.available),
      verified: Boolean(verified?.verified),
      output: verified,
      nextStep: verified
        ? installable
          ? "Pass the verified plugin archive to the CoreBlow plugin installer boundary."
          : "Pass the verified artifact to the CoreBlow plugin installer once installer wiring is available."
        : "Run with --output <path> to fetch and verify the artifact before install.",
    },
    plan: [
      {
        step: "resolve-package",
        status: download.package ? "ready" : "blocked",
        detail: download.package ? `Resolved ${download.package.id}` : `Package ${id} was not resolved`,
      },
      {
        step: "verify-publisher",
        status: download.publisher?.handle ? "ready" : "blocked",
        detail: download.publisher?.handle
          ? `Publisher ${download.publisher.handle} is attached to this version`
          : "Publisher metadata is missing",
      },
      {
        step: "fetch-artifact",
        status: verified?.verified ? "complete" : "ready",
        detail: verified?.verified
          ? `Verified ${verified.bytes} bytes with SHA-256 ${verified.sha256}`
          : "Artifact metadata is available; no output path was provided",
      },
      {
        step: "install-plugin",
        status: dryRun ? "planned" : "blocked",
        detail: dryRun
          ? "CoreBlow plugin installation is previewed only because --dry-run was provided."
          : applyBlockedReason,
      },
    ],
  };
}

function isCoreBlowPluginArchive(artifact) {
  if (!artifact) return false;
  return (
    artifact.mediaType === "application/vnd.coreblow.plugin-archive+gzip" ||
    /\.coreblow-plugin\.t(?:ar\.)?gz$/i.test(artifact.name ?? "")
  );
}

function readCatalogPackageVersion(catalog, id, requested) {
  const record = catalog.findById(id);
  if (!record) throw new Error(`CoreHub package not found: ${id}`);
  const version = catalog.findVersion(id, requested);
  if (!version) throw new Error(`CoreHub package version not found: ${id}`);
  return version;
}

function printCatalogRecord(catalog, id) {
  const record = catalog.findById(id);
  if (!record) throw new Error(`CoreHub entry not found: ${id}`);
  console.log(JSON.stringify(record, null, 2));
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function printPlannedCommand(command, capability) {
  console.log(`${command} is planned for CoreHub Registry API v1.`);
  console.log(`${capability} will use https://coreblow.com/corehub as the public surface.`);
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  return values[index + 1];
}

function readQueueListOptions(values) {
  return {
    status: readOption(values, "--status"),
    limit: readOptionalNonNegativeInteger(values, "--limit"),
    offset: readOptionalNonNegativeInteger(values, "--offset"),
  };
}

function readOptionalNonNegativeInteger(values, name) {
  const value = readOption(values, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function hasFlag(values, name) {
  return values.includes(name);
}

function positionalArgs(values) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      if (optionTakesValue(value)) index += 1;
      continue;
    }
    result.push(value);
  }
  return result;
}

function optionTakesValue(name) {
  return new Set([
    "--contact",
    "--artifact-upload",
    "--artifact-upload-id",
    "--changelog",
    "--display-name",
    "--kind",
    "--limit",
    "--max-bytes",
    "--notes",
    "--offset",
    "--output",
    "--publisher",
    "--provider",
    "--registry",
    "--region",
    "--source",
    "--token",
    "--upload-slot",
    "--user",
    "--version",
  ]).has(name);
}

function printRecords(records) {
  for (const record of records) {
    const score = record.score === undefined ? "" : ` score=${record.score}`;
    console.log(`${record.id}\t${record.kind}\t${record.name}${score}`);
    console.log(`  ${record.summary}`);
    console.log(`  ${record.source}`);
  }
}

function printVersions(versions) {
  for (const version of versions) {
    const status = version.status ? `\t${version.status}` : "";
    console.log(
      `${version.id}\t${version.tag ?? "version"}\t${version.version ?? "unversioned"}${status}`,
    );
    if (version.publisher?.handle) console.log(`  publisher=${version.publisher.handle}`);
    if (version.artifact?.name) console.log(`  artifact=${version.artifact.name}`);
    if (version.source) console.log(`  ${version.source}`);
  }
}

function printInstallResult(result) {
  const name = result.package?.name ?? result.package?.id ?? "unknown";
  const id = result.package?.id ?? "unknown";
  const version = result.version ?? "unknown";
  const publisher = result.publisher?.handle ?? "unknown";
  const verified = result.download?.verified ? "yes" : "not yet";
  console.log(`${result.dryRun ? "Install preview" : "Install"}: ${name}`);
  console.log(`Package: ${id}`);
  console.log(`Version: ${version}`);
  console.log(`Publisher: ${publisher}`);
  console.log(`Verified artifact: ${verified}`);
  console.log(`Status: ${result.install.status}`);
  console.log(result.install.message);
}

async function runPackageUploadCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "request") {
    const source = positionalArgs(args)[0];
    if (!source) throw new Error("package upload request requires an artifact file or folder");
    if (!hasFlag(args, "--dry-run")) {
      throw new Error("package upload request is a dry-run contract in this phase. Re-run with --dry-run.");
    }
    const result = registry
      ? await createArtifactUploadRequestViaRegistry(source, args, registry)
      : await createArtifactUploadRequestDryRun(source, args);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "verify") {
    const source = positionalArgs(args)[0];
    if (!source) throw new Error("package upload verify requires an artifact file or folder");
    if (!hasFlag(args, "--dry-run")) {
      throw new Error("package upload verify is a dry-run contract in this phase. Re-run with --dry-run.");
    }
    const uploadSlotId = readOption(args, "--upload-slot");
    if (!uploadSlotId) throw new Error("package upload verify requires --upload-slot <id>");
    const result = registry
      ? await createArtifactUploadVerificationViaRegistry(source, args, registry)
      : await createArtifactUploadVerificationDryRun(source, args);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printPackageHelp();
}

async function createPackageSubmissionDryRun(source, values) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package submit");
  const packageId = inspected.package.id;
  const version = inspected.package.version;
  const now = new Date().toISOString();
  const versionSlug = slugVersion(version);
  const artifactUploadId = `artifact-${packageId}-${versionSlug}`;
  const submissionId = `submission-${packageId}-${versionSlug}`;
  const sourceUrl = readOption(values, "--source") ?? inspected.source ?? `https://github.com/${publisherHandle}/${packageId}`;
  const changelog = readOption(values, "--changelog") ?? "CoreHub package submission dry run.";
  const artifactUpload = {
    id: artifactUploadId,
    packageId,
    version,
    publisherHandle,
    status: "verified",
    storage: {
      provider: "github-raw",
      key: artifactStorageKey(publisherHandle, packageId, version, inspected.artifact.name),
      url: sourceUrl,
    },
    mediaType: inspected.artifact.mediaType,
    size: inspected.artifact.size,
    sha256: inspected.artifact.sha256,
    uploadedBy: auth.actor,
    createdAt: now,
    verifiedAt: now,
  };
  const submission = {
    id: submissionId,
    packageId,
    kind: inspected.package.kind,
    publisherHandle,
    version,
    status: "pending_review",
    artifactUploadId,
    source: sourceUrl,
    changelog,
    submittedBy: auth.actor,
    submittedAt: now,
  };
  return {
    dryRun: true,
    status: "planned",
    actor: auth.actor,
    source: {
      path: resolve(source),
      type: inspected.type,
    },
    submission,
    artifactUpload,
    packageVersionPreview: {
      id: `version-${packageId}-${versionSlug}`,
      packageId,
      version,
      tag: "latest",
      publisherHandle,
      status: "pending_review",
      artifactUploadId,
      submissionId,
      createdAt: now,
      moderationStatus: "pending",
    },
    validation: {
      ready: true,
      checks: [
        "authenticated actor resolved",
        "package id and version resolved",
        "publisher handle resolved",
        "artifact checksum computed",
        "submission remains pending review",
      ],
    },
    nextStep: "Submit this payload to the future authenticated package submission API.",
  };
}

async function createPackageSubmissionViaRegistry(source, values, registry) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package submit");
  const packageId = inspected.package.id;
  const version = inspected.package.version;
  const versionSlug = slugVersion(version);
  const artifactUploadId =
    readOption(values, "--artifact-upload") ??
    readOption(values, "--artifact-upload-id") ??
    `artifact-${packageId}-${versionSlug}`;
  const sourceUrl = readOption(values, "--source") ?? inspected.source ?? `https://github.com/${publisherHandle}/${packageId}`;
  const changelog = readOption(values, "--changelog") ?? "CoreHub package submission dry run.";
  const result = await new CoreHubRegistryClient(registry).createPackageSubmission(
    {
      packageId,
      kind: inspected.package.kind,
      publisherHandle,
      version,
      artifactUploadId,
      source: sourceUrl,
      changelog,
    },
    { auth },
  );
  return {
    dryRun: true,
    status: "remote_pending_review",
    registry: normalizeRegistry(registry),
    actor: auth.actor,
    source: {
      path: resolve(source),
      type: inspected.type,
    },
    submission: result.submission,
    artifactUpload: result.artifactUpload,
    packageVersionPreview: result.packageVersionPreview,
    moderationReview: result.moderationReview,
    validation: {
      ready: true,
      checks: [
        "authenticated actor resolved",
        "publisher handle resolved",
        "verified artifact upload resolved",
        "submission accepted by CoreHub API v2",
        "submission remains pending review",
      ],
    },
    nextStep: "Wait for moderation review before projecting this version into the public catalog.",
  };
}

async function createArtifactUploadRequestDryRun(source, values) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package upload request");
  const packageId = inspected.package.id;
  const version = inspected.package.version;
  const versionSlug = slugVersion(version);
  const provider = readOption(values, "--provider") ?? "r2";
  if (!["r2", "s3"].includes(provider)) {
    throw new Error("package upload request --provider must be r2 or s3");
  }
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const maxBytes = Number.parseInt(readOption(values, "--max-bytes") ?? "104857600", 10);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < inspected.artifact.size) {
    throw new Error("package upload request --max-bytes must be an integer greater than or equal to artifact size");
  }
  const storage = {
    provider,
    key: artifactStorageKey(publisherHandle, packageId, version, inspected.artifact.name),
  };
  const region = readOption(values, "--region");
  if (region) storage.region = region;
  const uploadSlotId = `upload-${packageId}-${versionSlug}`;
  const upload = createSignedUploadContract({
    uploadSlotId,
    storage,
    mediaType: inspected.artifact.mediaType,
    sha256: inspected.artifact.sha256,
    size: inspected.artifact.size,
    maxBytes,
    expiresAt,
  });
  const artifactUpload = {
    id: `artifact-${packageId}-${versionSlug}`,
    packageId,
    version,
    publisherHandle,
    status: "requested",
    storage,
    upload,
    mediaType: inspected.artifact.mediaType,
    size: inspected.artifact.size,
    sha256: inspected.artifact.sha256,
    uploadedBy: auth.actor,
    createdAt: now,
  };
  return {
    dryRun: true,
    status: "planned",
    actor: auth.actor,
    source: {
      path: resolve(source),
      type: inspected.type,
    },
    uploadSlot: {
      id: uploadSlotId,
      packageId,
      version,
      publisherHandle,
      storage,
      upload,
      expected: {
        mediaType: inspected.artifact.mediaType,
        size: inspected.artifact.size,
        sha256: inspected.artifact.sha256,
      },
      artifactUpload,
    },
    validation: {
      ready: true,
      checks: [
        "authenticated actor resolved",
        "publisher handle resolved",
        "artifact checksum computed",
        "managed storage locator reserved",
        "signed upload metadata generated",
      ],
    },
    nextStep: `Upload artifact bytes with ${upload.method}, then run corehub package upload verify ${inspected.artifact.name} --upload-slot ${uploadSlotId} --dry-run.`,
  };
}

async function createArtifactUploadRequestViaRegistry(source, values, registry) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package upload request");
  const provider = readOption(values, "--provider") ?? "r2";
  if (!["r2", "s3"].includes(provider)) {
    throw new Error("package upload request --provider must be r2 or s3");
  }
  const maxBytes = Number.parseInt(readOption(values, "--max-bytes") ?? "104857600", 10);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < inspected.artifact.size) {
    throw new Error("package upload request --max-bytes must be an integer greater than or equal to artifact size");
  }
  const uploadSlot = await new CoreHubRegistryClient(registry).requestArtifactUpload(
    {
      packageId: inspected.package.id,
      version: inspected.package.version,
      publisherHandle,
      provider,
      region: readOption(values, "--region"),
      maxBytes,
      artifact: {
        name: inspected.artifact.name,
        mediaType: inspected.artifact.mediaType,
        size: inspected.artifact.size,
        sha256: inspected.artifact.sha256,
      },
    },
    { auth },
  );
  return {
    dryRun: true,
    status: "remote_planned",
    registry: normalizeRegistry(registry),
    actor: auth.actor,
    source: {
      path: resolve(source),
      type: inspected.type,
    },
    uploadSlot,
    nextStep: `Upload artifact bytes with ${uploadSlot.upload.method}, then run corehub package upload verify ${inspected.artifact.name} --upload-slot ${uploadSlot.id} --registry ${normalizeRegistry(registry)} --dry-run.`,
  };
}

async function createArtifactUploadVerificationViaRegistry(source, values, registry) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  if (inspected.type !== "archive") {
    throw new Error("package upload verify with --registry requires an archive artifact file");
  }
  const uploadSlotId = readOption(values, "--upload-slot");
  const bytes = await readFile(resolve(source));
  const client = new CoreHubRegistryClient(registry);
  const uploaded = await client.putArtifactUpload(uploadSlotId, bytes, {
    auth,
    mediaType: inspected.artifact.mediaType,
    sha256: inspected.artifact.sha256,
  });
  const verified = await client.verifyArtifactUpload(uploadSlotId, { auth });
  return {
    dryRun: true,
    status: verified.status,
    registry: normalizeRegistry(registry),
    actor: auth.actor,
    uploadSlotId,
    source: {
      path: resolve(source),
      type: inspected.type,
    },
    uploaded,
    artifactUpload: verified.artifactUpload,
    verification: verified.verification,
    nextStep: "Create a package submission that references this verified artifact upload.",
  };
}

async function createArtifactUploadVerificationDryRun(source, values) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package upload verify");
  const packageId = inspected.package.id;
  const version = inspected.package.version;
  const versionSlug = slugVersion(version);
  const uploadSlotId = readOption(values, "--upload-slot");
  const expectedSlotId = `upload-${packageId}-${versionSlug}`;
  const provider = readOption(values, "--provider") ?? "r2";
  if (!["r2", "s3"].includes(provider)) {
    throw new Error("package upload verify --provider must be r2 or s3");
  }
  const storage = {
    provider,
    key: artifactStorageKey(publisherHandle, packageId, version, inspected.artifact.name),
  };
  const region = readOption(values, "--region");
  if (region) storage.region = region;
  const now = new Date().toISOString();
  const expectedArtifact = {
    uploadSlotId: expectedSlotId,
    size: inspected.artifact.size,
    sha256: inspected.artifact.sha256,
  };
  const actualArtifact = {
    uploadSlotId,
    size: inspected.artifact.size,
    sha256: inspected.artifact.sha256,
  };
  const checksumMatches = actualArtifact.sha256 === expectedArtifact.sha256;
  const sizeMatches = actualArtifact.size === expectedArtifact.size;
  return {
    dryRun: true,
    status: checksumMatches && sizeMatches ? "verified" : "rejected",
    actor: auth.actor,
    uploadSlotId,
    source: {
      path: resolve(source),
      type: inspected.type,
    },
    artifactUpload: {
      id: `artifact-${packageId}-${versionSlug}`,
      packageId,
      version,
      publisherHandle,
      status: checksumMatches && sizeMatches ? "verified" : "rejected",
      storage,
      mediaType: inspected.artifact.mediaType,
      size: inspected.artifact.size,
      sha256: inspected.artifact.sha256,
      uploadedBy: auth.actor,
      createdAt: now,
      verifiedAt: now,
    },
    verification: {
      uploadSlotMatchesSource: uploadSlotId === expectedSlotId,
      checksumMatches,
      sizeMatches,
      expected: expectedArtifact,
      actual: actualArtifact,
    },
    nextStep: "Create a package submission that references this verified artifact upload.",
  };
}

function resolvePackagePublisherHandle(values, inspected, auth, commandName) {
  const publisherHandle =
    normalizeHandle(readOption(values, "--publisher")) ||
    normalizeHandle(inspected.publisher?.handle) ||
    normalizeHandle(auth.defaultPublisherHandle);
  if (!publisherHandle) {
    throw new Error(`${commandName} requires --publisher, artifact publisher metadata, or a login publisher`);
  }
  return publisherHandle;
}

function slugVersion(version) {
  return version.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function artifactStorageKey(publisherHandle, packageId, version, artifactName) {
  return `uploads/${publisherHandle}/${packageId}/${version}/${artifactName}`;
}

function createSignedUploadContract({ uploadSlotId, storage, mediaType, sha256, size, maxBytes, expiresAt }) {
  const url = `https://coreblow.com/corehub/api/v2/artifacts/uploads/${uploadSlotId}`;
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

async function inspectPackageSubmitSource(source) {
  const path = resolve(source);
  const info = await stat(path);
  if (info.isDirectory()) return inspectPackageSubmitFolder(path);
  if (/\.json$/i.test(path)) return inspectPackageSubmitManifest(path);
  if (/\.t(?:ar\.)?gz$/i.test(path)) return inspectPackageSubmitArchive(path);
  throw new Error("package submit source must be a folder, .json manifest, or .tgz artifact");
}

async function inspectPackageSubmitFolder(path) {
  const manifest = JSON.parse(await readFile(join(path, "corehub.artifact.json"), "utf8"));
  const files = await collectFolderFiles(path);
  const hash = createHash("sha256");
  let size = 0;
  for (const file of files) {
    size += file.size;
    hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return normalizeSubmitManifest({
    type: "folder",
    sourcePath: path,
    manifest,
    artifact: {
      name: `${manifest.package.id}-${manifest.package.version}.coreblow-plugin-folder`,
      mediaType: "application/vnd.coreblow.plugin-folder",
      size,
      sha256: hash.digest("hex"),
    },
    storageKey: path,
  });
}

async function inspectPackageSubmitManifest(path) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  return normalizeSubmitManifest({
    type: "manifest",
    sourcePath: path,
    manifest,
    artifact: manifest.artifact,
    storageKey: path,
  });
}

async function inspectPackageSubmitArchive(path) {
  const bytes = await readFile(path);
  const manifest = await readArchiveCoreHubManifest(path);
  return normalizeSubmitManifest({
    type: "archive",
    sourcePath: path,
    manifest,
    artifact: {
      name: path.split(/[\\/]/).at(-1),
      mediaType: "application/vnd.coreblow.plugin-archive+gzip",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    storageKey: path,
  });
}

async function readArchiveCoreHubManifest(path) {
  const candidates = ["corehub.artifact.json", "package/corehub.artifact.json"];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync("tar", ["-xOzf", path, candidate], {
        encoding: "utf8",
      });
      return JSON.parse(stdout);
    } catch {
      // Try the next common archive layout.
    }
  }
  throw new Error("package submit archive must contain corehub.artifact.json");
}

function normalizeSubmitManifest({ type, sourcePath, manifest, artifact, storageKey }) {
  const pkg = manifest.package;
  if (!pkg?.id || !pkg?.version || !pkg?.kind) {
    throw new Error("package submit metadata must include package.id, package.version, and package.kind");
  }
  if (!artifact?.sha256 || !Number.isInteger(artifact.size)) {
    throw new Error("package submit metadata must include artifact.size and artifact.sha256");
  }
  return {
    type,
    sourcePath,
    package: pkg,
    publisher: manifest.publisher ?? null,
    source: manifest.source,
    artifact,
  };
}

async function collectFolderFiles(root) {
  const result = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = await readFile(path);
      result.push({
        path: path.slice(root.length + 1).replaceAll("\\", "/"),
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function createWhoamiResult(auth) {
  const writeSideState = await readWriteSideState();
  const memberships = writeSideState.publisherMembers.filter(
    (member) => member.userId === auth.actor.id && member.status === "active",
  );
  const defaultPublisher =
    writeSideState.publisherAccounts.find(
      (publisher) => publisher.handle === auth.defaultPublisherHandle,
    ) ??
    writeSideState.publisherAccounts.find(
      (publisher) => publisher.handle === memberships[0]?.publisherHandle,
    ) ??
    null;
  return {
    authenticated: true,
    auth: {
      schemaVersion: auth.schemaVersion,
      createdAt: auth.createdAt,
    },
    actor: auth.actor,
    tokenPreview: previewToken(auth.token),
    defaultPublisher,
    memberships,
    registryWrite: {
      status: "planned",
      api: "/corehub/api/v2/publishers/me",
    },
  };
}

async function readWriteSideState() {
  const path = new URL("../fixtures/write-side-state.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8"));
}

async function findWriteSidePublisher(handle) {
  const writeSideState = await readWriteSideState();
  return writeSideState.publisherAccounts.find((publisher) => publisher.handle === handle) ?? null;
}

async function requireAuthState() {
  const auth = await readAuthState();
  if (!auth) throw new Error("Not logged in. Run: corehub login --token <token>");
  return auth;
}

async function readAuthState() {
  const envToken = process.env.COREHUB_TOKEN;
  if (envToken) {
    return {
      schemaVersion: authSchemaVersion,
      token: envToken,
      actor: {
        type: "user",
        id: process.env.COREHUB_USER ?? "env-user",
      },
      defaultPublisherHandle: normalizeHandle(process.env.COREHUB_PUBLISHER),
      createdAt: "env",
    };
  }
  try {
    const raw = JSON.parse(await readFile(authStatePath(), "utf8"));
    if (raw?.schemaVersion !== authSchemaVersion || !raw.token || !raw.actor?.id) {
      throw new Error(`CoreHub auth state is invalid at ${authStatePath()}`);
    }
    return raw;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAuthState(auth) {
  const path = authStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
}

function authStatePath() {
  const root = process.env.COREHUB_HOME || join(homedir(), ".corehub");
  return join(root, "auth.json");
}

function previewToken(token) {
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function normalizeHandle(handle) {
  const normalized = String(handle ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
  if (!normalized) return "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    throw new Error("publisher handle must be lowercase kebab-case");
  }
  return normalized;
}

function titleizeHandle(handle) {
  return handle
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

class CoreHubRegistryClient {
  constructor(registry) {
    this.registry = normalizeRegistry(registry);
  }

  async list(options = {}) {
    const url = this.apiUrl("/entries");
    if (options.kind) url.searchParams.set("kind", options.kind);
    return this.readData(url);
  }

  async info() {
    return this.readData(this.apiUrl(""));
  }

  async search(query, options = {}) {
    const path = options.packageRoute ? "/packages/search" : "/search";
    const url = this.apiUrl(path);
    url.searchParams.set("q", query);
    return this.readData(url);
  }

  async inspect(id, options = {}) {
    const path = options.packageRoute ? `/packages/${encodeURIComponent(id)}` : `/entries/${encodeURIComponent(id)}`;
    return this.readData(this.apiUrl(path));
  }

  async versions(id) {
    return this.readData(this.apiUrl(`/packages/${encodeURIComponent(id)}/versions`));
  }

  async files(id) {
    return this.readData(this.apiUrl(`/packages/${encodeURIComponent(id)}/files`));
  }

  async artifact(id) {
    return this.readData(this.apiUrl(`/packages/${encodeURIComponent(id)}/artifact`));
  }

  async download(id) {
    const url = this.apiUrl(`/packages/${encodeURIComponent(id)}/download`);
    url.searchParams.set("redirect", "false");
    return this.readData(url, { allowStatuses: new Set([501]) });
  }

  async publishers() {
    return this.readData(this.apiUrl("/publishers"));
  }

  async publisher(handle) {
    return this.readData(this.apiUrl(`/publishers/${encodeURIComponent(handle)}`));
  }

  async submissions(options = {}) {
    const url = this.apiV2Url("/submissions");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url);
  }

  async submission(submissionId) {
    return this.readV2Data(this.apiV2Url(`/submissions/${encodeURIComponent(submissionId)}`));
  }

  async reviews(options = {}) {
    const url = this.apiV2Url("/reviews");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url);
  }

  async review(reviewId) {
    return this.readV2Data(this.apiV2Url(`/reviews/${encodeURIComponent(reviewId)}`));
  }

  async requestArtifactUpload(payload, options = {}) {
    return this.writeData(this.apiV2Url("/artifacts/uploads"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    }).then((data) => data.uploadSlot);
  }

  async putArtifactUpload(uploadSlotId, bytes, options = {}) {
    return this.writeData(this.apiV2Url(`/artifacts/uploads/${encodeURIComponent(uploadSlotId)}`), {
      auth: options.auth,
      method: "PUT",
      body: bytes,
      headers: {
        "Content-Type": options.mediaType ?? "application/octet-stream",
        "x-corehub-artifact-sha256": options.sha256,
      },
      expectedVersion: "v2",
    });
  }

  async verifyArtifactUpload(uploadSlotId, options = {}) {
    return this.writeData(this.apiV2Url(`/artifacts/uploads/${encodeURIComponent(uploadSlotId)}/verify`), {
      auth: options.auth,
      method: "POST",
      expectedVersion: "v2",
    });
  }

  async createPackageSubmission(payload, options = {}) {
    return this.writeData(this.apiV2Url("/submissions"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async decideReview(reviewId, decision, payload = {}, options = {}) {
    return this.writeData(this.apiV2Url(`/reviews/${encodeURIComponent(reviewId)}/${decision}`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  apiUrl(path) {
    return new URL(`${this.registry}/api/v1${path}`);
  }

  apiV2Url(path) {
    return new URL(`${this.registry}/api/v2${path}`);
  }

  async readData(url, options = {}) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "corehub-cli" },
    });
    const allowedStatuses = options.allowStatuses ?? new Set();
    if (!response.ok && !allowedStatuses.has(response.status)) {
      throw new Error(`CoreHub registry request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!payload || payload.apiVersion !== "v1" || !("data" in payload)) {
      throw new Error("CoreHub registry returned an invalid v1 response");
    }
    return payload.data;
  }

  async readV2Data(url) {
    return (await this.readV2Envelope(url)).data;
  }

  async readV2Envelope(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "corehub-cli" },
    });
    if (!response.ok) {
      throw new Error(`CoreHub registry request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!payload || payload.apiVersion !== "v2" || !("data" in payload)) {
      throw new Error("CoreHub registry returned an invalid v2 response");
    }
    return { data: payload.data, meta: payload.meta ?? {} };
  }

  async writeData(url, options = {}) {
    const response = await fetch(url, {
      method: options.method,
      headers: this.authHeaders(options.auth, options.headers),
      body: options.body,
    });
    if (!response.ok) {
      throw new Error(`CoreHub registry request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!payload || payload.apiVersion !== options.expectedVersion || !("data" in payload)) {
      throw new Error(`CoreHub registry returned an invalid ${options.expectedVersion} response`);
    }
    return payload.data;
  }

  authHeaders(auth, headers = {}) {
    return {
      Accept: "application/json",
      "User-Agent": "corehub-cli",
      ...(auth?.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...(auth?.actor?.id ? { "x-corehub-user": auth.actor.id } : {}),
      ...headers,
    };
  }
}

function normalizeRegistry(registry) {
  const text = String(registry ?? "").trim().replace(/\/+$/, "");
  if (!text) return "";
  if (!/^https?:\/\//.test(text)) {
    throw new Error("--registry must be an HTTP URL");
  }
  return text.endsWith("/corehub") ? text : `${text}/corehub`;
}

function printHelp() {
  console.log(`CoreHub CLI

Usage:
  corehub validate
  corehub login --token <token> [--user github:<login>] [--publisher <handle>]
  corehub whoami [--json]
  corehub logout
  corehub explore [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub list [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub search <query> [--registry https://coreblow.com/corehub]
  corehub install <entry-id> [--dry-run] [--output artifact.json] [--json] [--registry https://coreblow.com/corehub]
  corehub inspect <entry-id|skill-folder> [--registry https://coreblow.com/corehub]
  corehub publishers list [--registry https://coreblow.com/corehub]
  corehub publishers inspect <handle> [--registry https://coreblow.com/corehub]
  corehub publisher whoami [--json]
  corehub publisher claim <handle> --dry-run [--display-name name] [--kind user|organization]
  corehub submissions list [--status pending_review|approved|rejected] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub submissions inspect <submission-id> --registry https://coreblow.com/corehub
  corehub review list [--status open|approved|blocked] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub review status <review-id> --registry https://coreblow.com/corehub
  corehub review approve <review-id> --registry https://coreblow.com/corehub [--notes text]
  corehub review block <review-id> --registry https://coreblow.com/corehub [--notes text]
  corehub skill publish <skill-folder>
  corehub package explore [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub package search <query> [--registry https://coreblow.com/corehub]
  corehub package inspect <entry-id> [--registry https://coreblow.com/corehub]
  corehub package versions <entry-id> [--registry https://coreblow.com/corehub]
  corehub package files <entry-id> [--registry https://coreblow.com/corehub]
  corehub package artifact <entry-id> [--registry https://coreblow.com/corehub]
  corehub package download <entry-id> [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package install <entry-id> [--dry-run] [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package submit <artifact|folder> --dry-run [--publisher handle] [--source url] [--changelog text] [--registry https://coreblow.com/corehub]
  corehub package upload request <artifact|folder> --dry-run [--publisher handle] [--provider r2|s3]
  corehub package upload verify <artifact|folder> --upload-slot <id> --dry-run [--publisher handle]
  corehub package publish <source>
  corehub registry info --registry https://coreblow.com/corehub
`);
}

function printPackageHelp() {
  console.log(`CoreHub package commands

Usage:
  corehub package explore [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub package search <query> [--registry https://coreblow.com/corehub]
  corehub package inspect <entry-id> [--registry https://coreblow.com/corehub]
  corehub package versions <entry-id> [--registry https://coreblow.com/corehub]
  corehub package files <entry-id> [--registry https://coreblow.com/corehub]
  corehub package artifact <entry-id> [--registry https://coreblow.com/corehub]
  corehub package download <entry-id> [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package install <entry-id> [--dry-run] [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package submit <artifact|folder> --dry-run [--publisher handle] [--source url] [--changelog text] [--registry https://coreblow.com/corehub]
  corehub package upload request <artifact|folder> --dry-run [--publisher handle] [--provider r2|s3]
  corehub package upload verify <artifact|folder> --upload-slot <id> --dry-run [--publisher handle]
  corehub package publish <source>
`);
}

function printRegistryHelp() {
  console.log(`CoreHub registry commands

Usage:
  corehub registry info --registry https://coreblow.com/corehub
`);
}

function printReviewHelp() {
  console.log(`CoreHub review commands

Usage:
  corehub review list [--status open|approved|blocked] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub review status <review-id> --registry https://coreblow.com/corehub
  corehub review inspect <review-id> --registry https://coreblow.com/corehub
  corehub review approve <review-id> --registry https://coreblow.com/corehub [--notes text]
  corehub review block <review-id> --registry https://coreblow.com/corehub [--notes text]
`);
}

function printSubmissionHelp() {
  console.log(`CoreHub submission commands

Usage:
  corehub submissions list [--status pending_review|approved|rejected] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub submissions inspect <submission-id> --registry https://coreblow.com/corehub
  corehub submissions status <submission-id> --registry https://coreblow.com/corehub
`);
}

function printPublisherHelp() {
  console.log(`CoreHub publisher commands

Usage:
  corehub publisher whoami [--json]
  corehub publisher claim <handle> --dry-run [--display-name name] [--kind user|organization]
  corehub publishers list [--registry https://coreblow.com/corehub]
  corehub publishers inspect <handle> [--registry https://coreblow.com/corehub]
`);
}

function printSkillHelp() {
  console.log(`CoreHub skill commands

Usage:
  corehub skill publish <skill-folder>
`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
