// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type {
  BackendView,
  NativeSessionTreeView,
  SessionView,
  WorkspaceEntryView,
  WorkspaceFileDiffView,
  WorkspaceView
} from "../model.js";
import { reviewFileKey } from "./review-diff.js";
import { BranchesPanel, FilesPanel, ReviewFileTree } from "./Inspector.js";
import { inspectorTreeItems } from "./inspector-tree-navigation.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key) => key;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0)
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Inspector production trees", () => {
  it("keeps the search query but retires settled matches after a workspace rebind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = { matches: [], truncated: false, totalFiles: 0, totalMatches: 0, revision: "new" };
    const searchWorkspacePage = vi.fn<AppController["searchWorkspacePage"]>(async () => page).mockResolvedValueOnce({
      ...page, revision: "old", totalFiles: 1, totalMatches: 1,
      matches: [{ path: "report.txt", line: 1, preview: "needle_A from the old root", submatches: [], revision: "old",
        range: { startByte: 0, endByte: 8, startLine: 1, endLine: 1, startColumn: 1, endColumn: 9 } }]
    });
    const controller = { state: { connectionGeneration: 1 }, listWorkspaceEntries: vi.fn(async () => []), searchWorkspacePage } as unknown as AppController;
    const original = workspace([]);
    const view = (selected: WorkspaceView) => <FilesPanel controller={controller} workspace={selected} sessionId="session-one" canWrite={false} t={t} onSelectionQuote={vi.fn()} />;
    try {
      const host = await render(view(original));
      const search = required(host.querySelector<HTMLInputElement>('input[type="search"]'));
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "needle_A");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(host.textContent).toContain("needle_A from the old root");
      await act(async () => roots.at(-1)!.render(view({ ...original,
        remoteWorkspace: { kind: "ssh", hostId: "ssh-host", hostTargetId: "ssh-target", workspaceRoot: "/project" }
      })));
      expect(search.value).toBe("needle_A");
      expect(host.textContent).not.toContain("needle_A from the old root");
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(searchWorkspacePage).toHaveBeenCalledTimes(2);
      expect(searchWorkspacePage).toHaveBeenLastCalledWith(original.id, expect.objectContaining({ query: "needle_A" }), expect.any(AbortSignal));
      expect(host.textContent).toContain(t("workspace.noMatches"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("navigates and expands the Files tree without tabbing through every row button", async () => {
    const entries = [directory("src"), file("README.md")];
    const listWorkspaceEntries = vi.fn(async (_workspaceId: string, path: string) => path === "src" ? [file("src/App.tsx")] : entries);
    const controller = { state: { connectionGeneration: 1 }, listWorkspaceEntries } as unknown as AppController;
    const host = await render(<FilesPanel
      controller={controller}
      workspace={workspace(entries)}
      sessionId="session-one"
      canWrite={false}
      t={t}
      onSelectionQuote={vi.fn()}
    />);
    await settle();

    const tree = required(host.querySelector<HTMLDivElement>('[role="tree"]'));
    let items = inspectorTreeItems(tree);
    expect(items.map((item) => item.tabIndex)).toEqual([0, -1]);
    expect(tree.querySelectorAll<HTMLButtonElement>(".file-tree__row[tabindex='0']")).toHaveLength(0);

    items[0]?.focus();
    await press(items[0], "ArrowRight", true);
    items = inspectorTreeItems(tree);
    expect(listWorkspaceEntries).toHaveBeenCalledWith("workspace-one", "src");
    expect(items.map((item) => item.dataset.inspectorTreeKey)).toEqual(["src", "src/App.tsx", "README.md"]);
    await press(items[0], "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    await press(items[1], "ArrowLeft");
    expect(document.activeElement).toBe(items[0]);
  });

  it("keeps Branch navigation primary controls out of the Tab order while preserving its fork action", async () => {
    const navigateSessionBranch = vi.fn(async () => undefined);
    const treeView: NativeSessionTreeView = {
      nativeSessionId: "native-one",
      roots: [{
        id: "root",
        kind: "message",
        role: "user",
        text: "Root question",
        active: false,
        children: [{ id: "child", parentId: "root", kind: "message", role: "assistant", text: "Answer", active: false, children: [] }]
      }]
    };
    const controller = {
      getSessionTree: vi.fn(async () => treeView),
      navigateSessionBranch,
      forkSession: vi.fn(async () => "forked"),
      navigate: vi.fn()
    } as unknown as AppController;
    const host = await render(<BranchesPanel
      controller={controller}
      backend={backend()}
      session={session()}
      t={t}
      runAction={(_key, action) => { void action(); }}
    />);
    await settle();

    const tree = required(host.querySelector<HTMLDivElement>('[role="tree"]'));
    let items = inspectorTreeItems(tree);
    expect(items.map((item) => item.tabIndex)).toEqual([0]);
    expect(tree.querySelector<HTMLButtonElement>("[data-inspector-tree-toggle]")?.tabIndex).toBe(-1);
    expect(tree.querySelector<HTMLButtonElement>("[data-inspector-tree-primary]")?.tabIndex).toBe(-1);
    expect(tree.querySelector<HTMLButtonElement>("[data-inspector-tree-secondary-action]")?.tabIndex).toBe(0);

    items[0]?.focus();
    await press(items[0], "ArrowRight");
    items = inspectorTreeItems(tree);
    expect(items).toHaveLength(2);
    await press(items[0], "ArrowRight");
    expect(document.activeElement).toBe(items[1]);
    await press(items[1], "Enter", true);
    expect(navigateSessionBranch).toHaveBeenCalledWith("session-one", { kind: "native_entry", entryId: "child" }, { expectedGeneration: 1n, summarize: false });
  });

  it("shows isolated-workspace branch forks only when the backend can derive the workspace", async () => {
    const treeView: NativeSessionTreeView = {
      nativeSessionId: "native-one",
      roots: [{ id: "root", kind: "message", role: "user", text: "Root question", active: false, children: [] }]
    };
    const controller = {
      getSessionTree: vi.fn(async () => treeView),
      navigateSessionBranch: vi.fn(async () => undefined),
      forkSession: vi.fn(async () => "forked"),
      navigate: vi.fn()
    } as unknown as AppController;
    const isolatedSession: SessionView = {
      ...session(),
      worktree: {
        leaseId: "0123456789abcdef01234567",
        workspaceId: "workspace-one",
        workingPath: "D:/worktrees/session-one",
        repositoryRoot: "D:/workspace",
        branch: "joko/session-one",
        sourceRef: "main",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        sourceStrategy: "explicit",
        sourceRefreshed: false,
        state: "active",
        acquiredAt: 1,
        updatedAt: 1
      }
    };
    const unavailable = await render(<BranchesPanel
      controller={controller}
      backend={backend()}
      session={isolatedSession}
      t={t}
      runAction={(_key, action) => { void action(); }}
    />);
    const available = await render(<BranchesPanel
      controller={controller}
      backend={backend(true)}
      session={isolatedSession}
      t={t}
      runAction={(_key, action) => { void action(); }}
    />);
    await settle();

    expect(unavailable.querySelector("[data-inspector-tree-secondary-action]")).toBeNull();
    expect(available.querySelector<HTMLButtonElement>("[data-inspector-tree-secondary-action]")?.textContent).toBe("session.fork");
    expect(controller.forkSession).not.toHaveBeenCalled();
  });

  it.each(["main", "detached"] as const)("moves through the %s Review hierarchy with standard tree keys", async location => {
    const files = [diff("src/App.tsx"), diff("src/lib/data.ts"), diff("README.md")];
    const onSelect = vi.fn();
    const owner = location === "main"
      ? document
      : required(document.body.appendChild(document.createElement("iframe")).contentDocument);
    if (owner !== document) {
      Object.defineProperty(required(owner.defaultView).HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: vi.fn()
      });
    }
    const host = await render(<ReviewFileTree files={files} selectedKey={reviewFileKey(files[0]!)} onSelect={onSelect} t={t} />, owner);
    await settle();

    const tree = required(host.querySelector<HTMLDivElement>('[role="tree"]'));
    expect(tree.ownerDocument).toBe(owner);
    expect(tree instanceof Element).toBe(location === "main");
    let selected = required(tree.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]'));
    expect(inspectorTreeItems(tree).filter((item) => item.tabIndex === 0)).toEqual([selected]);
    selected.focus();
    await press(selected, "ArrowLeft");
    let parent = required(tree.querySelector<HTMLElement>('[data-inspector-tree-key="directory:src"]'));
    expect(owner.activeElement).toBe(parent);

    await press(parent, "ArrowLeft");
    expect(parent.getAttribute("aria-expanded")).toBe("false");
    await press(parent, "ArrowRight");
    parent = required(tree.querySelector<HTMLElement>('[data-inspector-tree-key="directory:src"]'));
    expect(parent.getAttribute("aria-expanded")).toBe("true");
    await press(parent, "ArrowRight");
    const nestedDirectory = required(tree.querySelector<HTMLElement>('[data-inspector-tree-key="directory:src/lib"]'));
    expect(owner.activeElement).toBe(nestedDirectory);
    await press(nestedDirectory, "ArrowRight");
    const nestedFile = required(tree.querySelector<HTMLElement>(`[data-inspector-tree-key="${reviewFileKey(files[1]!)}"]`));
    expect(owner.activeElement).toBe(nestedFile);
    await press(nestedFile, "Enter");
    expect(onSelect).toHaveBeenCalledWith(reviewFileKey(files[1]!));
  });
});

async function render(element: ReactNode, owner = document): Promise<HTMLDivElement> {
  const host = owner.body.appendChild(owner.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function press(target: Element | undefined, key: string, settleAfter = false): Promise<void> {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    if (settleAfter) {
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    }
  });
}

function workspace(entries: readonly WorkspaceEntryView[]): WorkspaceView {
  return { id: "workspace-one", targetId: "target-one", name: "Workspace", kind: "userProject", serverPath: "D:/workspace", trusted: true, dirty: false, entries };
}

function directory(path: string): WorkspaceEntryView {
  return { path, name: path.split("/").at(-1) ?? path, kind: "directory", generated: false };
}

function file(path: string): WorkspaceEntryView {
  return { path, name: path.split("/").at(-1) ?? path, kind: "file", generated: false };
}

function diff(path: string): WorkspaceFileDiffView {
  return { path, source: "unstaged", status: "modified", binary: false, text: "", hunks: [] };
}

function session(): SessionView {
  return { id: "session-one", backendId: "backend-one", targetId: "target-one", name: "Task", state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 };
}

function backend(deriveWorkspace = false): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["session.fork", { name: "session.fork", supported: true, options: [] }],
      ...(deriveWorkspace ? [["workspace.derive", { name: "workspace.derive", supported: true, options: [] }] as const] : [])
    ])
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the Inspector tree control to exist.");
  return value;
}
