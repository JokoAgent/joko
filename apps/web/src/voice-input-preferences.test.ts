import { describe, expect, it } from "vitest";
import {
  createVoiceInputShortcutFromMacNativeKeys,
  formatVoiceInputShortcut,
  matchesVoiceInputShortcut,
  defaultVoiceInputShortcut,
  parseVoiceDictionaryCsv,
  parseVoiceInputPreferences,
  readVoiceInputPreferences,
  releasesVoiceInputShortcut,
  voiceInputLocale,
  writeVoiceInputPreferences
} from "./voice-input-preferences.js";

describe("voice input preferences", () => {
  it("persists only bounded device, locale, and shortcut preferences", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); }
    };

    const shortcut = { code: "KeyM", meta: false, ctrl: false, alt: true, shift: true, fn: false } as const;
    const saved = writeVoiceInputPreferences({ locale: "zh-cn", deviceId: "device-a", shortcut }, storage);
    expect(saved).toEqual({
      locale: "zh-CN",
      deviceId: "device-a",
      shortcut,
      refinementInstructions: "",
      dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] },
      dictionaryTerms: [],
      autoDictionaryEnabled: true,
      playInteractionSound: true,
      fastActivationEnabled: false,
      muteOtherSounds: true
    });
    expect(readVoiceInputPreferences(storage)).toEqual(saved);
    expect([...values.values()][0]).not.toMatch(/audio|transcript|secret/iu);
  });

  it("rejects malformed or noncanonical stored values as a whole", () => {
    expect(parseVoiceInputPreferences({ locale: "not_a_locale", deviceId: "bad\0device", shortcut: "unexpected" }))
      .toEqual({ locale: "auto", shortcut: defaultVoiceInputShortcut(), refinementInstructions: "", dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] }, dictionaryTerms: [], autoDictionaryEnabled: true, playInteractionSound: true, fastActivationEnabled: false, muteOtherSounds: true });
    expect(parseVoiceInputPreferences({ locale: "en-us" }))
      .toEqual({ locale: "auto", shortcut: defaultVoiceInputShortcut(), refinementInstructions: "", dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] }, dictionaryTerms: [], autoDictionaryEnabled: true, playInteractionSound: true, fastActivationEnabled: false, muteOtherSounds: true });
    const current = writeVoiceInputPreferences({}, undefined);
    const { muteOtherSounds: _missingBoolean, ...incompletePreferences } = current;
    expect(parseVoiceInputPreferences(incompletePreferences)).toEqual(parseVoiceInputPreferences(undefined));
    if (current.shortcut !== "disabled") {
      const { fn: _missingFn, ...incompleteShortcut } = current.shortcut;
      expect(parseVoiceInputPreferences({ ...current, shortcut: incompleteShortcut }))
        .toEqual(parseVoiceInputPreferences(undefined));
    }
    expect(voiceInputLocale({ locale: "en-US" })).toBe("en-US");
    expect(voiceInputLocale(parseVoiceInputPreferences({ locale: "auto", shortcut: "unexpected" }))).toBeUndefined();
  });

  it("matches only the configured modified shortcut", () => {
    const ctrlShiftM = { code: "KeyM", meta: false, ctrl: true, alt: false, shift: true, fn: false } as const;
    const altShiftM = { code: "KeyM", meta: false, ctrl: false, alt: true, shift: true, fn: false } as const;
    expect(matchesVoiceInputShortcut({ code: "KeyM", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, ctrlShiftM, "Win32")).toBe(true);
    expect(matchesVoiceInputShortcut({ code: "KeyM", ctrlKey: false, metaKey: false, altKey: true, shiftKey: true }, altShiftM, "Win32")).toBe(true);
    expect(matchesVoiceInputShortcut({ code: "KeyM", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, ctrlShiftM, "Win32")).toBe(false);
  });

  it("keeps the exact supported spoken-language set and normalizes regional locale tags", () => {
    expect(writeVoiceInputPreferences({ locale: "en-US" }, undefined).locale).toBe("en");
    expect(writeVoiceInputPreferences({ locale: "ja-JP" }, undefined).locale).toBe("ja");
    expect(writeVoiceInputPreferences({ locale: "zh-TW" }, undefined).locale).toBe("zh-TW");
    expect(writeVoiceInputPreferences({ locale: "fr-FR" }, undefined).locale).toBe("auto");
  });

  it("ends a held shortcut when any member key is released", () => {
    const ctrlShiftM = { code: "KeyM", meta: false, ctrl: true, alt: false, shift: true, fn: false } as const;
    const altShiftM = { code: "KeyM", meta: false, ctrl: false, alt: true, shift: true, fn: false } as const;
    const commandM = { code: "KeyM", meta: true, ctrl: false, alt: false, shift: false, fn: false } as const;
    expect(releasesVoiceInputShortcut({ code: "KeyM" }, ctrlShiftM, "Win32")).toBe(true);
    expect(releasesVoiceInputShortcut({ code: "ShiftLeft" }, ctrlShiftM, "Win32")).toBe(true);
    expect(releasesVoiceInputShortcut({ code: "ControlRight" }, ctrlShiftM, "Win32")).toBe(true);
    expect(releasesVoiceInputShortcut({ code: "MetaRight" }, commandM, "MacIntel")).toBe(true);
    expect(releasesVoiceInputShortcut({ code: "AltLeft" }, altShiftM, "Win32")).toBe(true);
    expect(releasesVoiceInputShortcut({ code: "KeyA" }, ctrlShiftM, "Win32")).toBe(false);
    expect(releasesVoiceInputShortcut({ code: "KeyM" }, "disabled", "Win32")).toBe(false);
  });

  it("normalizes, formats, and matches macOS Fn combinations from bounded native snapshots", () => {
    const fnA = createVoiceInputShortcutFromMacNativeKeys(["Fn", "KeyA"]);
    const fnF12 = createVoiceInputShortcutFromMacNativeKeys(["Fn", "ControlRight", "F12"]);
    expect(fnA).toEqual({ code: "KeyA", meta: false, ctrl: false, alt: false, shift: false, fn: true });
    expect(fnF12).toEqual({ code: "F12", meta: false, ctrl: true, alt: false, shift: false, fn: true });
    expect(formatVoiceInputShortcut(fnA ?? "disabled", "MacIntel")).toBe("Fn+A");
    expect(writeVoiceInputPreferences({ shortcut: fnF12 }, undefined).shortcut).toEqual(fnF12);
    expect(matchesVoiceInputShortcut({ code: "KeyA", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, fnA ?? "disabled", "MacIntel")).toBe(false);
    expect(createVoiceInputShortcutFromMacNativeKeys(["Fn", "KeyA", "Other"])).toBeUndefined();
    expect(createVoiceInputShortcutFromMacNativeKeys(["Fn", "KeyA", "KeyB"])).toBeUndefined();
  });

  it("imports a strict single-column CSV dictionary and deduplicates terms", () => {
    expect(parseVoiceDictionaryCsv('Joko\n"OpenAI, Inc."\njoko\n')).toEqual({
      ok: true,
      terms: ["Joko", "OpenAI, Inc."],
      duplicateRows: 1,
      skippedTooLong: 0
    });
    expect(parseVoiceDictionaryCsv("one,two")).toEqual({ ok: false, reason: "invalid" });
    expect(parseVoiceDictionaryCsv('"unterminated')).toEqual({ ok: false, reason: "invalid" });
  });

  it("persists bounded refinement instructions and dictionary terms", () => {
    const saved = writeVoiceInputPreferences({
      refinementInstructions: "Keep shell commands verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator", "joko"],
      playInteractionSound: false
    }, undefined);
    expect(saved).toMatchObject({
      refinementInstructions: "Keep shell commands verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator"],
      playInteractionSound: false
    });
    expect(writeVoiceInputPreferences({ muteOtherSounds: false }, undefined).muteOtherSounds).toBe(false);
  });
});
