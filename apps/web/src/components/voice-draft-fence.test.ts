import { describe, expect, it } from "vitest";
import { plainTextToComposerDocument } from "../composer-quote-document.js";
import { applyVoiceDraftResult, createVoiceDraftFence } from "./voice-draft-fence.js";

describe("voice draft fence", () => {
  it("replaces only the selection captured at microphone start", () => {
    const text = "hello brave world";
    const fence = createVoiceDraftFence({ sessionId: "task-one", revision: 4, text, selection: { from: 6, to: 11 } });
    const result = applyVoiceDraftResult({
      fence,
      sessionId: "task-one",
      revision: 4,
      document: plainTextToComposerDocument(text),
      text,
      transcript: "kind"
    });

    expect(result).toMatchObject({ applied: true, text: "hello kind world", caret: 10 });
  });

  it("rejects a late result after any newer draft revision", () => {
    const text = "existing";
    const fence = createVoiceDraftFence({ sessionId: "task-one", revision: 8, text });

    expect(applyVoiceDraftResult({
      fence,
      sessionId: "task-one",
      revision: 9,
      document: plainTextToComposerDocument("existing plus user edit"),
      text: "existing plus user edit",
      transcript: "late result"
    })).toEqual({ applied: false, reason: "staleRevision" });
  });

  it("rejects results from another task and empty transcripts", () => {
    const text = "draft";
    const fence = createVoiceDraftFence({ sessionId: "task-one", revision: 1, text });
    const document = plainTextToComposerDocument(text);

    expect(applyVoiceDraftResult({ fence, sessionId: "task-two", revision: 1, document, text, transcript: "replacement" }))
      .toEqual({ applied: false, reason: "staleSession" });
    expect(applyVoiceDraftResult({ fence, sessionId: "task-one", revision: 1, document, text, transcript: "  " }))
      .toEqual({ applied: false, reason: "empty" });
  });
});
