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
  slots: [],
  submissions: [],
  reviews: [],
  packageVersions: [],
  ownershipTransfers: [],
  installEvents: [],
  auditEvents: [],
  auditCheckpoints: [],
};

await store.save(snapshot);
const loaded = await store.load();
assert.deepEqual(loaded, snapshot);
assert.equal(rows.get("write-side-state")?.updated_at, snapshot.savedAt);

console.log(
  JSON.stringify(
    {
      status: "ok",
      migration: "d1-snapshot",
      table,
      persistedKeys: [...rows.keys()],
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
          if (/SELECT value FROM corehub_state WHERE key = \?1/.test(sql)) {
            return rows.get(bindings[0]) ?? null;
          }
          throw new Error(`Unexpected mock D1 query: ${sql}`);
        },
        async run() {
          executedSql.push(sql);
          if (/^CREATE TABLE IF NOT EXISTS corehub_state/.test(sql)) {
            return { success: true };
          }
          if (/INSERT INTO corehub_state/.test(sql)) {
            rows.set(bindings[0], { key: bindings[0], value: bindings[1], updated_at: bindings[2] });
            return { success: true };
          }
          throw new Error(`Unexpected mock D1 mutation: ${sql}`);
        },
      };
    },
  };
}
