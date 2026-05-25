#!/usr/bin/env node

const suites = {
  "public-api": [
    "../test/public-api-compat.test.mjs",
    "../test/npm-artifact-routes.test.mjs",
  ],
  cli: ["../test/cli-moderator-surface.test.mjs"],
  scanner: ["../test/scanner-routes.test.mjs"],
  skill: ["../test/community-skill-routes.test.mjs"],
  community: ["../test/community-moderation-ui.test.mjs"],
  accounts: [
    "../test/oauth-account-routes.test.mjs",
    "../test/account-org-settings.test.mjs",
    "../test/publisher-portal-hardening.test.mjs",
  ],
  legacy: ["../test/catalog.test.mjs"],
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(suites);

for (const name of names) {
  const files = suites[name];
  if (!files) {
    console.error(`Unknown CoreHub test surface: ${name}`);
    console.error(`Available surfaces: ${Object.keys(suites).join(", ")}`);
    process.exit(1);
  }
  console.log(`CoreHub test surface: ${name}`);
  for (const file of files) await import(file);
}
