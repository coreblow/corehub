#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { CoreHubSkillInspector, readCatalog } from "./corehub.mjs";

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);
const defaultRegistry = process.env.COREHUB_REGISTRY ?? "";

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
  } else if (command === "package") {
    await runPackageCommand(args);
  } else if (command === "registry") {
    await runRegistryCommand(args);
  } else if (command === "skill") {
    await runSkillCommand(args);
  } else if (command === "inspect") {
    await runInspect(args);
  } else {
    printHelp();
  }
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
  return [
    {
      id: record.id,
      version: record.version ?? null,
      tag: "latest",
      review: record.review ?? null,
      source: record.source,
    },
  ];
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

function positionalArgs(values) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith("--")) {
      index += 1;
      continue;
    }
    result.push(value);
  }
  return result;
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
    console.log(`${version.id}\t${version.tag ?? "version"}\t${version.version ?? "unversioned"}`);
    if (version.source) console.log(`  ${version.source}`);
  }
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

  apiUrl(path) {
    return new URL(`${this.registry}/api/v1${path}`);
  }

  async readData(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "corehub-cli" },
    });
    if (!response.ok) {
      throw new Error(`CoreHub registry request failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!payload || payload.apiVersion !== "v1" || !("data" in payload)) {
      throw new Error("CoreHub registry returned an invalid v1 response");
    }
    return payload.data;
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
  corehub explore [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub list [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub search <query> [--registry https://coreblow.com/corehub]
  corehub inspect <entry-id|skill-folder> [--registry https://coreblow.com/corehub]
  corehub skill publish <skill-folder>
  corehub package explore [--kind skill|plugin|provider|channel] [--registry https://coreblow.com/corehub]
  corehub package search <query> [--registry https://coreblow.com/corehub]
  corehub package inspect <entry-id> [--registry https://coreblow.com/corehub]
  corehub package versions <entry-id> [--registry https://coreblow.com/corehub]
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
  corehub package publish <source>
`);
}

function printRegistryHelp() {
  console.log(`CoreHub registry commands

Usage:
  corehub registry info --registry https://coreblow.com/corehub
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
