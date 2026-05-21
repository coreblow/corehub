import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { CoreHubCatalog, CoreHubSkillInspector, validateCatalog } from "../src/corehub.mjs";
import { CoreHubCatalogSchemaValidator } from "../src/schema-validator.mjs";

const execFileAsync = promisify(execFile);
const entries = JSON.parse(await readFile(new URL("../catalog.json", import.meta.url), "utf-8"));
const schema = JSON.parse(
  await readFile(new URL("../schemas/corehub.catalog.schema.json", import.meta.url), "utf-8"),
);
const writeSideSchema = JSON.parse(
  await readFile(new URL("../schemas/corehub.write-side.schema.json", import.meta.url), "utf-8"),
);
const writeSideState = JSON.parse(
  await readFile(new URL("../fixtures/write-side-state.json", import.meta.url), "utf-8"),
);
const pluginLabEntry = entries.find((entry) => entry.id === "plugin-lab");
const errors = validateCatalog(entries);
const pluginLabArtifactBytes = await readFile(
  new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url),
);
const pluginLabArtifactManifest = JSON.parse(
  await readFile(
    new URL("../artifacts/plugin-lab-0.1.0.corehub-manifest.json", import.meta.url),
    "utf-8",
  ),
);
const pluginLabArtifactUrl = "/artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz";
const pluginLabRemoteArtifact = {
  ...entries[2].versions[0].artifact,
  storage: {
    ...entries[2].versions[0].artifact.storage,
    url: pluginLabArtifactUrl,
  },
};

assert.deepEqual(errors, []);
assert.deepEqual(new CoreHubCatalogSchemaValidator(schema).validate(entries), []);
assert.deepEqual(new CoreHubCatalogSchemaValidator(writeSideSchema).validate(writeSideState), []);
assert.equal(entries[0].id, "coreblow");
assert.equal(writeSideState.schemaVersion, "corehub.write.v1");
assert.equal(writeSideState.authSessions[0].actor.id, "github:coreblow-admin");
assert.equal(writeSideState.publisherClaims[0].handle, "coreblow");
assert.equal(writeSideState.packageSubmissions[0].status, "approved");
assert.equal(writeSideState.packageVersions[0].status, "available");
assert.equal(writeSideState.artifactUploads[0].sha256, pluginLabEntry.versions[0].artifact.sha256);
assert.equal(writeSideState.artifactUploads[0].size, pluginLabEntry.versions[0].artifact.size);

const catalog = new CoreHubCatalog(entries);
assert.equal(catalog.findById("plugin-lab").kind, "plugin");
assert.equal(catalog.findById("plugin-lab").publisher.handle, "coreblow");
assert.equal(catalog.listVersions("plugin-lab")[0].publisher.handle, "coreblow");
assert.equal(catalog.findVersion("plugin-lab", "latest").status, "available");
assert.equal(catalog.findVersion("plugin-lab", "latest").artifact.downloadEnabled, true);
assert.equal(
  catalog.findVersion("plugin-lab", "0.1.0").artifact.name,
  "plugin-lab-0.1.0.coreblow-plugin.tgz",
);
assert.equal(
  catalog.findVersion("plugin-lab", "0.1.0").artifact.storage.key,
  "artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz",
);
assert.equal(catalog.findVersion("plugin-lab", "0.1.0").artifact.files.length, 5);
assert.ok(
  catalog
    .findVersion("plugin-lab", "0.1.0")
    .artifact.files.some((file) => file.path === "corehub.artifact.json"),
);
assert.equal(pluginLabArtifactManifest.schemaVersion, "corehub.artifact.v1");
assert.equal(pluginLabArtifactManifest.package.id, "plugin-lab");
assert.deepEqual(
  pluginLabArtifactManifest.artifact.files,
  catalog.findVersion("plugin-lab", "0.1.0").artifact.files,
);
assert.equal(
  pluginLabArtifactManifest.artifact.sha256,
  catalog.findVersion("plugin-lab", "0.1.0").artifact.sha256,
);

