#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CoreHubSkillInspector, listCatalogRecords, readCatalog } from "./corehub.mjs";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);
const defaultRegistry = process.env.COREHUB_REGISTRY ?? "";
const authSchemaVersion = "corehub.auth.v1";
const installStateSchemaVersion = "corehub.installs.v1";
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
  } else if (command === "admin") {
    await runAdminCommand(args);
  } else if (command === "audit") {
    await runAuditCommand(args);
  } else if (command === "analytics" || command === "install-events") {
    await runAnalyticsCommand(args);
  } else if (command === "submission" || command === "submissions") {
    await runSubmissionCommand(args);
  } else if (command === "review" || command === "reviews") {
    await runReviewCommand(args);
  } else if (command === "transfer" || command === "transfers") {
    await runTransferCommand(args);
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
  const registry = readOption(values, "--registry") ?? defaultRegistry;
  const result = await createWhoamiResult(auth, registry);
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
  const registry = readOption(values, "--registry") ?? defaultRegistry;
  const auth = await requireAuthState();
  const result = await createWhoamiResult(auth, registry);
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
  const auth = await requireAuthState();
  const kind = readOption(values, "--kind") ?? "organization";
  if (!new Set(["user", "organization"]).has(kind)) {
    throw new Error("--kind must be user or organization");
  }
  const displayName = readOption(values, "--display-name") ?? titleizeHandle(handle);
  const source = readOption(values, "--source") ?? `https://github.com/${handle}`;
  const contact = readOption(values, "--contact") ?? `https://github.com/${handle}`;

  if (!dryRun) {
    const registry = readOption(values, "--registry") ?? defaultRegistry;
    if (!registry) {
      throw new Error("publisher claim requires --registry or COREHUB_REGISTRY for live claim");
    }
    const client = new CoreHubRegistryClient(registry);
    const result = await client.claimPublisher({ handle, displayName, kind, source, contact }, { auth });
    console.log(JSON.stringify({ ...result, dryRun: false }, null, 2));
    return;
  }

  const existing = await findWriteSidePublisher(handle);
  const result = {
    dryRun: true,
    status: existing ? "already_claimed" : "planned",
    actor: auth.actor,
    claim: {
      handle,
      displayName,
      kind,
      status: "pending",
      source,
      contact,
    },
    nextStep: existing
      ? `Publisher ${handle} already exists in CoreHub write-side state.`
      : "Submit this claim to the authenticated publisher API for verification.",
  };
  console.log(JSON.stringify(result, null, 2));
}

