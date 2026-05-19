import { CoreHubCatalogValidator } from "./corehub.mjs";

export function validateCatalogEntry(entry) {
  return new CoreHubCatalogValidator().validateEntry(entry);
}

export function validateCatalog(entries) {
  return new CoreHubCatalogValidator().validate(entries);
}
