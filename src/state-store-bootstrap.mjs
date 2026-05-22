import { CoreHubD1StateStore, CoreHubLocalJsonStateStore } from "./api-server.mjs";

export const defaultStateStoreKind = "local-json";
export const defaultD1StateKey = "write-side-state";
export const defaultD1StateTable = "corehub_state";

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
