import { describe, expect, it } from "vitest";
import type { VoiceInputSessionView } from "./model.js";
import {
  deleteVoiceInputHistoryEntry,
  readVoiceInputUsage,
  recordVoiceInputSession,
  resetVoiceInputUsage
} from "./voice-input-history.js";

describe("voice input usage", () => {
  it("records each terminal session once and keeps local transcript history removable", () => {
    const storage = memoryStorage();
    const success = session({ id: "voice-one", outcome: "success", result: { text: "spoken words", source: "stable", salvaged: false } });
    recordVoiceInputSession(success, storage);
    recordVoiceInputSession(success, storage);
    recordVoiceInputSession(session({ id: "voice-two", outcome: "noSpeech" }), storage);
    recordVoiceInputSession(session({ id: "voice-three", outcome: "failed" }), storage);

    expect(readVoiceInputUsage(storage)).toMatchObject({
      entries: [{ id: "voice-one", text: "spoken words" }],
      totalAudioMs: 750,
      sessionCount: 3,
      noSpeechSessionCount: 1,
      failedSessionCount: 1
    });
    expect(deleteVoiceInputHistoryEntry("voice-one", storage).entries).toEqual([]);
    expect(resetVoiceInputUsage(storage)).toEqual({
      entries: [], totalAudioMs: 0, sessionCount: 0, noSpeechSessionCount: 0, failedSessionCount: 0
    });
  });
});

function session(patch: Partial<VoiceInputSessionView>): VoiceInputSessionView {
  return {
    id: "voice-default",
    state: "done",
    nextChunkSequence: 2n,
    acceptedAudioBytes: 3,
    acceptedAudioDurationMs: 250,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_250,
    recoveryAttempts: 0,
    stallWarning: false,
    ...patch
  };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); }
  };
}
