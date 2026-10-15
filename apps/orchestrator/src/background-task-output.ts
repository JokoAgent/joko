import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { BackgroundTaskOutputSchema, BackgroundTaskOutputState, type BackgroundTaskOutput } from "@joko/contracts";
import type { SessionHost } from "./session-host.js";

/** The native owner supplies the registered output source. Neither ordinary
 * clients nor task guests can submit a filesystem location. */
export async function readTaskBackgroundOutput(host: SessionHost, sessionId: string, backgroundTaskId: string,
  maximumBytes = 16_384, assertCurrent: () => void = () => undefined, signal?: AbortSignal): Promise<BackgroundTaskOutput> {
  if (!sessionId || !backgroundTaskId || sessionId.length > 512 || backgroundTaskId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(sessionId + backgroundTaskId)
    || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 262_144) {
    throw new ConnectError("The background output request is invalid.", Code.InvalidArgument);
  }
  assertCurrent(); signal?.throwIfAborted();
  const result = await host.getBackgroundTaskOutput(sessionId, backgroundTaskId, maximumBytes);
  assertCurrent(); signal?.throwIfAborted();
  if (result.status === "available" && Buffer.byteLength(result.text, "utf8") > maximumBytes + 3
    || !Number.isSafeInteger(result.totalBytes) || result.totalBytes < 0
    || !Number.isSafeInteger(result.capturedAtMs) || result.capturedAtMs < 0
    || result.modifiedAtMs !== undefined && (!Number.isSafeInteger(result.modifiedAtMs) || result.modifiedAtMs < 0)) {
    throw new ConnectError("The native background output observation is invalid.", Code.FailedPrecondition);
  }
  return create(BackgroundTaskOutputSchema, { sessionId, backgroundTaskId,
    state: result.status === "available" ? BackgroundTaskOutputState.AVAILABLE
      : result.status === "unavailable" ? BackgroundTaskOutputState.UNAVAILABLE : BackgroundTaskOutputState.FAILED,
    text: result.status === "available" ? result.text : "", totalBytes: BigInt(result.totalBytes),
    truncated: result.status === "available" && result.truncated, capturedAtMs: BigInt(result.capturedAtMs),
    ...(result.modifiedAtMs === undefined ? {} : { modifiedAtMs: BigInt(result.modifiedAtMs) }) });
}
