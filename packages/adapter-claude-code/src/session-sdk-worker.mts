import { parentPort, workerData } from "node:worker_threads";
import type {
  ClaudeDurableSessionStore,
  ClaudeSessionStoreChildReservation
} from "./claude-session-store.js";
import type { SessionSdkRequest, SessionSdkWorkerData } from "./session-sdk-owner.js";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

// This worker owns only the published filesystem Session APIs. Never forward
// SDK error text, console output, or a stack to the parent process.
const port = parentPort;
if (port === null) throw new Error("Native Session worker requires an owner.");
let store: ClaudeDurableSessionStore | undefined;
try {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const data = workerData as SessionSdkWorkerData;
  const request = data.request as SessionSdkRequest;
  let value: unknown;
  switch (request.kind) {
    case "getSessionInfo": value = await sdk.getSessionInfo(request.sessionId, request.options); break;
    case "getSessionMessages": value = await sdk.getSessionMessages(request.sessionId, request.options); break;
    case "listSessions": value = await sdk.listSessions(request.options); break;
    case "deleteSession": value = await sdk.deleteSession(request.sessionId, request.options); break;
    case "forkSession": value = await sdk.forkSession(request.sessionId, request.options); break;
    case "importSessionToStore": {
      if (data.sessionStoreAuthority === undefined) throw new Error("Stored Session authority is unavailable.");
      const storeModule = await loadStoreModule();
      store = storeModule.createClaudeDurableSessionStore(data.sessionStoreAuthority, request.access);
      await sdk.importSessionToStore(request.sessionId, sdkStoreBoundary(store, storeModule.CLAUDE_SESSION_STORE_LIMITS.maximumBatchBytes), {
        dir: request.options.dir,
        includeSubagents: false,
        batchSize: 500
      });
      storeModule.sealClaudeSessionStoreImport(data.sessionStoreAuthority, request.access);
      value = undefined;
      break;
    }
    case "forkStoredSession": {
      if (data.sessionStoreAuthority === undefined) throw new Error("Stored Session authority is unavailable.");
      const storeModule = await loadStoreModule();
      store = storeModule.createClaudeDurableSessionStore(data.sessionStoreAuthority, request.access, {
        onChildReserved: async (reservation) => await acknowledgeReservation(port, reservation)
      });
      const sdkStore = sdkStoreBoundary(store, storeModule.CLAUDE_SESSION_STORE_LIMITS.maximumBatchBytes);
      value = await sdk.forkSession(request.sessionId, {
        dir: request.options.dir,
        ...(request.options.upToMessageId === undefined ? {} : { upToMessageId: request.options.upToMessageId }),
        sessionStore: sdkStore
      });
      break;
    }
    case "getStoredSessionInfo":
      if (data.sessionStoreAuthority === undefined) throw new Error("Stored Session authority is unavailable.");
      {
        const storeModule = await loadStoreModule();
        store = storeModule.createClaudeDurableSessionStore(data.sessionStoreAuthority, request.access);
        value = await sdk.getSessionInfo(request.sessionId, {
          dir: request.options.dir,
          sessionStore: sdkStoreBoundary(store, storeModule.CLAUDE_SESSION_STORE_LIMITS.maximumBatchBytes)
        });
      }
      break;
    case "getStoredSessionMessages":
      if (data.sessionStoreAuthority === undefined) throw new Error("Stored Session authority is unavailable.");
      {
        const storeModule = await loadStoreModule();
        store = storeModule.createClaudeDurableSessionStore(data.sessionStoreAuthority, request.access);
        value = await sdk.getSessionMessages(request.sessionId, {
          ...request.options,
          sessionStore: sdkStoreBoundary(store, storeModule.CLAUDE_SESSION_STORE_LIMITS.maximumBatchBytes)
        });
      }
      break;
    case "deleteStoredSession":
      if (data.sessionStoreAuthority === undefined) throw new Error("Stored Session authority is unavailable.");
      {
        const storeModule = await loadStoreModule();
        store = storeModule.createClaudeDurableSessionStore(data.sessionStoreAuthority, request.access);
        value = await sdk.deleteSession(request.sessionId, {
          dir: request.options.dir,
          sessionStore: sdkStoreBoundary(store, storeModule.CLAUDE_SESSION_STORE_LIMITS.maximumBatchBytes)
        });
      }
      break;
    default: throw new Error("Invalid native Session request.");
  }
  const json = JSON.stringify({ value });
  if (Buffer.byteLength(json, "utf8") > 24 * 1024 * 1024) throw new Error("Native Session result exceeds its bound.");
  port.postMessage({ type: "result", json });
} catch {
  port.postMessage({ type: "failure" });
} finally {
  store?.close();
  port.close();
  // All awaited public SDK work has settled; terminate only this dedicated
  // Worker so SDK module-level handles cannot retain the Orchestrator.
  process.exit(0);
}

type StoreModule = typeof import("./claude-session-store.js");

async function loadStoreModule(): Promise<StoreModule> {
  const specifier = import.meta.url.endsWith(".mts")
    ? "./claude-session-store.ts"
    : "./claude-session-store.js";
  return await import(specifier) as StoreModule;
}

/** The fixed SDK's public fork helper currently includes own `undefined`
 * fields even though SessionStore entries use JSON round-trip semantics.
 * Normalize only at that published serialization boundary; the durable store
 * itself remains strict and never interprets private entry fields. */
function sdkStoreBoundary(store: ClaudeDurableSessionStore, maximumBatchBytes: number): SessionStore {
  return {
    append: async (key, entries) => {
      const json = JSON.stringify(entries);
      if (Buffer.byteLength(json, "utf8") > maximumBatchBytes) throw new Error("Stored Session batch exceeds its bound.");
      const normalized: unknown = JSON.parse(json);
      if (!Array.isArray(normalized)) throw new Error("Stored Session batch is invalid.");
      await store.append(key, normalized as SessionStoreEntry[]);
    },
    load: async (key) => await store.load(key),
    listSessions: async (projectKey) => await store.listSessions(projectKey),
    delete: async (key) => await store.delete(key),
    listSubkeys: async (key) => await store.listSubkeys(key)
  };
}

function acknowledgeReservation(
  owner: NonNullable<typeof parentPort>,
  reservation: ClaudeSessionStoreChildReservation
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (message === null || typeof message !== "object" || Array.isArray(message)) return;
      const envelope = message as Record<string, unknown>;
      if (envelope["type"] !== "childReservationAck"
        || envelope["operationId"] !== reservation.operationId
        || envelope["generation"] !== reservation.generation
        || envelope["sessionId"] !== reservation.sessionId
        || typeof envelope["accepted"] !== "boolean") return;
      owner.off("message", onMessage);
      if (envelope["accepted"]) resolve();
      else reject(new Error("Stored Session reservation was not accepted."));
    };
    owner.on("message", onMessage);
    owner.postMessage({ type: "childReserved", ...reservation });
  });
}
