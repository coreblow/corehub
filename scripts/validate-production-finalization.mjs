#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const files = {
  wrangler: "ops/cloudflare/wrangler.corehub-api.persistence.example.toml",
  deployWorkflow: ".github/workflows/deploy.yml",
  operatorSmokeWorkflow: ".github/workflows/operator-smoke.yml",
  productionPersistence: "docs/production-persistence.md",
  productionRollback: "docs/production-rollback.md",
  directoryApi: "docs/directory-api.md",
  marketplacePlan: "docs/clawhub-package-marketplace-implementation-plan.md",
};

const checks = [];
const errors = [];
const texts = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")])),
);

requirePattern("production d1 binding", texts.wrangler, /\[\[d1_databases\]\][\s\S]*binding\s*=\s*"COREHUB_D1"/);
requirePattern("production r2 binding", texts.wrangler, /\[\[r2_buckets\]\][\s\S]*binding\s*=\s*"COREHUB_R2"/);
requirePattern("production signing secret", texts.wrangler, /wrangler secret put COREHUB_SIGNING_SECRET/);
requirePattern("production rate limit config", texts.wrangler, /COREHUB_RATE_LIMIT_MAX\s*=/);
requirePattern("deploy workflow protected environment", texts.deployWorkflow, /environment:\s*(?:\n\s*name:\s*)?Production/);
requirePattern("deploy workflow post deploy smoke", texts.deployWorkflow, /smoke:post-deploy/);
requirePattern("operator smoke workflow", texts.operatorSmokeWorkflow, /--verify-admin[\s\S]*smoke:post-deploy/);
requirePattern("rollback validated restore", texts.productionRollback, /persistence:snapshot -- validate[\s\S]*persistence:snapshot -- restore/);
requirePattern(
  "production access policy",
  texts.productionPersistence,
  /Production Access Policy[\s\S]*private[\s\S]*COREHUB_RATE_LIMIT_MAX/,
);
requirePattern(
  "private visibility docs",
  texts.directoryApi,
  /Private channel packages are excluded from anonymous Registry API v1/,
);
requirePattern("phase j status", texts.marketplacePlan, /Phase J: Production Finalization[\s\S]*Status: in progress/);

if (errors.length > 0) {
  console.error(JSON.stringify({ status: "failed", checks, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ status: "ready", checks }, null, 2));

function requirePattern(name, text, pattern) {
  if (pattern.test(text)) {
    checks.push({ name, status: "pass" });
    return;
  }
  checks.push({ name, status: "fail" });
  errors.push({ name, pattern: String(pattern) });
}
