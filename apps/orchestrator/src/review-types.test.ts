import { describe, expect, it } from "vitest";

import {
  MAX_REVIEW_ATTACHMENTS,
  MAX_REVIEW_FOCUS_CHARACTERS,
  readReviewFailureCode,
  readReviewRunState,
  readReviewTargetKind,
  readStartReviewRequest
} from "./review-types.js";

const blob = {
  id: "blob-one",
  sha256: "A".repeat(64),
  byteLength: 12,
  mimeType: "Text/Plain",
  fileName: "report.txt"
};

describe("review request types", () => {
  it("strictly normalizes a bounded BlobRef-only request", () => {
    expect(readStartReviewRequest({
      sourceSessionId: "  session-one  ",
      focus: "  第一行\r\n第二行  ",
      attachments: [{ kind: "file", displayName: "  résumé.txt ", blob }]
    })).toEqual({
      sourceSessionId: "session-one",
      focus: "第一行\n第二行",
      attachments: [{
        kind: "file",
        displayName: "résumé.txt",
        blob: { ...blob, sha256: "a".repeat(64), mimeType: "text/plain" }
      }]
    });
  });

  it("rejects focus and attachment count above the public limits", () => {
    expect(() => readStartReviewRequest({
      sourceSessionId: "session-one",
      focus: "界".repeat(MAX_REVIEW_FOCUS_CHARACTERS + 1),
      attachments: []
    })).toThrow(/4000/u);
    expect(() => readStartReviewRequest({
      sourceSessionId: "session-one",
      attachments: Array.from({ length: MAX_REVIEW_ATTACHMENTS + 1 }, () => ({ kind: "file", displayName: "a.txt", blob }))
    })).toThrow(/20/u);
  });

  it("counts Unicode code points without accepting a split-surrogate overflow", () => {
    const focus = "😀".repeat(MAX_REVIEW_FOCUS_CHARACTERS);
    expect(readStartReviewRequest({ sourceSessionId: "session", focus, attachments: [] }).focus).toBe(focus);
    expect(() => readStartReviewRequest({ sourceSessionId: "session", focus: `${focus}😀`, attachments: [] })).toThrow(/4000/u);
  });

  it.each(["base64", "path", "ticket", "secret", "metadata"])("rejects unsupported secret-bearing field %s", (field) => {
    expect(() => readStartReviewRequest({ sourceSessionId: "session", attachments: [], [field]: "do-not-store" })).toThrow(/unsupported field/u);
    expect(() => readStartReviewRequest({
      sourceSessionId: "session",
      attachments: [{ kind: "file", displayName: "a.txt", blob: { ...blob, [field]: "do-not-store" } }]
    })).toThrow(/unsupported field/u);
  });

  it("rejects malformed hashes, paths, duplicate blobs, and non-plain objects", () => {
    expect(() => readStartReviewRequest({ sourceSessionId: "session", attachments: [{ kind: "file", displayName: "../a.txt", blob }] })).toThrow(/file name/u);
    expect(() => readStartReviewRequest({ sourceSessionId: "session", attachments: [{ kind: "file", displayName: "a.txt", blob: { ...blob, sha256: "abc" } }] })).toThrow(/sha256/u);
    expect(() => readStartReviewRequest({ sourceSessionId: "session", attachments: [
      { kind: "file", displayName: "a.txt", blob },
      { kind: "file", displayName: "b.txt", blob }
    ] })).toThrow(/repeat/u);
    expect(() => readStartReviewRequest(new Date())).toThrow(/plain object/u);
  });

  it("recognizes only stable review enums", () => {
    expect(readReviewFailureCode("interrupted")).toBe("interrupted");
    expect(readReviewFailureCode("other")).toBeUndefined();
    expect(readReviewTargetKind("mixed")).toBe("mixed");
    expect(readReviewTargetKind("code")).toBeUndefined();
    expect(readReviewRunState("completed")).toBe("completed");
    expect(readReviewRunState("queued")).toBeUndefined();
  });
});
