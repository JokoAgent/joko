import { describe, expect, it } from "vitest";
import { MOBILE_SUPPORTED_LOCALES } from "./mobile-locale-preference";
import { mobileMessage, mobileMessagesTesting } from "./mobile-messages";

describe("mobile message catalogs", () => {
  it("has an exact key and variable set in every supported locale", () => {
    const english = mobileMessagesTesting.catalogs.en;
    const keys = Object.keys(english).sort();
    expect(keys.length).toBeGreaterThan(80);
    for (const locale of MOBILE_SUPPORTED_LOCALES) {
      const catalog = mobileMessagesTesting.catalogs[locale];
      expect(Object.keys(catalog).sort()).toEqual(keys);
      for (const key of keys) {
        expect(catalog[key as keyof typeof catalog].trim()).not.toBe("");
        expect(mobileMessagesTesting.placeholders(catalog[key as keyof typeof catalog]))
          .toEqual(mobileMessagesTesting.placeholders(english[key as keyof typeof english]));
      }
    }
  });

  it("interpolates only the exact variables declared by the selected message", () => {
    expect(mobileMessage("zh-CN", "settings.diagnostics.on", { count: 3 }))
      .toBe("已开启 · 保留 3 个事件");
    expect(() => mobileMessage("en", "settings.diagnostics.on")).toThrow("Invalid variables");
    expect(() => mobileMessage("en", "settings.title", { extra: "no" })).toThrow("Invalid variables");
    expect(mobileMessage("ja", "home.search")).toBe("タスクとメッセージを検索");
    expect(mobileMessage("ko", "devices.open", { name: "Phone" })).toBe("Phone 기기 열기");
  });

  it("keeps product branding Joko-owned", () => {
    for (const catalog of Object.values(mobileMessagesTesting.catalogs)) {
      expect(Object.values(catalog).join("\n")).not.toMatch(/cindy|xdt|maker/iu);
    }
  });
});
