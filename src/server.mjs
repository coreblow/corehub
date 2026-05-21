#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CoreHubLocalStorageAdapter, createCoreHubApiHandler } from "./api-server.mjs";

const defaultHost = "127.0.0.1";
const defaultPort = 8787;

export async function createCoreHubServer(options = {}) {
  const host = options.host ?? process.env.COREHUB_HOST ?? defaultHost;
  const port = Number.parseInt(String(options.port ?? process.env.COREHUB_PORT ?? process.env.PORT ?? defaultPort), 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("COREHUB_PORT must be an integer between 0 and 65535");
  }
  const dataRoot = resolve(options.dataRoot ?? process.env.COREHUB_DATA_ROOT ?? ".corehub-local");
  const storageRoot = resolve(options.storageRoot ?? process.env.COREHUB_STORAGE_ROOT ?? join(dataRoot, "storage"));
  const statePath = resolve(options.statePath ?? process.env.COREHUB_STATE_PATH ?? join(dataRoot, "write-side-state.json"));
  const publicBaseUrl = options.publicBaseUrl ?? process.env.COREHUB_PUBLIC_BASE_URL ?? "https://coreblow.com/corehub";
  const auditRetentionDays = options.auditRetentionDays ?? process.env.COREHUB_AUDIT_RETENTION_DAYS ?? 365;
  await mkdir(storageRoot, { recursive: true });
  const storage = await CoreHubLocalStorageAdapter.open({
    root: storageRoot,
    statePath,
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
    statePath,
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

async function main() {
  const app = await createCoreHubServer();
  const info = await app.listen();
  console.log(`CoreHub API server listening on ${info.url}`);
  console.log(`State: ${app.statePath}`);
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
