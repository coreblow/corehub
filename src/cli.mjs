#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { CoreHubSkillInspector, readCatalog } from "./corehub.mjs";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
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
    const catalog = await readCatalog();
    const kind = readOption(args, "--kind");
    printRecords(catalog.list({ kind }));
  } else if (command === "search") {
    const query = args.join(" ").trim();
    if (!query) throw new Error("search requires a query");
    const catalog = await readCatalog();
    printRecords(catalog.search(query));
  } else if (command === "package") {
    await runPackageCommand(args);
  } else if (command === "skill") {
    await runSkillCommand(args);
  } else if (command === "inspect") {
    await runInspect(args);
  } else {
    printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function runPackageCommand(values) {
  const subcommand = values[0] ?? "help";
  const args = values.slice(1);
  const catalog = await readCatalog();

  if (subcommand === "explore" || subcommand === "list") {
    printRecords(catalog.list({ kind: readOption(args, "--kind") }));
    return;
  }

  if (subcommand === "inspect") {
    const id = args[0];
    if (!id) throw new Error("package inspect requires an entry id");
    printCatalogRecord(catalog, id);
    return;
  }

  if (subcommand === "search") {
    const query = args.join(" ").trim();
    if (!query) throw new Error("package search requires a query");
    printRecords(catalog.search(query));
    return;
  }

  if (subcommand === "publish") {
    printPlannedCommand("corehub package publish", "Registry-backed package publishing");
    return;
  }

  printPackageHelp();
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
  const target = values[0];
  if (!target) throw new Error("inspect requires a catalog id or skill folder");

  if (await isDirectory(target)) {
    const result = await new CoreHubSkillInspector().inspectFolder(target);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const catalog = await readCatalog();
  printCatalogRecord(catalog, target);
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

function printRecords(records) {
  for (const record of records) {
    const score = record.score === undefined ? "" : ` score=${record.score}`;
    console.log(`${record.id}\t${record.kind}\t${record.name}${score}`);
    console.log(`  ${record.summary}`);
    console.log(`  ${record.source}`);
  }
}

function printHelp() {
  console.log(`CoreHub CLI

Usage:
  corehub validate
  corehub explore [--kind skill|plugin|provider|channel]
  corehub list [--kind skill|plugin|provider|channel]
  corehub search <query>
  corehub inspect <entry-id|skill-folder>
  corehub skill publish <skill-folder>
  corehub package explore [--kind skill|plugin|provider|channel]
  corehub package search <query>
  corehub package inspect <entry-id>
  corehub package publish <source>
`);
}

function printPackageHelp() {
  console.log(`CoreHub package commands

Usage:
  corehub package explore [--kind skill|plugin|provider|channel]
  corehub package search <query>
  corehub package inspect <entry-id>
  corehub package publish <source>
`);
}

function printSkillHelp() {
  console.log(`CoreHub skill commands

Usage:
  corehub skill publish <skill-folder>
`);
}
