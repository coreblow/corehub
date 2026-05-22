#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const input = readOption("--input") ?? "ops/cloudflare/wrangler.corehub-api.persistence.example.toml";
const output = readOption("--output") ?? "ops/cloudflare/wrangler.corehub-api.production.toml";
const databaseId = readOption("--database-id") ?? process.env.COREHUB_D1_DATABASE_ID;
const force = args.includes("--force");

if (!databaseId || databaseId.includes("replace-with") || !/^[a-zA-Z0-9_-]+$/.test(databaseId)) {
  fail("Provide a real D1 database id with --database-id or COREHUB_D1_DATABASE_ID.");
}

const inputPath = resolve(input);
const outputPath = resolve(output);
if (inputPath === outputPath) fail("Refusing to overwrite the input template.");

const existing = await readFile(outputPath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
if (existing && !force) {
  fail(`Output already exists: ${output}. Re-run with --force to replace it.`);
}

await mkdir(dirname(outputPath), { recursive: true });
await copyFile(inputPath, outputPath);
const source = await readFile(outputPath, "utf8");
const rendered = source
  .replace('database_id = "replace-with-cloudflare-d1-database-id"', `database_id = "${databaseId}"`)
  .replace(
    "# Required before deploy:",
    [
      "# Production materialized from ops/cloudflare/wrangler.corehub-api.persistence.example.toml.",
      "# Do not commit this file with environment-specific resource ids.",
      "# Required before deploy:",
    ].join("\n"),
  );
await writeFile(outputPath, rendered);

console.log(
  JSON.stringify(
    {
      status: "materialized",
      input,
      output,
      d1DatabaseId: databaseId,
      next: [
        `wrangler secret put COREHUB_SIGNING_SECRET --config ${output}`,
        `COREHUB_SIGNING_SECRET=<secret> npm run deploy:worker:check -- --config ${output} --require-wrangler`,
        `wrangler deploy --config ${output}`,
      ],
    },
    null,
    2,
  ),
);

function readOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message) {
  console.error(JSON.stringify({ status: "failed", error: message }, null, 2));
  process.exit(1);
}
