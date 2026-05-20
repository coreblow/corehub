import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { CoreHubCatalog, CoreHubSkillInspector, validateCatalog } from "../src/corehub.mjs";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";

const execFileAsync = promisify(execFile);
const entries = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf-8"));
const schema = JSON.parse(
  await readFile(new URL("../schemas/corehub.catalog.schema.json", import.meta.url), "utf-8"),
);
const errors = validateCatalog(entries);

assert.deepEqual(errors, []);
assert.deepEqual(new CoreHubCatalogSchemaValidator(schema).validate(entries), []);
assert.equal(entries[0].id, "coreblow");

const catalog = new CoreHubCatalog(entries);
assert.equal(catalog.findById("plugin-lab").kind, "plugin");
assert.equal(catalog.list({ kind: "skill" }).length, 1);
assert.equal(catalog.list({ verifiedOnly: true }).length, entries.length);

const searchResults = catalog.search("plugin compatibility");
assert.equal(searchResults[0].id, "plugin-lab");
assert.ok(searchResults[0].score > 0);

const invalid = validateCatalog([
  {
    id: "Bad ID",
    kind: "unknown",
    name: "",
    summary: "",
    source: "https://example.com/not-github",
    tags: ["Not Kebab"],
    coreblow: {
      minCoreblowVersion: "v1",
      requiresEnv: ["bad-env"],
    },
  },
]);
assert.ok(invalid.some((error) => error.includes("id must be kebab-case")));
assert.ok(invalid.some((error) => error.includes("kind must be one of")));
assert.ok(invalid.some((error) => error.includes("source must be a GitHub URL")));
assert.ok(invalid.some((error) => error.includes("coreblow.requiresEnv")));

const inspected = await new CoreHubSkillInspector().inspectFolder(
  new URL("../fixtures/example-skill", import.meta.url).pathname,
);
assert.equal(inspected.hasSkillFile, true);
assert.equal(inspected.hasManifest, true);
assert.ok(inspected.fingerprint);
assert.ok(inspected.files.some((file) => file.path === "SKILL.md"));

const cliPath = new URL("../src/cli.mjs", import.meta.url).pathname;
const explore = await execFileAsync(process.execPath, [cliPath, "explore"]);
assert.match(explore.stdout, /corehub-directory\tskill\tCoreHub Directory Metadata/);

const packageInspect = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "inspect",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageInspect.stdout).id, "plugin-lab");

const skillPublish = await execFileAsync(process.execPath, [
  cliPath,
  "skill",
  "publish",
  new URL("../fixtures/example-skill", import.meta.url).pathname,
]);
assert.equal(JSON.parse(skillPublish.stdout).dryRun, true);
