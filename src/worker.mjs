import { Buffer } from "node:buffer";
import { CoreHubLocalStorageAdapter, createCoreHubApiHandler } from "./api-server.mjs";
import {
  createCoreHubStateStore,
  defaultD1StateKey,
  defaultD1StateTable,
} from "./state-store-bootstrap.mjs";

const defaultWorkerStorageRoot = ".corehub-worker-storage";

export async function handleCoreHubWorkerRequest(request, env = {}, context = undefined, options = {}) {
  try {
    if (new URL(request.url).pathname === "/healthz") {
      const app = await createCoreHubWorkerApp(env, options);
      return Response.json({
        ok: true,
        service: "corehub-api",
        runtime: "cloudflare-worker",
        stateStore: app.stateStoreKind,
      });
    }
    const app = await createCoreHubWorkerApp(env, options);
    const handler = createCoreHubApiHandler({ storage: app.storage });
    const response = createFetchResponseRecorder();
    await handler(await toNodeLikeRequest(request), response);
    return response.toResponse();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "CoreHub Worker error" },
      { status: error?.statusCode ?? 500 },
    );
  }
}

export async function createCoreHubWorkerApp(env = {}, options = {}) {
  const stateStoreConfig = createCoreHubStateStore({
    stateStoreKind: options.stateStoreKind ?? env.COREHUB_STATE_STORE ?? (env.COREHUB_D1 ? "d1" : "local-json"),
    statePath: options.statePath ?? env.COREHUB_STATE_PATH ?? ".corehub-worker-state.json",
    d1Database: options.d1Database ?? env.COREHUB_D1,
    d1Key: options.d1Key ?? env.COREHUB_D1_STATE_KEY ?? defaultD1StateKey,
    d1Table: options.d1Table ?? env.COREHUB_D1_STATE_TABLE ?? defaultD1StateTable,
  });
  const storage = await CoreHubLocalStorageAdapter.open({
    root: options.storageRoot ?? env.COREHUB_STORAGE_ROOT ?? defaultWorkerStorageRoot,
    stateStore: stateStoreConfig.stateStore,
    publicBaseUrl: options.publicBaseUrl ?? env.COREHUB_PUBLIC_BASE_URL ?? "https://coreblow.com/corehub",
    auditRetentionDays: options.auditRetentionDays ?? env.COREHUB_AUDIT_RETENTION_DAYS ?? 365,
  });
  return {
    storage,
    stateStoreKind: stateStoreConfig.stateStoreKind,
    stateStoreKey: stateStoreConfig.stateStoreKey,
    stateStoreTable: stateStoreConfig.stateStoreTable,
  };
}

async function toNodeLikeRequest(request) {
  const bytes = Buffer.from(await request.arrayBuffer());
  const headers = {};
  for (const [name, value] of request.headers.entries()) {
    headers[name.toLowerCase()] = value;
  }
  return {
    method: request.method,
    url: request.url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (bytes.byteLength > 0) yield bytes;
    },
  };
}

function createFetchResponseRecorder() {
  const headers = new Headers();
  let body = "";
  return {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name, value);
    },
    end(value = "") {
      body = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    },
    toResponse() {
      return new Response(body, {
        status: this.statusCode,
        headers,
      });
    },
  };
}

export default {
  fetch(request, env, context) {
    return handleCoreHubWorkerRequest(request, env, context);
  },
};
