import { describe, expect, it, vi } from "vitest";
import {
  readDesktopPreferredSystemLocale,
  resolveDesktopPreferredSystemLocale
} from "./system-locale.js";

describe("Desktop preferred system locale", () => {
  it("uses the first supported language from the ordered OS preference list", () => {
    expect(resolveDesktopPreferredSystemLocale(["fr-FR", "zh-Hant-CN", "en-US"])).toBe("zh-CN");
    expect(resolveDesktopPreferredSystemLocale(["invalid locale", "en-GB", "zh-CN"])).toBe("en");
  });

  it("normalizes BCP-47 variants while keeping pseudo and unsupported locales out of the projection", () => {
    expect(resolveDesktopPreferredSystemLocale(["zh_Hans_TW.UTF-8"])).toBe("zh-CN");
    expect(resolveDesktopPreferredSystemLocale(["zh-Hant-CN"])).toBe("zh-CN");
    expect(resolveDesktopPreferredSystemLocale(["zh-HK"])).toBe("zh-CN");
    expect(resolveDesktopPreferredSystemLocale(["en-XA"])).toBe("en");
    expect(resolveDesktopPreferredSystemLocale(["ja-JP", "ko-KR"])).toBe("en");
  });

  it("falls back to app.getLocale only when the ordered preference list is empty", () => {
    const preferred = vi.fn(() => ["fr-FR", "zh-TW"]);
    const fallback = vi.fn(() => "en-US");
    expect(readDesktopPreferredSystemLocale({
      getPreferredSystemLanguages: preferred,
      getLocale: fallback
    })).toBe("zh-CN");
    expect(fallback).not.toHaveBeenCalled();

    preferred.mockReturnValue([]);
    fallback.mockReturnValue("zh_CN.UTF-8");
    expect(readDesktopPreferredSystemLocale({
      getPreferredSystemLanguages: preferred,
      getLocale: fallback
    })).toBe("zh-CN");
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("fails closed to English when Electron locale reads throw or contain no supported language", () => {
    expect(readDesktopPreferredSystemLocale({
      getPreferredSystemLanguages: () => { throw new Error("not ready"); },
      getLocale: () => { throw new Error("not ready"); }
    })).toBe("en");
    expect(resolveDesktopPreferredSystemLocale([null, "", "ja-JP"])).toBe("en");
  });
});