for (const entry of entries) {
  for (const version of entry.versions ?? []) {
    const artifact = version.artifact;
    if (artifact?.storage?.provider !== "github-raw") continue;
    const bytes = await readFile(new URL(`../${artifact.storage.key}`, import.meta.url));
    assert.equal(bytes.byteLength, artifact.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
}
assert.equal(catalog.list({ kind: "skill" }).length, 1);
assert.equal(catalog.list({ verifiedOnly: true }).length, entries.length);
assert.equal(catalog.listPublishers().length, 1);
assert.equal(catalog.findPublisher("coreblow").entries.length, entries.length);

const searchResults = catalog.search("compatibility lab fixtures");
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
    publisher: {
      handle: "Bad Publisher",
      displayName: "",
      url: "not-url",
      verified: "yes",
    },
    versions: [
      {
        version: "v1",
        tag: "Bad Tag",
        publishedAt: "",
        publisher: { handle: "other" },
        status: "unknown",
        artifact: {
          name: "",
          mediaType: "",
          size: -1,
          sha256: "bad",
          downloadEnabled: "yes",
          storage: { provider: "unknown", key: "", url: "not-url" },
          provenance: { source: "https://example.com/not-github", reviewState: "unknown" },
          files: [{ path: "", size: -1, sha256: "bad" }],
        },
      },
    ],
    coreblow: {
      minCoreblowVersion: "v1",
      requiresEnv: ["bad-env"],
    },
  },
]);
assert.ok(invalid.some((error) => error.includes("id must be kebab-case")));
assert.ok(invalid.some((error) => error.includes("kind must be one of")));
assert.ok(invalid.some((error) => error.includes("source must be a GitHub URL")));
assert.ok(invalid.some((error) => error.includes("publisher.handle")));
assert.ok(invalid.some((error) => error.includes("publisher.verified")));
assert.ok(invalid.some((error) => error.includes("versions[0].publisher.handle")));
assert.ok(invalid.some((error) => error.includes("versions[0].artifact.sha256")));
assert.ok(invalid.some((error) => error.includes("versions[0].artifact.storage.provider")));
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

const packageVersions = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "versions",
  "plugin-lab",
]);
assert.match(packageVersions.stdout, /plugin-lab\tlatest\t0\.1\.0\tavailable/);
assert.match(packageVersions.stdout, /publisher=coreblow/);

const packageArtifact = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "artifact",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageArtifact.stdout).artifact.downloadEnabled, true);

const packageFiles = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "files",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageFiles.stdout).artifact.name, "plugin-lab-0.1.0.coreblow-plugin.tgz");

const packageDownload = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "download",
  "plugin-lab",
]);
assert.equal(JSON.parse(packageDownload.stdout).download.available, true);

const packageInstall = await execFileAsync(process.execPath, [
  cliPath,
  "package",
  "install",
  "plugin-lab",
]);
const installPlan = JSON.parse(packageInstall.stdout);
assert.equal(installPlan.dryRun, false);
assert.equal(installPlan.install.status, "blocked");
assert.equal(installPlan.download.verified, false);
assert.match(installPlan.install.message, /resolved an installable CoreBlow plugin archive/);
assert.equal(installPlan.plan.at(-1).step, "install-plugin");

const topLevelInstallPreview = await execFileAsync(process.execPath, [
  cliPath,
  "install",
  "--dry-run",
  "plugin-lab",
  "--json",
]);
const previewPlan = JSON.parse(topLevelInstallPreview.stdout);
assert.equal(previewPlan.dryRun, true);
assert.equal(previewPlan.install.status, "planned");

const publisherList = await execFileAsync(process.execPath, [cliPath, "publishers", "list"]);
assert.equal(JSON.parse(publisherList.stdout)[0].handle, "coreblow");

const publisherInspect = await execFileAsync(process.execPath, [
  cliPath,
  "publishers",
  "inspect",
  "coreblow",
]);
assert.equal(JSON.parse(publisherInspect.stdout).entries.length, entries.length);

