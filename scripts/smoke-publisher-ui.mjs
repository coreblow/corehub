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

const tempRoot = await mkdtemp(join(tmpdir(), "corehub-publisher-ui-smoke-"));
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
  await page.goto(`${info.url}/publisher`, { waitUntil: "domcontentloaded" });
  await assertVisibleText(page, "CoreHub Publisher Portal");
  await assertVisibleText(page, "Publisher Session");
  logStep("publisher session gate rendered");

  await page.getByPlaceholder("github:coreblow-admin").fill("github:coreblow-admin");
  await page.getByPlaceholder("publisher token").fill("local-publisher-token");
  await page.getByRole("button", { name: "Connect" }).click();

  await assertVisibleText(page, "validated publisher");
  await assertVisibleText(page, "Whoami");
  await assertVisibleText(page, "Owned Packages");
  await assertVisibleText(page, "Upload Artifact and Submit Package");
  await assertVisibleText(page, "Submission Status");
  await assertVisibleText(page, "Ownership Transfer");
  await assertVisibleText(page, "Artifact Uploads");
  await assertVisibleText(page, "admin publisher");

  const loginError = page.locator("#loginError");
  assert.equal(await loginError.isVisible(), false);
  logStep("authenticated publisher dashboard rendered");

  const dashboard = await page.evaluate(async () => {
    const response = await fetch("/corehub/api/v2/publisher/dashboard", {
      headers: {
        accept: "application/json",
        authorization: "Bearer local-publisher-token",
        "x-corehub-user": "github:coreblow-admin",
        "x-corehub-token": "local-publisher-token",
      },
    });
    return { status: response.status, payload: await response.json() };
  });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.payload.data.identity.memberships[0].publisherHandle, "coreblow");
  assert.equal(dashboard.payload.data.counts.publishers, 1);
  assert.equal(Array.isArray(dashboard.payload.data.packages), true);
  logStep("publisher dashboard API is available through browser context");

  const sessionStatus = await page.evaluate(async () => {
    const response = await fetch("/corehub/api/v2/session/validate?role=publisher", {
      headers: {
        accept: "application/json",
        authorization: "Bearer local-publisher-token",
        "x-corehub-user": "github:coreblow-admin",
        "x-corehub-token": "local-publisher-token",
      },
    });
    return { status: response.status, payload: await response.json() };
  });
  assert.equal(sessionStatus.status, 200);
  assert.equal(sessionStatus.payload.data.valid, true);
  assert.equal(sessionStatus.payload.data.role, "publisher");
  logStep("publisher session validation is explicit");

  await page.locator("#artifactUrlInput").fill("https://raw.githubusercontent.com/coreblow/corehub/b184ccee4dc283abf850d880f971ef103ddb2ab8/artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz");
  await page.locator("#artifactNameInput").fill("plugin-lab-0.2.0.coreblow-plugin.tgz");
  await page.locator("#artifactMediaTypeInput").fill("application/vnd.coreblow.plugin-archive+gzip");
  await page.locator("#artifactSizeInput").fill("736");
  await page.locator("#artifactSha256Input").fill("4de3b0826298645b080a471904b5bfb7731aaed67a6b6da2bad26402e91a6c90");
  await page.locator("#packageIdInput").fill("plugin-lab");
  await page.locator("#versionInput").fill("0.2.0");
  await page.locator("#sourceInput").fill("https://github.com/coreblow/plugin-lab");
  await page.getByRole("button", { name: "Upload and submit" }).click();
  await assertVisibleText(page, "Submitted submission-plugin-lab-0-2-0 for review.");
  await assertVisibleText(page, "submission-plugin-lab-0-2-0");
  await assertVisibleText(page, "upload-plugin-lab-0-2-0");
  logStep("publisher portal submitted external artifact package");
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
