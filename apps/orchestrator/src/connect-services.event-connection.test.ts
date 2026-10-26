import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import { EventService } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { toProtoEventCursor } from "./proto-mapper.js";

function fixture() {
  const unsubscribed = vi.fn(), stopRevocation = vi.fn();
  const connections = { authenticate: vi.fn(() => ({ id: "owner" })), fence: vi.fn(), onRevoked: vi.fn(() => stopRevocation) };
  const store = { health: vi.fn(() => ({ globalCursor: 0n, revision: 1n })), subscribe: vi.fn(() => unsubscribed), listEvents: vi.fn(() => []) };
  const application = { config: { publicOrigin: "http://127.0.0.1:4318" }, store, connections,
    artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {},
    sessionHost: { inspectRuntimeActivity: () => [] }, scheduler: { hasInFlightActivity: () => false }, adapters: [],
    browserActivity: [], close: async () => undefined } as unknown as OrchestratorApplication;
  const services = createConnectServices(application);
  const client = createClient(EventService, createRouterTransport(router => router.service(EventService, services.event)));
  return { client, connections, store, unsubscribed, stopRevocation };
}

async function currentCursor(f: ReturnType<typeof fixture>) {
  const cursor = (await f.client.getRuntimeActivity({})).summary?.cursor;
  expect(cursor).toBeDefined();
  f.connections.authenticate.mockClear();
  return cursor!;
}

describe("Event stream live-ready response", () => {
  it("confirms an idle authenticated stream without manufacturing an Event, cursor or durable write", async () => {
    const f = fixture(), abort = new AbortController(), headers = vi.fn();
    const afterCursor = await currentCursor(f);
    const iterator = f.client.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor },
      { signal: abort.signal, onHeader: headers })[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      expect(first.done).toBe(false); expect(first.value?.event).toBeUndefined();
      expect(headers).toHaveBeenCalledOnce(); expect(f.connections.authenticate).toHaveBeenCalledOnce();
      expect(f.connections.fence).toHaveBeenCalledOnce(); expect(f.store.listEvents).not.toHaveBeenCalled();
      expect(afterCursor.sequence).toBe(0n); expect(f.store.health().globalCursor).toBe(0n);
      let settled = false;
      const next = iterator.next().then(() => { settled = true; }, () => { settled = true; });
      for (let turn = 0; turn < 20; turn++) await Promise.resolve();
      expect(settled).toBe(false);
      abort.abort(); await next;
      expect(f.unsubscribed).toHaveBeenCalledOnce(); expect(f.stopRevocation).toHaveBeenCalledOnce();
    } finally { abort.abort(); }
  });

  it.each(["authentication", "cursor", "history", "availability", "final-fence"] as const)(
    "preserves the initial %s failure before any successful response, even though Connect returns response headers",
    async boundary => {
      const f = fixture(), abort = new AbortController(), headers = vi.fn();
      let afterCursor = await currentCursor(f);
      let code = Code.Unauthenticated;
      if (boundary === "authentication") f.connections.authenticate.mockImplementation(() => { throw new Error("Credential revoked"); });
      if (boundary === "cursor") { afterCursor = toProtoEventCursor(0n, afterCursor.generation + 1n, 0); code = Code.FailedPrecondition; }
      if (boundary === "history") {
        f.store.health.mockReturnValue({ globalCursor: 1n, revision: 1n }); code = Code.FailedPrecondition;
      }
      if (boundary === "availability") {
        f.store.health.mockImplementation(() => { throw new ConnectError("Store unavailable", Code.Unavailable); }); code = Code.Unavailable;
      }
      if (boundary === "final-fence") f.connections.fence.mockImplementation(() => { throw new ConnectError("Credential revoked during replay", Code.Unauthenticated); });
      try {
        const iterator = f.client.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor },
          { signal: abort.signal, onHeader: headers })[Symbol.asyncIterator]();
        await expect(iterator.next()).rejects.toMatchObject({ code });
        expect(headers).toHaveBeenCalledOnce();
        if (boundary === "history") expect(f.store.listEvents).toHaveBeenCalledOnce();
        if (boundary === "final-fence") expect(f.connections.fence).toHaveBeenCalledOnce();
        if (boundary !== "authentication") {
          expect(f.unsubscribed).toHaveBeenCalledOnce(); expect(f.stopRevocation).toHaveBeenCalledOnce();
        }
      } finally { abort.abort(); }
    }
  );
});
