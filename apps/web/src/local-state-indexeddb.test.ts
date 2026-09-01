import { afterEach, describe, expect, it, vi } from "vitest";

const CURRENT_STORES = ["profiles", "secrets", "keys", "drafts", "preferences", "machine-caches"] as const;

describe("local IndexedDB initialization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fails closed when the current-version database schema is incomplete", async () => {
    const incompleteStores = new Set<string>(["profiles"]);
    const incompleteDatabase = databaseWithStores(1, incompleteStores);
    const open = vi.fn((_name: string, _version?: number) => scheduledOpenRequest(incompleteDatabase.database, false));
    const deleteDatabase = vi.fn();
    vi.stubGlobal("indexedDB", { open, deleteDatabase });
    const { LocalState } = await import("./local-state.js");

    await expect(LocalState.open()).rejects.toThrow("The local UI state schema is unsupported.");

    expect(incompleteDatabase.close).toHaveBeenCalledOnce();
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("joko-ui", 1);
  });

  it("creates the exact current schema and closes it when another window replaces it", async () => {
    const stores = new Set<string>();
    const currentDatabase = databaseWithStores(1, stores);
    const open = vi.fn((_name: string, _version?: number) => scheduledOpenRequest(currentDatabase.database, true));
    const deleteDatabase = vi.fn();
    vi.stubGlobal("indexedDB", { open, deleteDatabase });
    const { LocalState } = await import("./local-state.js");

    await expect(Promise.all([LocalState.open(), LocalState.open()])).resolves.toHaveLength(2);

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("joko-ui", 1);
    expect([...stores]).toEqual(CURRENT_STORES);
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(currentDatabase.close).not.toHaveBeenCalled();
    currentDatabase.database.onversionchange?.call(
      currentDatabase.database,
      new Event("versionchange") as IDBVersionChangeEvent
    );
    expect(currentDatabase.close).toHaveBeenCalledOnce();
  });

  it("opens an existing exact current schema without requiring an upgrade", async () => {
    const stores = new Set<string>(CURRENT_STORES);
    const currentDatabase = databaseWithStores(1, stores);
    const open = vi.fn((_name: string, _version?: number) => scheduledOpenRequest(currentDatabase.database, false));
    const deleteDatabase = vi.fn();
    vi.stubGlobal("indexedDB", { open, deleteDatabase });
    const { LocalState } = await import("./local-state.js");

    await expect(LocalState.open()).resolves.toBeInstanceOf(LocalState);

    expect(open).toHaveBeenCalledWith("joko-ui", 1);
    expect(deleteDatabase).not.toHaveBeenCalled();
    expect(currentDatabase.close).not.toHaveBeenCalled();
  });
});

function databaseWithStores(version: number, stores: Set<string>): {
  readonly database: IDBDatabase;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const database = {
    version,
    get objectStoreNames() {
      return {
        get length() {
          return stores.size;
        },
        contains(name: string) {
          return stores.has(name);
        }
      } as DOMStringList;
    },
    createObjectStore(name: string) {
      stores.add(name);
      return {} as IDBObjectStore;
    },
    close,
    onversionchange: null
  } as unknown as IDBDatabase;
  return { database, close };
}

function scheduledOpenRequest(database: IDBDatabase, upgrade: boolean): IDBOpenDBRequest {
  const request = { result: database, error: null } as unknown as IDBOpenDBRequest;
  queueMicrotask(() => {
    if (upgrade) request.onupgradeneeded?.call(request, new Event("upgradeneeded") as IDBVersionChangeEvent);
    request.onsuccess?.call(request, new Event("success"));
  });
  return request;
}
