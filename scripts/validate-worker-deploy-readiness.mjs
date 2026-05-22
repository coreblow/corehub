#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultConfig = "ops/cloudflare/wrangler.corehub-api.persistence.example.toml";
const args = process.argv.slice(2);
const mode = args.includes("--production") ? "production" : "template";
const configPath = readOption("--config") ?? defaultConfig;
const text = await readFile(resolve(configPath), "utf8");
const config = parseWranglerToml(text);
const errors = [];
const checks = [];

function pass(name, detail) {
  checks.push({ name, status: "pass", detail });
}

function fail(name, detail) {
  errors.push({ name, detail });
  checks.push({ name, status: "fail", detail });
}

function requireEqual(name, actual, expected) {
  if (actual === expected) pass(name, expected);
  else fail(name, `expected ${expected}, received ${actual ?? "missing"}`);
}

function requirePresent(name, value) {
  if (typeof value === "string" && value.trim().length > 0) pass(name, value);
  else fail(name, "missing");
}

requireEqual("worker main", config.root.main, "src/worker.mjs");
if ((config.root.compatibility_flags ?? "").includes("nodejs_compat")) pass("nodejs_compat", config.root.compatibility_flags);
else fail("nodejs_compat", "compatibility_flags must include nodejs_compat");

requireEqual("state store", config.vars.COREHUB_STATE_STORE, "d1");
requirePresent("public base URL", config.vars.COREHUB_PUBLIC_BASE_URL);
if (config.vars.COREHUB_PUBLIC_BASE_URL?.startsWith("https://")) pass("public base URL scheme", config.vars.COREHUB_PUBLIC_BASE_URL);
else fail("public base URL scheme", "COREHUB_PUBLIC_BASE_URL must use https");
requirePresent("D1 state key", config.vars.COREHUB_D1_STATE_KEY);
requirePresent("D1 state table", config.vars.COREHUB_D1_STATE_TABLE);
requirePresent("R2 bucket name", config.vars.COREHUB_R2_BUCKET_NAME);
requirePresent("admin actors", config.vars.COREHUB_ADMIN_ACTORS);
requireSigningKeyId(config.vars.COREHUB_SIGNING_KEY_ID);

const d1 = config.d1Databases.find((item) => item.binding === "COREHUB_D1");
if (d1) pass("D1 binding", d1.binding);
else fail("D1 binding", "missing [[d1_databases]] binding COREHUB_D1");

const r2 = config.r2Buckets.find((item) => item.binding === "COREHUB_R2");
if (r2) pass("R2 binding", r2.binding);
else fail("R2 binding", "missing [[r2_buckets]] binding COREHUB_R2");

if (/wrangler secret put COREHUB_SIGNING_SECRET/.test(text)) pass("signing secret runbook", "wrangler secret put COREHUB_SIGNING_SECRET");
else fail("signing secret runbook", "missing wrangler secret command comment");

if (mode === "production") {
  if (!d1?.database_id || d1.database_id.includes("replace-with")) {
    fail("D1 database id", "production deploy requires a real D1 database_id");
  } else {
    pass("D1 database id", d1.database_id);
  }
  const signingSecret = process.env.COREHUB_SIGNING_SECRET;
  if (typeof signingSecret === "string" && signingSecret.length >= 12) {
    pass("COREHUB_SIGNING_SECRET", "present");
  } else {
    fail("COREHUB_SIGNING_SECRET", "set COREHUB_SIGNING_SECRET with at least 12 characters before deploy");
  }
  if (process.env.COREHUB_PUBLIC_BASE_URL && process.env.COREHUB_PUBLIC_BASE_URL !== config.vars.COREHUB_PUBLIC_BASE_URL) {
    fail(
      "COREHUB_PUBLIC_BASE_URL env",
      `env ${process.env.COREHUB_PUBLIC_BASE_URL} does not match config ${config.vars.COREHUB_PUBLIC_BASE_URL}`,
    );
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ status: "failed", mode, config: configPath, checks, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "ready", mode, config: configPath, checks }, null, 2));

function readOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireSigningKeyId(value) {
  try {
    assert.match(value ?? "", /^[a-zA-Z0-9._-]+$/);
    pass("signing key id", value);
  } catch {
    fail("signing key id", "COREHUB_SIGNING_KEY_ID must use letters, numbers, dot, underscore, or dash");
  }
}

function parseWranglerToml(source) {
  const root = {};
  const vars = {};
  const d1Databases = [];
  const r2Buckets = [];
  let current = root;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    if (line === "[vars]") {
      current = vars;
      continue;
    }
    if (line === "[[d1_databases]]") {
      const item = {};
      d1Databases.push(item);
      current = item;
      continue;
    }
    if (line === "[[r2_buckets]]") {
      const item = {};
      r2Buckets.push(item);
      current = item;
      continue;
    }
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    current[match[1]] = parseTomlScalar(match[2]);
  }

  return { root, vars, d1Databases, r2Buckets };
}

function parseTomlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return trimmed;
}
