import { parentPort, workerData } from "node:worker_threads";
import type { SessionSdkRequest } from "./session-sdk-owner.js";

// This worker owns only the published filesystem Session APIs. Never forward
// SDK error text, console output, or a stack to the parent process.
const port = parentPort;
if (port === null) throw new Error("Native Session worker requires an owner.");
try {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const request = workerData as SessionSdkRequest;
  let value: unknown;
  switch (request.kind) {
    case "getSessionInfo": value = await sdk.getSessionInfo(request.sessionId, request.options); break;
    case "getSessionMessages": value = await sdk.getSessionMessages(request.sessionId, request.options); break;
    case "listSessions": value = await sdk.listSessions(request.options); break;
    case "deleteSession": value = await sdk.deleteSession(request.sessionId, request.options); break;
    case "forkSession": value = await sdk.forkSession(request.sessionId, request.options); break;
    default: throw new Error("Invalid native Session request.");
  }
  const json = JSON.stringify({ value });
  if (Buffer.byteLength(json, "utf8") > 24 * 1024 * 1024) throw new Error("Native Session result exceeds its bound.");
  port.postMessage({ type: "result", json });
} catch {
  port.postMessage({ type: "failure" });
} finally {
  port.close();
  // All awaited public SDK work has settled; terminate only this dedicated
  // Worker so SDK module-level handles cannot retain the Orchestrator.
  process.exit(0);
}
