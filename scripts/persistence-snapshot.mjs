#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const supportedSchemaVersion = "corehub.local-state.v1";
const currentPersistenceVersion = "corehub.persistence.v1";
const migrations = [
  {
    id: "2026-05-22-corehub-local-state-v1",
    from: "none",
    to: currentPersistenceVersion,
    snapshotSchemaVersion: supportedSchemaVersion,
    destructive: false,
    description: "Baseline full-snapshot persistence contract for CoreHub write-side state.",
  },
];
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const commandArgs = args.slice(1);

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "current") {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          currentPersistenceVersion,
          supportedSchemaVersion,
          latestMigrationId: migrations.at(-1)?.id ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "migrations") {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          currentPersistenceVersion,
          supportedSchemaVersion,
          migrations,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "export") {
    const input = readOption(commandArgs, "--input") ?? process.env.COREHUB_STATE_PATH;
    const output = readOption(commandArgs, "--output");
    if (!input) throw new Error("persistence export requires --input or COREHUB_STATE_PATH");
    if (!output) throw new Error("persistence export requires --output");
    const snapshot = await readSnapshot(input);
    const validation = validateSnapshot(snapshot);
    if (validation.status !== "valid") {
      console.log(JSON.stringify({ status: "invalid", input: resolve(input), validation }, null, 2));
      process.exitCode = 1;
      return;
    }
    const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;
    await mkdir(dirname(resolve(output)), { recursive: true });
    await writeFile(output, rendered);
    console.log(
      JSON.stringify(
        {
          status: "exported",
          input: resolve(input),
          output: resolve(output),
          schemaVersion: snapshot.schemaVersion,
          sha256: sha256(rendered),
          counts: snapshotCounts(snapshot),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "validate") {
    const input = readOption(commandArgs, "--input") ?? positionalArgs(commandArgs)[0];
    if (!input) throw new Error("persistence validate requires --input <snapshot>");
    const snapshot = await readSnapshot(input);
    const validation = validateSnapshot(snapshot);
    console.log(JSON.stringify({ input: resolve(input), ...validation }, null, 2));
    if (validation.status !== "valid") process.exitCode = 1;
    return;
  }

  if (command === "restore") {
    const input = readOption(commandArgs, "--input") ?? positionalArgs(commandArgs)[0];
    const output = readOption(commandArgs, "--output") ?? process.env.COREHUB_STATE_PATH;
    const dryRun = hasFlag(commandArgs, "--dry-run") || !hasFlag(commandArgs, "--apply");
    if (!input) throw new Error("persistence restore requires --input <snapshot>");
    if (!output) throw new Error("persistence restore requires --output or COREHUB_STATE_PATH");
    const snapshot = await readSnapshot(input);
    const validation = validateSnapshot(snapshot);
    if (validation.status !== "valid") {
      console.log(JSON.stringify({ status: "invalid", input: resolve(input), output: resolve(output), validation }, null, 2));
      process.exitCode = 1;
      return;
    }
    if (!dryRun) {
      await mkdir(dirname(resolve(output)), { recursive: true });
      await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    console.log(
      JSON.stringify(
        {
          status: dryRun ? "restore_planned" : "restored",
          dryRun,
          input: resolve(input),
          output: resolve(output),
          schemaVersion: snapshot.schemaVersion,
          counts: snapshotCounts(snapshot),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "migrate") {
    const input = readOption(commandArgs, "--input") ?? process.env.COREHUB_STATE_PATH;
    const backup = readOption(commandArgs, "--backup");
    const dryRun = hasFlag(commandArgs, "--dry-run") || !hasFlag(commandArgs, "--apply");
    if (!input) throw new Error("persistence migrate requires --input or COREHUB_STATE_PATH");
    if (!backup) throw new Error("persistence migrate requires --backup");
    const snapshot = await readSnapshot(input);
    const validation = validateSnapshot(snapshot);
    const backupValidation = validateSnapshot(await readSnapshot(backup));
    const plan = buildMigrationPlan({ input, backup, validation, backupValidation, dryRun });
    if (validation.status !== "valid" || backupValidation.status !== "valid") {
      console.log(JSON.stringify(plan, null, 2));
      process.exitCode = 1;
      return;
    }
    if (!dryRun) {
      await writeFile(input, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  printHelp();
  process.exitCode = 2;
}

async function readSnapshot(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") {
    errors.push("snapshot must be an object");
  } else {
    if (snapshot.schemaVersion !== supportedSchemaVersion) {
      errors.push(`schemaVersion must be ${supportedSchemaVersion}`);
    }
    for (const key of [
      "slots",
      "submissions",
      "reviews",
      "packageVersions",
      "ownershipTransfers",
      "installEvents",
      "auditEvents",
      "auditCheckpoints",
    ]) {
      if (!Array.isArray(snapshot[key])) errors.push(`${key} must be an array`);
    }
    const auditErrors = validateAuditChainShape(snapshot.auditEvents ?? [], snapshot.auditCheckpoints ?? []);
    errors.push(...auditErrors);
  }
  return {
    status: errors.length === 0 ? "valid" : "invalid",
    schemaVersion: snapshot?.schemaVersion ?? null,
    errors,
    counts: snapshot && typeof snapshot === "object" ? snapshotCounts(snapshot) : {},
  };
}

function validateAuditChainShape(events, checkpoints) {
  const errors = [];
  const latestCheckpoint = checkpoints.reduce((latest, checkpoint) => {
    if (!latest || checkpoint.sequence > latest.sequence) return checkpoint;
    return latest;
  }, null);
  let previousHash = latestCheckpoint?.head ?? "0".repeat(64);
  let expectedSequence = (latestCheckpoint?.sequence ?? 0) + 1;
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.sequence !== expectedSequence) errors.push(`${event.id ?? "audit-event"}.sequence expected ${expectedSequence}`);
    if (event.previousHash !== previousHash) errors.push(`${event.id ?? "audit-event"}.previousHash expected ${previousHash}`);
    if (!/^[a-f0-9]{64}$/.test(String(event.eventHash ?? ""))) {
      errors.push(`${event.id ?? "audit-event"}.eventHash must be sha256`);
    }
    previousHash = event.eventHash ?? "";
    expectedSequence = Number(event.sequence ?? 0) + 1;
  }
  return errors;
}

function snapshotCounts(snapshot) {
  return {
    slots: snapshot.slots?.length ?? 0,
    submissions: snapshot.submissions?.length ?? 0,
    reviews: snapshot.reviews?.length ?? 0,
    packageVersions: snapshot.packageVersions?.length ?? 0,
    ownershipTransfers: snapshot.ownershipTransfers?.length ?? 0,
    installEvents: snapshot.installEvents?.length ?? 0,
    auditEvents: snapshot.auditEvents?.length ?? 0,
    auditCheckpoints: snapshot.auditCheckpoints?.length ?? 0,
  };
}

function buildMigrationPlan({ input, backup, validation, backupValidation, dryRun }) {
  const steps = migrations.map((migration) => ({
    id: migration.id,
    from: migration.from,
    to: migration.to,
    destructive: migration.destructive,
    status: validation.schemaVersion === migration.snapshotSchemaVersion ? "already_applied" : "pending",
    description: migration.description,
  }));
  return {
    status: validation.status === "valid" && backupValidation.status === "valid" ? (dryRun ? "migration_planned" : "migrated") : "blocked",
    dryRun,
    input: resolve(input),
    backup: resolve(backup),
    currentPersistenceVersion,
    supportedSchemaVersion,
    backupRequired: true,
    validation,
    backupValidation,
    steps,
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readOption(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return undefined;
  return values[index + 1];
}

function hasFlag(values, name) {
  return values.includes(name);
}

function positionalArgs(values) {
  return values.filter((value, index) => !value.startsWith("--") && !values[index - 1]?.startsWith("--"));
}

function printHelp() {
  console.log(`CoreHub persistence snapshot tools

Usage:
  node scripts/persistence-snapshot.mjs export --input state.json --output backup.json
  node scripts/persistence-snapshot.mjs validate --input backup.json
  node scripts/persistence-snapshot.mjs current
  node scripts/persistence-snapshot.mjs migrations
  node scripts/persistence-snapshot.mjs migrate --input state.json --backup backup.json --dry-run
  node scripts/persistence-snapshot.mjs restore --input backup.json --output state.json --dry-run
  node scripts/persistence-snapshot.mjs restore --input backup.json --output state.json --apply
`);
}
