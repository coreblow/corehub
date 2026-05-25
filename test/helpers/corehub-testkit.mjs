import { createHash } from "node:crypto";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreHubLocalStorageAdapter, createCoreHubApiHandler, signJwt } from "../../src/api-server.mjs";

export const fixedNow = new Date("2026-05-21T00:00:00Z");
export const adminActor = { type: "user", id: "github:coreblow-admin" };
export const publisherHeaders = {
  "x-corehub-user": "github:coreblow-admin",
};
export const jsonHeaders = {
  ...publisherHeaders,
  "content-type": "application/json",
};

export const catalogEntries = JSON.parse(await readFile(new URL("../../catalog.json", import.meta.url), "utf-8"));
export const pluginLabEntry = catalogEntries.find((entry) => entry.id === "plugin-lab");
export const pluginLabArtifactBytes = await readFile(
  new URL("../../artifacts/plugin-lab-0.1.0.coreblow-plugin.tgz", import.meta.url),
);

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createOAuthToken(actor = adminActor) {
  return signJwt(
    {
      actor,
      iss: "corehub-test",
      aud: "corehub-oauth",
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    "corehub-local-development-signing-secret",
  );
}

export async function startCoreHubTestServer(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "corehub-surface-test-"));
  const storage =
    options.storage ??
    new CoreHubLocalStorageAdapter({
      root,
      publicBaseUrl: options.publicBaseUrl ?? "https://coreblow.com/corehub",
      signedReadSecret: options.signedReadSecret,
    });
  const server = createServer(
    createCoreHubApiHandler({
      storage,
      now: options.now ?? (() => fixedNow),
      rateLimit: options.rateLimit,
      sessionTokens: options.sessionTokens,
      oauth: options.oauth,
    }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    root,
    storage,
    server,
    origin,
    corehubUrl: `${origin}/corehub`,
    v1Url: `${origin}/corehub/api/v1`,
    v2Url: `${origin}/corehub/api/v2`,
    npmUrl: `${origin}/corehub/api/npm`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function seedManagedPackage(
  storage,
  {
    packageId = "surface-plugin",
    version = "0.1.0",
    publisherHandle = "coreblow",
    kind = "plugin",
    channel = "stable",
    now = fixedNow,
  } = {},
) {
  const artifact = {
    ...pluginLabEntry.versions[0].artifact,
    name: `${packageId}-${version}.coreblow-plugin.tgz`,
    npm: {
      ...pluginLabEntry.versions[0].artifact.npm,
      tarballName: `${packageId}-${version}.coreblow-plugin.tgz`,
    },
  };
  const slot = await storage.requestUploadSlot(
    {
      packageId,
      version,
      publisherHandle,
      provider: "managed",
      artifact,
    },
    { actor: adminActor, now },
  );
  await storage.putObject(slot.id, pluginLabArtifactBytes, { "x-corehub-artifact-sha256": artifact.sha256 }, { actor: adminActor, now });
  const verified = await storage.verifyUpload(slot.id, { actor: adminActor, now });
  const submissionResult = await storage.createSubmission(
    {
      packageId,
      version,
      kind,
      publisherHandle,
      channel,
      artifactUploadId: verified.artifactUpload.id,
      changelog: "Surface parity fixture.",
    },
    { actor: adminActor, now },
  );
  const approval = await storage.decideReview(
    submissionResult.moderationReview.id,
    "approve",
    { notes: "Surface parity fixture approved." },
    { actor: adminActor, now },
  );
  return {
    slot,
    verified,
    submission: submissionResult.submission,
    review: approval.moderationReview,
    packageVersion: approval.packageVersion,
    artifact,
  };
}

export async function seedHostedSkill(
  storage,
  { slug = "surface-skill", publisherHandle = "coreblow", now = fixedNow } = {},
) {
  return storage.publishSkill(
    {
      slug,
      version: "0.1.0",
      publisherHandle,
      displayName: "Surface Skill",
      summary: "Hosted skill surface parity fixture.",
      source: "https://github.com/coreblow/surface-skill",
      files: [
        {
          path: "SKILL.md",
          mediaType: "text/markdown;charset=UTF-8",
          content: "# Surface Skill\n\nA hosted skill test fixture.\n",
        },
        {
          path: "corehub.skill.json",
          mediaType: "application/json;charset=UTF-8",
          content: JSON.stringify({ id: slug, version: "0.1.0", entrypoint: "SKILL.md" }),
        },
      ],
    },
    { actor: adminActor, now },
  );
}
