import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CoreHubCatalog, CoreHubSkillInspector, validateCatalog } from "../src/corehub.mjs";

const entries = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf-8"));
const errors = validateCatalog(entries);

assert.deepEqual(errors, []);
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
