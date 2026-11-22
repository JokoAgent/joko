import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrollMobileSpeaker, mobileSpeakerGate, readMobileSpeakerSettings, removeMobileSpeakerProfile, writeMobileSpeakerSettings } from "./mobile-speaker-filter";

const mocks = vi.hoisted(() => ({
  values: new Map<string, string>(), supported: vi.fn(() => true),
  prepare: vi.fn<() => Promise<void>>(), enroll: vi.fn()
}));
vi.mock("../storage", () => ({ mobileSecureStorage: {
  getItem: async (key: string) => mocks.values.get(key) ?? null,
  setItem: async (key: string, value: string) => { mocks.values.set(key, value); },
  removeItem: async (key: string) => { mocks.values.delete(key); }
} }));
vi.mock("../mobile-realtime-audio", () => ({ mobileVoiceCaptureRuntime: {} }));
vi.mock("./models", () => ({ prepareMobileSpeakerModels: mocks.prepare }));
vi.mock("./native", async () => ({
  ...(await vi.importActual<typeof import("./native")>("./native")),
  isSpeakerOnnxAvailable: mocks.supported
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("./onnx-engine", () => ({
  createOnnxSpeakerEnrollmentEngine: () => ({}), createOnnxSpeakerGateEngine: () => ({})
}));
vi.mock("@joko/voice-speaker", async importOriginal => ({
  ...(await importOriginal<typeof import("@joko/voice-speaker")>()), buildSpeakerEnrollment: mocks.enroll
}));

const clips = [new Float32Array(1), new Float32Array(1), new Float32Array(1)];

describe("mobile voiceprints", () => {
  beforeEach(() => {
    mocks.values.clear();
    mocks.supported.mockReturnValue(true);
    mocks.prepare.mockReset().mockResolvedValue(undefined);
    mocks.enroll.mockReset().mockImplementation(async () => ({ ok: true, embedding: new Float32Array(192).fill(0.1) }));
  });

  it("preserves the old profile on failure or cancel and replaces only the matching identity", async () => {
    const { signal } = new AbortController();
    await enrollMobileSpeaker("other", clips, signal);
    await enrollMobileSpeaker("owner", clips, signal);
    await writeMobileSpeakerSettings("owner", { enabled: true, strictness: "strict" }, signal);
    const before = [...mocks.values.values()];
    mocks.enroll.mockResolvedValueOnce({ ok: false, reason: "inconsistent" });
    await expect(enrollMobileSpeaker("owner", clips, signal)).resolves.toMatchObject({ ok: false });
    const pending = new AbortController();
    mocks.enroll.mockImplementationOnce(async () => {
      pending.abort();
      return { ok: true, embedding: new Float32Array(192).fill(0.2) };
    });
    await expect(enrollMobileSpeaker("owner", clips, pending.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect([...mocks.values.values()]).toEqual(before);

    mocks.enroll.mockResolvedValueOnce({ ok: true, embedding: new Float32Array(192).fill(0.3) });
    await expect(enrollMobileSpeaker("owner", clips, signal)).resolves.toEqual({ ok: true });
    expect([...mocks.values.values()][0]).toBe(before[0]);
    expect([...mocks.values.values()][1]).not.toBe(before[1]);
    await expect(readMobileSpeakerSettings("owner")).resolves.toMatchObject({ enrolled: true, enabled: true, strictnessOverride: "strict" });
    await expect(removeMobileSpeakerProfile("owner", pending.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(readMobileSpeakerSettings("owner")).resolves.toMatchObject({ enrolled: true });
    await removeMobileSpeakerProfile("owner", signal);
    await expect(readMobileSpeakerSettings("owner")).resolves.toMatchObject({ enrolled: false });
    await expect(readMobileSpeakerSettings("other")).resolves.toMatchObject({ enrolled: true });
  });

  it("reports an unavailable enabled filter and distinguishes a default from an explicit standard setting", async () => {
    const { signal } = new AbortController(), notice = vi.fn();
    await enrollMobileSpeaker("owner", clips, signal);
    await writeMobileSpeakerSettings("owner", { enabled: true, strictness: "strict" }, signal);
    mocks.supported.mockReturnValue(false);
    await expect(mobileSpeakerGate("other", notice, signal)).resolves.toBeUndefined();
    expect(notice).not.toHaveBeenCalled();
    await expect(mobileSpeakerGate("owner", notice, signal)).resolves.toBeUndefined();
    expect(notice).toHaveBeenCalledExactlyOnceWith("unavailable");
    mocks.supported.mockReturnValue(true);
    mocks.prepare.mockRejectedValueOnce(new Error("models missing"));
    await expect(mobileSpeakerGate("owner", notice, signal)).resolves.toBeUndefined();
    expect(notice).toHaveBeenCalledTimes(2);
    await writeMobileSpeakerSettings("owner", { enabled: false }, signal);
    await writeMobileSpeakerSettings("owner", { strictness: "standard" }, signal);
    await expect(readMobileSpeakerSettings("owner")).resolves.toMatchObject({ enabled: false, strictnessOverride: "standard" });
    await writeMobileSpeakerSettings("owner", { strictness: null }, signal);
    expect(JSON.parse([...mocks.values.values()][0]!)).not.toHaveProperty("strictness");
    await expect(readMobileSpeakerSettings("owner")).resolves.toMatchObject({ enrolled: true, enabled: false, strictness: "standard", strictnessOverride: undefined });
    await writeMobileSpeakerSettings("owner", { enabled: true }, signal);
    await expect(mobileSpeakerGate("owner", notice, signal)).resolves.toBeDefined();
    expect(notice).toHaveBeenCalledTimes(2);
  });
});
