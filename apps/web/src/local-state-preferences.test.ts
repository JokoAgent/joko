import { describe, expect, it } from "vitest";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { DEFAULT_SIDEBAR_OWNER_LAYOUT, withSidebarOwnerLayout } from "./sidebar-layout.js";

describe("cross-window durable UI preference mutations", () => {
  it("merges a stale renderer's unrelated patch with the latest durable owner layout", async () => {
    const database = memoryPreferenceDatabase();
    const firstWindow = memoryLocalState(database.database);
    const secondWindow = memoryLocalState(database.database);
    await firstWindow.savePreferences({
      ...DEFAULT_UI_PREFERENCES,
      sidebarOwnerLayouts: {
        owner: { ...DEFAULT_SIDEBAR_OWNER_LAYOUT, projectFilter: ["other"] }
      }
    });
    const staleSecondWindowSnapshot = await secondWindow.readPreferences();

    await firstWindow.mutatePreferences((current) => ({
      ...current,
      sidebarOwnerLayouts: withSidebarOwnerLayout(current.sidebarOwnerLayouts, "owner", {
        projectFilter: ["other", "restored"]
      })
    }));
    await secondWindow.mutatePreferences((current) => ({ ...current, theme: "light" }));

    expect(staleSecondWindowSnapshot?.sidebarOwnerLayouts.owner?.projectFilter).toEqual(["other"]);
    await expect(firstWindow.readPreferences()).resolves.toMatchObject({
      theme: "light",
      sidebarOwnerLayouts: {
        owner: { projectFilter: ["other", "restored"] }
      }
    });
  });

  it("keeps exact owner patches from separate renderers in one durable value", async () => {
    const database = memoryPreferenceDatabase();
    const firstWindow = memoryLocalState(database.database);
    const secondWindow = memoryLocalState(database.database);

    await firstWindow.mutatePreferences((current) => ({
      ...current,
      sidebarOwnerLayouts: withSidebarOwnerLayout(current.sidebarOwnerLayouts, "owner-a", {
        projectFilter: ["project-a"]
      })
    }));
    await secondWindow.mutatePreferences((current) => ({
      ...current,
      sidebarOwnerLayouts: withSidebarOwnerLayout(current.sidebarOwnerLayouts, "owner-b", {
        projectFilter: ["project-b"]
      })
    }));

    expect((await firstWindow.readPreferences())?.sidebarOwnerLayouts).toMatchObject({
      "owner-a": { projectFilter: ["project-a"] },
      "owner-b": { projectFilter: ["project-b"] }
    });
  });

  it("canonically clears the optional automatic connection target without resetting unrelated fields", async () => {
    const database = memoryPreferenceDatabase();
    const state = memoryLocalState(database.database);
    await state.savePreferences({
      ...DEFAULT_UI_PREFERENCES,
      theme: "light",
      automaticConnectionTarget: { kind: "profile", profileId: "profile-a" }
    });

    await state.mutatePreferences((current) => ({ ...current, automaticConnectionTarget: undefined }));

    const restored = await state.readPreferences();
    expect(restored).toMatchObject({ theme: "light" });
    expect(Object.hasOwn(restored ?? {}, "automaticConnectionTarget")).toBe(false);
  });

  it("leaves the previous durable value intact when the readwrite transaction aborts", async () => {
    const database = memoryPreferenceDatabase();
    const state = memoryLocalState(database.database);
    await state.savePreferences({ ...DEFAULT_UI_PREFERENCES, theme: "light" });
    database.failNextPut();

    await expect(state.mutatePreferences((current) => ({ ...current, theme: "dark" })))
      .rejects.toThrow("preference write failed");
    await expect(state.readPreferences()).resolves.toMatchObject({ theme: "light" });
  });
});

describe("device-local recent projects", () => {
  it("partitions exact connection owners and keeps failed removal from inventing a successful state", async () => {
    const database = memoryPreferenceDatabase();
    const firstWindow = memoryLocalState(database.database);
    const secondWindow = memoryLocalState(database.database);
    const project = { targetId: "target", workspaceId: "workspace", name: "Project", serverPath: "/srv/project", lastUsedAt: 1 };
    await firstWindow.recordRecentProject("server-a\u0000profile-a", project);
    await expect(secondWindow.readRecentProjects("server-a\u0000profile-a")).resolves.toEqual([expect.objectContaining({
      targetId: project.targetId, workspaceId: project.workspaceId, serverPath: project.serverPath
    })]);
    await expect(secondWindow.readRecentProjects("server-a\u0000profile-b")).resolves.toEqual([]);
    await expect(secondWindow.readRecentProjects("server-b\u0000profile-a")).resolves.toEqual([]);

    database.failNextPut();
    await expect(secondWindow.removeRecentProject("server-a\u0000profile-a", project)).rejects.toThrow("preference write failed");
    await expect(firstWindow.readRecentProjects("server-a\u0000profile-a")).resolves.toHaveLength(1);
    await secondWindow.removeRecentProject("server-a\u0000profile-a", project);
    await expect(firstWindow.readRecentProjects("server-a\u0000profile-a")).resolves.toEqual([]);
  });
});

function memoryLocalState(database: IDBDatabase): LocalState {
  const LocalStateConstructor = LocalState as unknown as new (database: IDBDatabase) => LocalState;
  return new LocalStateConstructor(database);
}

function memoryPreferenceDatabase(): {
  readonly database: IDBDatabase;
  readonly failNextPut: () => void;
} {
  const records = new Map<IDBValidKey, unknown>();
  let rejectNextPut = false;
  const database = {
    transaction(): IDBTransaction {
      let hasWrite = false;
      let settled = false;
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        objectStore(): IDBObjectStore {
          return {
            get(key: IDBValidKey): IDBRequest<unknown> {
              const request = {
                result: undefined as unknown,
                error: null as DOMException | null,
                onsuccess: null as ((event: Event) => void) | null,
                onerror: null as ((event: Event) => void) | null
              };
              queueMicrotask(() => {
                request.result = records.get(key);
                request.onsuccess?.(new Event("success"));
                queueMicrotask(() => {
                  if (settled || hasWrite) return;
                  settled = true;
                  transaction.oncomplete?.(new Event("complete"));
                });
              });
              return request as unknown as IDBRequest<unknown>;
            },
            put(value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
              if (key === undefined) throw new Error("The in-memory preference store requires a key.");
              hasWrite = true;
              const shouldReject = rejectNextPut;
              rejectNextPut = false;
              queueMicrotask(() => {
                if (settled) return;
                settled = true;
                if (shouldReject) {
                  transaction.error = new DOMException("preference write failed", "AbortError");
                  transaction.onabort?.(new Event("abort"));
                  return;
                }
                records.set(key, value);
                transaction.oncomplete?.(new Event("complete"));
              });
              return {} as IDBRequest<IDBValidKey>;
            }
          } as IDBObjectStore;
        }
      };
      return transaction as unknown as IDBTransaction;
    }
  } as unknown as IDBDatabase;
  return {
    database,
    failNextPut: () => { rejectNextPut = true; }
  };
}