const authHome = await mkdtemp(join(tmpdir(), "corehub-auth-"));
try {
  const authEnv = { ...process.env, COREHUB_HOME: authHome };
  const login = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "login",
      "--token",
      "local-dev-token",
      "--user",
      "github:coreblow-admin",
      "--publisher",
      "coreblow",
      "--json",
    ],
    { env: authEnv },
  );
  assert.equal(JSON.parse(login.stdout).defaultPublisher.handle, "coreblow");

  const whoami = await execFileAsync(process.execPath, [cliPath, "publisher", "whoami", "--json"], {
    env: authEnv,
  });
  const whoamiPayload = JSON.parse(whoami.stdout);
  assert.equal(whoamiPayload.actor.id, "github:coreblow-admin");
  assert.equal(whoamiPayload.memberships[0].publisherHandle, "coreblow");

  const claim = await execFileAsync(
    process.execPath,
    [cliPath, "publisher", "claim", "example-org", "--dry-run", "--display-name", "Example Org"],
    { env: authEnv },
  );
  const claimPayload = JSON.parse(claim.stdout);
  assert.equal(claimPayload.dryRun, true);
  assert.equal(claimPayload.status, "planned");
  assert.equal(claimPayload.claim.handle, "example-org");

  const folderSubmit = await execFileAsync(
    process.execPath,
    [cliPath, "package", "submit", new URL("../fixtures/plugin-lab-plugin", import.meta.url).pathname, "--dry-run"],
    { env: authEnv },
  );
  const folderSubmitPayload = JSON.parse(folderSubmit.stdout);
  assert.equal(folderSubmitPayload.dryRun, true);
  assert.equal(folderSubmitPayload.submission.status, "pending_review");
  assert.equal(folderSubmitPayload.submission.packageId, "plugin-lab");
  assert.equal(folderSubmitPayload.submission.publisherHandle, "coreblow");
  assert.equal(folderSubmitPayload.artifactUpload.status, "verified");
  assert.equal(folderSubmitPayload.artifactUpload.mediaType, "application/vnd.coreblow.plugin-folder");

  const archiveSubmit = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "package",
      "submit",
      new URL("../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url).pathname,
      "--dry-run",
    ],
    { env: authEnv },
  );
  const archiveSubmitPayload = JSON.parse(archiveSubmit.stdout);
  assert.equal(archiveSubmitPayload.source.type, "archive");
  assert.equal(archiveSubmitPayload.submission.status, "pending_review");
  assert.equal(archiveSubmitPayload.artifactUpload.sha256, pluginLabEntry.versions[0].artifact.sha256);
  assert.equal(archiveSubmitPayload.artifactUpload.size, pluginLabEntry.versions[0].artifact.size);

  const logout = await execFileAsync(process.execPath, [cliPath, "logout"], { env: authEnv });
  assert.match(logout.stdout, /Logged out/);
} finally {
  await rm(authHome, { recursive: true, force: true });
}

const skillPublish = await execFileAsync(process.execPath, [
  cliPath,
  "skill",
  "publish",
  new URL("../fixtures/example-skill", import.meta.url).pathname,
]);
assert.equal(JSON.parse(skillPublish.stdout).dryRun, true);

const registryServer = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json;charset=UTF-8");

  if (url.pathname === "/corehub/api/v1/entries") {
    response.end(JSON.stringify({ apiVersion: "v1", data: [entries[1]], meta: { count: 1 } }));
    return;
  }

  if (url.pathname === "/corehub/api/v1") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          name: "CoreHub Registry API",
          entries: "/corehub/api/v1/entries",
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/search") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: [{ ...entries[2], score: 8 }],
        meta: { count: 1, query: url.searchParams.get("q") },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab") {
    response.end(JSON.stringify({ apiVersion: "v1", data: entries[2], meta: { count: 1 } }));
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/versions") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: new CoreHubCatalog(entries).listVersions("plugin-lab"),
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/artifact") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          package: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab" },
          version: "0.1.0",
          publisher: { handle: "coreblow" },
          artifact: pluginLabRemoteArtifact,
          files: [],
          download: { available: true, url: new URL(pluginLabArtifactUrl, `http://${request.headers.host}`) },
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/packages/plugin-lab/download") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: {
          package: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab" },
          version: "0.1.0",
          publisher: { handle: "coreblow" },
          artifact: pluginLabRemoteArtifact,
          download: {
            available: true,
            url: new URL(pluginLabArtifactUrl, `http://${request.headers.host}`),
          },
        },
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === pluginLabArtifactUrl) {
    response.setHeader("Content-Type", "application/vnd.coreblow.plugin-archive+gzip");
    response.end(pluginLabArtifactBytes);
    return;
  }

  if (url.pathname === "/corehub/api/v1/publishers") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: [{ handle: "coreblow", displayName: "CoreBlow", entries: [entries[2]] }],
        meta: { count: 1 },
      }),
    );
    return;
  }

  if (url.pathname === "/corehub/api/v1/publishers/coreblow") {
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        data: { handle: "coreblow", displayName: "CoreBlow", entries: [entries[2]] },
        meta: { count: 1 },
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ apiVersion: "v1", data: null, meta: { count: 0 } }));
});

