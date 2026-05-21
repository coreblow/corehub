import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";

const statePath = resolve("fixtures/write-side-state.json");
const schemaPath = resolve("schemas/corehub.write-side.schema.json");

const state = JSON.parse(await readFile(statePath, "utf8"));
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const errors = new CoreHubCatalogSchemaValidator(schema).validate(state);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("CoreHub write-side fixture matches schemas/corehub.write-side.schema.json.");
}
