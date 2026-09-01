import * as contract from "@joko/contracts";
import type { NativeSessionState } from "@joko/core";
import { describe, expect, it } from "vitest";

import { projectDurablePiState } from "./connect-services.js";
import { markNativeStateObservationStale, nativeStateObservation } from "./native-state-observation.js";

const binding = {
  opaqueRef: "D:\\service-only\\sessions\\native-1.jsonl",
  nativeSessionId: "native-1",
  generation: 4
};

describe("durable Pi state projection", () => {
  it("does not fabricate a Pi state before a successful native observation", () => {
    const projected = projectDurablePiState(undefined, binding);

    expect(projected.state).toBeUndefined();
    expect(projected.observation).toMatchObject({
      source: contract.PiStateObservationSource.UNSPECIFIED,
      completeness: contract.PiStateObservationCompleteness.UNOBSERVED,
      runtimeGeneration: 4n,
      bindingCurrent: false
    });
  });

  it("projects complete, partial, and stale observations without guessing missing fields", () => {
    const exact = nativeStateObservation(fixtureState(true), undefined, 123);
    const current = projectDurablePiState(exact, binding);
    expect(current.state).toMatchObject({
      nativeSessionId: "native-1",
      nativeSessionName: "Observed",
      nativeSessionFileDisplay: "native-1.jsonl",
      steeringMode: contract.PiQueueMode.ALL,
      followUpMode: contract.PiQueueMode.ONE_AT_A_TIME,
      autoRetry: false,
      messageCount: 9n,
      activeLeafId: "leaf-9"
    });
    expect(current.observation).toMatchObject({
      source: contract.PiStateObservationSource.DURABLE_RPC,
      completeness: contract.PiStateObservationCompleteness.COMPLETE,
      runtimeGeneration: 4n,
      bindingCurrent: true
    });

    const partial = projectDurablePiState(nativeStateObservation(fixtureState(false), undefined, 124), binding);
    expect(partial.state).toBeUndefined();
    expect(partial.observation.completeness).toBe(contract.PiStateObservationCompleteness.PARTIAL);
    expect(partial.observation.bindingCurrent).toBe(true);

    const staleGeneration = projectDurablePiState(exact, { ...binding, generation: 5 });
    expect(staleGeneration.state).toEqual(current.state);
    expect(staleGeneration.observation).toMatchObject({
      completeness: contract.PiStateObservationCompleteness.STALE,
      runtimeGeneration: 4n,
      bindingCurrent: false
    });

    const explicitlyStale = projectDurablePiState(markNativeStateObservationStale(exact, 130), binding);
    expect(explicitlyStale.state).toEqual(current.state);
    expect(explicitlyStale.observation.completeness).toBe(contract.PiStateObservationCompleteness.STALE);
    expect(explicitlyStale.observation.bindingCurrent).toBe(false);
  });
});

function fixtureState(includePi: boolean): NativeSessionState {
  return {
    binding,
    name: "Observed",
    streaming: false,
    compacting: false,
    pendingMessages: 0,
    providerId: "provider",
    modelId: "model",
    effort: "medium",
    fastMode: false,
    permissionMode: "ask",
    ...(includePi
      ? {
          pi: {
            nativeSessionId: "native-1",
            nativeSessionName: "Observed",
            nativeSessionFileDisplay: "D:\\service-only\\sessions\\native-1.jsonl",
            model: { providerId: "provider", modelId: "model" },
            thinkingLevel: "medium",
            streaming: false,
            compacting: false,
            steeringMode: "all" as const,
            followUpMode: "one_at_a_time" as const,
            autoCompaction: true,
            autoRetry: false,
            messageCount: 9,
            pendingMessageCount: 0,
            activeLeafId: "leaf-9"
          }
        }
      : {})
  };
}
