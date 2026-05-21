import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";

const fixturePath = resolve("fixtures/audit-alert-fail-closed.json");
const schemaPath = resolve("schemas/corehub.audit-alert.schema.json");

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const schema = JSON.parse(await readFile(schemaPath, "utf8"));
const errors = new CoreHubCatalogSchemaValidator(schema).validate(fixture);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log("CoreHub audit alert fixture matches schemas/corehub.audit-alert.schema.json.");
}
