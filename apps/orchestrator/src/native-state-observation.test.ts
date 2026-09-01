import type { NativeSessionState, PiNativeStateMetadata } from "@joko/core";
import { describe, expect, it } from "vitest";

import {
  materializedNativeStateObservation,
  markNativeStateObservationStale,
  nativeBindingFingerprint,
  nativeStateObservation,
  nativeStateObservationIsCurrent
} from "./native-state-observation.js";

describe("native state observation", () => {
  it("materializes one bounded, redacted, binding-fenced live observation", () => {
    const state = fixtureState();
    const observation = nativeStateObservation(state, fixturePiState(), 123);

    expect(observation).toMatchObject({
      format: 1,
      generation: 7,
      observedAt: 123,
      bindingFingerprint: nativeBindingFingerprint("managed://native/one"),
      state: {
        nativeSessionId: "native-one",
        name: "task [REDACTED]",
        streaming: false,
        pendingMessages: 2,
        autoCompaction: true,
        autoRetry: false
      },
      pi: {
        nativeSessionFileDisplay: "session.jsonl",
        nativeSessionName: "native [REDACTED]"
      }
    });
    expect(JSON.stringify(observation)).not.toContain("managed://native/one");
    expect(JSON.stringify(observation)).not.toContain("sk-abcdefghijklmnop");
    expect(nativeStateObservationIsCurrent(observation, 7, "managed://native/one")).toBe(true);
    expect(nativeStateObservationIsCurrent(observation, 8, "managed://native/one")).toBe(false);
    expect(nativeStateObservationIsCurrent(observation, 7, "managed://native/two")).toBe(false);
    expect(materializedNativeStateObservation(JSON.parse(JSON.stringify(observation)))).toEqual(observation);
    const stale = markNativeStateObservationStale(observation, 124);
    expect(stale.staleAt).toBe(124);
    expect(nativeStateObservationIsCurrent(stale, 7, "managed://native/one")).toBe(false);
    expect(materializedNativeStateObservation(JSON.parse(JSON.stringify(stale)))).toEqual(stale);
  });

  it("fails closed on malformed persisted data without weakening the previous truth", () => {
    const observation = nativeStateObservation(fixtureState(), undefined, 123);
    expect(materializedNativeStateObservation({ ...observation, generation: -1 })).toBeUndefined();
    expect(materializedNativeStateObservation({ ...observation, bindingFingerprint: "native-path" })).toBeUndefined();
    expect(materializedNativeStateObservation({ ...observation, state: { ...observation.state, streaming: "yes" } })).toBeUndefined();
    expect(materializedNativeStateObservation({ ...observation, pi: { autoRetry: true } })).toBeUndefined();
    expect(materializedNativeStateObservation({ ...observation, staleAt: 0 / 0 })).toBeUndefined();
  });

  it("never persists an absolute native-session identifier as a service-node path", () => {
    const state = fixtureState();
    const observation = nativeStateObservation({
      ...state,
      binding: {
        ...state.binding,
        nativeSessionId: "D:\\private\\sessions\\native.jsonl"
      }
    }, {
      ...fixturePiState(),
      nativeSessionId: "/srv/private/sessions/native.jsonl"
    }, 123);

    expect(observation.state.nativeSessionId).toBe("native.jsonl");
    expect(observation.pi?.nativeSessionId).toBe("native.jsonl");
    expect(JSON.stringify(observation)).not.toContain("private");
  });
});

function fixtureState(): NativeSessionState {
  return {
    binding: { opaqueRef: "managed://native/one", nativeSessionId: "native-one", generation: 7 },
    name: "task sk-abcdefghijklmnop",
    streaming: false,
    compacting: false,
    pendingMessages: 2,
    providerId: "provider",
    modelId: "model",
    effort: "medium",
    fastMode: false,
    permissionMode: "ask",
    autoCompaction: true,
    autoRetry: false,
    usage: {
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 7,
      contextTokens: 7,
      contextWindow: 128_000,
      cost: 0
    }
  };
}

function fixturePiState(): PiNativeStateMetadata {
  return {
    nativeSessionId: "native-one",
    nativeSessionName: "native sk-abcdefghijklmnop",
    nativeSessionFileDisplay: "D:\\private\\sessions\\session.jsonl",
    model: { providerId: "provider", modelId: "model" },
    thinkingLevel: "medium",
    streaming: false,
    compacting: false,
    steeringMode: "one_at_a_time",
    followUpMode: "all",
    autoCompaction: true,
    autoRetry: true,
    messageCount: 5,
    pendingMessageCount: 2,
    activeLeafId: "leaf-1"
  };
}
