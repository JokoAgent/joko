import { QueueItemState } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  plainTextMobileComposerDraft
} from "./mobile-composer-document";
import {
  appendMobileOptimisticUserRow,
  markMobileOptimisticUserRowSubmitted,
  mobileOptimisticActiveOperationIds,
  mobileQueueBlocksOptimisticUserRow,
  projectMobileOptimisticUserRows,
  reconcileMobileOptimisticUserRows,
  retireMobileOptimisticUserRow,
  retireMobileOptimisticUserRowsForSession,
  type MobileOptimisticUserRow
} from "./mobile-optimistic-user-row";
import type { TimelineRow } from "./timeline";

describe("mobile optimistic user rows", () => {
  const ownerKey = "owner-one";

  it("reserves one body-only slot from the structured draft and deduplicates exact sends", () => {
    const observed = [timelineRow("assistant-one")];
    const quoted = appendMobileSelectionQuote(plainTextMobileComposerDraft("Follow up"), {
      sourceSessionId: "source-session",
      sourceMessageId: "source-message",
      sourceEventId: "source-event",
      sourceRole: "assistant",
      text: "quoted answer"
    }, "quote-one").draft;

    const reserved = appendMobileOptimisticUserRow([], observed, ownerKey, "session-one", "operation-one", quoted);

    expect(reserved).toEqual([{
      ownerKey,
      sessionId: "session-one",
      operationId: "operation-one",
      phase: "dispatching",
      row: {
        id: "optimistic-user:operation-one",
        label: "You",
        text: "Follow up\n\n> quoted answer",
        sequence: 0n,
        eventId: "operation-one",
        kind: "user",
        completed: false,
        operationId: "operation-one",
        optimistic: true
      },
      precedingRowIds: new Set(["assistant-one"])
    }]);
    expect(appendMobileOptimisticUserRow(
      reserved, observed, ownerKey, "session-one", "operation-one", quoted
    )).toBe(reserved);
    expect(appendMobileOptimisticUserRow(
      [], [timelineRow("echo", { kind: "user", operationId: "operation-one" })],
      ownerKey, "session-one", "operation-one", quoted
    )).toEqual([]);
    expect(() => appendMobileOptimisticUserRow(
      [], observed, ownerKey, "session-one", "empty", plainTextMobileComposerDraft("   ")
    )).toThrow(/message or attach a file/u);
  });

  it("keeps reservation order and lets a durable echo replace its original slot", () => {
    const firstObserved = [
      timelineRow("first", { sequence: 90n }),
      timelineRow("second", { sequence: 1n })
    ];
    const first = appendMobileOptimisticUserRow(
      [], firstObserved, ownerKey, "session-one", "operation-one", plainTextMobileComposerDraft("one")
    );
    const both = appendMobileOptimisticUserRow(
      first, firstObserved, ownerKey, "session-one", "operation-two", plainTextMobileComposerDraft("two")
    );
    expect(both[1]?.precedingRowIds).toEqual(new Set([
      "first", "second", "optimistic-user:operation-one"
    ]));

    const later = timelineRow("later", { sequence: -5n });
    expect(projectMobileOptimisticUserRows([...firstObserved, later], both, ownerKey, "session-one")
      .map((row) => row.id)).toEqual([
      "first", "second", "optimistic-user:operation-one", "optimistic-user:operation-two", "later"
    ]);

    const echo = timelineRow("durable-message", {
      kind: "user",
      text: "authoritative body",
      operationId: "operation-one",
      sequence: 999n
    });
    const projected = projectMobileOptimisticUserRows([...firstObserved, later, echo], both, ownerKey, "session-one");
    expect(projected.map((row) => row.id)).toEqual([
      "first", "second", "durable-message", "optimistic-user:operation-two", "later"
    ]);
    expect(projected[2]).toBe(echo);

    const reconciled = reconcileMobileOptimisticUserRows(
      both, [...firstObserved, later, echo], ownerKey, "session-one", new Set()
    );
    expect(identities(reconciled)).toEqual([
      "session-one/operation-one", "session-one/operation-two"
    ]);
    expect(projectMobileOptimisticUserRows(
      [...firstObserved, later, echo], reconciled, ownerKey, "session-one"
    ).map((row) => row.id)).toEqual([
      "first", "second", "durable-message", "optimistic-user:operation-two", "later"
    ]);
  });

  it("does not infer an echo from text, time, id, or a non-user operation row", () => {
    const optimistic = appendMobileOptimisticUserRow(
      [], [], ownerKey, "session-one", "operation-one", plainTextMobileComposerDraft("same body")
    );
    const status = timelineRow("optimistic-user:operation-one", {
      kind: "status",
      text: "same body",
      operationId: "operation-one",
      sequence: 0n
    });

    expect(projectMobileOptimisticUserRows([status], optimistic, ownerKey, "session-one").map((row) => row.kind))
      .toEqual(["user", "status"]);
    expect(reconcileMobileOptimisticUserRows(optimistic, [status], ownerKey, "session-one", new Set())).toBe(optimistic);
    expect(projectMobileOptimisticUserRows([status], optimistic, ownerKey, "another-session")).toEqual([status]);
  });

  it("reconciles only an authoritative user echo and retires exact failures or Session owners", () => {
    const one = appendMobileOptimisticUserRow(
      [], [], ownerKey, "session-one", "operation-one", plainTextMobileComposerDraft("one")
    );
    const two = appendMobileOptimisticUserRow(
      one, [], ownerKey, "session-one", "operation-two", plainTextMobileComposerDraft("two")
    );
    const all = appendMobileOptimisticUserRow(
      two, [], ownerKey, "session-two", "operation-three", plainTextMobileComposerDraft("three")
    );
    const submitted = markMobileOptimisticUserRowSubmitted(
      markMobileOptimisticUserRowSubmitted(all, "session-one", "operation-one"),
      "session-one",
      "operation-two"
    );
    const echoed = reconcileMobileOptimisticUserRows(submitted, [timelineRow("echo", {
      kind: "user", operationId: "operation-one"
    })], ownerKey, "session-one", new Set(["operation-two"]));
    expect(identities(echoed)).toEqual([
      "session-one/operation-one", "session-one/operation-two", "session-two/operation-three"
    ]);

    const failed = retireMobileOptimisticUserRow(echoed, "session-one", "operation-two");
    expect(identities(failed)).toEqual(["session-one/operation-one", "session-two/operation-three"]);
    const anchorsRetired = reconcileMobileOptimisticUserRows(failed, [timelineRow("echo", {
      kind: "user", operationId: "operation-one"
    })], ownerKey, "session-one", new Set());
    expect(identities(anchorsRetired)).toEqual(["session-two/operation-three"]);
    expect(retireMobileOptimisticUserRow(anchorsRetired, "session-one", "operation-two")).toBe(anchorsRetired);

    const unknown = retireMobileOptimisticUserRow(all, "session-one", "operation-one");
    expect(identities(unknown)).toEqual([
      "session-one/operation-two", "session-two/operation-three"
    ]);
    expect(retireMobileOptimisticUserRowsForSession(unknown, "session-one"))
      .toEqual([all[2]]);
  });

  it("retires submitted rows only after their exact receipt and Queue activity disappear", () => {
    const dispatching = appendMobileOptimisticUserRow(
      [], [], ownerKey, "session-one", "operation-one", plainTextMobileComposerDraft("one")
    );
    expect(reconcileMobileOptimisticUserRows(dispatching, [], ownerKey, "session-one", new Set())).toBe(dispatching);

    const submitted = markMobileOptimisticUserRowSubmitted(dispatching, "session-one", "operation-one");
    expect(submitted[0]?.phase).toBe("submitted");
    expect(reconcileMobileOptimisticUserRows(
      submitted, [], ownerKey, "session-one", new Set(["operation-one"])
    )).toBe(submitted);
    expect(reconcileMobileOptimisticUserRows(submitted, [], ownerKey, "session-one", new Set())).toEqual([]);
    expect(reconcileMobileOptimisticUserRows(dispatching, [], "owner-two", "session-one", new Set())).toEqual([]);
  });

  it("tracks every known dispatch phase by exact Queue source identity and treats unknown as busy", () => {
    const queue = [
      { sessionId: "session-one", sourceId: "accepted", state: QueueItemState.ACCEPTED },
      { sessionId: "session-one", sourceId: "dispatching", state: QueueItemState.DISPATCHING },
      { sessionId: "session-one", sourceId: "backend", state: QueueItemState.BACKEND_ACCEPTED },
      { sessionId: "session-one", sourceId: "unknown", state: QueueItemState.DISPATCH_UNKNOWN },
      { sessionId: "session-one", sourceId: "done", state: QueueItemState.COMPLETED },
      { sessionId: "session-two", sourceId: "other", state: QueueItemState.ACCEPTED }
    ];

    expect(mobileOptimisticActiveOperationIds(queue, "session-one"))
      .toEqual(new Set(["accepted", "dispatching", "backend"]));
    expect(mobileQueueBlocksOptimisticUserRow(queue, "session-one")).toBe(true);
    expect(mobileQueueBlocksOptimisticUserRow([
      { sessionId: "session-one", sourceId: "done", state: QueueItemState.COMPLETED }
    ], "session-one")).toBe(false);
  });
});

function timelineRow(id: string, override: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id,
    label: "Assistant",
    text: id,
    sequence: 1n,
    eventId: `event-${id}`,
    kind: "assistant",
    completed: true,
    ...override
  };
}

function identities(rows: readonly MobileOptimisticUserRow[]): string[] {
  return rows.map((entry) => `${entry.sessionId}/${entry.operationId}`);
}
