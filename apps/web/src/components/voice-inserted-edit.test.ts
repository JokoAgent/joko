import { describe, expect, it } from "vitest";
import { createVoiceDraftFence } from "./voice-draft-fence.js";
import { createVoiceInsertedEditTracker, inspectVoiceInsertedEdit } from "./voice-inserted-edit.js";

describe("voice inserted edit inspection", () => {
  it("extracts a correction between stable composer anchors", () => {
    const tracker = createVoiceInsertedEditTracker({
      fence: createVoiceDraftFence({ sessionId: "task-one", revision: 1, text: "Use  today.", selection: { from: 4, to: 4 } }),
      insertedText: "voice kit",
      rawTranscriptText: "voice kid"
    });
    expect(inspectVoiceInsertedEdit(tracker, "Use VoiceKit today.")).toEqual({
      edited: true,
      beforeText: "voice kit",
      afterText: "VoiceKit",
      rawTranscriptText: "voice kid"
    });
  });

  it("ignores edits elsewhere while the inserted text remains", () => {
    const tracker = createVoiceInsertedEditTracker({
      fence: createVoiceDraftFence({ sessionId: "task-one", revision: 1, text: "Use  today.", selection: { from: 4, to: 4 } }),
      insertedText: "VoiceKit"
    });
    expect(inspectVoiceInsertedEdit(tracker, "Please use VoiceKit today."))
      .toEqual({ edited: false, reason: "insertedTextPresent" });
  });

  it("handles a composer containing only the inserted transcript", () => {
    const tracker = createVoiceInsertedEditTracker({
      fence: createVoiceDraftFence({ sessionId: "task-one", revision: 1, text: "" }),
      insertedText: "voice kit"
    });
    expect(inspectVoiceInsertedEdit(tracker, "VoiceKit")).toMatchObject({ edited: true, afterText: "VoiceKit" });
  });

  it("rejects broad replacement evidence", () => {
    const tracker = createVoiceInsertedEditTracker({
      fence: createVoiceDraftFence({ sessionId: "task-one", revision: 1, text: "" }),
      insertedText: "short text"
    });
    expect(inspectVoiceInsertedEdit(tracker, "x".repeat(100)))
      .toEqual({ edited: false, reason: "tooLong" });
  });
});
