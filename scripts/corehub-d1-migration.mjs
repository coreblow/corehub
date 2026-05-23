#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreHubD1StateStore } from "../src/api-server.mjs";

const defaultConfig = "ops/cloudflare/wrangler.corehub-api.persistence.example.toml";
const args = process.argv.slice(2);
const command = args[0] ?? "plan";
const commandArgs = args.slice(1);

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main() {
  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }

  const configPath = readOption("--config") ?? defaultConfig;
  const config = parseWranglerToml(await readFile(resolve(configPath), "utf8"));
  const table = readOption("--table") ?? config.vars.COREHUB_D1_STATE_TABLE ?? "corehub_state";
  const databaseName = readOption("--database") ?? config.d1Database?.database_name;
  const databaseId = config.d1Database?.database_id ?? null;
  const sql = `${CoreHubD1StateStore.migrationSql({ table })}\n`;

  if (command === "sql") {
    process.stdout.write(sql);
    return;
  }

  const plan = {
    status: "planned",
    config: resolve(configPath),
    binding: config.d1Database?.binding ?? null,
    databaseName: databaseName ?? null,
    databaseId,
    table,
    sql,
    applyCommand: databaseName
      ? `wrangler d1 execute ${databaseName} --remote --file <generated-sql> --config ${configPath}`
      : null,
  };

  if (command === "plan") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command !== "apply") {
    printHelp();
    process.exitCode = 2;
    return;
  }

  const dryRun = hasFlag("--dry-run") || !hasFlag("--apply");
  if (!databaseName) {
    throw new Error("D1 migration apply requires database_name in wrangler config or --database <name>");
  }
  if (!dryRun && (!databaseId || databaseId.includes("replace-with"))) {
    throw new Error("D1 migration apply requires a real database_id in the wrangler config");
  }
  if (dryRun) {
    console.log(JSON.stringify({ ...plan, status: "apply_planned", dryRun: true }, null, 2));
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "corehub-d1-migration-"));
  const sqlPath = join(tempDir, "corehub-d1-migration.sql");
  try {
    await writeFile(sqlPath, sql);
    const result = spawnSync(
      "wrangler",
      ["d1", "execute", databaseName, "--remote", "--file", sqlPath, "--config", configPath],
      { stdio: "inherit" },
    );
    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute failed with exit code ${result.status ?? "unknown"}`);
    }
    console.log(
      JSON.stringify(
        {
          ...plan,
          status: "applied",
          dryRun: false,
          sqlFile: sqlPath,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function readOption(name) {
  const index = commandArgs.indexOf(name);
  return index >= 0 ? commandArgs[index + 1] : undefined;
}

function hasFlag(name) {
  return commandArgs.includes(name);
}

function parseWranglerToml(source) {
  const vars = {};
  let d1Database = null;
  let current = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line === "[vars]") {
      current = vars;
      continue;
    }
    if (line === "[[d1_databases]]") {
      d1Database = {};
      current = d1Database;
      continue;
    }
    if (/^\[/.test(line)) {
      current = {};
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    current[match[1]] = parseTomlScalar(match[2]);
  }

  return { vars, d1Database };
}

function parseTomlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function printHelp() {
  console.log(`CoreHub D1 migration helper

Usage:
  node scripts/corehub-d1-migration.mjs sql [--config wrangler.toml] [--table corehub_state]
  node scripts/corehub-d1-migration.mjs plan [--config wrangler.toml] [--database corehub]
  node scripts/corehub-d1-migration.mjs apply [--config wrangler.toml] [--database corehub] --dry-run
  node scripts/corehub-d1-migration.mjs apply [--config wrangler.toml] [--database corehub] --apply
`);
}
