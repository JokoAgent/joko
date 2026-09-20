import { describe, expect, it } from "vitest";
import {
  mobileComposerRichProtocolLimits,
  parseMobileComposerRichWebMessage
} from "./mobile-composer-rich-input-protocol";

function encode(value: unknown): string {
  return JSON.stringify(value);
}

describe("mobile composer rich input protocol", () => {
  it("accepts the exact versioned lifecycle and document messages", () => {
    expect(parseMobileComposerRichWebMessage(encode({ type: "ready", instanceId: "instance-1" }))).toEqual({
      type: "ready",
      instanceId: "instance-1"
    });
    expect(parseMobileComposerRichWebMessage(encode({
      type: "change",
      instanceId: "instance-1",
      documentId: 7,
      segments: [
        { type: "text", text: "hello " },
        { type: "occurrence", occurrenceKey: "mention:one" }
      ],
      start: 6,
      end: 6
    }))).toEqual({
      type: "change",
      instanceId: "instance-1",
      documentId: 7,
      segments: [
        { type: "text", text: "hello " },
        { type: "occurrence", occurrenceKey: "mention:one" }
      ],
      start: 6,
      end: 6
    });
    expect(parseMobileComposerRichWebMessage(encode({
      type: "paste",
      instanceId: "instance-1",
      documentId: 7,
      start: 0,
      end: 5,
      text: "plain"
    }))).toMatchObject({ type: "paste", text: "plain" });
  });

  it("rejects aliases, unknown fields, malformed ranges, and unbounded payloads", () => {
    expect(parseMobileComposerRichWebMessage(encode({ type: "ready", instanceId: "instance-1", version: 1 }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage(encode({
      type: "change",
      instanceId: "instance-1",
      documentId: 0,
      segments: [],
      start: 0,
      end: 0
    }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage(encode({
      type: "selection",
      instanceId: "instance-1",
      documentId: 1,
      start: 2,
      end: 1
    }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage(encode({
      type: "paste",
      instanceId: "instance-1",
      documentId: 1,
      start: 0,
      end: 0,
      text: "x".repeat(mobileComposerRichProtocolLimits.maximumPasteCharacters + 1)
    }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage("{" )).toBeUndefined();
  });

  it("rejects malformed or over-budget semantic segments", () => {
    const base = {
      type: "change",
      instanceId: "instance-1",
      documentId: 1,
      start: 0,
      end: 0
    };
    expect(parseMobileComposerRichWebMessage(encode({
      ...base,
      segments: [{ type: "occurrence", occurrenceKey: "mention:one", authority: "forged" }]
    }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage(encode({
      ...base,
      segments: [{ type: "text", text: "" }]
    }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage(encode({
      ...base,
      segments: [{ type: "text", text: "x".repeat(mobileComposerRichProtocolLimits.maximumDocumentCharacters + 1) }]
    }))).toBeUndefined();
  });

  it("keeps instance and occurrence identities free of control characters", () => {
    expect(parseMobileComposerRichWebMessage(encode({ type: "focus", instanceId: "bad\ninstance" }))).toBeUndefined();
    expect(parseMobileComposerRichWebMessage(encode({
      type: "activate",
      instanceId: "instance-1",
      documentId: 1,
      occurrenceKey: "atom:\u0000bad"
    }))).toBeUndefined();
  });
});
