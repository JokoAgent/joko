import { describe, expect, it } from "vitest";

import {
  isDesktopGlobalVoiceGeneration,
  parseDesktopGlobalVoiceCommand,
  parseDesktopGlobalVoiceCommitRequest,
  parseDesktopGlobalVoiceStatus
} from "../src/channels.js";

describe("global voice generation protocol", () => {
  it("accepts only exact commands carrying a live canonical generation", () => {
    expect(parseDesktopGlobalVoiceCommand({ generation: "17", type: "start" })).toEqual({
      type: "start",
      generation: "17"
    });
    expect(parseDesktopGlobalVoiceCommand({ type: "retry", generation: "18" })).toEqual({
      type: "retry",
      generation: "18"
    });

    for (const value of [
      { type: "start" },
      { type: "start", generation: "0" },
      { type: "start", generation: "01" },
      { type: "start", generation: "1", extra: true },
      { type: "unknown", generation: "1" }
    ]) expect(() => parseDesktopGlobalVoiceCommand(value)).toThrow(TypeError);
  });

  it("reserves generation zero for the initial idle projection", () => {
    expect(parseDesktopGlobalVoiceStatus({ generation: "0", state: "idle" })).toEqual({
      state: "idle",
      generation: "0"
    });
    expect(parseDesktopGlobalVoiceStatus({
      transcript: "ready",
      state: "listening",
      generation: "23"
    })).toEqual({
      state: "listening",
      generation: "23",
      transcript: "ready"
    });
    expect(parseDesktopGlobalVoiceStatus({
      errorKind: "microphone",
      generation: "23",
      state: "error"
    })).toEqual({
      state: "error",
      generation: "23",
      errorKind: "microphone"
    });

    expect(() => parseDesktopGlobalVoiceStatus({ state: "starting", generation: "0" })).toThrow(TypeError);
    expect(() => parseDesktopGlobalVoiceStatus({
      state: "listening",
      generation: "23",
      transcript: "x",
      extra: true
    })).toThrow(TypeError);
    expect(() => parseDesktopGlobalVoiceStatus({
      state: "listening",
      generation: "23",
      transcript: "x".repeat(4_097)
    })).toThrow(TypeError);
  });

  it("accepts one bounded exact-generation commit and rejects legacy or ambiguous values", () => {
    expect(parseDesktopGlobalVoiceCommitRequest({ text: "hello", generation: "42" })).toEqual({
      generation: "42",
      text: "hello"
    });

    for (const value of [
      { text: "legacy" },
      { text: "", generation: "1" },
      { text: "hello", generation: "0" },
      { text: "hello", generation: "1", replay: true },
      { text: "hello\u0000", generation: "1" }
    ]) expect(() => parseDesktopGlobalVoiceCommitRequest(value)).toThrow(TypeError);
  });

  it("bounds generations to canonical safe decimal integers", () => {
    expect(isDesktopGlobalVoiceGeneration("1")).toBe(true);
    expect(isDesktopGlobalVoiceGeneration(String(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(isDesktopGlobalVoiceGeneration("0")).toBe(false);
    expect(isDesktopGlobalVoiceGeneration("0", true)).toBe(true);

    for (const value of [
      "",
      "00",
      "+1",
      "-1",
      "1.0",
      String(Number.MAX_SAFE_INTEGER + 1),
      "9".repeat(17),
      1
    ]) expect(isDesktopGlobalVoiceGeneration(value)).toBe(false);
  });
});
