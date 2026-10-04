import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_LOCALE,
  readHostSystemLocale,
  resolveLocalePreference,
  resolvePreferredSystemLocale,
  resolveSystemLocale
} from "./system-locale.js";

describe("system locale resolution", () => {
  it("normalizes BCP-47 casing and underscores", () => {
    expect(resolveSystemLocale("EN_us")).toBe("en");
    expect(resolveSystemLocale(" ZH_hAnS_hK ")).toBe("zh-CN");
    expect(resolveSystemLocale("zh_HANT_tw.UTF-8")).toBe("zh-CN");
  });

  it("routes every Chinese script and region variant to the current Chinese catalog", () => {
    for (const tag of [
      "zh",
      "zh-CN",
      "zh-SG",
      "zh-TW",
      "zh-HK",
      "zh-MO",
      "zh-Hans",
      "zh-Hant",
      "zh-Hans-HK",
      "zh-Hant-CN"
    ]) {
      expect(resolveSystemLocale(tag), tag).toBe("zh-CN");
    }
  });

  it("uses the first currently supported language in preference order", () => {
    expect(resolvePreferredSystemLocale(["fr-FR", "ja-JP", "ko-KR", "zh-Hant-TW", "en-US"]))
      .toBe("zh-CN");
    expect(resolvePreferredSystemLocale(["ja-JP", "ko-KR", "en_GB", "zh-CN"]))
      .toBe("en");
    expect(resolvePreferredSystemLocale(["en-US", "zh-CN"]))
      .toBe("en");
  });

  it("falls back only after unsupported and malformed entries are exhausted", () => {
    expect(resolvePreferredSystemLocale(["ja-JP", "ko-KR", "fr-FR"]))
      .toBe(DEFAULT_SYSTEM_LOCALE);
    expect(resolvePreferredSystemLocale(["", "  ", "zh--CN"]))
      .toBe(DEFAULT_SYSTEM_LOCALE);
    expect(resolvePreferredSystemLocale([])).toBe(DEFAULT_SYSTEM_LOCALE);
  });

  it("never resolves the pseudo locale from a system preference", () => {
    expect(resolveSystemLocale("en-XA")).toBe("en");
    expect(resolvePreferredSystemLocale(["en-XA", "zh-CN"]))
      .toBe("en");
  });

  it("resolves only system preferences through the host locale", () => {
    expect(resolveLocalePreference("system", "zh-CN")).toBe("zh-CN");
    expect(resolveLocalePreference("en", "zh-CN")).toBe("en");
    expect(resolveLocalePreference("en-XA", "zh-CN")).toBe("en-XA");
  });

  it("prefers the Desktop locale and otherwise reads browser language priority", () => {
    expect(readHostSystemLocale({
      jokoDesktop: { preferredSystemLocale: "zh-CN" },
      navigator: { languages: ["en-US"], language: "en-US" }
    })).toBe("zh-CN");

    expect(readHostSystemLocale({
      navigator: { languages: ["ja-JP", "zh-Hant-TW", "en-US"], language: "en-US" }
    })).toBe("zh-CN");

    expect(readHostSystemLocale({
      navigator: { languages: [], language: "zh_Hans_CN" }
    })).toBe("zh-CN");
  });

  it("rejects a pseudo or malformed Desktop system locale", () => {
    expect(readHostSystemLocale({
      jokoDesktop: { preferredSystemLocale: "en-XA" },
      navigator: { languages: ["en-US"] }
    })).toBe("en");
    expect(readHostSystemLocale({ jokoDesktop: { preferredSystemLocale: "unknown" } }))
      .toBe(DEFAULT_SYSTEM_LOCALE);
  });
});
