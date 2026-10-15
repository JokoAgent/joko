import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { EventSchema, StreamEventsResponseSchema, type EventCursor, type StreamEventsResponse } from "@joko/contracts";
import type { SharedOwnerEventsOwner } from "./shared-owner-events-broker.js";

export type SharedOwnerEventsRequest =
  | { readonly type: "subscribe"; readonly owner: SharedOwnerEventsOwner; readonly authKey: string; readonly cursor: EventCursor }
  | { readonly type: "ack"; readonly serial: number }
  | { readonly type: "pong" }
  | { readonly type: "close" };

export type SharedOwnerEventsReply =
  | { readonly type: "ready" }
  | { readonly type: "event"; readonly bytes: ArrayBuffer; readonly serial: number }
  | { readonly type: "error"; readonly code: number; readonly message: string }
  | { readonly type: "ping" };

/** One private port per connection occurrence; no credential is part of the worker address. */
export async function* streamSharedOwnerEvents(
  owner: SharedOwnerEventsOwner,
  authKey: string,
  cursor: EventCursor,
  signal: AbortSignal,
  onDocumentRetired: () => void
): AsyncGenerator<StreamEventsResponse> {
  signal.throwIfAborted();
  const worker = new SharedWorker(new URL("./shared-owner-events.worker.ts", import.meta.url), {
    name: "joko-owner-events-v1", type: "module"
  });
  const port = worker.port;
  const host = typeof window === "undefined" ? undefined : window;
  let wake: (() => void) | undefined;
  let pending: Extract<SharedOwnerEventsReply, { type: "event" }> | undefined;
  let failure: ConnectError | undefined;
  let closed = false;
  let ready = false;
  let liveness: ReturnType<typeof setTimeout> | undefined;
  const fail = (error: ConnectError): void => { failure ??= error; wake?.(); };
  const abort = (): void => { closed = true; wake?.(); };
  const retire = (): void => { onDocumentRetired(); abort(); };
  const startup = setTimeout(() => fail(new ConnectError("The event worker did not start.", Code.Unavailable)), 15_000);
  port.onmessage = ({ data }: MessageEvent<SharedOwnerEventsReply>): void => {
    if (closed || signal.aborted) return;
    clearTimeout(liveness);
    liveness = setTimeout(() => fail(new ConnectError("The event worker stopped responding.", Code.Unavailable)), 90_000);
    if (data.type === "ping") { port.postMessage({ type: "pong" } satisfies SharedOwnerEventsRequest); return; }
    if (data.type === "ready") { ready = true; clearTimeout(startup); return; }
    if (data.type === "error") { fail(new ConnectError(data.message, data.code)); return; }
    if (data.type !== "event" || !ready || !(data.bytes instanceof ArrayBuffer) || !Number.isSafeInteger(data.serial)) {
      fail(new ConnectError("The event worker returned an invalid response.", Code.DataLoss)); return;
    }
    if (pending !== undefined) { fail(new ConnectError("The event subscriber fell behind.", Code.OutOfRange)); return; }
    pending = data; wake?.();
  };
  port.onmessageerror = (): void => fail(new ConnectError("The event worker response could not be read.", Code.DataLoss));
  worker.onerror = (): void => fail(new ConnectError("The event worker stopped.", Code.Unavailable));
  signal.addEventListener("abort", abort, { once: true });
  host?.addEventListener("pagehide", retire, { once: true });
  try {
    port.start();
    port.postMessage({ type: "subscribe", owner, authKey, cursor } satisfies SharedOwnerEventsRequest);
    while (!closed && !signal.aborted) {
      if (failure !== undefined) throw failure;
      if (pending === undefined) {
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
        continue;
      }
      const next = pending; pending = undefined;
      const event = fromBinary(EventSchema, new Uint8Array(next.bytes));
      yield create(StreamEventsResponseSchema, { event });
      if (!closed && !signal.aborted) port.postMessage({ type: "ack", serial: next.serial } satisfies SharedOwnerEventsRequest);
    }
  } finally {
    closed = true;
    clearTimeout(startup);
    clearTimeout(liveness);
    signal.removeEventListener("abort", abort);
    host?.removeEventListener("pagehide", retire);
    port.onmessage = null; port.onmessageerror = null; worker.onerror = null;
    try { port.postMessage({ type: "close" } satisfies SharedOwnerEventsRequest); } finally { port.close(); }
    pending = undefined;
  }
}
