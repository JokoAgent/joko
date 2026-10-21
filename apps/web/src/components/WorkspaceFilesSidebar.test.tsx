// @vitest-environment jsdom

import { unicodeCorpus } from "../i18n/test-corpus.js";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkspaceFilesSidebar,
  clampWorkspaceFilesMenuPosition,
  splitWorkspaceSearchPreview,
  workspaceSearchErrorText,
  type WorkspaceFilesDocumentActions,
  type WorkspaceFilesSidebarHandle
} from "./WorkspaceFilesSidebar.js";
import type { WorkspaceFilesEntryView } from "./workspace-tree-state.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.useRealTimers();
});

async function* emptyWorkspaceSearch() {
  yield {
    kind: "end" as const,
    truncated: false,
    totalMatches: 0,
    totalFiles: 0,
    revision: "sha256:empty"
  };
}

describe("WorkspaceFilesSidebar static document-host surface", () => {
  it("renders the compact tree and keeps the alternate search surface mounted", () => {
    const markup = renderToStaticMarkup(<WorkspaceFilesSidebar
      workspaceId="workspace-a"
      activeTargetId="target-a"
      workspaceDisplayName="Joko"
      projectOptions={[
        { targetId: "target-a", workspaceId: "workspace-a", sessionId: "session-a", displayName: "Joko", activeSessionCount: 2 },
        { targetId: "target-b", workspaceId: "workspace-b", sessionId: "session-b", displayName: "Other", activeSessionCount: 1 }
      ]}
      selectedPath="README.md"
      initialDirectories={new Map([["", [
        { path: "src", name: "src", kind: "directory" as const },
        { path: "README.md", name: "README.md", kind: "file" as const }
      ]]])}
      initialFileIndex={{ paths: ["README.md"], truncated: false }}
      loadDirectory={vi.fn(async () => [])}
      searchWorkspace={vi.fn(emptyWorkspaceSearch)}
      onSelectFile={vi.fn()}
      onOpenSearchMatch={vi.fn()}
      onSelectProject={vi.fn()}
      onLeaveDocumentMode={vi.fn()}
    />);

    expect(markup).toContain("role=\"tree\"");
    expect(markup).toContain("role=\"treeitem\"");
    expect(markup).toContain("aria-level=\"1\"");
    expect(markup).toContain("aria-selected=\"true\"");
    expect(markup).toContain("Back to task");
    expect(markup).toContain("Switch project");
    expect(markup).toContain("2 active");
    expect(markup).toContain("aria-current=\"true\"");
    expect(markup).toContain("Filter files");
    expect(markup).toContain("Search in files");
    expect(markup).not.toContain("/server/");
  });

  it("does not render structural write affordances merely because callbacks exist elsewhere", () => {
    const markup = renderToStaticMarkup(<WorkspaceFilesSidebar
      workspaceId="workspace-a"
      workspaceDisplayName="Joko"
      initialDirectories={new Map([["", []]])}
      loadDirectory={vi.fn(async () => [])}
      searchWorkspace={vi.fn(emptyWorkspaceSearch)}
      onSelectFile={vi.fn()}
      onOpenSearchMatch={vi.fn()}
      onLeaveDocumentMode={vi.fn()}
    />);
    expect(markup).not.toContain("New file");
    expect(markup).not.toContain("New folder");
    expect(markup).not.toContain("Rename");
    expect(markup).not.toContain("Delete");
  });

  it("clamps a fixed menu within the owner viewport", () => {
    expect(clampWorkspaceFilesMenuPosition(990, 790, 1000, 800)).toEqual({ x: 768, y: 580 });
    expect(clampWorkspaceFilesMenuPosition(-50, -20, 1000, 800)).toEqual({ x: 8, y: 8 });
  });
});