async function runPackageCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "explore" || subcommand === "list") {
    printRecords(await listRecords({ registry, packageRoute: true, ...readDiscoveryOptions(args) }));
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

  if (subcommand === "verify") {
    const source = positionalArgs(args)[0];
    if (!source) throw new Error("package verify requires an artifact file");
    console.log(JSON.stringify(await createPackageVerifyResult(source, args, registry), null, 2));
    return;
  }

  if (subcommand === "moderation-status" || subcommand === "moderation") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error(`package ${subcommand} requires an entry id`);
    console.log(JSON.stringify(await readPackageModerationStatus(id, { registry }), null, 2));
    return;
  }

  if (subcommand === "readiness" || subcommand === "migration-status") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error(`package ${subcommand} requires an entry id`);
    const result = await readPackageReadiness(id, { registry });
    console.log(JSON.stringify({ ...result, command: `package.${subcommand}` }, null, 2));
    return;
  }

  if (subcommand === "report") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package report requires an entry id");
    if (!registry) throw new Error("package report requires --registry or COREHUB_REGISTRY");
    const reason = readOption(args, "--reason");
    if (!reason) throw new Error("package report requires --reason <text>");
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).createPackageReport(
      { packageId: id, version: readOption(args, "--version"), reason },
      { auth },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "appeal") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package appeal requires an entry id");
    if (!registry) throw new Error("package appeal requires --registry or COREHUB_REGISTRY");
    const version = readOption(args, "--version");
    if (!version) throw new Error("package appeal requires --version <version>");
    const message = readOption(args, "--message");
    if (!message) throw new Error("package appeal requires --message <text>");
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).createPackageAppeal(
      { packageId: id, version, message },
      { auth },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "reports") {
    await runPackageReportsCommand(args, registry);
    return;
  }

  if (subcommand === "appeals") {
    await runPackageAppealsCommand(args, registry);
    return;
  }

  if (subcommand === "trusted-publisher") {
    await runPackageTrustedPublisherCommand(args, registry);
    return;
  }

  if (subcommand === "publish-token") {
    await runPackagePublishTokenCommand(args, registry);
    return;
  }

  if (subcommand === "delete") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package delete requires an entry id");
    if (!registry) throw new Error("package delete requires --registry or COREHUB_REGISTRY");
    if (!hasFlag(args, "--yes")) throw new Error("package delete requires --yes");
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).deletePackage(
      id,
      { reason: readOption(args, "--reason") },
      { auth },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "undelete") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package undelete requires an entry id");
    if (!registry) throw new Error("package undelete requires --registry or COREHUB_REGISTRY");
    if (!hasFlag(args, "--yes")) throw new Error("package undelete requires --yes");
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).undeletePackage(id, { auth });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "install") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package install requires an entry id");
    const output = readOption(args, "--output");
    const dryRun = hasFlag(args, "--dry-run");
    console.log(
      JSON.stringify(
        await createPackageInstallPlan(id, {
          output,
          registry,
          dryRun,
          fetchForApply: !dryRun,
        }),
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "installed" || subcommand === "installs") {
    await runPackageInstalledCommand(args, registry);
    return;
  }

  if (["pin", "unpin", "uninstall", "update", "sync"].includes(subcommand)) {
    await runPackageInstalledCommand([subcommand, ...args], registry);
    return;
  }

  if (subcommand === "submit") {
    const source = positionalArgs(args)[0];
    if (!source) throw new Error("package submit requires an artifact file or folder");
    const dryRun = hasFlag(args, "--dry-run");
    if (!dryRun) {
      if (!registry) {
        throw new Error("package submit requires --registry or COREHUB_REGISTRY for live submissions");
      }
      const result = await executePackagePublish(source, args, registry);
      console.log(JSON.stringify(result, null, 2));
      return;
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

  if (subcommand === "transfer") {
    await runTransferCommand(args);
    return;
  }

  if (subcommand === "search") {
    const query = positionalArgs(args).join(" ").trim();
    if (!query) throw new Error("package search requires a query");
    printRecords(await searchRecords(query, { registry, packageRoute: true, ...readDiscoveryOptions(args) }));
    return;
  }

  if (subcommand === "publish") {
    await runPackagePublishCommand(args, registry);
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
  const auth = await readAuthState();

  if (subcommand === "list") {
    if (!registry) throw new Error("review list requires --registry or COREHUB_REGISTRY");
    const result = await new CoreHubRegistryClient(registry).reviews({ ...readQueueListOptions(args), auth });
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
    const result = await new CoreHubRegistryClient(registry).review(reviewId, { auth });
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

  if (subcommand === "assign") {
    if (!registry) throw new Error("review assign requires --registry or COREHUB_REGISTRY");
    const reviewId = positionalArgs(args)[0];
    if (!reviewId) throw new Error("review assign requires a review id");
    const assignee = readOption(args, "--to") ?? readOption(args, "--assignee") ?? positionalArgs(args)[1];
    if (!assignee) throw new Error("review assign requires --to <actor-id>");
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).assignReview(reviewId, { assignee }, { auth });
    console.log(
      JSON.stringify(
        {
          status: result.moderationReview.status,
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

  if (subcommand === "evidence") {
    const evidenceCommand = args[0] ?? "help";
    const evidenceArgs = args.slice(1);
    if (evidenceCommand !== "add") {
      printReviewHelp();
      return;
    }
    if (!registry) throw new Error("review evidence add requires --registry or COREHUB_REGISTRY");
    const reviewId = positionalArgs(evidenceArgs)[0];
    if (!reviewId) throw new Error("review evidence add requires a review id");
    const type = readOption(evidenceArgs, "--type") ?? "manual_note";
    const summary = readOption(evidenceArgs, "--summary") ?? readOption(evidenceArgs, "--notes");
    if (!summary) throw new Error("review evidence add requires --summary or --notes");
    const auth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).addReviewEvidence(reviewId, { type, summary }, { auth });
    console.log(
      JSON.stringify(
        {
          status: result.moderationReview.status,
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
  const auth = await readAuthState();

  if (subcommand === "list") {
    if (!registry) throw new Error("submissions list requires --registry or COREHUB_REGISTRY");
    const result = await new CoreHubRegistryClient(registry).submissions({ ...readQueueListOptions(args), auth });
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
    const result = await new CoreHubRegistryClient(registry).submission(submissionId, { auth });
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

async function runTransferCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;
  const auth = await readAuthState();

  if (subcommand === "list") {
    if (!registry) throw new Error("transfers list requires --registry or COREHUB_REGISTRY");
    const result = await new CoreHubRegistryClient(registry).transfers({
      ...readQueueListOptions(args),
      packageId: readOption(args, "--package"),
      auth,
    });
    console.log(
      JSON.stringify(
        {
          status: "ok",
          registry: normalizeRegistry(registry),
          ...result.meta,
          transfers: result.data,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "inspect" || subcommand === "status") {
    if (!registry) throw new Error(`transfers ${subcommand} requires --registry or COREHUB_REGISTRY`);
    const transferId = positionalArgs(args)[0];
    if (!transferId) throw new Error(`transfers ${subcommand} requires a transfer id`);
    const result = await new CoreHubRegistryClient(registry).transfer(transferId, { auth });
    console.log(
      JSON.stringify(
        {
          status: result.transfer.status,
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "request") {
    if (!registry) throw new Error("transfers request requires --registry or COREHUB_REGISTRY");
    const packageId = positionalArgs(args)[0];
    if (!packageId) throw new Error("transfers request requires a package id");
    const fromPublisherHandle = normalizeHandle(readOption(args, "--from") ?? auth?.defaultPublisherHandle);
    const toPublisherHandle = normalizeHandle(readOption(args, "--to"));
    if (!fromPublisherHandle) throw new Error("transfers request requires --from or a login publisher");
    if (!toPublisherHandle) throw new Error("transfers request requires --to <publisher>");
    const requiredAuth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).requestTransfer(
      {
        packageId,
        fromPublisherHandle,
        toPublisherHandle,
        reason: readOption(args, "--reason") ?? readOption(args, "--notes"),
      },
      { auth: requiredAuth },
    );
    console.log(
      JSON.stringify(
        {
          status: result.transfer.status,
          registry: normalizeRegistry(registry),
          actor: requiredAuth.actor,
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (["accept", "reject", "cancel"].includes(subcommand)) {
    if (!registry) throw new Error(`transfers ${subcommand} requires --registry or COREHUB_REGISTRY`);
    const transferId = positionalArgs(args)[0];
    if (!transferId) throw new Error(`transfers ${subcommand} requires a transfer id`);
    const requiredAuth = await requireAuthState();
    const result = await new CoreHubRegistryClient(registry).decideTransfer(
      transferId,
      subcommand,
      { notes: readOption(args, "--notes") },
      { auth: requiredAuth },
    );
    console.log(
      JSON.stringify(
        {
          status: result.transfer.status,
          registry: normalizeRegistry(registry),
          actor: requiredAuth.actor,
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTransferHelp();
}

async function runAnalyticsCommand(values) {
  const subcommand = values[0] ?? "summary";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;
  if (!registry) throw new Error("analytics requires --registry or COREHUB_REGISTRY");

  if (subcommand === "record" || subcommand === "ingest") {
    const packageId = positionalArgs(args)[0];
    if (!packageId) throw new Error(`analytics ${subcommand} requires a package id`);
    const version = readOption(args, "--version") ?? "latest";
    const event = readOption(args, "--event") ?? "installed";
    const source = readOption(args, "--source") ?? "cli";
    const clientId = readOption(args, "--client-id");
    const reason = readOption(args, "--reason");
    if (process.env.COREHUB_DISABLE_TELEMETRY === "1") {
      console.log(
        JSON.stringify(
          {
            status: "skipped",
            reason: "telemetry_disabled",
            packageId,
            version,
            event,
            source,
          },
          null,
          2,
        ),
      );
      return;
    }
    const auth = await readAuthState();
    const result = await new CoreHubRegistryClient(registry).recordInstallEvent(
      { packageId, version, event, source, clientId, reason },
      { auth },
    );
    console.log(
      JSON.stringify(
        {
          status: "recorded",
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "summary" || subcommand === "summarize") {
    const auth = await readAuthState();
    const result = await new CoreHubRegistryClient(registry).installAnalyticsSummary({
      auth,
      packageId: readOption(args, "--package"),
      version: readOption(args, "--version"),
      event: readOption(args, "--event"),
      source: readOption(args, "--source"),
      since: readOption(args, "--since"),
      until: readOption(args, "--until"),
    });
    console.log(
      JSON.stringify(
        {
          status: "ok",
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  printAnalyticsHelp();
}

async function runAdminCommand(values) {
  const subcommand = values[0] ?? "status";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;
  if (!registry) throw new Error("admin requires --registry or COREHUB_REGISTRY");
  const auth = await readAuthState();
  const client = new CoreHubRegistryClient(registry);

  if (subcommand === "status" || subcommand === "health") {
    const result = await client.adminStatus({ auth });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    if (result.status !== "ok" || result.readiness?.status !== "ready") process.exitCode = 1;
    return;
  }

  if (subcommand === "support-bundle") {
    const output = readOption(args, "--output");
    const limit = readOptionalNonNegativeInteger(args, "--limit") ?? 20;
    const result = await client.adminSupportBundle({ auth, limit });
    const payload = {
      status: result.status,
      registry: normalizeRegistry(registry),
      ...result,
    };
    const rendered = `${JSON.stringify(payload, null, 2)}\n`;
    if (output) {
      await writeTextOutput(output, rendered);
      console.log(
        JSON.stringify(
          {
            status: "exported",
            healthStatus: result.status,
            readiness: result.readiness?.status,
            registry: normalizeRegistry(registry),
            output: resolve(output),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(rendered);
    }
    if (result.status !== "ok" || result.readiness?.status !== "ready") process.exitCode = 1;
    return;
  }

  printAdminHelp();
}

async function runAuditCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "alert-metrics") {
    const metricsCommand = args[0] ?? "help";
    const metricsArgs = args.slice(1);
    if (!new Set(["summarize", "assert"]).has(metricsCommand)) {
      printAuditHelp();
      return;
    }
    const input = positionalArgs(metricsArgs)[0];
    if (!input) throw new Error(`audit alert-metrics ${metricsCommand} requires a JSONL file`);
    const format = readOption(metricsArgs, "--format") ?? "json";
    if (!new Set(["json", "markdown"]).has(format)) throw new Error("--format must be json or markdown");
    const output = readOption(metricsArgs, "--output");
    const summary = summarizeAuditAlertDeliveryMetrics(await readFile(input, "utf8"), { input: resolve(input) });
    if (metricsCommand === "assert") {
      const assertion = assertAuditAlertDeliveryMetrics(summary, {
        maxDeadLetterRate: readOptionalRate(metricsArgs, "--max-dead-letter-rate"),
        maxRetryRate: readOptionalRate(metricsArgs, "--max-retry-rate"),
        maxFailedRate: readOptionalRate(metricsArgs, "--max-failed-rate"),
      });
      console.log(JSON.stringify(assertion, null, 2));
      if (assertion.status !== "passed") process.exitCode = 1;
      return;
    }
    const rendered = format === "markdown" ? formatAlertMetricsSummaryMarkdown(summary) : `${JSON.stringify(summary, null, 2)}\n`;
    if (output) {
      await writeTextOutput(output, rendered);
      console.log(
        JSON.stringify(
          {
            status: "exported",
            format,
            input: summary.input,
            output: resolve(output),
            parsedMetrics: summary.parsedMetrics,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(rendered);
    }
    return;
  }

  if (subcommand === "list" || subcommand === "events") {
    if (!registry) throw new Error("audit list requires --registry or COREHUB_REGISTRY");
    const auth = await readAuthState();
    const format = readOption(args, "--format") ?? "json";
    if (!new Set(["json", "jsonl"]).has(format)) throw new Error("--format must be json or jsonl");
    const output = readOption(args, "--output");
    const result = await new CoreHubRegistryClient(registry).auditEvents({
      ...readQueueListOptions(args),
      actor: readOption(args, "--actor"),
      action: readOption(args, "--action"),
      target: readOption(args, "--target"),
      targetType: readOption(args, "--target-type"),
      auth,
    });
    const payload = {
      status: "ok",
      registry: normalizeRegistry(registry),
      ...result.meta,
      auditEvents: result.data,
    };
    const rendered = formatAuditOutput(payload, format);
    if (output) {
      await writeTextOutput(output, rendered);
      console.log(
        JSON.stringify(
          {
            status: "exported",
            registry: payload.registry,
            format,
            output: resolve(output),
            count: payload.count,
            total: payload.total,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(rendered);
    }
    return;
  }

  if (subcommand === "verify") {
    if (!registry) throw new Error("audit verify requires --registry or COREHUB_REGISTRY");
    const auth = await readAuthState();
    const result = await new CoreHubRegistryClient(registry).verifyAuditEvents({ auth });
    console.log(
      JSON.stringify(
        {
          status: result.valid ? "valid" : "invalid",
          registry: normalizeRegistry(registry),
          ...result,
        },
        null,
        2,
      ),
    );
    if (!result.valid) process.exitCode = 1;
    return;
  }

  if (subcommand === "retention" || subcommand === "policy") {
    if (!registry) throw new Error("audit retention requires --registry or COREHUB_REGISTRY");
    const auth = await readAuthState();
    const output = readOption(args, "--output");
    const prune = hasFlag(args, "--prune");
    const dryRun = hasFlag(args, "--dry-run") || !prune;
    if (prune && !dryRun && !output) {
      throw new Error("audit retention --prune requires --output <file> so events are exported before pruning");
    }
    const client = new CoreHubRegistryClient(registry);
    let exportResult = null;
    if (output) {
      const events = await client.auditEvents({ limit: 100000, auth });
      const rendered = formatAuditOutput({ auditEvents: events.data }, "jsonl");
      await writeTextOutput(output, rendered);
      exportResult = {
        output: resolve(output),
        exportHash: createHash("sha256").update(rendered).digest("hex"),
        exportedAt: new Date().toISOString(),
        exportedCount: events.data.length,
      };
    }
    const result = prune
      ? await client.pruneAuditRetention({
          auth,
          dryRun,
          exportHash: exportResult?.exportHash,
          exportedAt: exportResult?.exportedAt,
          exportedCount: exportResult?.exportedCount,
        })
      : await client.auditRetention({ auth });
    console.log(
      JSON.stringify(
        {
          status: result.status,
          registry: normalizeRegistry(registry),
          ...(exportResult ?? {}),
          ...result,
        },
        null,
        2,
      ),
    );
    if (result.status === "blocked" || result.verification?.valid === false) process.exitCode = 1;
    return;
  }

  if (subcommand === "incident") {
    const incidentCommand = args[0] ?? "help";
    const incidentArgs = args.slice(1);
    if (incidentCommand !== "report") {
      printAuditHelp();
      return;
    }
    if (!registry) throw new Error("audit incident report requires --registry or COREHUB_REGISTRY");
    const auth = await readAuthState();
    const format = readOption(incidentArgs, "--format") ?? "json";
    if (!new Set(["json", "markdown"]).has(format)) throw new Error("--format must be json or markdown");
    const output = readOption(incidentArgs, "--output");
    const limit = readOptionalNonNegativeInteger(incidentArgs, "--limit") ?? 20;
    const client = new CoreHubRegistryClient(registry);
    const verification = await client.verifyAuditEvents({ auth });
    const retention = await client.auditRetention({ auth });
    const recent = await client.auditEvents({ limit, auth });
    const report = buildAuditIncidentReport({
      registry,
      verification,
      retention,
      recentAuditEvents: recent.data,
      recentMeta: recent.meta,
    });
    const rendered = format === "markdown" ? formatAuditIncidentMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
    if (output) {
      await writeTextOutput(output, rendered);
      console.log(
        JSON.stringify(
          {
            status: "exported",
            incidentStatus: report.status,
            registry: report.registry,
            format,
            output: resolve(output),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(rendered);
    }
    if (report.status === "fail_closed") process.exitCode = 1;
    return;
  }

  printAuditHelp();
}

async function runSkillCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const registry = readOption(args, "--registry") ?? defaultRegistry;

  if (subcommand === "publish") {
    const folder = positionalArgs(args)[0];
    if (!folder) throw new Error("skill publish requires a folder");

    const dryRun = hasFlag(args, "--dry-run");
    if (dryRun || !registry) {
      const result = await new CoreHubSkillInspector().inspectFolder(folder);
      console.log(JSON.stringify({ dryRun: true, registryPublish: "planned", ...result }, null, 2));
      return;
    }

    const publishArgs = [...args, "--family", "skill"];
    const result = await executePackagePublish(folder, publishArgs, registry);
    console.log(JSON.stringify(result, null, 2));
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
    return new CoreHubRegistryClient(options.registry).list(options);
  }

  const catalog = await readCatalog();
  return listCatalogRecords(catalog.list({ kind: options.kind }), options);
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
      ...options,
    });
  }

  const catalog = await readCatalog();
  return catalog.search(query, options);
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
  const canRecordInstall = !dryRun && installable && Boolean(verified?.verified);
  const installed = canRecordInstall
    ? await recordLocalInstall({
        download,
        artifact,
        output: verified,
        registry: options.registry,
      })
    : null;
  const applyBlockedReason =
    installable && verified?.verified
      ? "CoreHub verified the artifact and recorded local install state. CoreBlow installer handoff remains a separate boundary."
      : installable
      ? "CoreHub resolved an installable CoreBlow plugin archive. Run corehub install or provide --output to fetch and verify it before installer handoff."
      : artifact?.mediaType === "application/vnd.coreblow.corehub.manifest+json"
      ? "CoreHub resolved a registry manifest, but this version does not yet provide an installable CoreBlow plugin archive."
      : "CoreHub install apply is blocked until the CoreBlow plugin installer boundary is wired.";

  return {
    dryRun,
    install: {
      status: dryRun ? "planned" : installed ? "installed" : "blocked",
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
    localState: installed,
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
        status: dryRun ? "planned" : installed ? "complete" : "blocked",
        detail: dryRun
          ? "CoreBlow plugin installation is previewed only because --dry-run was provided."
          : applyBlockedReason,
      },
    ],
  };
}

async function runPackageInstalledCommand(values, registry) {
  const subcommand = values[0] ?? "list";
  const args = values.slice(1);

  if (subcommand === "list" || subcommand === "ls") {
    const state = await readInstallState();
    const packages = activeInstallRecords(state);
    console.log(JSON.stringify({ status: "ok", packages }, null, 2));
    return;
  }

  if (subcommand === "pin" || subcommand === "unpin") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error(`package ${subcommand} requires an entry id`);
    console.log(JSON.stringify(await setLocalInstallPinned(id, subcommand === "pin"), null, 2));
    return;
  }

  if (subcommand === "uninstall") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package uninstall requires an entry id");
    console.log(JSON.stringify(await uninstallLocalPackage(id), null, 2));
    return;
  }

  if (subcommand === "update") {
    const id = positionalArgs(args)[0];
    if (!id) throw new Error("package update requires an entry id");
    const state = await readInstallState();
    const current = findLocalInstall(state, id);
    if (!current) throw new Error(`CoreHub package is not installed locally: ${id}`);
    const result = await createPackageUpdatePlan(id, {
      registry,
      dryRun: hasFlag(args, "--dry-run"),
      output: readOption(args, "--output"),
      current,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "sync") {
    const result = await syncLocalInstalls({
      registry,
      dryRun: hasFlag(args, "--dry-run"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printPackageHelp();
}

async function createPackageUpdatePlan(id, options = {}) {
  if (options.current?.pinned) {
    return {
      status: "skipped",
      reason: "pinned",
      packageId: id,
      current: options.current,
      message: `Package ${id} is pinned; update will not overwrite local state.`,
    };
  }
  const plan = await createPackageInstallPlan(id, {
    registry: options.registry || options.current?.registry,
    output: options.output,
    dryRun: options.dryRun,
    fetchForApply: !options.dryRun,
  });
  return {
    status: plan.localState ? "updated" : plan.dryRun ? "planned" : "blocked",
    packageId: id,
    previous: {
      version: options.current?.version ?? null,
      artifactSha256: options.current?.artifact?.sha256 ?? null,
    },
    plan,
  };
}

async function syncLocalInstalls(options = {}) {
  const state = await readInstallState();
  const packages = activeInstallRecords(state);
  const results = [];
  for (const item of packages) {
    if (item.pinned) {
      results.push({ status: "skipped", reason: "pinned", packageId: item.id, current: item });
      continue;
    }
    results.push(await createPackageUpdatePlan(item.id, { ...options, current: item }));
  }
  return {
    status: "ok",
    dryRun: Boolean(options.dryRun),
    count: results.length,
    results,
  };
}

async function recordLocalInstall({ download, artifact, output, registry }) {
  const state = await readInstallState();
  const id = download.package?.id;
  if (!id) throw new Error("CoreHub install cannot be recorded without package id");
  const previous = findLocalInstall(state, id);
  if (previous?.pinned) {
    throw new Error(`Package ${id} is pinned; unpin it before reinstalling or updating`);
  }
  const now = new Date().toISOString();
  const record = {
    id,
    name: download.package?.name ?? id,
    kind: download.package?.kind ?? "plugin",
    version: download.version ?? null,
    publisher: download.publisher ?? null,
    registry: normalizeRegistry(registry),
    status: "installed",
    pinned: Boolean(previous?.pinned),
    artifact: {
      name: artifact?.name ?? null,
      mediaType: artifact?.mediaType ?? null,
      size: artifact?.size ?? null,
      sha256: artifact?.sha256 ?? null,
    },
    artifactPath: output?.path ?? null,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  };
  state.packages = state.packages.filter((item) => item.id !== id);
  state.packages.push(record);
  await writeInstallState(state);
  return record;
}

async function setLocalInstallPinned(id, pinned) {
  const state = await readInstallState();
  const record = findLocalInstall(state, id);
  if (!record) throw new Error(`CoreHub package is not installed locally: ${id}`);
  const updated = { ...record, pinned, updatedAt: new Date().toISOString() };
  state.packages = state.packages.map((item) => (item.id === id ? updated : item));
  await writeInstallState(state);
  return { status: pinned ? "pinned" : "unpinned", package: updated };
}

async function uninstallLocalPackage(id) {
  const state = await readInstallState();
  const record = findLocalInstall(state, id);
  if (!record) throw new Error(`CoreHub package is not installed locally: ${id}`);
  const updated = {
    ...record,
    status: "uninstalled",
    pinned: false,
    uninstalledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.packages = state.packages.map((item) => (item.id === id ? updated : item));
  await writeInstallState(state);
  return { status: "uninstalled", package: updated };
}

function activeInstallRecords(state) {
  return state.packages.filter((item) => item.status === "installed").sort((left, right) => left.id.localeCompare(right.id));
}

function findLocalInstall(state, id) {
  return activeInstallRecords(state).find((item) => item.id === id) ?? null;
}

async function readInstallState() {
  try {
    const raw = JSON.parse(await readFile(installStatePath(), "utf8"));
    if (raw?.schemaVersion !== installStateSchemaVersion || !Array.isArray(raw.packages)) {
      throw new Error(`CoreHub install state is invalid at ${installStatePath()}`);
    }
    return raw;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { schemaVersion: installStateSchemaVersion, packages: [] };
    }
    throw error;
  }
}

async function writeInstallState(state) {
  const path = installStatePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function installStatePath() {
  const root = process.env.COREHUB_HOME || join(homedir(), ".corehub");
  return join(root, "installs.json");
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

function readDiscoveryOptions(values) {
  return {
    kind: readOption(values, "--kind"),
    family: readOption(values, "--family"),
    channel: readOption(values, "--channel"),
    category: readOption(values, "--category"),
    capabilityTag: readOption(values, "--capability") ?? readOption(values, "--capability-tag"),
    sort: readOption(values, "--sort"),
    isOfficial: hasFlag(values, "--official") ? true : readBooleanOption(values, "--is-official"),
    featured: hasFlag(values, "--featured") ? true : readBooleanOption(values, "--featured"),
    executesCode: readBooleanOption(values, "--executes-code") ?? readBooleanOption(values, "--executesCode"),
  };
}

function readBooleanOption(values, name) {
  const value = readOption(values, name);
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false`);
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

function formatAuditOutput(payload, format) {
  if (format === "jsonl") {
    return `${payload.auditEvents.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildAuditIncidentReport({ registry, verification, retention, recentAuditEvents, recentMeta }) {
  const failed = verification.valid === false || verification.behavior === "fail_closed";
  return {
    status: failed ? "fail_closed" : "ok",
    registry: normalizeRegistry(registry),
    generatedAt: new Date().toISOString(),
    summary: failed
      ? "Audit integrity verification failed. Treat write-side evidence as suspect until reviewed."
      : "Audit integrity verification passed. No audit integrity incident is active.",
    severity: failed ? "critical" : "informational",
    operatorActions: failed
      ? [
          "Stop audit retention pruning immediately.",
          "Export the current audit events and local state before making changes.",
          "Preserve the registry state file, storage metadata, and CI logs.",
          "Escalate to the CoreHub operator or security owner for manual review.",
        ]
      : [
          "Continue normal operations.",
          "Keep retention pruning gated by export-before-prune policy.",
          "Archive this report when an operator needs evidence of a clean audit chain.",
        ],
    verification,
    retention,
    recentAuditEvents,
    recentAuditMeta: recentMeta,
    alertDelivery: {
      status: "not_configured",
      delivered: false,
      destination: "none",
      attempts: 0,
    },
  };
}

function formatAuditIncidentMarkdown(report) {
  const lines = [
    "# CoreHub Audit Incident Report",
    "",
    `- Status: ${report.status}`,
    `- Severity: ${report.severity}`,
    `- Registry: ${report.registry}`,
    `- Generated At: ${report.generatedAt}`,
    `- Audit Behavior: ${report.verification.behavior}`,
    `- Audit Head: ${report.verification.head}`,
    `- Audit Event Count: ${report.verification.count}`,
    `- Retention Status: ${report.retention.status}`,
    `- Alert Delivery Status: ${report.alertDelivery?.status ?? "not_configured"}`,
    `- Alert Delivery Destination: ${report.alertDelivery?.destination ?? "none"}`,
    `- Alert Delivery Attempts: ${report.alertDelivery?.attempts ?? 0}`,
    `- Alert Delivery Dead-lettered: ${String(Boolean(report.alertDelivery?.deadLetter))}`,
    "",
    "## Summary",
    "",
    report.summary,
    "",
    "## Operator Actions",
    "",
    ...report.operatorActions.map((action, index) => `${index + 1}. ${action}`),
    "",
    "## Verification Errors",
    "",
    ...(report.verification.errors.length > 0 ? report.verification.errors.map((error) => `- ${error}`) : ["- None"]),
    "",
    "## Recent Audit Events",
    "",
    ...report.recentAuditEvents.map((event) => `- ${event.sequence}: ${event.action} -> ${event.targetType}:${event.targetId}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function summarizeAuditAlertDeliveryMetrics(text, { input } = {}) {
  const lines = text.split(/\r?\n/);
  const metrics = [];
  let ignoredLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.schemaVersion === "corehub.audit-alert-delivery-metric.v1") {
        metrics.push(parsed);
      } else {
        ignoredLines += 1;
      }
    } catch {
      ignoredLines += 1;
    }
  }

  const attemptMetrics = metrics.filter((metric) => metric.eventType === "alert.delivery.attempt");
  const finalMetrics = metrics.filter((metric) => metric.eventType === "alert.delivery.final");
  const attemptStatusCounts = countBy(attemptMetrics, "status");
  const finalStatusCounts = countBy(finalMetrics, "status");
  return {
    status: "ok",
    input,
    totalLines: lines.filter((line) => line.trim()).length,
    parsedMetrics: metrics.length,
    ignoredLines,
    attemptEvents: attemptMetrics.length,
    finalEvents: finalMetrics.length,
    destinations: countBy(metrics, "destination"),
    attemptStatusCounts,
    finalStatusCounts,
    rates: {
      delivered: ratio(finalStatusCounts.delivered ?? 0, finalMetrics.length),
      deadLetter: ratio(finalStatusCounts.dead_letter ?? 0, finalMetrics.length),
      notConfigured: ratio(finalStatusCounts.not_configured ?? 0, finalMetrics.length),
      retry: ratio(attemptStatusCounts.retry ?? 0, attemptMetrics.length),
      failed: ratio(attemptStatusCounts.failed ?? 0, attemptMetrics.length),
    },
    firstMetricAt: metrics[0]?.createdAt ?? null,
    lastMetricAt: metrics.at(-1)?.createdAt ?? null,
  };
}

function assertAuditAlertDeliveryMetrics(summary, thresholds) {
  const checks = [
    buildRateCheck("deadLetter", summary.rates.deadLetter, thresholds.maxDeadLetterRate),
    buildRateCheck("retry", summary.rates.retry, thresholds.maxRetryRate),
    buildRateCheck("failed", summary.rates.failed, thresholds.maxFailedRate),
  ].filter(Boolean);
  const failedChecks = checks.filter((check) => !check.passed);
  return {
    status: failedChecks.length === 0 ? "passed" : "failed",
    input: summary.input,
    parsedMetrics: summary.parsedMetrics,
    ignoredLines: summary.ignoredLines,
    rates: summary.rates,
    thresholds: {
      maxDeadLetterRate: thresholds.maxDeadLetterRate ?? null,
      maxRetryRate: thresholds.maxRetryRate ?? null,
      maxFailedRate: thresholds.maxFailedRate ?? null,
    },
    checks,
    failures: failedChecks,
  };
}

function buildRateCheck(name, actual, maximum) {
  if (maximum === undefined) return null;
  return {
    name,
    actual,
    maximum,
    passed: actual <= maximum,
  };
}

function formatAlertMetricsSummaryMarkdown(summary) {
  return `# CoreHub Alert Delivery Metrics Summary

- Status: ${summary.status}
- Input: ${summary.input}
- Parsed Metrics: ${summary.parsedMetrics}
- Ignored Lines: ${summary.ignoredLines}
- Attempt Events: ${summary.attemptEvents}
- Final Events: ${summary.finalEvents}
- Delivered Rate: ${formatRate(summary.rates.delivered)}
- Retry Rate: ${formatRate(summary.rates.retry)}
- Dead-letter Rate: ${formatRate(summary.rates.deadLetter)}

## Final Status Counts

${formatCountTable(summary.finalStatusCounts)}

## Attempt Status Counts

${formatCountTable(summary.attemptStatusCounts)}

## Destinations

${formatCountTable(summary.destinations)}
`;
}

function countBy(items, key) {
  return items.reduce((counts, item) => {
    const value = item?.[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function ratio(count, total) {
  return total > 0 ? count / total : 0;
}

function formatRate(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatCountTable(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "| Value | Count |\n| --- | --- |\n| none | 0 |";
  return ["| Value | Count |", "| --- | --- |", ...entries.map(([value, count]) => `| ${value} | ${count} |`)].join("\n");
}

function readOptionalRate(values, name) {
  const value = readOption(values, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return parsed;
}

async function writeTextOutput(outputPath, text) {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
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
    "--action",
    "--actor",
    "--changelog",
    "--display-name",
    "--format",
    "--family",
    "--channel",
    "--category",
    "--capability",
    "--capability-tag",
    "--sort",
    "--is-official",
    "--executes-code",
    "--executesCode",
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
    "--target",
    "--target-type",
    "--token",
    "--upload-slot",
    "--user",
    "--version",
  ]).has(name);
}

function printRecords(records) {
  for (const record of records) {
    const score = record.score === undefined ? "" : ` score=${record.score}`;
    const marketplace = record.marketplace ? ` ${record.marketplace.family}/${record.marketplace.channel}` : "";
    console.log(`${record.id}\t${record.kind}\t${record.name}${marketplace}${score}`);
    console.log(`  ${record.summary}`);
    console.log(`  ${record.source}`);
  }
}

function appendDiscoverySearchParams(url, options = {}) {
  if (options.kind) url.searchParams.set("kind", options.kind);
  if (options.family) url.searchParams.set("family", options.family);
  if (options.channel) url.searchParams.set("channel", options.channel);
  if (options.category) url.searchParams.set("category", options.category);
  if (options.capabilityTag) url.searchParams.set("capabilityTag", options.capabilityTag);
  if (options.sort) url.searchParams.set("sort", options.sort);
  if (options.isOfficial !== undefined) url.searchParams.set("isOfficial", String(options.isOfficial));
  if (options.featured !== undefined) url.searchParams.set("featured", String(options.featured));
  if (options.executesCode !== undefined) url.searchParams.set("executesCode", String(options.executesCode));
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
    const result = registry
      ? await createArtifactUploadRequestViaRegistry(source, args, registry)
      : await createArtifactUploadRequestDryRun(source, args);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "verify") {
    const source = positionalArgs(args)[0];
    if (!source) throw new Error("package upload verify requires an artifact file or folder");
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

async function runPackagePublishCommand(values, registry) {
  const source = positionalArgs(values)[0];
  if (!source) throw new Error("package publish requires an artifact file or folder");

  if (!registry) {
    throw new Error("package publish requires --registry or COREHUB_REGISTRY for both dry-run and live publishing");
  }

  if (hasFlag(values, "--dry-run")) {
    const result = await createPackagePublishDryRun(source, values, registry);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = await executePackagePublish(source, values, registry);
  console.log(JSON.stringify(result, null, 2));
}

async function runPackageReportsCommand(values, registry) {
  const subcommand = values[0] ?? "list";
  const args = values.slice(1);
  if (!registry) throw new Error("package reports requires --registry or COREHUB_REGISTRY");
  const auth = await requireAuthState();
  const client = new CoreHubRegistryClient(registry);

  if (subcommand === "list") {
    const result = await client.packageReports(
      {
        status: readOption(args, "--status") ?? "open",
        packageId: readOption(args, "--package"),
        ...readQueueListOptions(args),
      },
      { auth },
    );
    console.log(
      JSON.stringify(
        {
          status: "ok",
          registry: normalizeRegistry(registry),
          ...result.meta,
          reports: result.data,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "triage") {
    const reportId = positionalArgs(args)[0];
    if (!reportId) throw new Error("package reports triage requires a report id");
    const status = readOption(args, "--status");
    if (!status) throw new Error("package reports triage requires --status open|confirmed|dismissed");
    const result = await client.triagePackageReport(
      reportId,
      {
        status,
        note: readOption(args, "--note") ?? readOption(args, "--notes"),
        finalAction: readOption(args, "--action") ?? readOption(args, "--final-action"),
      },
      { auth },
    );
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  printPackageHelp();
}

async function runPackageAppealsCommand(values, registry) {
  const subcommand = values[0] ?? "list";
  const args = values.slice(1);
  if (!registry) throw new Error("package appeals requires --registry or COREHUB_REGISTRY");
  const auth = await requireAuthState();
  const client = new CoreHubRegistryClient(registry);

  if (subcommand === "list") {
    const result = await client.packageAppeals(
      {
        status: readOption(args, "--status") ?? "open",
        packageId: readOption(args, "--package"),
        ...readQueueListOptions(args),
      },
      { auth },
    );
    console.log(
      JSON.stringify(
        {
          status: "ok",
          registry: normalizeRegistry(registry),
          ...result.meta,
          appeals: result.data,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "resolve") {
    const appealId = positionalArgs(args)[0];
    if (!appealId) throw new Error("package appeals resolve requires an appeal id");
    const status = readOption(args, "--status");
    if (!status) throw new Error("package appeals resolve requires --status open|accepted|rejected");
    const result = await client.resolvePackageAppeal(
      appealId,
      {
        status,
        note: readOption(args, "--note") ?? readOption(args, "--notes"),
        finalAction: readOption(args, "--action") ?? readOption(args, "--final-action"),
      },
      { auth },
    );
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  printPackageHelp();
}

async function runPackageTrustedPublisherCommand(values, registry) {
  const subcommand = values[0] ?? "get";
  const args = values.slice(1);
  if (!registry) throw new Error("package trusted-publisher requires --registry or COREHUB_REGISTRY");
  const packageId = positionalArgs(args)[0];
  if (!packageId) throw new Error(`package trusted-publisher ${subcommand} requires an entry id`);
  const auth = await requireAuthState();
  const client = new CoreHubRegistryClient(registry);

  if (subcommand === "get") {
    const result = await client.getTrustedPublisher(packageId, { auth });
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  if (subcommand === "set") {
    const repository = readOption(args, "--repository");
    const workflowFilename = readOption(args, "--workflow") ?? readOption(args, "--workflow-filename");
    if (!repository) throw new Error("package trusted-publisher set requires --repository owner/repo");
    if (!workflowFilename) throw new Error("package trusted-publisher set requires --workflow filename.yml");
    const result = await client.setTrustedPublisher(
      packageId,
      {
        repository,
        workflowFilename,
        environment: readOption(args, "--environment"),
      },
      { auth },
    );
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  if (subcommand === "delete") {
    if (!hasFlag(args, "--yes")) throw new Error("package trusted-publisher delete requires --yes");
    const result = await client.deleteTrustedPublisher(packageId, { auth });
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  printPackageHelp();
}

async function runPackagePublishTokenCommand(values, registry) {
  const subcommand = values[0] ?? "mint";
  const args = values.slice(1);
  if (!registry) throw new Error("package publish-token requires --registry or COREHUB_REGISTRY");
  const packageId = positionalArgs(args)[0];
  if (!packageId) throw new Error(`package publish-token ${subcommand} requires an entry id`);
  const auth = await requireAuthState();
  const client = new CoreHubRegistryClient(registry);

  if (subcommand === "mint") {
    const version = readOption(args, "--version");
    if (!version) throw new Error("package publish-token mint requires --version <version>");
    const result = await client.mintPublishToken(
      packageId,
      {
        version,
        repository: readOption(args, "--repository"),
        workflowFilename: readOption(args, "--workflow") ?? readOption(args, "--workflow-filename"),
        environment: readOption(args, "--environment"),
        runId: readOption(args, "--run-id") ?? "local-run",
        runAttempt: readOption(args, "--run-attempt") ?? "1",
        sha: readOption(args, "--sha") ?? "local-dev-sha",
        ref: readOption(args, "--ref") ?? "refs/heads/main",
      },
      { auth },
    );
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  if (subcommand === "revoke") {
    const tokenId = readOption(args, "--token-id") ?? positionalArgs(args)[1];
    if (!tokenId) throw new Error("package publish-token revoke requires --token-id <id>");
    const result = await client.revokePublishToken(packageId, tokenId, { auth });
    console.log(JSON.stringify({ registry: normalizeRegistry(registry), ...result }, null, 2));
    return;
  }

  printPackageHelp();
}

async function createPackagePublishDryRun(source, values, registry) {
  const auth = await requireAuthState();
  const inspected = await inspectPackageSubmitSource(source);
  const kind = resolvePackagePublishKind(values, inspected.package.kind);
  const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package publish");
  const packageId = readOption(values, "--name") ?? inspected.package.id;
  const version = readOption(values, "--version") ?? inspected.package.version;
  const versionSlug = slugVersion(version);
  const artifactUploadId = `artifact-${packageId}-${versionSlug}`;
  const uploadSlotId = `upload-${packageId}-${versionSlug}`;
  const sourceUrl = readOption(values, "--source") ?? inspected.source ?? `https://github.com/${publisherHandle}/${packageId}`;
  const changelog = readOption(values, "--changelog") ?? "CoreHub package publish dry run.";
  const provider = readOption(values, "--provider") ?? "r2";
  if (!["r2", "s3"].includes(provider)) {
    throw new Error("package publish --provider must be r2 or s3");
  }
  const storage = {
    provider,
    key: artifactStorageKey(publisherHandle, packageId, version, inspected.artifact.name),
  };
  return {
    dryRun: true,
    status: registry ? "remote_publish_planned" : "planned",
    command: "package.publish",
    ...(registry ? { registry: normalizeRegistry(registry) } : {}),
    actor: auth.actor,
    source: {
      path: resolve(source),
      type: inspected.type,
      url: sourceUrl,
    },
    package: {
      id: packageId,
      version,
      kind,
      detectedKind: inspected.package.kind,
      name: inspected.package.name ?? packageId,
    },
    publisherHandle,
    artifact: {
      name: inspected.artifact.name,
      mediaType: inspected.artifact.mediaType,
      size: inspected.artifact.size,
      sha256: inspected.artifact.sha256,
      storage,
    },
    uploadPlan: {
      endpoint: "/corehub/api/v2/artifacts/uploads",
      uploadSlotId,
      artifactUploadId,
      provider,
      status: "planned",
    },
    submissionPlan: {
      endpoint: "/corehub/api/v2/submissions",
      submissionId: `submission-${packageId}-${versionSlug}`,
      artifactUploadId,
      changelog,
      channel: readOption(values, "--channel") ?? "stable",
      publishTokenId: readOption(values, "--publish-token-id") ?? null,
      reviewStatus: "pending_review",
    },
    validation: {
      ready: true,
      checks: [
        "authenticated actor resolved",
        "publisher handle resolved",
        "package id and version resolved",
        "artifact checksum computed",
        "publish is dry-run only until registry writes are explicitly enabled",
      ],
    },
    nextStep: registry
      ? "Run package upload request, package upload verify, then package submit against this registry when live writes are approved."
      : "Run with --registry to preview the hosted CoreHub write path, then upload and submit when live writes are approved.",
  };
}

async function createPackageVerifyResult(source, values, registry) {
  const sourcePath = resolve(source);
  const bytes = await readFile(sourcePath);
  const actual = {
    path: sourcePath,
    name: sourcePath.split(/[\\/]/).at(-1),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const expectedSha256 = readOption(values, "--sha256");
  const packageId = readOption(values, "--package");
  const expected = {};
  if (expectedSha256) expected.sha256 = expectedSha256;
  if (packageId) {
    if (!registry) throw new Error("package verify --package requires --registry or COREHUB_REGISTRY");
    const artifact = await readPackageArtifact(packageId, { registry });
    expected.packageId = packageId;
    expected.sha256 = artifact.artifact.sha256;
    expected.size = artifact.artifact.size;
    expected.name = artifact.artifact.name;
  }
  if (!expected.sha256) {
    throw new Error("package verify requires --sha256 or --package with --registry");
  }
  const checksumMatches = actual.sha256.toLowerCase() === String(expected.sha256).toLowerCase();
  const sizeMatches = expected.size === undefined || expected.size === actual.size;
  const nameMatches = expected.name === undefined || expected.name === actual.name;
  return {
    status: checksumMatches && sizeMatches && nameMatches ? "verified" : "failed",
    artifact: actual,
    expected,
    verification: {
      checksumMatches,
      sizeMatches,
      nameMatches,
    },
  };
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

async function packFolderToTgz(folder, tgzPath) {
  await execFileAsync("tar", ["-czf", resolve(tgzPath), "-C", resolve(folder), "."]);
}

async function executePackagePublish(source, values, registry) {
  const auth = await requireAuthState();
  let isTempArchive = false;
  let archivePath = resolve(source);
  let tempDir = null;

  const info = await stat(archivePath);
  if (info.isDirectory()) {
    tempDir = await mkdtemp(join(tmpdir(), "corehub-publish-pack-"));
    const manifestPath = join(archivePath, "corehub.artifact.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (err) {
      throw new Error(`Failed to read corehub.artifact.json in folder: ${err.message}`);
    }
    const packageId = manifest.package?.id;
    const version = manifest.package?.version;
    if (!packageId || !version) {
      throw new Error("Folder corehub.artifact.json must contain package.id and package.version");
    }
    const slug = slugVersion(version);
    archivePath = join(tempDir, `${packageId}-${slug}.tgz`);
    await packFolderToTgz(source, archivePath);
    isTempArchive = true;
  }

  try {
    const inspected = await inspectPackageSubmitSource(archivePath);
    const publisherHandle = resolvePackagePublisherHandle(values, inspected, auth, "package publish");
    const packageId = inspected.package.id;
    const version = inspected.package.version;
    const versionSlug = slugVersion(version);
    const artifactUploadId = `artifact-${packageId}-${versionSlug}`;

    const provider = readOption(values, "--provider") ?? "r2";
    if (!["r2", "s3"].includes(provider)) {
      throw new Error("package publish --provider must be r2 or s3");
    }

    const maxBytes = Number.parseInt(readOption(values, "--max-bytes") ?? "104857600", 10);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < inspected.artifact.size) {
      throw new Error("package publish --max-bytes must be an integer greater than or equal to artifact size");
    }

    const client = new CoreHubRegistryClient(registry);

    const uploadSlot = await client.requestArtifactUpload(
      {
        packageId,
        version,
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
      { auth }
    );

    const bytes = await readFile(archivePath);
    const uploaded = await client.putArtifactUpload(uploadSlot.id, bytes, {
      auth,
      mediaType: inspected.artifact.mediaType,
      sha256: inspected.artifact.sha256,
    });

    const verified = await client.verifyArtifactUpload(uploadSlot.id, { auth });

    const sourceUrl = readOption(values, "--source") ?? inspected.source ?? `https://github.com/${publisherHandle}/${packageId}`;
    const changelog = readOption(values, "--changelog") ?? "CoreHub live package publish.";
    const submissionResult = await client.createPackageSubmission(
      {
        packageId,
        kind: inspected.package.kind,
        publisherHandle,
        version,
        artifactUploadId,
        source: sourceUrl,
        changelog,
        channel: readOption(values, "--channel") ?? "stable",
        publishTokenId: readOption(values, "--publish-token-id"),
        manualOverrideReason: readOption(values, "--manual-override-reason"),
      },
      { auth }
    );

    return {
      dryRun: false,
      status: "remote_pending_review",
      registry: normalizeRegistry(registry),
      actor: auth.actor,
      source: {
        path: resolve(source),
        type: inspected.type,
      },
      submission: submissionResult.submission,
      artifactUpload: submissionResult.artifactUpload,
      packageVersionPreview: submissionResult.packageVersionPreview,
      moderationReview: submissionResult.moderationReview,
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
  } finally {
    if (isTempArchive && tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
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

async function readPackageModerationStatus(id, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).moderationStatus(id);
  }

  const catalog = await readCatalog();
  const record = catalog.findById(id);
  if (!record) throw new Error(`CoreHub package not found: ${id}`);
  return createPackageModerationStatus(record);
}

async function readPackageReadiness(id, options = {}) {
  if (options.registry) {
    return new CoreHubRegistryClient(options.registry).readiness(id);
  }

  const catalog = await readCatalog();
  const record = catalog.findById(id);
  if (!record) throw new Error(`CoreHub package not found: ${id}`);
  return createPackageReadiness(record);
}

function createPackageModerationStatus(record) {
  const latest = selectLatestPackageVersion(record);
  const reviewState = record.review?.state ?? "unknown";
  const blocked = latest?.status === "blocked" || reviewState === "blocked" || latest?.artifact?.downloadEnabled === false;
  const reasons = [];
  if (!latest) reasons.push("latest-version-missing");
  if (latest?.status && latest.status !== "available") reasons.push(`version-${latest.status}`);
  if (reviewState !== "verified") reasons.push(`review-${reviewState}`);
  if (latest?.artifact?.downloadEnabled === false) reasons.push("download-disabled");
  return {
    status: "ok",
    package: {
      id: record.id,
      kind: record.kind,
      name: record.name,
      publisher: record.publisher ?? null,
    },
    review: record.review ?? null,
    latestVersion: latest
      ? {
          version: latest.version,
          tag: latest.tag ?? null,
          status: latest.status ?? "unknown",
          moderationStatus: reviewState,
          blockedFromDownload: blocked,
          downloadEnabled: Boolean(latest.artifact?.downloadEnabled),
          reasons,
          moderationReason: record.review?.notes ?? null,
        }
      : null,
  };
}

function createPackageReadiness(record) {
  const latest = selectLatestPackageVersion(record);
  const checks = [];
  const add = (id, label, status, message) => checks.push({ id, label, status, message });
  add(
    "publisher",
    "Verified publisher",
    record.publisher?.verified ? "pass" : "fail",
    record.publisher?.verified ? `Publisher ${record.publisher.handle} is verified.` : "Package publisher is not verified.",
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
    record.source || latest?.artifact?.provenance?.source ? "pass" : "fail",
    record.source || latest?.artifact?.provenance?.source
      ? `Source is ${record.source ?? latest.artifact.provenance.source}.`
      : "Source provenance is missing.",
  );
  add(
    "coreblow-compatibility",
    "CoreBlow compatibility",
    record.coreblow?.minCoreblowVersion && Array.isArray(record.coreblow?.platforms) && record.coreblow.platforms.length > 0
      ? "pass"
      : "fail",
    record.coreblow?.minCoreblowVersion
      ? `minCoreblowVersion=${record.coreblow.minCoreblowVersion}.`
      : "CoreBlow compatibility metadata is missing.",
  );
  add(
    "moderation",
    "Moderation state",
    record.review?.state === "verified" && latest?.status === "available" ? "pass" : "fail",
    record.review?.state === "verified" && latest?.status === "available"
      ? "Package is verified and latest version is available."
      : `Review state is ${record.review?.state ?? "unknown"} and latest status is ${latest?.status ?? "missing"}.`,
  );
  const blockers = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return {
    status: "ok",
    ready: blockers.length === 0,
    package: {
      id: record.id,
      kind: record.kind,
      name: record.name,
      latestVersion: latest?.version ?? null,
      publisher: record.publisher ?? null,
    },
    checks,
    blockers,
  };
}

function selectLatestPackageVersion(record) {
  return (
    record.versions?.find((version) => version.tag === "latest") ??
    record.versions?.toSorted((left, right) => String(right.publishedAt ?? "").localeCompare(String(left.publishedAt ?? ""))).at(0) ??
    null
  );
}

function resolvePackagePublishKind(values, detectedKind) {
  const raw = readOption(values, "--family") ?? readOption(values, "--kind") ?? detectedKind;
  const normalized = String(raw).trim();
  const mapped =
    new Map([
      ["code-plugin", "plugin"],
      ["bundle-plugin", "plugin"],
    ]).get(normalized) ?? normalized;
  if (!["skill", "plugin", "provider", "channel"].includes(mapped)) {
    throw new Error("--family must be skill, plugin, provider, channel, code-plugin, or bundle-plugin");
  }
  return mapped;
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

async function createWhoamiResult(auth, registry) {
  if (registry) {
    try {
      const client = new CoreHubRegistryClient(registry);
      const payload = await client.publisherIdentity({ auth });
      return {
        ...payload,
        tokenPreview: previewToken(auth.token),
      };
    } catch {
      // fallback
    }
  }

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
    const url = this.apiUrl(options.packageRoute ? "/packages" : "/entries");
    appendDiscoverySearchParams(url, options);
    return this.readData(url);
  }

  async info() {
    return this.readData(this.apiUrl(""));
  }

  async search(query, options = {}) {
    const path = options.packageRoute ? "/packages/search" : "/search";
    const url = this.apiUrl(path);
    url.searchParams.set("q", query);
    appendDiscoverySearchParams(url, options);
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

  async moderationStatus(id) {
    return this.readData(this.apiUrl(`/packages/${encodeURIComponent(id)}/moderation`));
  }

  async readiness(id) {
    return this.readData(this.apiUrl(`/packages/${encodeURIComponent(id)}/readiness`));
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
    return this.readV2Envelope(url, { auth: options.auth });
  }

  async submission(submissionId, options = {}) {
    return this.readV2Data(this.apiV2Url(`/submissions/${encodeURIComponent(submissionId)}`), {
      auth: options.auth,
    });
  }

  async reviews(options = {}) {
    const url = this.apiV2Url("/reviews");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url, { auth: options.auth });
  }

  async review(reviewId, options = {}) {
    return this.readV2Data(this.apiV2Url(`/reviews/${encodeURIComponent(reviewId)}`), {
      auth: options.auth,
    });
  }

  async auditEvents(options = {}) {
    const url = this.apiV2Url("/audit/events");
    if (options.actor) url.searchParams.set("actor", options.actor);
    if (options.action) url.searchParams.set("action", options.action);
    if (options.target) url.searchParams.set("target", options.target);
    if (options.targetType) url.searchParams.set("targetType", options.targetType);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url, { auth: options.auth });
  }

  async verifyAuditEvents(options = {}) {
    return this.readV2Data(this.apiV2Url("/audit/verify"), { auth: options.auth });
  }

  async auditRetention(options = {}) {
    return this.readV2Data(this.apiV2Url("/audit/retention"), { auth: options.auth });
  }

  async adminStatus(options = {}) {
    return this.readV2Data(this.apiV2Url("/admin/status"), { auth: options.auth });
  }

  async adminSupportBundle(options = {}) {
    const url = this.apiV2Url("/admin/support-bundle");
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    return this.readV2Data(url, { auth: options.auth });
  }

  async pruneAuditRetention(options = {}) {
    return this.writeData(this.apiV2Url("/audit/retention/prune"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify({
        dryRun: options.dryRun,
        exportHash: options.exportHash,
        exportedAt: options.exportedAt,
        exportedCount: options.exportedCount,
      }),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
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

  async createPackageReport(payload, options = {}) {
    return this.writeData(this.apiV2Url("/package-reports"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async packageReports(options = {}, requestOptions = {}) {
    const url = this.apiV2Url("/package-reports");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.packageId) url.searchParams.set("package", options.packageId);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url, { auth: requestOptions.auth });
  }

  async triagePackageReport(reportId, payload, options = {}) {
    return this.writeData(this.apiV2Url(`/package-reports/${encodeURIComponent(reportId)}/triage`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async createPackageAppeal(payload, options = {}) {
    return this.writeData(this.apiV2Url("/package-appeals"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async packageAppeals(options = {}, requestOptions = {}) {
    const url = this.apiV2Url("/package-appeals");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.packageId) url.searchParams.set("package", options.packageId);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url, { auth: requestOptions.auth });
  }

  async resolvePackageAppeal(appealId, payload, options = {}) {
    return this.writeData(this.apiV2Url(`/package-appeals/${encodeURIComponent(appealId)}/resolve`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async deletePackage(packageId, payload = {}, options = {}) {
    return this.writeData(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}`), {
      auth: options.auth,
      method: "DELETE",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async undeletePackage(packageId, options = {}) {
    return this.writeData(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}/undelete`), {
      auth: options.auth,
      method: "POST",
      expectedVersion: "v2",
    });
  }

  async getTrustedPublisher(packageId, options = {}) {
    return this.readV2Data(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}/trusted-publisher`), { auth: options.auth });
  }

  async setTrustedPublisher(packageId, payload, options = {}) {
    return this.writeData(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}/trusted-publisher`), {
      auth: options.auth,
      method: "PUT",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async deleteTrustedPublisher(packageId, options = {}) {
    return this.writeData(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}/trusted-publisher`), {
      auth: options.auth,
      method: "DELETE",
      expectedVersion: "v2",
    });
  }

  async mintPublishToken(packageId, payload, options = {}) {
    return this.writeData(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}/publish-tokens`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async revokePublishToken(packageId, tokenId, options = {}) {
    return this.writeData(this.apiV2Url(`/packages/${encodeURIComponent(packageId)}/publish-tokens/${encodeURIComponent(tokenId)}/revoke`), {
      auth: options.auth,
      method: "POST",
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

  async assignReview(reviewId, payload = {}, options = {}) {
    return this.writeData(this.apiV2Url(`/reviews/${encodeURIComponent(reviewId)}/assign`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async addReviewEvidence(reviewId, payload = {}, options = {}) {
    return this.writeData(this.apiV2Url(`/reviews/${encodeURIComponent(reviewId)}/evidence`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async claimPublisher(payload, options = {}) {
    return this.writeData(this.apiV2Url("/publishers/claim"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async publisherIdentity(options = {}) {
    return this.readV2Data(this.apiV2Url("/publishers/me"), { auth: options.auth });
  }

  async transfers(options = {}) {
    const url = this.apiV2Url("/transfers");
    if (options.status) url.searchParams.set("status", options.status);
    if (options.packageId) url.searchParams.set("package", options.packageId);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
    return this.readV2Envelope(url, { auth: options.auth });
  }

  async transfer(transferId, options = {}) {
    return this.readV2Data(this.apiV2Url(`/transfers/${encodeURIComponent(transferId)}`), {
      auth: options.auth,
    });
  }

  async requestTransfer(payload, options = {}) {
    return this.writeData(this.apiV2Url("/transfers"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async decideTransfer(transferId, decision, payload = {}, options = {}) {
    return this.writeData(this.apiV2Url(`/transfers/${encodeURIComponent(transferId)}/${decision}`), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async recordInstallEvent(payload, options = {}) {
    return this.writeData(this.apiV2Url("/install-events"), {
      auth: options.auth,
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      expectedVersion: "v2",
    });
  }

  async installAnalyticsSummary(options = {}) {
    const url = this.apiV2Url("/install-events/summary");
    if (options.packageId) url.searchParams.set("package", options.packageId);
    if (options.version) url.searchParams.set("version", options.version);
    if (options.event) url.searchParams.set("event", options.event);
    if (options.source) url.searchParams.set("source", options.source);
    if (options.since) url.searchParams.set("since", options.since);
    if (options.until) url.searchParams.set("until", options.until);
    return this.readV2Data(url, { auth: options.auth });
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

  async readV2Data(url, options = {}) {
    return (await this.readV2Envelope(url, options)).data;
  }

  async readV2Envelope(url, options = {}) {
    const response = await fetch(url, {
      headers: this.authHeaders(options.auth),
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
  corehub admin status --registry https://coreblow.com/corehub
  corehub admin support-bundle [--output file] [--limit n] --registry https://coreblow.com/corehub
  corehub audit list [--target id] [--action action] [--actor actor-id] [--format json|jsonl] [--output file] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub audit verify --registry https://coreblow.com/corehub
  corehub audit retention [--dry-run] [--prune --output file] --registry https://coreblow.com/corehub
  corehub audit incident report [--format json|markdown] [--output file] [--limit n] --registry https://coreblow.com/corehub
  corehub audit alert-metrics summarize <metrics.jsonl> [--format json|markdown] [--output file]
  corehub audit alert-metrics assert <metrics.jsonl> [--max-dead-letter-rate n] [--max-retry-rate n] [--max-failed-rate n]
  corehub analytics record <package-id> --version <version> --event installed --source cli --registry https://coreblow.com/corehub
  corehub analytics summary [--package package-id] [--event installed] [--source cli] --registry https://coreblow.com/corehub
  corehub submissions list [--status pending_review|approved|rejected] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub submissions inspect <submission-id> --registry https://coreblow.com/corehub
  corehub review list [--status open|approved|blocked] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub review status <review-id> --registry https://coreblow.com/corehub
  corehub review assign <review-id> --to moderator:<id> --registry https://coreblow.com/corehub
  corehub review evidence add <review-id> --type manual_note --summary text --registry https://coreblow.com/corehub
  corehub review approve <review-id> --registry https://coreblow.com/corehub [--notes text]
  corehub review block <review-id> --registry https://coreblow.com/corehub [--notes text]
  corehub transfers list [--status requested|completed|rejected|cancelled] [--package package-id] --registry https://coreblow.com/corehub
  corehub transfers request <package-id> --to <publisher> [--from publisher] --registry https://coreblow.com/corehub
  corehub transfers accept|reject|cancel <transfer-id> --registry https://coreblow.com/corehub [--notes text]
  corehub skill publish <skill-folder>
  corehub package explore [--family skill|code-plugin|bundle-plugin] [--category dev-tools] [--official] [--registry https://coreblow.com/corehub]
  corehub package search <query> [--family skill|code-plugin|bundle-plugin] [--category dev-tools] [--capability tag] [--official] [--registry https://coreblow.com/corehub]
  corehub package inspect <entry-id> [--registry https://coreblow.com/corehub]
  corehub package versions <entry-id> [--registry https://coreblow.com/corehub]
  corehub package files <entry-id> [--registry https://coreblow.com/corehub]
  corehub package artifact <entry-id> [--registry https://coreblow.com/corehub]
  corehub package download <entry-id> [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package verify <artifact> [--sha256 hex | --package entry-id --registry https://coreblow.com/corehub]
  corehub package moderation-status <entry-id> [--registry https://coreblow.com/corehub]
  corehub package readiness <entry-id> [--registry https://coreblow.com/corehub]
  corehub package report <entry-id> --reason text [--version version] --registry https://coreblow.com/corehub
  corehub package reports list [--status open|confirmed|dismissed|all] [--package entry-id] --registry https://coreblow.com/corehub
  corehub package reports triage <report-id> --status confirmed|dismissed|open [--note text] [--action none|quarantine|revoke] --registry https://coreblow.com/corehub
  corehub package appeal <entry-id> --version version --message text --registry https://coreblow.com/corehub
  corehub package appeals list [--status open|accepted|rejected|all] [--package entry-id] --registry https://coreblow.com/corehub
  corehub package appeals resolve <appeal-id> --status accepted|rejected|open [--note text] [--action none|approve] --registry https://coreblow.com/corehub
  corehub package trusted-publisher get|set|delete <entry-id> [--repository owner/repo] [--workflow file.yml] [--environment name] --registry https://coreblow.com/corehub
  corehub package publish-token mint <entry-id> --version version [--repository owner/repo] [--workflow file.yml] --registry https://coreblow.com/corehub
  corehub package publish-token revoke <entry-id> --token-id id --registry https://coreblow.com/corehub
  corehub package delete <entry-id> --yes [--reason text] --registry https://coreblow.com/corehub
  corehub package undelete <entry-id> --yes --registry https://coreblow.com/corehub
  corehub package install <entry-id> [--dry-run] [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package installed list
  corehub package pin|unpin|uninstall <entry-id>
  corehub package update <entry-id> [--dry-run] [--registry https://coreblow.com/corehub]
  corehub package sync [--dry-run] [--registry https://coreblow.com/corehub]
  corehub package submit <artifact|folder> --dry-run [--publisher handle] [--source url] [--changelog text] [--registry https://coreblow.com/corehub]
  corehub package upload request <artifact|folder> --dry-run [--publisher handle] [--provider r2|s3]
  corehub package upload verify <artifact|folder> --upload-slot <id> --dry-run [--publisher handle]
  corehub package transfer request <package-id> --to <publisher> [--from publisher] --registry https://coreblow.com/corehub
  corehub package publish <source> --dry-run [--family plugin|code-plugin|bundle-plugin] [--publisher handle] [--registry https://coreblow.com/corehub]
  corehub registry info --registry https://coreblow.com/corehub
`);
}

function printPackageHelp() {
  console.log(`CoreHub package commands

Usage:
  corehub package explore [--family skill|code-plugin|bundle-plugin] [--category dev-tools] [--official] [--registry https://coreblow.com/corehub]
  corehub package search <query> [--family skill|code-plugin|bundle-plugin] [--category dev-tools] [--capability tag] [--official] [--registry https://coreblow.com/corehub]
  corehub package inspect <entry-id> [--registry https://coreblow.com/corehub]
  corehub package versions <entry-id> [--registry https://coreblow.com/corehub]
  corehub package files <entry-id> [--registry https://coreblow.com/corehub]
  corehub package artifact <entry-id> [--registry https://coreblow.com/corehub]
  corehub package download <entry-id> [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package verify <artifact> [--sha256 hex | --package entry-id --registry https://coreblow.com/corehub]
  corehub package moderation-status <entry-id> [--registry https://coreblow.com/corehub]
  corehub package readiness <entry-id> [--registry https://coreblow.com/corehub]
  corehub package report <entry-id> --reason text [--version version] --registry https://coreblow.com/corehub
  corehub package reports list [--status open|confirmed|dismissed|all] [--package entry-id] --registry https://coreblow.com/corehub
  corehub package reports triage <report-id> --status confirmed|dismissed|open [--note text] [--action none|quarantine|revoke] --registry https://coreblow.com/corehub
  corehub package appeal <entry-id> --version version --message text --registry https://coreblow.com/corehub
  corehub package appeals list [--status open|accepted|rejected|all] [--package entry-id] --registry https://coreblow.com/corehub
  corehub package appeals resolve <appeal-id> --status accepted|rejected|open [--note text] [--action none|approve] --registry https://coreblow.com/corehub
  corehub package trusted-publisher get|set|delete <entry-id> [--repository owner/repo] [--workflow file.yml] [--environment name] --registry https://coreblow.com/corehub
  corehub package publish-token mint <entry-id> --version version [--repository owner/repo] [--workflow file.yml] --registry https://coreblow.com/corehub
  corehub package publish-token revoke <entry-id> --token-id id --registry https://coreblow.com/corehub
  corehub package delete <entry-id> --yes [--reason text] --registry https://coreblow.com/corehub
  corehub package undelete <entry-id> --yes --registry https://coreblow.com/corehub
  corehub package install <entry-id> [--dry-run] [--output artifact.json] [--registry https://coreblow.com/corehub]
  corehub package installed list
  corehub package pin|unpin|uninstall <entry-id>
  corehub package update <entry-id> [--dry-run] [--registry https://coreblow.com/corehub]
  corehub package sync [--dry-run] [--registry https://coreblow.com/corehub]
  corehub package submit <artifact|folder> --dry-run [--publisher handle] [--source url] [--changelog text] [--registry https://coreblow.com/corehub]
  corehub package upload request <artifact|folder> --dry-run [--publisher handle] [--provider r2|s3]
  corehub package upload verify <artifact|folder> --upload-slot <id> --dry-run [--publisher handle]
  corehub package transfer request <package-id> --to <publisher> [--from publisher] --registry https://coreblow.com/corehub
  corehub package publish <source> --dry-run [--family plugin|code-plugin|bundle-plugin] [--publisher handle] [--registry https://coreblow.com/corehub]
`);
}

function printRegistryHelp() {
  console.log(`CoreHub registry commands

Usage:
  corehub registry info --registry https://coreblow.com/corehub
`);
}

function printAdminHelp() {
  console.log(`CoreHub admin commands

Usage:
  corehub admin status --registry https://coreblow.com/corehub
  corehub admin health --registry https://coreblow.com/corehub
  corehub admin support-bundle [--output file] [--limit n] --registry https://coreblow.com/corehub
`);
}

function printAuditHelp() {
  console.log(`CoreHub audit commands

Usage:
  corehub audit list [--target id] [--target-type type] [--action action] [--actor actor-id] [--format json|jsonl] [--output file] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub audit verify --registry https://coreblow.com/corehub
  corehub audit retention [--dry-run] [--prune --output file] --registry https://coreblow.com/corehub
  corehub audit incident report [--format json|markdown] [--output file] [--limit n] --registry https://coreblow.com/corehub
  corehub audit alert-metrics summarize <metrics.jsonl> [--format json|markdown] [--output file]
  corehub audit alert-metrics assert <metrics.jsonl> [--max-dead-letter-rate n] [--max-retry-rate n] [--max-failed-rate n]
`);
}

function printAnalyticsHelp() {
  console.log(`CoreHub analytics commands

Usage:
  corehub analytics record <package-id> --version <version> --event resolved|downloaded|verified|installed|blocked|failed --source cli|coreblow|api|ci [--client-id id] --registry https://coreblow.com/corehub
  corehub analytics summary [--package package-id] [--version version] [--event event] [--source source] [--since timestamp] [--until timestamp] --registry https://coreblow.com/corehub
`);
}

function printReviewHelp() {
  console.log(`CoreHub review commands

Usage:
  corehub review list [--status open|approved|blocked] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub review status <review-id> --registry https://coreblow.com/corehub
  corehub review inspect <review-id> --registry https://coreblow.com/corehub
  corehub review assign <review-id> --to moderator:<id> --registry https://coreblow.com/corehub
  corehub review evidence add <review-id> --type manual_note --summary text --registry https://coreblow.com/corehub
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

function printTransferHelp() {
  console.log(`CoreHub transfer commands

Usage:
  corehub transfers list [--status requested|completed|rejected|cancelled] [--package package-id] [--limit n] [--offset n] --registry https://coreblow.com/corehub
  corehub transfers inspect <transfer-id> --registry https://coreblow.com/corehub
  corehub transfers status <transfer-id> --registry https://coreblow.com/corehub
  corehub transfers request <package-id> --to <publisher> [--from publisher] [--reason text] --registry https://coreblow.com/corehub
  corehub transfers accept <transfer-id> --registry https://coreblow.com/corehub [--notes text]
  corehub transfers reject <transfer-id> --registry https://coreblow.com/corehub [--notes text]
  corehub transfers cancel <transfer-id> --registry https://coreblow.com/corehub [--notes text]
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
