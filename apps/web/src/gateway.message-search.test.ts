import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  EventCursorSchema,
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  ListSessionTimelineResponseSchema,
  SearchSessionMessagesResponseSchema,
  SessionMessageSearchKind,
  SessionMessageSearchRole,
  SessionMessageSearchSemanticMode,
  SessionMessageSearchSessionStatus,
  SnapshotSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("durable message-history search", () => {
  it("uses the explicit owner scope and loads an exact around-event window", async () => {
    const calls: Array<{ readonly service: string; readonly method: string; readonly input: any }> = [];
    const transport = transportFor(async (method, input) => {
      calls.push({ service: method.parent.typeName, method: method.localName, input });
      if (method.localName === "searchSessionMessages") {
        return create(SearchSessionMessagesResponseSchema, {
          matches: [{
            sessionId: "session-1",
            eventId: "event-12",
            timelineItemId: "entry-12",
            role: SessionMessageSearchRole.ASSISTANT,
            kind: SessionMessageSearchKind.TEXT_MESSAGE,
            snippet: "Queue the durable follow-up",
            createdAt: { seconds: 123n },
            score: 0.75
          }],
          page: { nextPageToken: "next", totalSize: 4n },
          revision: { value: 9n }
        });
      }
      if (method.localName === "listSessionTimeline") {
        return create(ListSessionTimelineResponseSchema, {
          events: [],
          ...(input.aroundEventId || input.beforeCursor !== undefined ? {} : {
            nextBeforeCursor: create(EventCursorSchema, {
              opaqueToken: "cursor-12",
              sequence: 12n,
              generation: 1n
            })
          })
        });
      }
      throw new Error("Unexpected method: " + method.localName);
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.searchSessionMessages("  queue  ", "page-1", 900, { kind: "owner" }, {
      targetIds: ["target-1"],
      sessionIds: [],
      backendIds: ["backend-1"],
      sessionStatus: "active",
      sessionActivityFrom: 12_345,
      messageCreatedFrom: 10_000,
      messageCreatedBefore: 20_000
    })).resolves.toEqual({
      matches: [{
        sessionId: "session-1",
        eventId: "event-12",
        timelineItemId: "entry-12",
        role: "assistant",
        kind: "textMessage",
        snippet: "Queue the durable follow-up",
        createdAt: 123_000,
        score: 0.75
      }],
      nextPageToken: "next",
      totalSize: 4,
      revision: 9n,
      vectorUsed: false,
      poolCapped: false
    });
    await expect(gateway.loadSessionTimelineAround("session-1", "event-12", 900)).resolves.toEqual([]);
    const latestPage = await gateway.loadSessionTimelinePage("session-1", undefined, 900);
    expect(latestPage).toEqual({
      items: [],
      nextBeforeCursor: { opaqueToken: "cursor-12", sequence: 12n, generation: 1n }
    });
    await expect(gateway.loadSessionTimelinePage("session-1", latestPage.nextBeforeCursor, 0)).resolves.toEqual({ items: [] });

    expect(calls).toEqual([
      {
        service: "joko.v1.SessionService",
        method: "searchSessionMessages",
        input: {
          scope: { case: "owner", value: {} },
          query: "queue",
          page: { pageSize: 100, pageToken: "page-1" },
          semanticMode: SessionMessageSearchSemanticMode.HYBRID,
          filters: {
            targetIds: { values: ["target-1"] },
            sessionIds: { values: [] },
            backendIds: { values: ["backend-1"] },
            sessionStatus: SessionMessageSearchSessionStatus.ACTIVE,
            sessionActivityFrom: { seconds: 12n, nanos: 345_000_000 },
            messageCreatedFrom: { seconds: 10n, nanos: 0 },
            messageCreatedBefore: { seconds: 20n, nanos: 0 }
          }
        }
      },
      {
        service: "joko.v1.SessionService",
        method: "listSessionTimeline",
        input: { sessionId: "session-1", aroundEventId: "event-12", limit: 500 }
      },
      {
        service: "joko.v1.SessionService",
        method: "listSessionTimeline",
        input: { sessionId: "session-1", limit: 500 }
      },
      {
        service: "joko.v1.SessionService",
        method: "listSessionTimeline",
        input: {
          sessionId: "session-1",
          beforeCursor: expect.objectContaining({ opaqueToken: "cursor-12", sequence: 12n, generation: 1n }),
          limit: 1
        }
      }
    ]);
    gateway.disconnect();
  });

  it("rejects unknown role and kind values instead of relabeling them", async () => {
    const transport = transportFor(async (method) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      return create(SearchSessionMessagesResponseSchema, {
        matches: [{
          sessionId: "session-1",
          eventId: "event-1",
          timelineItemId: "event-1",
          role: SessionMessageSearchRole.UNSPECIFIED,
          kind: SessionMessageSearchKind.TEXT_MESSAGE,
          snippet: "hidden ambiguity"
        }]
      });
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.searchSessionMessages("ambiguity")).rejects.toThrow("unsupported message-search role");
    gateway.disconnect();
  });

  it("maps only the three search scopes represented by the public contract", async () => {
    const inputs: any[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      inputs.push(input);
      return create(SearchSessionMessagesResponseSchema, {});
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await gateway.searchSessionMessages("needle", "", 24, { kind: "session", sessionId: "session-1" });
    await gateway.searchSessionMessages("needle", "", 24, { kind: "target", targetId: "target-1" });
    await gateway.searchSessionMessages("needle", "", 24, { kind: "owner" });

    expect(inputs.map((input) => input.scope)).toEqual([
      { case: "sessionId", value: "session-1" },
      { case: "targetId", value: "target-1" },
      { case: "owner", value: {} }
    ]);
    gateway.disconnect();
  });

  it("maps both progressive-search stages to explicit wire semantic modes", async () => {
    const semanticModes: SessionMessageSearchSemanticMode[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      semanticModes.push(input.semanticMode);
      return create(SearchSessionMessagesResponseSchema, {});
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await gateway.searchAllSessionMessages("needle", { semanticMode: "keyword" });
    await gateway.searchAllSessionMessages("needle", { semanticMode: "hybrid" });

    expect(semanticModes).toEqual([
      SessionMessageSearchSemanticMode.KEYWORD,
      SessionMessageSearchSemanticMode.HYBRID
    ]);
    gateway.disconnect();
  });

  it("rejects malformed structured-filter timestamps before the first RPC", async () => {
    const unary = vi.fn(async () => create(SearchSessionMessagesResponseSchema, {}));
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transportFor(unary));
    await gateway.connect();

    await expect(gateway.searchAllSessionMessages("needle", {
      filters: { sessionActivityFrom: Number.NaN }
    })).rejects.toThrow(/integer Unix timestamp/u);
    expect(unary).not.toHaveBeenCalled();
    gateway.disconnect();
  });

  it("collects every page while preserving distinct hits from the same Session", async () => {
    const pageTokens: string[] = [];
    const wireFilters: unknown[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      pageTokens.push(input.page.pageToken);
      wireFilters.push(input.filters);
      if (input.page.pageToken === "") {
        return searchPage([
          searchMatch("session-a", "event-a-1", 40)
        ], "page-2", 4, 12n);
      }
      if (input.page.pageToken === "page-2") {
        return searchPage([
          searchMatch("session-a", "event-a-2", 30),
          searchMatch("session-b", "event-b-1", 20)
        ], "page-3", 4, 12n);
      }
      if (input.page.pageToken === "page-3") {
        return searchPage([
          searchMatch("session-c", "event-c-1", 10)
        ], "", 4, 12n);
      }
      throw new Error("Unexpected page token: " + input.page.pageToken);
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.searchAllSessionMessages(" needle ", {
      scope: { kind: "target", targetId: "target-1" },
      pageSize: 2,
      filters: {
        targetIds: ["target-1"],
        backendIds: ["backend-1"],
        sessionStatus: "archived",
        sessionActivityFrom: 12_345
      }
    })).resolves.toEqual({
      matches: [
        mappedSearchMatch("session-a", "event-a-1", 40),
        mappedSearchMatch("session-a", "event-a-2", 30),
        mappedSearchMatch("session-b", "event-b-1", 20),
        mappedSearchMatch("session-c", "event-c-1", 10)
      ],
      totalSize: 4,
      revision: 12n,
      vectorUsed: false,
      poolCapped: false
    });
    expect(pageTokens).toEqual(["", "page-2", "page-3"]);
    expect(wireFilters).toEqual(Array.from({ length: 3 }, () => ({
      targetIds: { values: ["target-1"] },
      backendIds: { values: ["backend-1"] },
      sessionStatus: SessionMessageSearchSessionStatus.ARCHIVED,
      sessionActivityFrom: { seconds: 12n, nanos: 345_000_000 }
    })));
    gateway.disconnect();
  });

  it("stops on an empty next token and rejects cyclic page tokens", async () => {
    let emptyTokenCalls = 0;
    const emptyTokenTransport = transportFor(async (method) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      emptyTokenCalls += 1;
      return searchPage([searchMatch("session-a", "event-a", 1)], "", 1, 3n);
    });
    const emptyTokenGateway = createOrchestratorGateway(profile(), "secret", {}, () => emptyTokenTransport);
    await emptyTokenGateway.connect();
    await expect(emptyTokenGateway.searchAllSessionMessages("needle")).resolves.toMatchObject({
      matches: [mappedSearchMatch("session-a", "event-a", 1)],
      totalSize: 1,
      revision: 3n
    });
    expect(emptyTokenCalls).toBe(1);
    emptyTokenGateway.disconnect();

    const requestedTokens: string[] = [];
    const cyclicTransport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      const token = input.page.pageToken as string;
      requestedTokens.push(token);
      return token === ""
        ? searchPage([], "page-a", 0, 4n)
        : token === "page-a"
          ? searchPage([], "page-b", 0, 4n)
          : searchPage([], "page-a", 0, 4n);
    });
    const cyclicGateway = createOrchestratorGateway(profile(), "secret", {}, () => cyclicTransport);
    await cyclicGateway.connect();
    await expect(cyclicGateway.searchAllSessionMessages("needle")).rejects.toThrow("cyclic message-search page token");
    expect(requestedTokens).toEqual(["", "page-a", "page-b"]);
    cyclicGateway.disconnect();
  });

  it("restarts from the first page once after revision drift and returns only the stable retry", async () => {
    const requestedTokens: string[] = [];
    const wireFilters: unknown[] = [];
    let requests = 0;
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      requestedTokens.push(input.page.pageToken);
      wireFilters.push(input.filters);
      requests += 1;
      if (requests === 1) return searchPage([searchMatch("session-stale", "event-stale-a", 4)], "stale-next", 2, 20n);
      if (requests === 2) return searchPage([searchMatch("session-stale", "event-stale-b", 3)], "", 2, 21n);
      if (requests === 3) return searchPage([searchMatch("session-fresh", "event-fresh-a", 2)], "fresh-next", 2, 22n);
      if (requests === 4) return searchPage([searchMatch("session-fresh", "event-fresh-b", 1)], "", 2, 22n);
      throw new Error("Unexpected request count: " + requests);
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.searchAllSessionMessages("needle", {
      filters: { sessionIds: ["session-fresh"], messageCreatedBefore: 20_000 }
    })).resolves.toEqual({
      matches: [
        mappedSearchMatch("session-fresh", "event-fresh-a", 2),
        mappedSearchMatch("session-fresh", "event-fresh-b", 1)
      ],
      totalSize: 2,
      revision: 22n,
      vectorUsed: false,
      poolCapped: false
    });
    expect(requestedTokens).toEqual(["", "stale-next", "", "fresh-next"]);
    expect(wireFilters).toEqual(Array.from({ length: 4 }, () => ({
      sessionIds: { values: ["session-fresh"] },
      sessionStatus: SessionMessageSearchSessionStatus.UNSPECIFIED,
      messageCreatedBefore: { seconds: 20n, nanos: 0 }
    })));
    gateway.disconnect();
  });

  it("fails explicitly when the full retry also observes revision drift", async () => {
    const requestedTokens: string[] = [];
    let requests = 0;
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      requestedTokens.push(input.page.pageToken);
      requests += 1;
      const retry = requests > 2;
      return input.page.pageToken === ""
        ? searchPage([searchMatch("session-a", `event-${requests}`, 2)], "next", 2, retry ? 30n : 20n)
        : searchPage([searchMatch("session-b", `event-${requests}`, 1)], "", 2, retry ? 31n : 21n);
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.searchAllSessionMessages("needle")).rejects.toThrow(
      "results changed while pages were loading after retrying from the first page"
    );
    expect(requestedTokens).toEqual(["", "next", "", "next"]);
    gateway.disconnect();
  });

  it("does not retry when the caller aborts as a drifting page completes", async () => {
    const abort = new AbortController();
    const requestedTokens: string[] = [];
    const transport = transportFor(async (method, input) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      requestedTokens.push(input.page.pageToken);
      if (input.page.pageToken === "") {
        return searchPage([searchMatch("session-a", "event-a", 2)], "next", 2, 40n);
      }
      abort.abort(new DOMException("Superseded search", "AbortError"));
      return searchPage([searchMatch("session-b", "event-b", 1)], "", 2, 41n);
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.searchAllSessionMessages("needle", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(requestedTokens).toEqual(["", "next"]);
    gateway.disconnect();
  });

  it("passes a caller cancellation signal to every page and stops an in-flight collection", async () => {
    let releaseSecondPage!: () => void;
    const secondPageStarted = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
    let requests = 0;
    const transport = transportFor(async (method, input, signal) => {
      if (method.localName !== "searchSessionMessages") throw new Error("Unexpected method: " + method.localName);
      requests += 1;
      if (input.page.pageToken === "") {
        return searchPage([searchMatch("session-a", "event-a", 2)], "next", 2, 8n);
      }
      releaseSecondPage();
      return new Promise((_resolve, reject) => {
        const rejectAbort = (): void => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal?.aborted === true) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    const gateway = createOrchestratorGateway(profile(), "secret", {}, () => transport);
    await gateway.connect();
    const abort = new AbortController();

    const search = gateway.searchAllSessionMessages("needle", { signal: abort.signal, pageSize: 1 });
    await secondPageStarted;
    abort.abort(new DOMException("Superseded search", "AbortError"));

    await expect(search).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(2);
    gateway.disconnect();
  });
});

function transportFor(handle: (method: any, input: any, signal?: AbortSignal) => Promise<unknown>): Transport {
  return {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          })
        : method.localName === "listManagedModelRuntimes"
          ? create(ListManagedModelRuntimesResponseSchema)
        : await handle(method, input, signal);
      return response(method, message);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

function profile() {
  return {
    id: "connection-search",
    deviceId: "device-search",
    serverId: "server-search",
    name: "Browser",
    origin: "https://orchestrator.example"
  };
}

function searchMatch(sessionId: string, eventId: string, createdAtSeconds: number) {
  return {
    sessionId,
    eventId,
    timelineItemId: `${eventId}-timeline`,
    role: SessionMessageSearchRole.ASSISTANT,
    kind: SessionMessageSearchKind.TEXT_MESSAGE,
    snippet: `match ${eventId}`,
    createdAt: { seconds: BigInt(createdAtSeconds) },
    score: createdAtSeconds / 100
  };
}

function mappedSearchMatch(sessionId: string, eventId: string, createdAtSeconds: number) {
  return {
    sessionId,
    eventId,
    timelineItemId: `${eventId}-timeline`,
    role: "assistant",
    kind: "textMessage",
    snippet: `match ${eventId}`,
    createdAt: createdAtSeconds * 1_000,
    score: createdAtSeconds / 100
  };
}

function searchPage(
  matches: readonly ReturnType<typeof searchMatch>[],
  nextPageToken: string,
  totalSize: number,
  revision: bigint
) {
  return create(SearchSessionMessagesResponseSchema, {
    matches: [...matches],
    page: { nextPageToken, totalSize: BigInt(totalSize) },
    revision: { value: revision }
  });
}
