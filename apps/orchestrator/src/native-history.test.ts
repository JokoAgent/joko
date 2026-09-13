import { createHash } from "node:crypto";

import type { BlobRef, NativeHistoryProjection } from "@joko/core";
import { describe, expect, it } from "vitest";

import { projectNativeHistory } from "./native-history.js";

describe("backend-neutral native history projection", () => {
  it("preserves stable IDs and visible payloads for a reconnect-equivalent projection", () => {
    const image: BlobRef = {
      id: "image-artifact",
      sha256: "a".repeat(64),
      byteLength: 24,
      mimeType: "image/png",
      fileName: "pi-image.png"
    };
    const history: NativeHistoryProjection = {
      events: [
        {
          nativeEntryId: "assistant-image",
          projectionKind: "message_assistant",
          contentIndex: 0,
          emittedAt: 1_000,
          payload: {
            type: "message_complete",
            role: "assistant",
            blocks: [{ kind: "image", blob: image, alt: "preview" }]
          },
          metadata: {
            namespace: "pi.native_history",
            fields: {
              nativeHydration: true,
              entryId: "assistant-image",
              nativeEntryType: "message"
            },
            pi: {
              entryId: "assistant-image",
              rpcEventType: "message_end",
              contentIndex: 0,
              payload: {
                case: "messageLifecycle",
                value: {
                  kind: "message_end",
                  nativeMessageId: "assistant-image",
                  nativeEntryId: "assistant-image",
                  parentEntryId: "",
                  role: "assistant",
                  contentIndex: 0
                }
              }
            }
          }
        },
        {
          nativeEntryId: "tool-image",
          nativeParentEntryId: "assistant-image",
          projectionKind: "tool_result",
          contentIndex: 0,
          emittedAt: 2_000,
          payload: {
            type: "tool_result",
            callId: "read-image",
            name: "read",
            output: "Image Size: 16x16.",
            parts: [
              { kind: "text", text: "Image Size: 16x16." },
              { kind: "image", blob: image, alt: "tool preview" }
            ],
            isError: false
          },
          metadata: {
            namespace: "pi.native_history",
            fields: {
              nativeHydration: true,
              entryId: "tool-image",
              nativeEntryType: "message",
              parentEntryId: "assistant-image"
            },
            pi: {
              entryId: "tool-image",
              parentEntryId: "assistant-image",
              rpcEventType: "message_end",
              contentIndex: 0,
              payload: {
                case: "messageLifecycle",
                value: {
                  kind: "message_end",
                  nativeMessageId: "tool-image",
                  nativeEntryId: "tool-image",
                  parentEntryId: "assistant-image",
                  role: "toolResult",
                  contentIndex: 0
                }
              }
            }
          }
        }
      ],
      activeEntryId: "tool-image"
    };

    const first = projectNativeHistory("session-1", "opaque:pi:session-1", history);
    const reconnected = projectNativeHistory("session-1", "opaque:pi:session-1", history);

    expect(first).toEqual(reconnected);
    expect(first.map((event) => event.id)).toEqual([
      "native-event-237534756cda294a1af0197ca4eea84bf8d3e7a445ad247045a95e448d956403",
      "native-event-9e23a195e8a7d9cb7c3b874aef9f9d1c46d5558e18bf8e0ed404822aef23579f"
    ]);
    expect(createHash("sha256").update(JSON.stringify(first)).digest("hex"))
      .toBe("7e7bd47ab44765015956a11f8d7ef08ee4d19b706f3ba21254645990ab15294f");
    expect(first[0]?.payload).toEqual({
      ...history.events[0]!.payload,
      nativeHistory: { identity: { entryId: "assistant-image" } }
    });
    expect(first[1]?.payload).toEqual({
      ...history.events[1]!.payload,
      nativeHistory: { identity: { entryId: "tool-image", parentEntryId: "assistant-image" } }
    });
    expect(first[0]?.metadata?.fields).toMatchObject({
      nativeBindingFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(JSON.stringify(first)).not.toContain("opaque:pi:session-1");
    const privatePathReference = "D:\\private\\pi-sessions\\session-1.jsonl";
    expect(JSON.stringify(projectNativeHistory("session-1", privatePathReference, history)))
      .not.toContain(privatePathReference);
  });

  it("allows multiple bounded projections per entry and rejects duplicate projection identities", () => {
    const history: NativeHistoryProjection = {
      events: [
        {
          nativeEntryId: "entry-1",
          projectionKind: "message",
          contentIndex: 0,
          payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "one" }] }
        },
        {
          nativeEntryId: "entry-1",
          projectionKind: "message",
          contentIndex: 1,
          payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "two" }] }
        }
      ]
    };
    expect(projectNativeHistory("session-1", "native-ref", history)).toHaveLength(2);
    expect(() => projectNativeHistory("session-1", "native-ref", {
      events: [history.events[0]!, history.events[0]!]
    })).toThrow("duplicate projection identity");
    expect(() => projectNativeHistory("session-1", "native-ref", {
      events: [{ ...history.events[0]!, nativeParentEntryId: "invalid\0parent" }]
    })).toThrow("invalid parent entry identity");
    expect(() => projectNativeHistory("session-1", "native-ref", {
      events: [{ ...history.events[0]!, nativeParentEntryId: "p".repeat(4_097) }]
    })).toThrow("invalid parent entry identity");
  });
});
