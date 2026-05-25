#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCoreHubServer } from "../src/server.mjs";

const playwrightVersion = "1.56.1";
const fromNpx = process.argv.includes("--npx-playwright");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function logStep(message) {
  console.log(`- ${message}`);
}

async function resolvePlaywright() {
  try {
    return normalizePlaywrightModule(await import("playwright"));
  } catch (error) {
    if (fromNpx) {
      const nodeModules = resolveNpxNodeModules();
      if (nodeModules) {
        return normalizePlaywrightModule(await import(pathToFileURL(join(nodeModules, "playwright", "index.js")).href));
      }
      throw error;
    }
    const result = spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        "--package",
        `playwright@${playwrightVersion}`,
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        "--npx-playwright",
      ],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "inherit",
      },
    );
    process.exit(result.status ?? 1);
  }
}

function normalizePlaywrightModule(module) {
  if (module?.chromium) return module;
  if (module?.default?.chromium) return module.default;
  return module;
}

function resolveNpxNodeModules() {
  for (const segment of String(process.env.PATH ?? "").split(":")) {
    if (segment.endsWith("/node_modules/.bin")) return dirname(segment);
  }
  return null;
}

async function launchChromium(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!String(error?.message ?? "").includes("Executable doesn't exist")) throw error;
    const install = spawnSync("npm", ["exec", "--yes", "--package", `playwright@${playwrightVersion}`, "--", "playwright", "install", "chromium"], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    if (install.status !== 0) throw error;
    return await chromium.launch({ headless: true });
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), "corehub-admin-ui-smoke-"));
const app = await createCoreHubServer({
  dataRoot: join(tempRoot, "data"),
  host: "127.0.0.1",
  port: 0,
});

let browser;
try {
  const { chromium } = await resolvePlaywright();
  const info = await app.listen();
  logStep(`server listening at ${info.url}`);

  browser = await launchChromium(chromium);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${info.url}/admin`, { waitUntil: "domcontentloaded" });
  await assertVisibleText(page, "CoreHub Admin");
  await assertVisibleText(page, "Admin Session");
  logStep("admin session gate rendered");

  await page.getByPlaceholder("github:coreblow-admin").fill("github:coreblow-admin");
  await page.getByPlaceholder("operator token").fill("local-admin-token");
  await page.getByRole("button", { name: "Connect" }).click();

  await assertVisibleText(page, "validated admin");
  await assertVisibleText(page, "Deploy Readiness");
  await assertVisibleText(page, "Support Bundle Summary");
  await assertVisibleText(page, "Pending Submissions");
  await assertVisibleText(page, "Open Reviews");
  await assertVisibleText(page, "Comment Reports Queue");
  await assertVisibleText(page, "Community Signals");
  await assertVisibleText(page, "Profile Signals");
  await assertVisibleText(page, "ready");

  const loginError = page.locator("#loginError");
  assert.equal(await loginError.isVisible(), false);
  logStep("authenticated admin dashboard rendered");

  const apiStatus = await page.evaluate(async () => {
    const response = await fetch("/corehub/api/v2/admin/status", {
      headers: {
        accept: "application/json",
        authorization: "Bearer local-admin-token",
        "x-corehub-user": "github:coreblow-admin",
        "x-corehub-token": "local-admin-token",
      },
    });
    return { status: response.status, payload: await response.json() };
  });
  assert.equal(apiStatus.status, 200);
  assert.equal(apiStatus.payload.data.readiness.status, "ready");
  assert.equal(apiStatus.payload.data.audit.valid, true);
  logStep("admin API status is ready through browser context");

  const sessionStatus = await page.evaluate(async () => {
    const response = await fetch("/corehub/api/v2/session/validate?role=admin", {
      headers: {
        accept: "application/json",
        authorization: "Bearer local-admin-token",
        "x-corehub-user": "github:coreblow-admin",
        "x-corehub-token": "local-admin-token",
      },
    });
    return { status: response.status, payload: await response.json() };
  });
  assert.equal(sessionStatus.status, 200);
  assert.equal(sessionStatus.payload.data.valid, true);
  assert.equal(sessionStatus.payload.data.role, "admin");
  logStep("admin session validation is explicit");
} finally {
  if (browser) await browser.close();
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
}

async function assertVisibleText(page, text) {
  await page.waitForFunction((expected) => document.body?.innerText.includes(expected), text, {
    timeout: 10_000,
  });
}