describe("WorkspaceFilesSidebar directory refresh lifecycle", () => {
  it("coalesces watcher bursts and keeps one successor read without starving the active request", async () => {
    vi.useFakeTimers();
    const host = mountDirectoryHost();
    await host.render("workspace-a");
    expect(host.requests).toHaveLength(1);

    await host.invalidateBurst();
    expect(host.requests).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(50));
    await host.invalidateBurst();
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(host.requests).toHaveLength(1);

    await act(async () => host.requests[0]!.resolve([{ path: "stale.txt", name: "stale.txt", kind: "file" }]));
    expect(host.requests).toHaveLength(2);
    expect(host.container.textContent).not.toContain("stale.txt");

    await host.invalidateBurst();
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(host.requests).toHaveLength(2);
    await act(async () => host.requests[1]!.resolve([]));
    expect(host.requests).toHaveLength(3);
    await act(async () => host.requests[2]!.resolve([{ path: "latest.txt", name: "latest.txt", kind: "file" }]));
    expect(host.container.textContent).toContain("latest.txt");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(host.requests).toHaveLength(3);
  });

  it("discards a queued old-workspace refresh when the workspace changes", async () => {
    vi.useFakeTimers();
    const host = mountDirectoryHost();
    await host.render("workspace-a");
    await host.invalidateBurst();
    await act(async () => vi.advanceTimersByTimeAsync(50));
    await host.render("workspace-b");
    expect(host.requests.map((request) => request.workspaceId)).toEqual(["workspace-a", "workspace-b"]);
    await act(async () => host.requests[0]!.resolve([{ path: "old.txt", name: "old.txt", kind: "file" }]));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(host.requests).toHaveLength(2);
    await act(async () => host.requests[1]!.resolve([{ path: "current.txt", name: "current.txt", kind: "file" }]));
    expect(host.container.textContent).toContain("current.txt");
    expect(host.container.textContent).not.toContain("old.txt");
  });
});

describe("WorkspaceFilesSidebar file operation ownership", () => {
  it("keeps a new folder draft independent of an earlier pending file creation", async () => {
    let finishFile!: () => void;
    const createFile = vi.fn(() => new Promise<void>((resolve) => { finishFile = resolve; }));
    const createDirectory = vi.fn()
      .mockRejectedValueOnce(new Error("Directory creation failed."))
      .mockResolvedValueOnce(undefined);
    const host = await mountOperationHost({
      capabilities: { createFile: true, createDirectory: true },
      createFile,
      createDirectory
    });

    await host.start("New file");
    await host.type("first.txt");
    await host.key("Enter");
    expect(createFile).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", parentPath: "", path: "first.txt" });
    expect(host.input().disabled).toBe(true);

    await host.start("New folder");
    expect(host.input().value).toBe("");
    expect(host.input().disabled).toBe(false);
    await host.type("next-folder");
    await act(async () => finishFile());
    expect(host.input().value).toBe("next-folder");
    expect(host.input().disabled).toBe(false);

    await host.key("Enter");
    expect(createDirectory).toHaveBeenCalledTimes(1);
    expect(host.input().value).toBe("next-folder");
    expect(host.input().disabled).toBe(false);
    expect(host.container.textContent).toContain("The workspace action failed.");
    await host.key("Enter");
    expect(createDirectory).toHaveBeenCalledTimes(2);
    expect(host.container.querySelector("[data-workspace-tree-inline] input")).toBeNull();
  });

  it("resets a reopened action and ignores the superseded request's failure", async () => {
    let failFile!: (error: Error) => void;
    const createFile = vi.fn(() => new Promise<void>((_resolve, reject) => { failFile = reject; }));
    const host = await mountOperationHost({ capabilities: { createFile: true }, createFile });

    await host.start("New file");
    await host.type("earlier.txt");
    await host.key("Enter");
    await host.start("New file");
    expect(host.input().value).toBe("");
    expect(host.input().disabled).toBe(false);
    await host.type("retained.txt");
    await act(async () => failFile(new Error("Earlier creation failed.")));
    expect(host.input().value).toBe("retained.txt");
    expect(host.container.textContent).not.toContain("The workspace action failed.");
    await host.key("Escape");
    expect(host.container.querySelector("[data-workspace-tree-inline] input")).toBeNull();
    expect(createFile).toHaveBeenCalledTimes(1);
  });
});

