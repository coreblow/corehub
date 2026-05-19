import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";

const catalogPath = resolve("catalog.json");
const schemaPath = resolve("schemas/corehub.catalog.schema.json");

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const errors = new CoreHubCatalogSchemaValidator(schema).validate(catalog);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("CoreHub catalog matches schemas/corehub.catalog.schema.json.");
}
