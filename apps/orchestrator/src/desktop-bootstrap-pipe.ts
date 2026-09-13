import type { Readable, Writable } from "node:stream";

import {
  DESKTOP_BOOTSTRAP_MAX_TTL_MS,
  DesktopBootstrapFrameDecoder,
  decodeDesktopBootstrapCommitPayload,
  decodeDesktopBootstrapRequestPayload,
  encodeDesktopBootstrapCommittedFrame,
  encodeDesktopBootstrapResponseFrame,
  type DesktopBootstrapCommit,
  type DesktopBootstrapCommitted,
  type DesktopBootstrapRequest,
  type DesktopBootstrapResponse
} from "@joko/contracts/desktop-bootstrap";

export const DESKTOP_BOOTSTRAP_REQUEST_FD = 3;
export const DESKTOP_BOOTSTRAP_RESPONSE_FD = 4;
export const DESKTOP_BOOTSTRAP_PIPE_READ_TIMEOUT_MS = 10_000;

export interface ReceivedDesktopBootstrapRequest {
  readonly request: DesktopBootstrapRequest;
  /** Resolves when the owning Desktop closes or loses its liveness pipe. */
  readonly parentDisconnected: Promise<void>;
  readonly receiveCommit: (options?: { readonly timeoutMs?: number }) => Promise<DesktopBootstrapCommit>;
  readonly close: () => void;
}

/**
 * Receive exactly one bounded request while retaining the input pipe as a
 * liveness lease for the Desktop parent process.
 */
export function receiveDesktopBootstrapRequest(
  input: Readable,
  options: { readonly timeoutMs?: number } = {}
): Promise<ReceivedDesktopBootstrapRequest> {
  const timeoutMs = options.timeoutMs ?? DESKTOP_BOOTSTRAP_PIPE_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DESKTOP_BOOTSTRAP_MAX_TTL_MS) {
    return Promise.reject(pipeUnavailable());
  }
  const decoder = new DesktopBootstrapFrameDecoder();
  let requestSettled = false;
  let disconnected = false;
  let resolveDisconnected!: () => void;
  const parentDisconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve; });

  return new Promise<ReceivedDesktopBootstrapRequest>((resolve, reject) => {
    const timer = setTimeout(() => fail(), timeoutMs);
    timer.unref();

    const markDisconnected = (): void => {
      if (disconnected) return;
      disconnected = true;
      resolveDisconnected();
      if (!requestSettled) fail();
    };
    const onError = (): void => markDisconnected();
    const onEnd = (): void => markDisconnected();
    const onClose = (): void => markDisconnected();
    const cleanupRequestListeners = (): void => {
      clearTimeout(timer);
      input.off("data", onData);
    };
    const cleanupAllListeners = (): void => {
      cleanupRequestListeners();
      input.off("error", onError);
      input.off("end", onEnd);
      input.off("close", onClose);
    };
    const close = (): void => {
      cleanupAllListeners();
      if (!disconnected) {
        disconnected = true;
        resolveDisconnected();
      }
      input.destroy();
    };
    const fail = (): void => {
      if (requestSettled) return;
      requestSettled = true;
      cleanupAllListeners();
      reject(pipeUnavailable());
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      if (requestSettled) return;
      let payload: Uint8Array | undefined;
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        [payload] = decoder.push(bytes);
        if (payload === undefined) return;
        decoder.finish();
        const request = decodeDesktopBootstrapRequestPayload(payload);
        requestSettled = true;
        cleanupRequestListeners();
        const receiveCommit = (commitOptions: { readonly timeoutMs?: number } = {}): Promise<DesktopBootstrapCommit> =>
          receiveDesktopBootstrapCommit(input, parentDisconnected, disconnected, commitOptions.timeoutMs);
        resolve({ request, parentDisconnected, receiveCommit, close });
      } catch {
        fail();
      } finally {
        payload?.fill(0);
      }
    };

    input.on("error", onError);
    input.on("end", onEnd);
    input.on("close", onClose);
    input.on("data", onData);
  });
}

/** Write the provisional response while retaining the output pipe for commit confirmation. */
export async function sendDesktopBootstrapResponse(
  output: Writable,
  response: DesktopBootstrapResponse
): Promise<void> {
  const frame = Buffer.from(encodeDesktopBootstrapResponseFrame(response));
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        output.off("error", onError);
        if (error === undefined) resolve(); else reject(pipeUnavailable());
      };
      const onError = (): void => finish(pipeUnavailable());
      output.once("error", onError);
      output.write(frame, (error) => finish(error ?? undefined));
    });
  } finally {
    frame.fill(0);
  }
}

/** Write the final commit confirmation and close the dedicated output pipe. */
export async function sendDesktopBootstrapCommitted(
  output: Writable,
  committed: DesktopBootstrapCommitted
): Promise<void> {
  const frame = Buffer.from(encodeDesktopBootstrapCommittedFrame(committed));
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        output.off("error", onError);
        if (error === undefined) resolve(); else reject(pipeUnavailable());
      };
      const onError = (): void => finish(pipeUnavailable());
      output.once("error", onError);
      output.end(frame, () => finish());
    });
  } finally {
    frame.fill(0);
  }
}

function receiveDesktopBootstrapCommit(
  input: Readable,
  parentDisconnected: Promise<void>,
  alreadyDisconnected: boolean,
  timeoutValue: number | undefined
): Promise<DesktopBootstrapCommit> {
  const timeoutMs = timeoutValue ?? DESKTOP_BOOTSTRAP_PIPE_READ_TIMEOUT_MS;
  if (alreadyDisconnected || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DESKTOP_BOOTSTRAP_MAX_TTL_MS) {
    return Promise.reject(pipeUnavailable());
  }
  return new Promise<DesktopBootstrapCommit>((resolve, reject) => {
    const decoder = new DesktopBootstrapFrameDecoder();
    let settled = false;
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("error", onFailure);
      input.off("end", onFailure);
      input.off("close", onFailure);
    };
    const finish = (commit?: DesktopBootstrapCommit): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (commit === undefined) reject(pipeUnavailable()); else resolve(commit);
    };
    const onFailure = (): void => finish();
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      let payload: Uint8Array | undefined;
      try {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        [payload] = decoder.push(bytes);
        if (payload === undefined) return;
        decoder.finish();
        finish(decodeDesktopBootstrapCommitPayload(payload));
      } catch {
        finish();
      } finally {
        payload?.fill(0);
      }
    };
    input.on("data", onData);
    input.once("error", onFailure);
    input.once("end", onFailure);
    input.once("close", onFailure);
    void parentDisconnected.then(onFailure);
  });
}

function pipeUnavailable(): Error {
  return new Error("The private Desktop bootstrap pipe is unavailable.");
}