await new Promise((resolve) => registryServer.listen(0, "127.0.0.1", resolve));
try {
  const registryUrl = `http://127.0.0.1:${registryServer.address().port}/corehub`;
  const remoteExplore = await execFileAsync(process.execPath, [
    cliPath,
    "explore",
    "--registry",
    registryUrl,
  ]);
  assert.match(remoteExplore.stdout, /corehub-directory\tskill\tCoreHub Directory Metadata/);

  const remoteSearch = await execFileAsync(process.execPath, [
    cliPath,
    "search",
    "plugin",
    "--registry",
    registryUrl,
  ]);
  assert.match(remoteSearch.stdout, /plugin-lab\tplugin\tPlugin Lab score=8/);

  const remoteInspect = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "inspect",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteInspect.stdout).id, "plugin-lab");

  const remoteVersions = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "versions",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.match(remoteVersions.stdout, /plugin-lab\tlatest\t0\.1\.0\tavailable/);

  const remoteArtifact = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "artifact",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteArtifact.stdout).artifact.downloadEnabled, true);

  const remoteDownload = await execFileAsync(process.execPath, [
    cliPath,
    "package",
    "download",
    "plugin-lab",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteDownload.stdout).download.available, true);

  const downloadDir = await mkdtemp(join(tmpdir(), "corehub-download-"));
  try {
    const downloadPath = join(downloadDir, "plugin-lab.coreblow-plugin.tgz");
    const remoteVerifiedDownload = await execFileAsync(process.execPath, [
      cliPath,
      "package",
      "download",
      "plugin-lab",
      "--output",
      downloadPath,
      "--registry",
      registryUrl,
    ]);
    const verified = JSON.parse(remoteVerifiedDownload.stdout);
    assert.equal(verified.output.verified, true);
    assert.equal(verified.output.bytes, entries[2].versions[0].artifact.size);
    assert.equal(verified.output.sha256, entries[2].versions[0].artifact.sha256);
    assert.deepEqual(await readFile(downloadPath), pluginLabArtifactBytes);
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }

  const installDir = await mkdtemp(join(tmpdir(), "corehub-install-"));
  try {
    const installPath = join(installDir, "plugin-lab.coreblow-plugin.tgz");
    const remoteInstall = await execFileAsync(process.execPath, [
      cliPath,
      "package",
      "install",
      "plugin-lab",
      "--output",
      installPath,
      "--registry",
      registryUrl,
    ]);
    const plan = JSON.parse(remoteInstall.stdout);
    assert.equal(plan.dryRun, false);
    assert.equal(plan.install.status, "blocked");
    assert.equal(plan.download.verified, true);
    assert.equal(plan.download.output.bytes, entries[2].versions[0].artifact.size);
    assert.equal(plan.download.output.sha256, entries[2].versions[0].artifact.sha256);
    assert.equal(plan.plan.find((step) => step.step === "fetch-artifact").status, "complete");
    assert.deepEqual(await readFile(installPath), pluginLabArtifactBytes);
  } finally {
    await rm(installDir, { recursive: true, force: true });
  }

  const remoteTopLevelPreview = await execFileAsync(process.execPath, [
    cliPath,
    "install",
    "plugin-lab",
    "--dry-run",
    "--json",
    "--registry",
    registryUrl,
  ]);
  const remotePreview = JSON.parse(remoteTopLevelPreview.stdout);
  assert.equal(remotePreview.dryRun, true);
  assert.equal(remotePreview.install.status, "planned");

  const remoteTopLevelInstall = await execFileAsync(process.execPath, [
    cliPath,
    "install",
    "plugin-lab",
    "--json",
    "--registry",
    registryUrl,
  ]);
  const remoteInstallPlan = JSON.parse(remoteTopLevelInstall.stdout);
  assert.equal(remoteInstallPlan.dryRun, false);
  assert.equal(remoteInstallPlan.install.status, "blocked");
  assert.equal(remoteInstallPlan.download.verified, true);
  assert.equal(remoteInstallPlan.download.output.bytes, entries[2].versions[0].artifact.size);
  assert.match(remoteInstallPlan.install.message, /verified an installable CoreBlow plugin archive/);

  const remotePublishers = await execFileAsync(process.execPath, [
    cliPath,
    "publishers",
    "list",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remotePublishers.stdout)[0].handle, "coreblow");

  const remotePublisher = await execFileAsync(process.execPath, [
    cliPath,
    "publishers",
    "inspect",
    "coreblow",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remotePublisher.stdout).handle, "coreblow");

  const remoteInfo = await execFileAsync(process.execPath, [
    cliPath,
    "registry",
    "info",
    "--registry",
    registryUrl,
  ]);
  assert.equal(JSON.parse(remoteInfo.stdout).name, "CoreHub Registry API");
} finally {
  await new Promise((resolve) => registryServer.close(resolve));
}
