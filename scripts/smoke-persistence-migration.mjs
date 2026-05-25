#!/usr/bin/env node
import assert from "node:assert/strict";
import { CoreHubD1StateStore } from "../src/api-server.mjs";

const rows = new Map();
const executedSql = [];
const database = createMockD1Database(rows, executedSql);
const table = "corehub_state";
const sql = CoreHubD1StateStore.migrationSql({ table });

await database.prepare(sql).run();
assert.match(executedSql[0], /CREATE TABLE IF NOT EXISTS corehub_state/);

const store = new CoreHubD1StateStore({ database, table });
const snapshot = {
  schemaVersion: "corehub.local-state.v1",
  savedAt: "2026-05-23T00:00:00.000Z",
  authSessions: [],
  userAccounts: [],
  publisherClaims: [],
  publisherAccounts: [],
  publisherMembers: [],
  slots: [
    {
      id: "upload-plugin-lab-0-1-0",
      packageId: "plugin-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      artifactUpload: { id: "artifact-plugin-lab-0-1-0", status: "verified" },
    },
  ],
  submissions: [],
  reviews: [],
  packageVersions: [
    {
      id: "version-plugin-lab-0-1-0",
      packageId: "plugin-lab",
      version: "0.1.0",
      publisherHandle: "coreblow",
      status: "available",
      channel: "stable",
    },
  ],
  packageSearchDigests: [
    {
      id: "package-search-digest-plugin-lab",
      packageId: "plugin-lab",
      name: "Plugin Lab",
      normalizedName: "plugin-lab",
      displayName: "Plugin Lab",
      family: "code-plugin",
      channel: "community",
      isOfficial: false,
      executesCode: true,
      category: "dev-tools",
      publisherHandle: "coreblow",
      summary: "CoreHub projected plugin package plugin-lab.",
      latestVersion: "0.1.0",
      capabilityTags: ["plugin", "published"],
      scanStatus: "clean",
      moderationState: "available",
      downloadEnabled: true,
      stats: { installs: 0, downloads: 0 },
      searchText: "plugin-lab Plugin Lab plugin published dev-tools",
      searchTokens: ["plugin-lab", "plugin", "lab", "published", "dev-tools"],
      entry: { id: "plugin-lab", kind: "plugin", name: "Plugin Lab" },
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
  ],
  skillVersions: [],
  skillSearchDigests: [],
  packageReports: [],
  packageAppeals: [],
  packageScanJobs: [],
  trustedPublishers: [],
  publishTokens: [],
  ownershipTransfers: [],
  installEvents: [],
  auditEvents: [],
  auditCheckpoints: [],
};

await store.save(snapshot);
const loaded = await store.load();
assert.deepEqual(loaded, snapshot);
assert.equal(rows.get("corehub_state_meta:manifest")?.updated_at, snapshot.savedAt);
assert.equal(rows.get("corehub_state_rows:slots:upload-plugin-lab-0-1-0")?.collection, "slots");
assert.equal(
  rows.get("corehub_state_indexes:slots:by_package_version:plugin-lab\u00000.1.0:upload-plugin-lab-0-1-0")?.row_id,
  "upload-plugin-lab-0-1-0",
);

console.log(
  JSON.stringify(
    {
      status: "ok",
      migration: "d1-normalized",
      table,
      persistedCollections: [...new Set([...rows.values()].map((row) => row.collection).filter(Boolean))].sort(),
      sql,
    },
    null,
    2,
  ),
);

function createMockD1Database(rows, executedSql) {
  return {
    prepare(sql) {
      let bindings = [];
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async first() {
          if (/SELECT value FROM corehub_state_meta WHERE key = \?1/.test(sql)) {
            return rows.get(`corehub_state_meta:${bindings[0]}`) ?? null;
          }
          if (/SELECT value FROM corehub_state WHERE key = \?1/.test(sql)) {
            return rows.get(`corehub_state:${bindings[0]}`) ?? rows.get(bindings[0]) ?? null;
          }
          throw new Error(`Unexpected mock D1 query: ${sql}`);
        },
        async all() {
          if (!/SELECT collection, value FROM corehub_state_rows ORDER BY collection ASC, position ASC, id ASC/.test(sql)) {
            throw new Error(`Unexpected mock D1 query: ${sql}`);
          }
          return {
            results: [...rows.entries()]
              .filter(([key]) => key.startsWith("corehub_state_rows:"))
              .map(([, row]) => row)
              .sort((left, right) => left.collection.localeCompare(right.collection) || left.position - right.position || left.id.localeCompare(right.id)),
          };
        },
        async run() {
          executedSql.push(sql);
          if (/^CREATE TABLE IF NOT EXISTS corehub_state/.test(sql)) {
            return { success: true };
          }
          if (/^DELETE FROM corehub_state_indexes$/.test(sql)) {
            for (const key of [...rows.keys()].filter((key) => key.startsWith("corehub_state_indexes:"))) rows.delete(key);
            return { success: true };
          }
          if (/^DELETE FROM corehub_state_rows$/.test(sql)) {
            for (const key of [...rows.keys()].filter((key) => key.startsWith("corehub_state_rows:"))) rows.delete(key);
            return { success: true };
          }
          if (/INSERT INTO corehub_state_meta/.test(sql)) {
            rows.set(`corehub_state_meta:${bindings[0]}`, { key: bindings[0], value: bindings[1], updated_at: bindings[2] });
            return { success: true };
          }
          if (/INSERT INTO corehub_state_rows/.test(sql)) {
            rows.set(`corehub_state_rows:${bindings[0]}:${bindings[1]}`, {
              collection: bindings[0],
              id: bindings[1],
              position: bindings[2],
              value: bindings[3],
              updated_at: bindings[4],
            });
            return { success: true };
          }
          if (/INSERT INTO corehub_state_indexes/.test(sql)) {
            rows.set(`corehub_state_indexes:${bindings[0]}:${bindings[1]}:${bindings[2]}:${bindings[3]}`, {
              collection: bindings[0],
              index_name: bindings[1],
              index_key: bindings[2],
              row_id: bindings[3],
              updated_at: bindings[4],
            });
            return { success: true };
          }
          if (/INSERT INTO corehub_state/.test(sql)) {
            rows.set(`corehub_state:${bindings[0]}`, { key: bindings[0], value: bindings[1], updated_at: bindings[2] });
            rows.set(bindings[0], { key: bindings[0], value: bindings[1], updated_at: bindings[2] });
            return { success: true };
          }
          throw new Error(`Unexpected mock D1 mutation: ${sql}`);
        },
      };
    },
  };
}