async function mountOperationHost(documentActions: WorkspaceFilesDocumentActions) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  const initialDirectories = new Map([["", []]]);
  await act(async () => root.render(<WorkspaceFilesSidebar
    workspaceId="workspace-a"
    workspaceDisplayName="Joko"
    documentActions={documentActions}
    initialDirectories={initialDirectories}
    loadDirectory={async () => []}
    searchWorkspace={emptyWorkspaceSearch}
    onSelectFile={() => undefined}
    onOpenSearchMatch={() => undefined}
    onLeaveDocumentMode={() => undefined}
  />));
  const input = (): HTMLInputElement => {
    const element = container.querySelector<HTMLInputElement>("[data-workspace-tree-inline] input");
    if (element === null) throw new Error("The file operation input is missing.");
    return element;
  };
  return {
    container,
    input,
    start: async (label: string) => {
      await act(async () => container.querySelector("[role='tree']")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })));
      const action = [...document.querySelectorAll<HTMLButtonElement>(".workspace-files-context-menu button")].find((button) => button.textContent === label);
      if (action === undefined) throw new Error(`The ${label} action is missing.`);
      await act(async () => action.click());
    },
    type: async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    key: async (key: string) => {
      await act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    }
  };
}

function mountDirectoryHost() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const ref = createRef<WorkspaceFilesSidebarHandle>();
  const requests: Array<{
    readonly workspaceId: string;
    readonly resolve: (entries: readonly WorkspaceFilesEntryView[]) => void;
  }> = [];
  const loadDirectory = ({ workspaceId }: { readonly workspaceId: string }) => new Promise<readonly WorkspaceFilesEntryView[]>((resolve) => {
    requests.push({ workspaceId, resolve });
  });
  return {
    container,
    requests,
    render: async (workspaceId: string) => {
      await act(async () => root.render(<WorkspaceFilesSidebar
        ref={ref}
        workspaceId={workspaceId}
        workspaceDisplayName={workspaceId}
        loadDirectory={loadDirectory}
        searchWorkspace={emptyWorkspaceSearch}
        onSelectFile={() => undefined}
        onOpenSearchMatch={() => undefined}
        onLeaveDocumentMode={() => undefined}
      />));
    },
    invalidateBurst: async () => {
      await act(async () => {
        for (let index = 0; index < 25; index += 1) {
          await ref.current!.invalidateChange({ kind: "created", path: `file-${index}.txt` });
        }
      });
    }
  };
}

describe("splitWorkspaceSearchPreview", () => {
  it("trims rg indentation and highlights every authoritative byte range", () => {
    expect(splitWorkspaceSearchPreview("   Foo foo FOO", [
      { startByte: 3, endByte: 6 },
      { startByte: 7, endByte: 10 },
      { startByte: 11, endByte: 14 }
    ]).map(({ text, match }) => [text, match])).toEqual([
      ["Foo", true],
      [" ", false],
      ["foo", true],
      [" ", false],
      ["FOO", true]
    ]);
  });

  it("does not invent visually plausible matches absent from rg", () => {
    expect(splitWorkspaceSearchPreview("Foo foo", [{ startByte: 4, endByte: 7 }]).filter((segment) => segment.match).map((segment) => segment.text)).toEqual(["foo"]);
    expect(splitWorkspaceSearchPreview("a+b then a+b", [{ startByte: 0, endByte: 3 }]).filter((segment) => segment.match).map((segment) => segment.text)).toEqual(["a+b"]);
  });

  it("maps UTF-8 offsets safely across CJK and astral Unicode without fake highlights", () => {
    expect(splitWorkspaceSearchPreview(unicodeCorpus.utf8SearchPreview, [{ startByte: 12, endByte: 16 }]).map(({ text, match }) => [text, match])).toEqual([
      [unicodeCorpus.utf8SearchPrefix, false],
      ["🐾", true]
    ]);
    expect(splitWorkspaceSearchPreview(unicodeCorpus.utf8SearchPrefix, [{ startByte: 4, endByte: 7 }]).every((segment) => !segment.match)).toBe(true);
  });

  it("shows a terminal provider reason and only falls back for an empty message", () => {
    expect(workspaceSearchErrorText(" ripgrep is unavailable. ", "Workspace search failed.")).toBe("ripgrep is unavailable.");
    expect(workspaceSearchErrorText("", "Workspace search failed.")).toBe("Workspace search failed.");
  });
});
