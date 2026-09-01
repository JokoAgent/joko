import type { BlobRef } from "@joko/core";
import { describe, expect, it } from "vitest";

import { projectPiNativeHistory, type PiNativeSessionHistory } from "./native-history.js";

describe("Pi native history projection", () => {
  it("projects cleaned message and tool-result image content without raw Pi persistence objects", () => {
    const image: BlobRef = {
      id: "image-artifact",
      sha256: "a".repeat(64),
      byteLength: 24,
      mimeType: "image/png",
      fileName: "pi-image.png"
    };
    const history: PiNativeSessionHistory = {
      entries: [
        {
          id: "assistant-image",
          type: "message",
          timestamp: 1_000,
          data: {
            message: {
              role: "assistant",
              content: [{ type: "image", blob: image, alt: "preview" }],
              duration: 850,
              usage: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 10, cost: { total: 0.0025 } }
            }
          }
        },
        {
          id: "tool-image",
          parentId: "assistant-image",
          type: "message",
          timestamp: 2_000,
          data: {
            message: {
              role: "toolResult",
              toolCallId: "read-image",
              toolName: "read",
              content: [
                { type: "text", text: "Image Size: 16x16." },
                { type: "image", blob: image, alt: "tool preview" }
              ],
              isError: false
            }
          }
        }
      ],
      leafId: "tool-image"
    };

    const first = projectPiNativeHistory("native-session-id", history);
    const reconnected = projectPiNativeHistory("native-session-id", history);

    expect(first).toEqual(reconnected);
    expect(first.events.map((event) => event.projectionKind)).toEqual(["message_assistant", "tool_result"]);
    expect(first.events.map((event) => event.payload)).toEqual([
      {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "image", blob: image, alt: "preview" }],
        usage: {
          inputTokens: 4,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          totalTokens: 10,
          cost: 0.0025
        },
        generationDurationMs: 850,
        generationReliable: true
      },
      {
        type: "tool_result",
        callId: "read-image",
        name: "read",
        output: "Image Size: 16x16.",
        parts: [
          { kind: "text", text: "Image Size: 16x16." },
          { kind: "image", blob: image, alt: "tool preview" }
        ],
        isError: false
      }
    ]);
    expect(first.events.map((event) => event.metadata?.pi?.payload.case)).toEqual([
      "messageLifecycle",
      "messageLifecycle"
    ]);
    expect(first.activeEntryId).toBe("tool-image");
    expect(first.activeEntryMetadata?.pi).toMatchObject({
      rpcEventType: "session_identity_update",
      leafId: "tool-image",
      payload: {
        case: "sessionIdentityUpdate",
        value: { nativeSessionId: "native-session-id", activeLeafId: "tool-image" }
      }
    });
    expect(JSON.stringify(first)).not.toContain("base64");
    expect(JSON.stringify(first)).not.toContain("data:image");
  });

  it("rebuilds only the active path and flattens assistant blocks in Pi order", () => {
    const projected = projectPiNativeHistory("native-branch", {
      entries: [
        {
          id: "root-user",
          type: "message",
          timestamp: 1_000,
          data: { message: { role: "user", content: [{ type: "text", text: "Root" }] } }
        },
        {
          id: "inactive-assistant",
          parentId: "root-user",
          type: "message",
          timestamp: 1_500,
          data: { message: { role: "assistant", content: [{ type: "text", text: "Inactive branch" }] } }
        },
        {
          id: "active-assistant",
          parentId: "root-user",
          type: "message",
          timestamp: 2_000,
          data: {
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Reasoning" },
                { type: "text", text: "Answer" },
                { type: "toolCall", id: "read-one", name: "read", arguments: { path: "README.md" } }
              ],
              usage: { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { total: 0 } }
            }
          }
        },
        {
          id: "active-result",
          parentId: "active-assistant",
          type: "message",
          timestamp: 3_000,
          data: {
            message: {
              role: "toolResult",
              toolCallId: "read-one",
              toolName: "read",
              content: [{ type: "text", text: "contents" }],
              isError: false
            }
          }
        }
      ],
      leafId: "active-result"
    });

    expect(projected.events.map((event) => event.nativeEntryId)).toEqual([
      "root-user",
      "active-assistant",
      "active-assistant",
      "active-assistant",
      "active-assistant",
      "active-result"
    ]);
    expect(projected.events.map((event) => event.projectionKind)).toEqual([
      "message_user",
      "message_assistant_thinking",
      "message_assistant_text",
      "message_assistant_tool_call",
      "message_assistant",
      "tool_result"
    ]);
    expect(projected.events.map((event) => event.contentIndex)).toEqual([0, 0, 1, 2, 3, 0]);
    expect(projected.events.map((event) => event.emittedAt)).toEqual([1_000, 2_000, 2_001, 2_002, 2_003, 3_000]);
    expect(projected.events.map((event) => event.payload.type)).toEqual([
      "message_complete",
      "thinking_delta",
      "text_delta",
      "tool_start",
      "message_complete",
      "tool_result"
    ]);
    expect(projected.events[3]).toMatchObject({
      payload: { type: "tool_start", callId: "read-one", name: "read", input: "{\"path\":\"README.md\"}" },
      metadata: {
        pi: {
          rpcEventType: "tool_execution_start",
          contentIndex: 2,
          nativeToolName: "read",
          payload: {
            case: "toolLifecycle",
            value: { nativeToolCallId: "read-one", builtInKind: "read", phase: "start", contentIndex: 2 }
          }
        }
      }
    });
    expect(projected.events[4]?.payload).toMatchObject({
      type: "message_complete",
      role: "assistant",
      blocks: [
        { kind: "thinking", text: "Reasoning" },
        { kind: "text", text: "Answer" },
        { kind: "tool_call", callId: "read-one", name: "read" }
      ],
      generationReliable: false
    });
    expect(JSON.stringify(projected)).not.toContain("Inactive branch");
  });

  it("owns every supported Pi JSONL taxonomy branch and emits bounded typed metadata", () => {
    const history: PiNativeSessionHistory = {
      entries: [
        { id: "custom-message", type: "custom_message", data: { customType: "visible-extension-message", content: "custom", display: true } },
        {
          id: "compact",
          parentId: "tree-parent-must-not-be-used-as-boundary",
          type: "compaction",
          data: {
            summary: "summary",
            firstKeptEntryId: "first-kept-entry",
            tokensBefore: 9_876
          }
        },
        {
          id: "branch",
          parentId: "new-branch-attachment",
          type: "branch_summary",
          data: { fromId: "abandoned-branch-leaf", summary: "branch summary" }
        },
        { id: "model", type: "model_change", data: { provider: "provider", modelId: "model" } },
        { id: "thinking", type: "thinking_level_change", data: { thinkingLevel: "high" } },
        { id: "tools", type: "active_tools_change", data: { activeToolNames: ["read", "write"] } },
        { id: "custom", type: "custom", data: { customType: "private" } },
        { id: "future", type: "future_entry", data: { secret: "must-not-be-copied" } }
      ]
    };

    const projected = projectPiNativeHistory(undefined, history);
    expect(projected.events.map((event) => event.projectionKind)).toEqual([
      "custom_message",
      "compaction",
      "branch_summary",
      "model_change",
      "thinking_level_change",
      "active_tools_change",
      "custom",
      "unknown"
    ]);
    expect(projected.events.map((event) => event.metadata?.pi?.payload.case)).toEqual([
      "messageLifecycle",
      "compactionUpdate",
      "compactionUpdate",
      "modelUpdate",
      "modelUpdate",
      "diagnostic",
      "diagnostic",
      "diagnostic"
    ]);
    expect(projected.events[1]?.metadata?.pi).toMatchObject({
      parentEntryId: "tree-parent-must-not-be-used-as-boundary",
      payload: {
        case: "compactionUpdate",
        value: {
          compactionId: "compact",
          trigger: "unknown",
          reason: "native_history",
          state: "completed",
          boundaryEntryId: "first-kept-entry",
          tokensBefore: 9_876,
          tokensAfter: 0,
          summaryPreview: "summary"
        }
      }
    });
    expect(projected.events[2]?.metadata?.pi).toMatchObject({
      parentEntryId: "new-branch-attachment",
      payload: {
        case: "compactionUpdate",
        value: {
          trigger: "branch",
          reason: "native_branch_summary",
          boundaryEntryId: "abandoned-branch-leaf",
          summaryPreview: "branch summary"
        }
      }
    });
    expect(projected.events[1]?.payload).toMatchObject({
      type: "compaction",
      reason: "native_history",
      compactionId: "compact",
      state: "completed",
      boundaryEntryId: "first-kept-entry",
      tokensBefore: 9_876
    });
    expect(projected.events[7]?.payload).toEqual({
      type: "status",
      key: "pi.history.unknown.future_entry",
      text: "Native Pi entry 'future_entry' preserved"
    });
    expect(JSON.stringify(projected)).not.toContain("must-not-be-copied");
  });

  it("publishes only Pi custom messages whose real display field is explicitly true", () => {
    const projected = projectPiNativeHistory("native-custom-message", {
      entries: [
        {
          id: "hidden-explicit",
          type: "custom_message",
          data: {
            customType: "joko-plan-mode",
            content: "[JOKO PLAN MODE ACTIVE] internal instructions",
            display: false
          }
        },
        {
          id: "hidden-missing-field",
          type: "custom_message",
          data: {
            customType: "malformed-extension-state",
            content: "malformed internal context"
          }
        },
        {
          id: "visible-explicit",
          type: "custom_message",
          data: {
            customType: "visible-extension-message",
            content: "Visible extension context",
            display: true
          }
        }
      ],
      leafId: "visible-explicit"
    });

    expect(projected.events).toHaveLength(1);
    expect(projected.events[0]).toMatchObject({
      nativeEntryId: "visible-explicit",
      projectionKind: "custom_message",
      contentIndex: 0,
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Visible extension context" }]
      },
      metadata: {
        pi: {
          entryId: "visible-explicit",
          rpcEventType: "message_end",
          payload: {
            case: "messageLifecycle",
            value: { nativeEntryId: "visible-explicit", role: "user" }
          }
        }
      }
    });
    expect(JSON.stringify(projected)).not.toContain("JOKO PLAN MODE ACTIVE");
    expect(JSON.stringify(projected)).not.toContain("malformed internal context");
    expect(projected.activeEntryId).toBe("visible-explicit");
  });

  it("rehydrates Pi bashExecution history as one terminal Shell card with typed metadata", () => {
    const artifact: BlobRef = {
      id: "full-shell-output",
      sha256: "b".repeat(64),
      byteLength: 4096,
      mimeType: "text/plain",
      fileName: "user-shell.log"
    };
    const projected = projectPiNativeHistory("native-shell", {
      entries: [{
        id: "bash-entry",
        parentId: "assistant-entry",
        type: "message",
        timestamp: 3_000,
        data: {
          message: {
            role: "bashExecution",
            command: "git status",
            output: "working tree dirty",
            exitCode: 1,
            cancelled: false,
            truncated: true,
            excludeFromContext: true,
            fullOutputArtifact: artifact
          }
        }
      }],
      leafId: "bash-entry"
    });

    expect(projected.events.map((event) => event.projectionKind)).toEqual(["bash_start", "bash_result"]);
    expect(projected.events.map((event) => event.contentIndex)).toEqual([0, 1]);
    expect(projected.events.map((event) => event.payload)).toEqual([
      { type: "tool_start", callId: "native-bash-bash-entry", name: "Shell", input: "git status" },
      {
        type: "tool_result",
        callId: "native-bash-bash-entry",
        name: "Shell",
        output: "working tree dirty\n[command exited with code 1]\n[full output stored as artifact]",
        isError: true,
        artifact
      }
    ]);
    expect(projected.events.map((event) => event.metadata?.pi)).toEqual([
      expect.objectContaining({
        rpcEventType: "bash_execution_start",
        nativeToolName: "user_shell",
        payload: { case: "bashUpdate", value: expect.objectContaining({ completed: false, excludedFromContext: true }) }
      }),
      expect.objectContaining({
        rpcEventType: "bash_execution_end",
        nativeToolName: "user_shell",
        payload: { case: "bashUpdate", value: expect.objectContaining({ completed: true, exitCode: 1 }) }
      })
    ]);
  });

  it("withholds Vision path and focus arguments from native history while preserving descriptions", () => {
    const projected = projectPiNativeHistory("native-vision", {
      entries: [
        {
          id: "assistant-vision-tools",
          type: "message",
          timestamp: 1_000,
          data: {
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "vision-call",
                  name: "vision",
                  arguments: {
                    path: "C:\\private\\NATIVE-VISION-PATH-MARKER.png",
                    query: "NATIVE-VISION-QUERY-MARKER"
                  }
                },
                {
                  type: "toolCall",
                  id: "vision-locate-call",
                  name: "vision-locate",
                  arguments: {
                    path: "C:\\private\\NATIVE-VISION-LOCATE-PATH-MARKER.png",
                    target: "NATIVE-VISION-TARGET-MARKER"
                  }
                }
              ]
            }
          }
        },
        {
          id: "vision-description",
          parentId: "assistant-vision-tools",
          type: "message",
          timestamp: 2_000,
          data: {
            message: {
              role: "toolResult",
              toolCallId: "vision-call",
              toolName: "vision",
              content: [{ type: "text", text: "A chart with three rising bars." }],
              isError: false
            }
          }
        },
        {
          id: "vision-locate-description",
          parentId: "vision-description",
          type: "message",
          timestamp: 3_000,
          data: {
            message: {
              role: "toolResult",
              toolCallId: "vision-locate-call",
              toolName: "vision-locate",
              content: [{ type: "text", text: "The submit button is near the lower-right corner." }],
              isError: false
            }
          }
        }
      ],
      leafId: "vision-locate-description"
    });

    const durableProjection = JSON.stringify(projected);
    for (const marker of [
      "NATIVE-VISION-PATH-MARKER",
      "NATIVE-VISION-QUERY-MARKER",
      "NATIVE-VISION-LOCATE-PATH-MARKER",
      "NATIVE-VISION-TARGET-MARKER"
    ]) {
      expect(durableProjection).not.toContain(marker);
    }
    expect(projected.events.filter((event) => event.payload.type === "tool_start").map((event) => event.payload)).toEqual([
      {
        type: "tool_start",
        callId: "vision-call",
        name: "vision",
        input: "[vision image path and focus withheld]"
      },
      {
        type: "tool_start",
        callId: "vision-locate-call",
        name: "vision-locate",
        input: "[vision image path and focus withheld]"
      }
    ]);
    expect(projected.events.filter((event) => event.payload.type === "tool_result").map((event) => event.payload)).toEqual([
      expect.objectContaining({ output: "A chart with three rising bars." }),
      expect.objectContaining({ output: "The submit button is near the lower-right corner." })
    ]);
    expect(durableProjection).toContain("vision image path and focus withheld");
  });

  it("rejects duplicate raw Pi entry identities before projection", () => {
    const duplicated = { id: "same", type: "custom_message", data: { content: "safe" } } as const;
    expect(() => projectPiNativeHistory(undefined, { entries: [duplicated, duplicated] }))
      .toThrow("duplicate entry ID 'same'");
  });

  it("preserves native Timeline text and tool input above the former 256 KiB preview boundary", () => {
    const longText = "m".repeat(256 * 1024 + 1);
    const longInput = "i".repeat(256 * 1024 + 1);
    const projected = projectPiNativeHistory(undefined, {
      entries: [
        {
          id: "large-user",
          type: "message",
          timestamp: 1,
          data: { message: { role: "user", content: [{ type: "text", text: longText }] } }
        },
        {
          id: "large-assistant",
          parentId: "large-user",
          type: "message",
          timestamp: 2,
          data: {
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "large-call", name: "read", arguments: { query: longInput } }]
            }
          }
        },
        {
          id: "large-tool-result",
          parentId: "large-assistant",
          type: "message",
          timestamp: 3,
          data: {
            message: {
              role: "toolResult",
              toolCallId: "large-call",
              toolName: "read",
              content: [{ type: "text", text: longText }],
              isError: false
            }
          }
        }
      ],
      leafId: "large-tool-result"
    });

    expect(projected.events.find((event) => event.nativeEntryId === "large-user")?.payload).toMatchObject({
      type: "message_complete",
      blocks: [{ kind: "text", text: longText }]
    });
    expect(projected.events.find((event) => event.projectionKind === "message_assistant_tool_call")?.payload).toMatchObject({
      type: "tool_start",
      input: JSON.stringify({ query: longInput })
    });
    expect(projected.events.find((event) => event.nativeEntryId === "large-tool-result")?.payload).toMatchObject({
      type: "tool_result",
      output: longText,
      parts: [{ kind: "text", text: longText }]
    });
  });
});
