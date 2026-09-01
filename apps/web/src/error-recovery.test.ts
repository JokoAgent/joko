import { create } from "@bufbuild/protobuf";
import { ErrorInfoSchema, ErrorSeverity, RecoveryActionKind } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { GatewayError, mapError } from "./gateway.js";

describe("typed error recovery projection", () => {
  it("preserves protocol recovery kinds instead of flattening them to prose", () => {
    const error = mapError(create(ErrorInfoSchema, {
      code: "EVENT_GAP",
      message: "Refresh required",
      phase: "stream",
      severity: ErrorSeverity.RETRYABLE,
      retryable: true,
      recoveryActions: [
        { kind: RecoveryActionKind.RETRY, label: "Try again" },
        { kind: RecoveryActionKind.RECONNECT, label: "Refresh state" },
        { kind: RecoveryActionKind.RESOLVE_INTERACTION, label: "Answer the question" },
        { kind: RecoveryActionKind.SELECT_NEW_SESSION, label: "Choose a task" },
        { kind: RecoveryActionKind.OPEN_DIAGNOSTICS, label: "Open diagnostics" },
        { kind: RecoveryActionKind.ABORT, label: "Stop" }
      ]
    }), "run-1");

    expect(error.runId).toBe("run-1");
    expect(error.recovery.map((action) => action.kind)).toEqual([
      "retry",
      "resnapshot",
      "resolveInteraction",
      "openSession",
      "openDiagnostics",
      "abort"
    ]);
  });

  it("keeps typed recovery while presenting service and recovery copy in Joko vocabulary", () => {
    const error = mapError(create(ErrorInfoSchema, {
      code: "SERVICE_UNAVAILABLE",
      message: "Orchestrator node did not answer.",
      phase: "connect",
      severity: ErrorSeverity.RETRYABLE,
      retryable: true,
      recoveryActions: [{ kind: RecoveryActionKind.RECONNECT, label: "Reconnect to Orchestrator node" }]
    }));

    expect(error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Joko node did not answer.",
      retryable: true,
      recovery: [{ kind: "resnapshot", label: "Reconnect to Joko node" }]
    });
    expect(new GatewayError("Orchestrator returned an invalid response.").message)
      .toBe("Joko service returned an invalid response.");
  });
});
