import { describe, expect, it } from "vitest";

import { projectPiNativeState } from "./state-projection.js";

describe("Pi native state projection", () => {
  it("combines live RPC fields with generation-owned retry and leaf state", () => {
    const state: Parameters<typeof projectPiNativeState>[0] = {
      sessionId: "native-1",
      sessionName: "task sk-abcdefghijklmnop",
      sessionFile: "D:\\service\\sessions\\native-1.jsonl",
      model: { provider: "provider", id: "model" } as never,
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: true,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      autoCompactionEnabled: true,
      messageCount: 5,
      pendingMessageCount: 2
    };
    const projected = projectPiNativeState(state, { autoRetry: false, activeLeafId: "leaf-2" });

    expect(projected).toMatchObject({
      nativeSessionId: "native-1",
      nativeSessionName: "task [REDACTED]",
      nativeSessionFileDisplay: "native-1.jsonl",
      model: { providerId: "provider", modelId: "model" },
      steeringMode: "all",
      followUpMode: "one_at_a_time",
      autoCompaction: true,
      autoRetry: false,
      messageCount: 5,
      pendingMessageCount: 2,
      activeLeafId: "leaf-2"
    });
    expect(JSON.stringify(projected)).not.toContain("D:\\service");
    expect(projectPiNativeState({
      ...state,
      sessionFile: "/service/sessions/native-2.jsonl"
    }, { autoRetry: false }).nativeSessionFileDisplay).toBe("native-2.jsonl");
  });
});
