import { describe, expect, it, vi } from "vitest";
import { MobileThemePreferenceStore, resolveMobileDarkTheme } from "./mobile-theme-preference";

function driver(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; })
  };
}

describe("MobileThemePreferenceStore", () => {
  it("hydrates only the strict current-v1 record and resolves system appearance", async () => {
    const storage = driver(JSON.stringify({ version: 1, theme: "dark" }));
    const store = new MobileThemePreferenceStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.hydrate();

    expect(store.snapshot).toEqual({ status: "ready", preference: "dark", saving: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(resolveMobileDarkTheme("dark", "light")).toBe(true);
    expect(resolveMobileDarkTheme("light", "dark")).toBe(false);
    expect(resolveMobileDarkTheme("system", "dark")).toBe(true);
    expect(resolveMobileDarkTheme("system", "light")).toBe(false);
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 0, theme: "dark" }),
    JSON.stringify({ version: 1, theme: "blue" }),
    JSON.stringify({ version: 1, theme: "dark", legacy: true })
  ])("fails closed to system for a non-current record: %s", async (raw) => {
    const store = new MobileThemePreferenceStore(driver(raw));

    await store.hydrate();

    expect(store.snapshot.status).toBe("error");
    expect(store.snapshot.preference).toBe("system");
    expect(store.snapshot.error).toContain("System appearance is being used");
  });

  it("uses system appearance with an explicit error when the saved preference is unreadable", async () => {
    const storage = driver();
    storage.getItem.mockRejectedValueOnce(new Error("storage locked"));
    const store = new MobileThemePreferenceStore(storage);

    await store.hydrate();

    expect(store.snapshot).toMatchObject({ status: "error", preference: "system", saving: false });
    expect(store.snapshot.error).toContain("storage locked");
  });

  it("publishes a new preference only after its current-v1 record is durable", async () => {
    let release!: () => void;
    const storage = driver();
    storage.setItem.mockImplementationOnce(async () => new Promise<void>((resolve) => { release = resolve; }));
    const store = new MobileThemePreferenceStore(storage);
    await store.hydrate();

    const saving = store.setPreference("dark");
    expect(store.snapshot).toEqual({ status: "ready", preference: "system", saving: true });
    await expect(store.setPreference("light")).rejects.toThrow("already being saved");
    release();
    await saving;

    expect(storage.setItem).toHaveBeenCalledWith(
      "joko.mobile.theme.v1",
      JSON.stringify({ version: 1, theme: "dark" })
    );
    expect(store.snapshot).toEqual({ status: "ready", preference: "dark", saving: false });
  });

  it("retains the previously applied preference when persistence fails", async () => {
    const storage = driver(JSON.stringify({ version: 1, theme: "light" }));
    const store = new MobileThemePreferenceStore(storage);
    await store.hydrate();
    storage.setItem.mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(store.setPreference("dark")).rejects.toThrow("disk unavailable");

    expect(store.snapshot.preference).toBe("light");
    expect(store.snapshot.saving).toBe(false);
    expect(store.snapshot.error).toContain("could not be saved");
  });
});
