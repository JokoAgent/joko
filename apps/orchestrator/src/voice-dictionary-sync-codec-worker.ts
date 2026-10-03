import { parentPort } from "node:worker_threads";

import {
  decodeVoiceDictionaryPeerMessage,
  encodeVoiceDictionaryPeerMessage
} from "./voice-dictionary-sync-wire.js";
import type { VoiceDictionaryPeerCodecWorkerReply, VoiceDictionaryPeerCodecWorkerRequest } from "./voice-dictionary-sync-codec.js";

const port = parentPort;
if (port === null) throw new Error("Voice dictionary peer codec worker requires a parent port.");

let tail: Promise<void> = Promise.resolve();

port.on("message", (value: unknown) => {
  tail = tail.then(() => {
    const request = validateRequest(value);
    if (request === undefined) throw new Error("Voice dictionary peer codec worker request is invalid.");
    try {
      const result = request.operation === "encode"
        ? encodeVoiceDictionaryPeerMessage(request.options)
        : decodeVoiceDictionaryPeerMessage(request.options);
      port.postMessage({ id: request.id, ok: true, value: result } satisfies VoiceDictionaryPeerCodecWorkerReply);
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: "Voice dictionary peer codec operation failed."
      } satisfies VoiceDictionaryPeerCodecWorkerReply);
    }
  }).catch(() => {
    process.exitCode = 1;
    port.close();
  });
});

function validateRequest(value: unknown): VoiceDictionaryPeerCodecWorkerRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const request = value as Record<string, unknown>;
  return Number.isSafeInteger(request["id"]) && (request["id"] as number) >= 1 &&
    (request["operation"] === "encode" || request["operation"] === "decode") &&
    typeof request["options"] === "object" && request["options"] !== null && !Array.isArray(request["options"])
    ? value as VoiceDictionaryPeerCodecWorkerRequest : undefined;
}
