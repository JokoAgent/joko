import { describe, expect, it } from "vitest";
import type { ErrorView, SessionView, TimelineItemView } from "./model.js";
import {
  activeRuntimeRecovery,
  projectRuntimeRecoveryTimeline,
  projectSessionRuntimeRecovery
} from "./runtime-recovery.js";

const error: ErrorView = {
  code: "UPSTREAM_OVERLOAD",
  message: "capacity interrupted",
  phase: "stream",
  severity: "retryable",
  retryable: true,
  recovery: []
};

describe("runtime recovery presentation", () => {
  it("hides the claimed error and internal prompt behind one active row", () => {
    const items = [
      item("error", 1n, "error", { runId: "run-a", error }),
      item("recovery", 2n, "runtimeRecovery", {
        runtimeRecovery: recovery("waiting")
      }),
      item("hidden-prompt", 3n, "user", {
        automaticContinuation: { recoveryId: "recover-a" }
      })
    ];

    expect(activeRuntimeRecovery(items)?.id).toBe("recover-a");
    expect(projectRuntimeRecoveryTimeline(items).map((value) => value.id)).toEqual(["recovery"]);
  });

  it("restores an exhausted error and projects active reconnect state without stale attention", () => {
    const exhausted = [
      item("error", 1n, "error", { runId: "run-a", error }),
      item("recovery", 2n, "runtimeRecovery", { runtimeRecovery: recovery("exhausted") })
    ];
    expect(projectRuntimeRecoveryTimeline(exhausted).map((value) => value.id)).toEqual(["error", "recovery"]);

    const session = {
      id: "session-a",
      backendId: "backend-a",
      targetId: "target-a",
      name: "Task",
      state: "error",
      pinned: false,
      archived: false,
      generation: 0n,
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      codeHostPullRequests: [],
      createdAt: 1,
      updatedAt: 2,
      retryRunId: "run-a",
      attention: {
        kind: "error",
        unread: true,
        subjectCursor: { opaqueToken: "1", sequence: 1n, generation: 0n },
        attentionCursor: { opaqueToken: "1", sequence: 1n, generation: 0n },
        readThroughCursor: { opaqueToken: "", sequence: 0n, generation: 0n },
        updatedAt: 2
      }
    } satisfies SessionView;
    const projected = projectSessionRuntimeRecovery(session, [
      item("recovery", 2n, "runtimeRecovery", { runtimeRecovery: recovery("running") })
    ]);
    expect(projected.state).toBe("retrying");
    expect(projected.retryRunId).toBeUndefined();
    expect(projected.attention).toBeUndefined();
  });
});

function recovery(state: NonNullable<TimelineItemView["runtimeRecovery"]>["state"]): NonNullable<TimelineItemView["runtimeRecovery"]> {
  return {
    id: "recover-a",
    sourceRunId: "run-a",
    state,
    attempt: 1,
    maximumAttempts: 5,
    sessionTotal: 1,
    error
  };
}

function item(
  id: string,
  sequence: bigint,
  kind: TimelineItemView["kind"],
  extra: Partial<TimelineItemView> = {}
): TimelineItemView {
  return { id, sequence, kind, createdAt: Number(sequence), ...extra };
}
