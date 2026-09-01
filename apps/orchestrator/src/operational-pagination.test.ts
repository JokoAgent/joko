import type { OperationalStore, PersistedEvent } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import {
  listAllInteractions,
  listAllQueueItems,
  listAllRuns,
  listAllVisibleSessionEvents
} from "./operational-pagination.js";

describe("complete Operational Store traversal", () => {
  it("reads every Event across cursor pages without duplicates or omissions", () => {
    const events = Array.from({ length: 7 }, (_, index) => persistedEvent(BigInt(index + 1)));
    const listEvents = vi.fn((query: { readonly afterCursor?: bigint; readonly limit?: number }) => {
      const start = query.afterCursor === undefined
        ? 0
        : events.findIndex((event) => event.globalCursor > query.afterCursor!);
      if (start < 0) return [];
      return events.slice(start, start + (query.limit ?? 1_000));
    });
    const store = { listEvents } as unknown as OperationalStore;

    expect(listAllVisibleSessionEvents(store, "session-one", 3).map((event) => event.id)).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4",
      "event-5",
      "event-6",
      "event-7"
    ]);
    expect(listEvents.mock.calls.map(([query]) => query.afterCursor)).toEqual([undefined, 3n, 6n]);
  });

  it("reads queue, interaction, and run collections beyond one offset page", () => {
    const queue = Array.from({ length: 5 }, (_, index) => ({ id: `queue-${index}` }));
    const interactions = Array.from({ length: 5 }, (_, index) => ({ id: `interaction-${index}` }));
    const runs = Array.from({ length: 5 }, (_, index) => ({ descriptor: { id: `run-${index}` } }));
    const listQueueItems = vi.fn((options: { readonly offset?: number; readonly limit?: number }) =>
      queue.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 1_000)));
    const listInteractions = vi.fn((options: { readonly offset?: number; readonly limit?: number }) =>
      interactions.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 1_000)));
    const listRuns = vi.fn((options: { readonly offset?: number; readonly limit?: number }) =>
      runs.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 1_000)));
    const store = { listQueueItems, listInteractions, listRuns } as unknown as OperationalStore;

    expect(listAllQueueItems(store, { sessionId: "session-one" }, 2).map((item) => item.id)).toEqual(
      queue.map((item) => item.id)
    );
    expect(listAllInteractions(store, { sessionId: "session-one" }, 2).map((item) => item.id)).toEqual(
      interactions.map((item) => item.id)
    );
    expect(listAllRuns(store, { sessionId: "session-one" }, 2).map((run) => run.descriptor.id)).toEqual(
      runs.map((run) => run.descriptor.id)
    );
    expect(listQueueItems.mock.calls.map(([options]) => options.offset)).toEqual([0, 2, 4]);
    expect(listInteractions.mock.calls.map(([options]) => options.offset)).toEqual([0, 2, 4]);
    expect(listRuns.mock.calls.map(([options]) => options.offset)).toEqual([0, 2, 4]);
  });
});

function persistedEvent(cursor: bigint): PersistedEvent {
  return {
    id: `event-${cursor}`,
    globalCursor: cursor,
    sequence: cursor,
    revision: 1n,
    emittedAt: Number(cursor),
    backendId: "backend-one",
    targetId: "target-one",
    sessionId: "session-one",
    generation: 1,
    traceId: `trace-${cursor}`,
    payload: { type: "status", key: "test", text: String(cursor) }
  };
}
