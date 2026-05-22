#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CoreHubD1StateStore,
  CoreHubLocalJsonStateStore,
  CoreHubLocalStorageAdapter,
  createCoreHubApiHandler,
} from "./api-server.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8787;
const defaultStateStoreKind = "local-json";
const defaultD1StateKey = "write-side-state";
const defaultD1StateTable = "corehub_state";

export async function createCoreHubServer(options = {}) {
  const env = options.env ?? process.env;
  const host = options.host ?? env.COREHUB_HOST ?? defaultHost;
  const port = Number.parseInt(String(options.port ?? env.COREHUB_PORT ?? env.PORT ?? defaultPort), 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("COREHUB_PORT must be an integer between 0 and 65535");
  }
  const dataRoot = resolve(options.dataRoot ?? env.COREHUB_DATA_ROOT ?? ".corehub-local");
  const storageRoot = resolve(options.storageRoot ?? env.COREHUB_STORAGE_ROOT ?? join(dataRoot, "storage"));
  const configuredStatePath = resolve(options.statePath ?? env.COREHUB_STATE_PATH ?? join(dataRoot, "write-side-state.json"));
  const publicBaseUrl = options.publicBaseUrl ?? env.COREHUB_PUBLIC_BASE_URL ?? "https://coreblow.com/corehub";
  const auditRetentionDays = options.auditRetentionDays ?? env.COREHUB_AUDIT_RETENTION_DAYS ?? 365;
  const stateStoreConfig = createCoreHubStateStore({
    stateStoreKind: options.stateStoreKind ?? env.COREHUB_STATE_STORE ?? defaultStateStoreKind,
    statePath: configuredStatePath,
    d1Database: options.d1Database ?? options.d1Binding ?? env.COREHUB_D1,
    d1Key: options.d1Key ?? env.COREHUB_D1_STATE_KEY ?? defaultD1StateKey,
    d1Table: options.d1Table ?? env.COREHUB_D1_STATE_TABLE ?? defaultD1StateTable,
  });
  await mkdir(storageRoot, { recursive: true });
  const storage = await CoreHubLocalStorageAdapter.open({
    root: storageRoot,
    stateStore: stateStoreConfig.stateStore,
    publicBaseUrl,
    auditRetentionDays,
  });
  const apiHandler = createCoreHubApiHandler({ storage });
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.setHeader("Content-Type", "application/json;charset=UTF-8");
      response.end(JSON.stringify({ ok: true, service: "corehub-api" }));
      return;
    }
    apiHandler(request, response);
  });
  return {
    host,
    port,
    storageRoot,
    statePath: stateStoreConfig.statePath,
    stateStoreKind: stateStoreConfig.stateStoreKind,
    stateStoreKey: stateStoreConfig.stateStoreKey,
    stateStoreTable: stateStoreConfig.stateStoreTable,
    publicBaseUrl,
    storage,
    server,
    async listen() {
      await new Promise((resolve) => server.listen(port, host, resolve));
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      return {
        url: `http://${host}:${actualPort}/corehub`,
        healthUrl: `http://${host}:${actualPort}/healthz`,
        port: actualPort,
      };
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function createCoreHubStateStore({
  stateStoreKind = defaultStateStoreKind,
  statePath,
  d1Database,
  d1Key = defaultD1StateKey,
  d1Table = defaultD1StateTable,
} = {}) {
  if (stateStoreKind === "local-json") {
    return {
      stateStoreKind,
      statePath,
      stateStore: new CoreHubLocalJsonStateStore({ statePath }),
    };
  }
  if (stateStoreKind === "d1") {
    if (!d1Database || typeof d1Database !== "object") {
      throw new Error("COREHUB_STATE_STORE=d1 requires a D1 database binding");
    }
    return {
      stateStoreKind,
      statePath: null,
      stateStoreKey: d1Key,
      stateStoreTable: d1Table,
      stateStore: new CoreHubD1StateStore({
        database: d1Database,
        key: d1Key,
        table: d1Table,
      }),
    };
  }
  throw new Error("COREHUB_STATE_STORE must be local-json or d1");
}

async function main() {
  const app = await createCoreHubServer();
  const info = await app.listen();
  console.log(`CoreHub API server listening on ${info.url}`);
  console.log(`State store: ${app.stateStoreKind}`);
  console.log(`State: ${app.statePath ?? "(managed by state store)"}`);
  console.log(`Storage: ${app.storageRoot}`);

  const shutdown = async () => {
    await app.close();
  };
  process.once("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
