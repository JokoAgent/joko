import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { EventService } from "@joko/contracts";
import { SharedOwnerEventsBroker, type SharedOwnerEventsOwner, type SharedOwnerEventsSubscription } from "./shared-owner-events-broker.js";
import type { SharedOwnerEventsReply, SharedOwnerEventsRequest } from "./shared-owner-events.js";

// The worker owns only an in-memory, read-only generated API client. Page-local
// Snapshots, projections, effect ledgers and mutation clients never enter it.
const broker = new SharedOwnerEventsBroker({
  async *openStream(owner, authKey, afterCursor, signal) {
    const transport = createConnectTransport({ baseUrl: owner.origin, useBinaryFormat: true,
      interceptors: [next => request => {
        request.header.set("authorization", `Bearer ${authKey}`);
        request.header.set("x-joko-client-version", "0.1.0");
        return next(request);
      }] });
    const client = createClient(EventService, transport);
    for await (const response of client.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor }, { signal })) {
      if (response.event !== undefined) yield response.event;
    }
  }
});

interface WorkerPort {
  readonly port: MessagePort;
  subscription?: SharedOwnerEventsSubscription;
  lastSeen: number;
  closed: boolean;
}

const ports = new Set<WorkerPort>();
let heartbeat: ReturnType<typeof setInterval> | undefined;
const send = (state: WorkerPort, reply: SharedOwnerEventsReply, transfer: Transferable[] = []): void => {
  if (state.closed) return;
  try { state.port.postMessage(reply, transfer); } catch { close(state); }
};
function close(state: WorkerPort): void {
  if (state.closed) return;
  state.closed = true;
  state.subscription?.close(); state.subscription = undefined;
  state.port.onmessage = null; state.port.onmessageerror = null; state.port.close();
  ports.delete(state);
  if (ports.size === 0 && heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined; }
}
function ownerValid(owner: SharedOwnerEventsOwner): boolean {
  if (owner === null || typeof owner !== "object"
    || ![owner.profileId, owner.serverId, owner.deviceId, owner.origin].every(value => typeof value === "string" && value !== "")) return false;
  try {
    const url = new URL(owner.origin);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
const host = globalThis as unknown as { onconnect: (event: MessageEvent) => void };
host.onconnect = ({ ports: incoming }): void => {
  const port = incoming[0];
  if (port === undefined) return;
  const state: WorkerPort = { port, lastSeen: Date.now(), closed: false };
  ports.add(state);
  port.onmessage = ({ data }: MessageEvent<SharedOwnerEventsRequest>): void => {
    if (state.closed) return;
    state.lastSeen = Date.now();
    if (data?.type === "close") { close(state); return; }
    if (data?.type === "pong") return;
    if (data?.type === "ack" && state.subscription !== undefined && Number.isSafeInteger(data.serial)) {
      state.subscription.ack(data.serial); return;
    }
    if (data?.type !== "subscribe" || state.subscription !== undefined || !ownerValid(data.owner)
      || typeof data.authKey !== "string" || data.authKey === "" || data.cursor === undefined
      || typeof data.cursor.generation !== "bigint" || typeof data.cursor.sequence !== "bigint"
      || data.cursor.generation < 0n || data.cursor.sequence < 0n) {
      send(state, { type: "error", code: Code.InvalidArgument, message: "The event subscription is invalid." }); close(state); return;
    }
    send(state, { type: "ready" });
    state.subscription = broker.subscribe(data.owner, data.authKey, data.cursor, {
      event(bytes, serial) { send(state, { type: "event", bytes, serial }, [bytes]); },
      error(code, message) { send(state, { type: "error", code, message }); queueMicrotask(() => close(state)); }
    });
  };
  port.onmessageerror = (): void => close(state);
  port.start();
  // A crashed/frozen Document cannot retain a credentialed subscription for
  // other live Documents. Normal close/pagehide releases it immediately.
  heartbeat ??= setInterval(() => {
    const now = Date.now();
    for (const current of ports) {
      if (now - current.lastSeen > 120_000) {
        send(current, { type: "error", code: Code.Unavailable, message: "The event subscriber expired." }); close(current);
      } else send(current, { type: "ping" });
    }
  }, 30_000);
};
