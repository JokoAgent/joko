import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MOBILE_FILES_PREFERENCES } from "./mobile-files-presentation";
import { MobileFilesPreferenceStore } from "./mobile-files-preferences";

const scope = { profileId: "profile", serverId: "node", workspaceId: "workspace" };
describe("Workspace Files display preferences", () => {
  it("hydrates other explicit overrides without overwriting a newer choice and isolates profiles, nodes and Workspaces", async () => {
    let finish!: (raw: string) => void; const storage = { getItem: vi.fn(() => new Promise<string>((resolve) => { finish = resolve; })), setItem: vi.fn(async (_key: string, _value: string) => undefined) };
    const store = new MobileFilesPreferenceStore(storage); const loading = store.hydrate();
    const changed = store.set(scope, { view: "list", sort: "size" }); expect(store.get(scope)).toEqual({ view: "list", sort: "size" });
    finish(JSON.stringify({ version: 1, overrides: [{ scope, preferences: { view: "grid", sort: "name" } },
      { scope: { ...scope, workspaceId: "other" }, preferences: { view: "list", sort: "mtime" } }] }));
    await loading; await changed;
    expect(store.get(scope)).toEqual({ view: "list", sort: "size" });
    expect(store.get({ ...scope, workspaceId: "other" })).toEqual({ view: "list", sort: "mtime" });
    expect(store.get({ ...scope, serverId: "other" })).toEqual(DEFAULT_MOBILE_FILES_PREFERENCES);
    expect(store.get({ ...scope, profileId: "other" })).toEqual(DEFAULT_MOBILE_FILES_PREFERENCES);
    expect(storage.getItem).toHaveBeenCalledOnce(); expect(JSON.parse(storage.setItem.mock.calls[0]![1]!)).toMatchObject({ version: 1, overrides: expect.any(Array) });
  });
  it("serializes writes, retains only 32 explicit overrides and reads only the strict current manifest", async () => {
    let saved: string | null = null; let finish!: () => void;
    const storage = { getItem: vi.fn(async () => saved), setItem: vi.fn(async (_key: string, value: string) => { saved = value; }) };
    const store = new MobileFilesPreferenceStore(storage); await store.hydrate();
    storage.setItem.mockImplementationOnce((_key, value) => new Promise((resolve) => { finish = () => { saved = value; resolve(); }; }));
    const first = store.set(scope, { view: "list", sort: "name" }); await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledOnce());
    const second = store.set(scope, { view: "grid", sort: "mtime" }); expect(storage.setItem).toHaveBeenCalledOnce(); finish(); await Promise.all([first, second]);
    expect(JSON.parse(saved!).overrides[0].preferences).toEqual({ view: "grid", sort: "mtime" });
    for (let index = 0; index < 34; index++) await store.set({ ...scope, workspaceId: `workspace-${index}` }, { view: "list", sort: "size" });
    expect(JSON.parse(saved!).overrides).toHaveLength(32); expect(store.get(scope)).toEqual(DEFAULT_MOBILE_FILES_PREFERENCES);
    const restored = new MobileFilesPreferenceStore(storage); await restored.hydrate(); expect(restored.get({ ...scope, workspaceId: "workspace-33" })).toEqual({ view: "list", sort: "size" });
    for (const invalid of [{ version: 0, overrides: [] }, { version: 1, overrides: [], extra: true }, { version: 1, overrides: [{ scope, preferences: { view: "tiles", sort: "name" } }] }]) {
      saved = JSON.stringify(invalid); const corrupt = new MobileFilesPreferenceStore(storage); await corrupt.hydrate(); expect(corrupt.get(scope)).toEqual(DEFAULT_MOBILE_FILES_PREFERENCES);
    }
  });
  it("preserves in-memory choices and existing stored owners across a transient read or write failure", async () => {
    const other = { ...scope, workspaceId: "other" };
    const storage = { getItem: vi.fn(async () => JSON.stringify({ version: 1, overrides: [{ scope: other, preferences: { view: "list", sort: "mtime" } }] })), setItem: vi.fn(async (_key: string, _value: string) => undefined) };
    storage.getItem.mockRejectedValueOnce(new Error("Storage unavailable")); const store = new MobileFilesPreferenceStore(storage);
    await expect(store.set(scope, { view: "list", sort: "size" })).rejects.toThrow("Storage unavailable"); expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.get(scope)).toEqual({ view: "list", sort: "size" });
    storage.setItem.mockRejectedValueOnce(new Error("Write unavailable")); await expect(store.set(scope, { view: "grid", sort: "size" })).rejects.toThrow("Write unavailable");
    await store.set(scope, { view: "list", sort: "name" }); expect(store.get(other)).toEqual({ view: "list", sort: "mtime" });
    const saved = JSON.parse(storage.setItem.mock.calls.at(-1)![1]!); expect(saved.overrides).toHaveLength(2);
  });
});
