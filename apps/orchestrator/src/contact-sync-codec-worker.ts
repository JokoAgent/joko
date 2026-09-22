import { parentPort } from "node:worker_threads";

import {
  decodeContactSyncMessageInProcess,
  encodeContactSyncMessageInProcess
} from "./contact-sync-wire.js";
import type { ContactSyncCodecWorkerReply, ContactSyncCodecWorkerRequest } from "./contact-sync-codec.js";

const port = parentPort;
if (port === null) throw new Error("Contacts sync codec worker requires a parent port.");

let tail: Promise<void> = Promise.resolve();

port.on("message", (value: unknown) => {
  tail = tail.then(() => {
    const request = validateRequest(value);
    if (request === undefined) throw new Error("Contacts sync codec worker request is invalid.");
    try {
      const result = request.operation === "encode"
        ? encodeContactSyncMessageInProcess(request.options)
        : decodeContactSyncMessageInProcess(request.options);
      port.postMessage({ id: request.id, ok: true, value: result } satisfies ContactSyncCodecWorkerReply);
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: boundedError(error)
      } satisfies ContactSyncCodecWorkerReply);
    }
  }).catch(() => {
    process.exitCode = 1;
    port.close();
  });
});

function validateRequest(value: unknown): ContactSyncCodecWorkerRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  return Number.isSafeInteger(request["id"]) && (request["id"] as number) >= 1 &&
    (request["operation"] === "encode" || request["operation"] === "decode") &&
    typeof request["options"] === "object" && request["options"] !== null && !Array.isArray(request["options"])
    ? value as ContactSyncCodecWorkerRequest : undefined;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Contacts sync codec operation failed.";
  return Buffer.byteLength(message, "utf8") <= 4_096 ? message : "Contacts sync codec operation failed.";
}
