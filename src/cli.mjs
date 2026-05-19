#!/usr/bin/env node
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
  } else if (command === "list") {
    const catalog = await readCatalog();
    const kind = readOption(args, "--kind");
    printRecords(catalog.list({ kind }));
  } else if (command === "search") {
    const query = args.join(" ").trim();
    if (!query) throw new Error("search requires a query");
    const catalog = await readCatalog();
    printRecords(catalog.search(query));
  } else if (command === "inspect") {
    const folder = args[0];
    if (!folder) throw new Error("inspect requires a folder");
    const result = await new CoreHubSkillInspector().inspectFolder(folder);
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHelp();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
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
  corehub list [--kind skill|plugin|provider|channel]
  corehub search <query>
  corehub inspect <skill-folder>
`);
}
