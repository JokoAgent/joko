// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type BackendView,
  type NativeSessionCatalogEntryView,
  type NativeSessionCatalogView
} from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { TaskImportSettings } from "./SettingsPage.js";

const roots: Root[] = [];
const t: Translator = (key, values) => values?.count === undefined ? key : `${key}:${values.count}`;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("TaskImportSettings", () => {
  it("renders supported sources, mixed global ordering, cross-source projects, exact counts, and partial errors", async () => {
    const scanNativeSessionCatalog = vi.fn<AppController["scanNativeSessionCatalog"]>(async (backendId): Promise<NativeSessionCatalogView> => {
      if (backendId === "backend-gamma") throw new Error("profile is unreadable");
      if (backendId === "backend-alpha") return catalog([
        entry({ id: "dialogue", reference: "native://dialogue", title: undefined, placement: "dialogue", archived: true, modifiedAt: 500 }),
        entry({ id: "alpha-project", reference: "native://alpha", title: "Alpha task", workingDirectory: "C:\\repo\\.worktrees\\alpha", projectDirectory: "C:\\repo", modifiedAt: 300 })
      ], 2, 3);
      return catalog([
        entry({ id: "beta-project", reference: "native://beta", title: "Beta task", workingDirectory: "c:\\repo", projectDirectory: "c:\\repo", modifiedAt: 400 })
      ], 1, 1);
    });
    const snapshot = makeSnapshot([
      backend("alpha", true, "Runtime Alpha"),
      backend("beta", true, "Runtime Beta", false),
      backend("gamma", true, "Runtime Gamma"),
      backend("hidden", false, "Unsupported Runtime"),
      backend("unrelated", undefined, "Unrelated Runtime")
    ]);
    const container = await renderSettings(controller({ scanNativeSessionCatalog }), snapshot);

    await waitFor(() => scanNativeSessionCatalog.mock.calls.length === 3 && container.querySelectorAll(".task-import-group").length === 1);

    expect(scanNativeSessionCatalog.mock.calls.map(([backendId, options]) => [backendId, options?.force, options?.signal instanceof AbortSignal]))
      .toEqual([
        ["backend-alpha", false, true],
        ["backend-beta", false, true],
        ["backend-gamma", false, true]
      ]);
    expect(container.textContent).not.toContain("Unsupported Runtime");
    expect(container.textContent).not.toContain("Unrelated Runtime");
    expect([...container.querySelectorAll(".task-import-summary strong")].map((node) => node.textContent)).toEqual(["3", "2", "1", "7"]);
    expect(container.querySelector(".task-import-source-errors")?.textContent).toContain("Runtime Gamma: profile is unreadable");
    expect(container.querySelector(".task-import-list")?.firstElementChild?.classList.contains("task-import-row--direct")).toBe(true);
    expect(container.querySelector(".task-import-row--direct")?.textContent).toContain("settings.sessionImport.untitled");
    expect(container.querySelector(".task-import-row--direct")?.textContent).toContain("settings.sessionImport.archived");
    expect(container.querySelector(".task-import-group__items")).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>(".task-import-group__identity")?.click());
    expect([...container.querySelectorAll(".task-import-group__items .task-import-row strong")].map((node) => node.textContent))
      .toEqual(["Beta task", "Alpha task"]);
    expect(container.querySelector(".task-import-group__items")?.textContent).toContain("Runtime Alpha");
    expect(container.querySelector(".task-import-group__items")?.textContent).toContain("Runtime Beta");
    expect(container.querySelector(".task-import-group__items")?.textContent).not.toContain("settings.sessionImport.importUnavailable");
    expect(container.querySelectorAll<HTMLInputElement>(".task-import-group__items input")[0]?.disabled).toBe(false);
  });

  it("combines capsule filters while preserving selection outside the current result", async () => {
    const scanNativeSessionCatalog = vi.fn<AppController["scanNativeSessionCatalog"]>(async (backendId) => catalog(backendId === "backend-filter-alpha" ? [
      entry({ id: "alpha-project", reference: "native://filter-alpha-project", title: "Alpha project", modifiedAt: 300 }),
      entry({ id: "alpha-dialogue", reference: "native://filter-alpha-dialogue", title: "Alpha dialogue", placement: "dialogue", modifiedAt: 200 })
    ] : [
      entry({ id: "beta-project", reference: "native://filter-beta-project", title: "Beta project", modifiedAt: 100 })
    ]));
    const container = await renderSettings(controller({ scanNativeSessionCatalog }), makeSnapshot([
      backend("filter-alpha", true, "Filter Alpha"),
      backend("filter-beta", true, "Filter Beta")
    ]));
    await waitFor(() => container.querySelectorAll(".task-import-group").length === 1);

    await act(async () => container.querySelector<HTMLInputElement>(".task-import-select-all input")?.click());
    expect(container.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selected:3");

    await clickRadio(container, "Filter Alpha");
    await clickRadio(container, "settings.sessionImport.dialogues");
    expect(container.querySelectorAll(".task-import-row--direct")).toHaveLength(1);
    expect(container.querySelectorAll(".task-import-group")).toHaveLength(0);
    expect(container.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selectedOutsideFilter:2");

    await act(async () => container.querySelector<HTMLInputElement>(".task-import-select-all input")?.click());
    expect(container.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selected:2");
    expect(container.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selectedOutsideFilter:2");
  });

  it("keeps the first scan non-blocking, reuses cached results on remount, and forces manual refresh", async () => {
    const first = deferred<NativeSessionCatalogView>();
    const firstScan = vi.fn<AppController["scanNativeSessionCatalog"]>(() => first.promise);
    const snapshot = makeSnapshot([backend("cache", true, "Cache Runtime")]);
    const firstRender = await renderSettings(controller({ scanNativeSessionCatalog: firstScan }), snapshot);

    expect(firstRender.querySelector(".task-import-empty")?.textContent).toContain("settings.sessionImport.emptyTitle");
    expect(firstRender.querySelector(".task-import-empty")?.textContent).toContain("settings.sessionImport.emptyBody");
    expect(firstRender.querySelector(".task-import-empty .is-spinning")).toBeNull();
    first.resolve(catalog([entry({ id: "cached", reference: "native://cached", title: "Cached task", placement: "dialogue" })]));
    await waitFor(() => firstRender.textContent?.includes("Cached task") === true);
    await unmountRoot(firstRender);

    const refresh = deferred<NativeSessionCatalogView>();
    const secondScan = vi.fn<AppController["scanNativeSessionCatalog"]>(() => refresh.promise);
    const secondRender = await renderSettings(controller({ scanNativeSessionCatalog: secondScan }), snapshot);
    expect(secondRender.textContent).toContain("Cached task");
    await waitFor(() => secondScan.mock.calls.length === 1);
    expect(secondScan.mock.calls[0]?.[1]?.force).toBe(false);
    refresh.resolve(catalog([entry({ id: "fresh", reference: "native://fresh", title: "Fresh task", placement: "dialogue" })]));
    await waitFor(() => secondRender.textContent?.includes("Fresh task") === true);
    await act(async () => secondRender.querySelector<HTMLInputElement>(".task-import-row--direct input")?.click());
    expect(secondRender.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selected:1");

    secondScan.mockRejectedValueOnce(new Error("refresh unavailable"));
    await act(async () => buttonWithText(secondRender, "settings.sessionImport.scan").click());
    await waitFor(() => secondScan.mock.calls.length === 2);
    expect(secondScan.mock.calls[1]?.[1]?.force).toBe(true);
    await waitFor(() => secondRender.textContent?.includes("refresh unavailable") === true);
    expect(secondRender.textContent).toContain("Fresh task");
    expect(secondRender.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selected:1");

    const forced = deferred<NativeSessionCatalogView>();
    secondScan.mockImplementationOnce(() => forced.promise);
    await act(async () => buttonWithText(secondRender, "settings.sessionImport.scan").click());
    await waitFor(() => secondScan.mock.calls.length === 3);
    expect(secondScan.mock.calls[2]?.[1]?.force).toBe(true);
    forced.resolve(catalog([entry({ id: "forced", reference: "native://forced", title: "Forced task", placement: "dialogue" })]));
    await waitFor(() => secondRender.textContent?.includes("Forced task") === true);
    expect(secondRender.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selected:0");
  });

  it("imports runtime histories, moves project tasks to their grouping target, archives hidden targets, and rescans", async () => {
    const scanNativeSessionCatalog = vi.fn<AppController["scanNativeSessionCatalog"]>(async () => catalog([
      entry({
        id: "worktree-task",
        reference: "native://worktree",
        title: "Worktree task",
        workingDirectory: "C:\\repo\\.worktrees\\one",
        projectDirectory: "C:\\repo",
        placement: "project",
        archived: true,
        modifiedAt: 200
      }),
      entry({
        id: "dialogue-task",
        reference: "native://direct",
        title: "Direct task",
        workingDirectory: "C:\\dialogue",
        projectDirectory: undefined,
        placement: "dialogue",
        modifiedAt: 100
      }),
      entry({
        id: "existing-task",
        reference: "native://existing",
        title: "Existing task",
        workingDirectory: undefined,
        projectDirectory: "C:\\repo",
        placement: "project",
        existingSessionId: "session-existing",
        modifiedAt: 150
      })
    ]));
    const createTarget = vi.fn(async (draft: Parameters<AppController["createTarget"]>[0]) => `target:${draft.serverPath}`);
    const createSession = vi.fn(async (draft: Parameters<AppController["createSession"]>[0]) => `session:${draft.name}`);
    const moveSessionProject = vi.fn<AppController["moveSessionProject"]>(async () => undefined);
    const archiveTarget = vi.fn<AppController["archiveTarget"]>(async () => undefined);
    const archiveSession = vi.fn<AppController["archiveSession"]>(async () => undefined);
    const refresh = vi.fn(async () => undefined);
    const onSuccess = vi.fn();
    let actionPromise: Promise<void> | undefined;
    const runAction: RunAction = (_key, action) => { actionPromise = action(); };
    const container = await renderSettings(controller({
      scanNativeSessionCatalog,
      createTarget,
      createSession,
      moveSessionProject,
      archiveTarget,
      archiveSession,
      refresh
    }), makeSnapshot([backend("import", true, "Import Runtime")]), runAction, onSuccess);
    await waitFor(() => container.querySelectorAll(".task-import-group").length === 1 && container.querySelectorAll(".task-import-row--direct").length === 1);

    await act(async () => container.querySelector<HTMLInputElement>(".task-import-group input")?.click());
    await act(async () => container.querySelector<HTMLInputElement>(".task-import-row--direct input")?.click());
    await act(async () => buttonWithText(container, "settings.sessionImport.importSelected").click());
    await waitFor(() => actionPromise !== undefined);
    await act(async () => { await actionPromise; });

    expect(createTarget.mock.calls.map(([draft]) => draft.serverPath).sort()).toEqual([
      "C:\\dialogue",
      "C:\\repo",
      "C:\\repo\\.worktrees\\one"
    ]);
    expect(createSession.mock.calls.map(([draft]) => [draft.targetId, draft.initialPlacement])).toEqual(expect.arrayContaining([
      ["target:C:\\repo\\.worktrees\\one", "project"],
      ["target:C:\\dialogue", "dialogue"]
    ]));
    expect(createSession.mock.calls.map(([draft]) => draft.catalogImport)).toEqual(expect.arrayContaining([
      { projectId: "target:C:\\repo", archived: true, createdAt: 1, modifiedAt: 200, snapshotToken: "scan-token" },
      { archived: false, createdAt: 1, modifiedAt: 100, snapshotToken: "scan-token" }
    ]));
    expect(moveSessionProject).toHaveBeenCalledExactlyOnceWith(
      "session-existing",
      "target:C:\\repo",
      { archived: false, modifiedAt: 150, snapshotToken: "scan-token" }
    );
    expect(archiveSession).not.toHaveBeenCalled();
    expect(archiveTarget.mock.calls.map(([targetId]) => targetId).sort()).toEqual([
      "target:C:\\dialogue",
      "target:C:\\repo\\.worktrees\\one"
    ]);
    expect(scanNativeSessionCatalog.mock.calls.map(([backendId, options]) => [backendId, options?.force])).toEqual([
      ["backend-import", false],
      ["backend-import", true],
      ["backend-import", true]
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledExactlyOnceWith("settings.sessionImport.importComplete");
  });

  it("rejects the batch with the native failure reason and keeps the failed task selected", async () => {
    const scanNativeSessionCatalog = vi.fn<AppController["scanNativeSessionCatalog"]>(async () => catalog([
      entry({ id: "broken", reference: "native://broken", title: "Broken task", placement: "dialogue" })
    ]));
    let actionPromise: Promise<void> | undefined;
    const runAction: RunAction = (_key, action) => {
      actionPromise = action();
      void actionPromise.catch(() => undefined);
    };
    const container = await renderSettings(controller({
      scanNativeSessionCatalog,
      createSession: vi.fn(async () => { throw new Error("runtime is unavailable"); })
    }), makeSnapshot([backend("failure", true, "Failure Runtime")]), runAction);
    await waitFor(() => container.querySelector(".task-import-row--direct") !== null);
    await act(async () => container.querySelector<HTMLInputElement>(".task-import-row--direct input")?.click());
    await act(async () => buttonWithText(container, "settings.sessionImport.importSelected").click());
    await waitFor(() => actionPromise !== undefined);
    let actionError: unknown;
    await act(async () => {
      try {
        await actionPromise;
      } catch (error) {
        actionError = error;
      }
    });

    expect(actionError).toBeInstanceOf(Error);
    expect((actionError as Error).message).toContain("runtime is unavailable");
    expect(container.querySelector(".task-import-footer")?.textContent).toContain("settings.sessionImport.selected:1");
    expect(container.querySelector(".task-import-row--direct")?.textContent).toContain("settings.sessionImport.item.error");
  });
});

async function renderSettings(
  controllerValue: AppController,
  snapshot: AppSnapshot,
  runAction: RunAction = () => undefined,
  onSuccess: (text: string) => void = () => undefined
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<TaskImportSettings
    controller={controllerValue}
    snapshot={snapshot}
    runAction={runAction}
    onSuccess={onSuccess}
    t={t}
  />));
  return container;
}

async function unmountRoot(container: HTMLDivElement): Promise<void> {
  const root = roots.pop();
  if (root === undefined) throw new Error("Missing test root");
  await act(async () => root.unmount());
  container.remove();
}

function controller(options: {
  readonly scanNativeSessionCatalog: AppController["scanNativeSessionCatalog"];
  readonly createTarget?: AppController["createTarget"];
  readonly refresh?: AppController["refresh"];
  readonly createSession?: AppController["createSession"];
  readonly moveSessionProject?: AppController["moveSessionProject"];
  readonly archiveTarget?: AppController["archiveTarget"];
  readonly archiveSession?: AppController["archiveSession"];
}): AppController {
  return {
    state: { preferences: { locale: "en" } },
    scanNativeSessionCatalog: vi.fn(options.scanNativeSessionCatalog),
    createTarget: vi.fn(options.createTarget ?? (async () => "target-created")),
    refresh: vi.fn(options.refresh ?? (async () => undefined)),
    createSession: vi.fn(options.createSession ?? (async () => "session-created")),
    moveSessionProject: vi.fn(options.moveSessionProject ?? (async () => undefined)),
    archiveTarget: vi.fn(options.archiveTarget ?? (async () => undefined)),
    archiveSession: vi.fn(options.archiveSession ?? (async () => undefined))
  } as unknown as AppController;
}

function makeSnapshot(backends: readonly BackendView[]): AppSnapshot {
  return { ...emptySnapshot(), backends };
}

function backend(key: string, catalogSupported: boolean | undefined, name: string, resumeSupported = true): BackendView {
  const capabilities = new Map<string, BackendView["capabilities"] extends ReadonlyMap<string, infer T> ? T : never>();
  if (catalogSupported !== undefined) capabilities.set("session.catalog", {
    name: "session.catalog",
    supported: catalogSupported,
    options: [],
    ...(catalogSupported ? {} : { reason: "runtime_missing" })
  });
  capabilities.set("session.discovery", { name: "session.discovery", supported: true, options: [] });
  capabilities.set("session.resume", { name: "session.resume", supported: resumeSupported, options: [], ...(resumeSupported ? {} : { reason: "runtime_missing" }) });
  return {
    id: `backend-${key}`,
    name,
    version: "1",
    health: "healthy",
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities
  };
}

function catalog(entries: readonly NativeSessionCatalogEntryView[], rejectedCount = 0, existingCount = 0): NativeSessionCatalogView {
  return { entries, rejectedCount, existingCount, snapshotToken: "scan-token" };
}

function entry(overrides: Partial<NativeSessionCatalogEntryView> = {}): NativeSessionCatalogEntryView {
  return {
    id: "native-1",
    reference: "native://restored",
    title: "Restored native task",
    workingDirectory: "C:\\workspace",
    projectDirectory: "C:\\workspace",
    createdAt: 1,
    modifiedAt: 1,
    archived: false,
    placement: "project",
    ...overrides
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((accept) => { resolve = accept; }), resolve };
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickRadio(container: ParentNode, text: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Radio not found: ${text}`);
  await act(async () => button.click());
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
    if (assertion()) return;
  }
  throw new Error("Condition was not met");
}
