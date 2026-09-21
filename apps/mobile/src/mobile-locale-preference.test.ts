import { describe, expect, it, vi } from "vitest";
import {
  MobileLocalePreferenceStore,
  mobileLocalePreferenceTesting,
  resolveMobileSystemLocale
} from "./mobile-locale-preference";

function driver(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; })
  };
}

describe("mobile locale resolution", () => {
  it.each([
    ["zh-Hans-CN", "zh-CN"],
    ["zh_CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-TW", "zh-TW"],
    ["ja-JP", "ja"],
    ["ko-KR", "ko"],
    ["fr-FR", "en"],
    [undefined, "en"]
  ])("maps %s to %s", (tag, expected) => {
    expect(resolveMobileSystemLocale(tag)).toBe(expected);
  });
});

describe("MobileLocalePreferenceStore", () => {
  it("exposes the detected locale while product surfaces wait for strict hydration", () => {
    const store = new MobileLocalePreferenceStore(driver(), () => "zh-Hant-MO");
    expect(store.snapshot).toEqual({
      status: "loading",
      preference: "system",
      effectiveLocale: "zh-TW",
      saving: false
    });
  });

  it("hydrates a strict explicit preference and ignores later system changes", async () => {
    let system = "en-US";
    const store = new MobileLocalePreferenceStore(
      driver(JSON.stringify({ version: 1, locale: "ja" })),
      () => system
    );
    await store.hydrate();
    system = "zh-Hant-TW";
    store.refreshSystemLocale();

    expect(store.snapshot).toEqual({ status: "ready", preference: "ja", effectiveLocale: "ja", saving: false });
  });

  it("refreshes only a system preference when the phone locale changes", async () => {
    let system = "en-US";
    const store = new MobileLocalePreferenceStore(driver(), () => system);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.hydrate();
    system = "zh-Hant-HK";
    store.refreshSystemLocale();

    expect(store.snapshot).toEqual({
      status: "ready",
      preference: "system",
      effectiveLocale: "zh-TW",
      saving: false
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 0, locale: "ja" }),
    JSON.stringify({ version: 1, locale: "fr" }),
    JSON.stringify({ version: 1, locale: "ja", legacy: true })
  ])("fails closed to the current system locale for an invalid record: %s", async (raw) => {
    const store = new MobileLocalePreferenceStore(driver(raw), () => "ko-KR");
    await store.hydrate();

    expect(store.snapshot).toMatchObject({ status: "error", preference: "system", effectiveLocale: "ko" });
    expect(store.snapshot.error).toContain("phone's language is being used");
  });

  it("publishes a new language only after its strict record is durable", async () => {
    let release!: () => void;
    const saved = driver();
    saved.setItem.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const store = new MobileLocalePreferenceStore(saved, () => "en-US");
    await store.hydrate();

    const saving = store.setPreference("zh-CN");
    expect(store.snapshot).toEqual({ status: "ready", preference: "system", effectiveLocale: "en", saving: true });
    release();
    await saving;

    expect(saved.setItem).toHaveBeenCalledWith(
      "joko.mobile.locale.v1",
      JSON.stringify({ version: 1, locale: "zh-CN" })
    );
    expect(store.snapshot).toEqual({ status: "ready", preference: "zh-CN", effectiveLocale: "zh-CN", saving: false });
  });

  it("persists an explicit return to the system language", async () => {
    const saved = driver(JSON.stringify({ version: 1, locale: "ja" }));
    const store = new MobileLocalePreferenceStore(saved, () => "ko-KR");
    await store.hydrate();
    await store.setPreference("system");

    expect(saved.setItem).toHaveBeenCalledWith(
      "joko.mobile.locale.v1",
      JSON.stringify({ version: 1, locale: "system" })
    );
    expect(store.snapshot).toEqual({
      status: "ready",
      preference: "system",
      effectiveLocale: "ko",
      saving: false
    });
  });

  it("retains the applied locale when a preference write fails", async () => {
    const saved = driver(JSON.stringify({ version: 1, locale: "ko" }));
    const store = new MobileLocalePreferenceStore(saved, () => "en-US");
    await store.hydrate();
    saved.setItem.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(store.setPreference("ja")).rejects.toThrow("disk unavailable");

    expect(store.snapshot.preference).toBe("ko");
    expect(store.snapshot.effectiveLocale).toBe("ko");
    expect(store.snapshot.error).toContain("could not be saved");
  });

  it("uses a Joko-owned current-v1 key", () => {
    expect(mobileLocalePreferenceTesting.storageKey).toBe("joko.mobile.locale.v1");
  });
});
