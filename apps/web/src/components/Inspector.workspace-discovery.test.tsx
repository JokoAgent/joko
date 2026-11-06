// @vitest-environment jsdom

import { Code, ConnectError } from "@connectrpc/connect";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type WorkspaceEntryView, type WorkspaceSearchMatchView,
  type WorkspaceSearchPageView, type WorkspaceView } from "../model.js";
import { collectCompleteWorkspaceSearch, FileTreeNode, FilesPanel, Inspector } from "./Inspector.js";
import type { Translator } from "./types.js";

vi.mock("./WorkspaceTextEditor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./WorkspaceTextEditor.js")>();
  return {
    ...actual,
    WorkspaceTextEditor: ({ value, onChange, ariaLabel }: import("./WorkspaceTextEditor.js").WorkspaceTextEditorProps) =>
      <textarea aria-label={ariaLabel} value={value} onChange={event => onChange?.(event.target.value)} />
  };
});

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Inspector workspace discovery", () => {
  it("collects every search page and rejects cyclic or revision-changing pagination", async () => {
    const firstMatches = Array.from({ length: 100 }, (_, index) => match(index + 1));
    const calls: Array<string | undefined> = [];
    const result = await collectCompleteWorkspaceSearch(async (pageToken) => {
      calls.push(pageToken);
      return pageToken === undefined
        ? page(firstMatches, "revision-1", "page-2", 101, 9)
        : page([match(101)], "revision-1", undefined, 101, 9, true);
    });

    expect(calls).toEqual([undefined, "page-2"]);
    expect(result.matches).toHaveLength(101);
    expect(result.matches.at(-1)?.preview).toBe("match 101");
    expect(result).toMatchObject({ totalMatches: 101, totalFiles: 9, truncated: true, revision: "revision-1" });

    await expect(collectCompleteWorkspaceSearch(async () => page([], "revision-1", "same", 0, 0)))
      .rejects.toThrow("cyclic page token");
    await expect(collectCompleteWorkspaceSearch(async (token) => token === undefined
      ? page([], "revision-1", "next", 0, 0)
      : page([], "revision-2", undefined, 0, 0)))
      .rejects.toThrow("changed while pages were loading");
  });

  it("shows a root listing failure and retries without presenting it as an empty workspace", async () => {
    const listWorkspaceEntries = vi.fn()
      .mockRejectedValueOnce(new Error("root denied"))
      .mockResolvedValueOnce([file("recovered.ts")]);
    const { container } = await mount(<FilesPanel
      controller={{ state: { connectionGeneration: 1 }, listWorkspaceEntries } as unknown as AppController}
      workspace={workspace([])}
      sessionId="session-one"
      canWrite={false}
      t={t}
      onSelectionQuote={() => undefined}
    />);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("root denied");
    expect(container.textContent).not.toContain("This workspace is empty.");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("recovered.ts");
  });

  it.each(["text", "binary"] as const)("keeps the Inspector draft after a Connect save conflict with a %s replacement", async kind => {
    const path = "note.txt", entry = file(path);
    const readWorkspaceFile = vi.fn()
      .mockResolvedValueOnce({ path, name: path, kind: "text", text: "Original text", revision: "r1", truncated: false })
      .mockResolvedValueOnce({ path, name: path, kind, text: kind === "text" ? "New disk text" : undefined, revision: "r2", truncated: false });
    const writeWorkspaceTextFile = vi.fn().mockRejectedValue(new ConnectError("Workspace file changed; read it again before saving.", Code.Aborted));
    const { container } = await mount(<FilesPanel
      controller={{ state: { connectionGeneration: 1 }, listWorkspaceEntries: async () => [entry], readWorkspaceFile, writeWorkspaceTextFile } as unknown as AppController}
      workspace={workspace([entry])}
      sessionId="session-one"
      canWrite
      t={t}
      onSelectionQuote={() => undefined}
    />);
    await act(async () => container.querySelector<HTMLButtonElement>(".file-tree__row")!.click());
    const editor = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "My unsaved text");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(async () => document.querySelector<HTMLButtonElement>(".workspace-file-editor-menu button[role=menuitem]")!.click());
    expect(writeWorkspaceTextFile).toHaveBeenCalledExactlyOnceWith("workspace-one", { path, text: "My unsaved text", expectedRevision: "r1" });
    expect(readWorkspaceFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector("textarea")?.value).toBe("My unsaved text");
    const reload = [...container.querySelectorAll<HTMLButtonElement>(".workspace-file-editor-alert button")]
      .find(button => button.textContent === t("workspace.reloadDisk"));
    if (kind === "text") {
      expect(reload).toBeDefined();
      await act(async () => reload!.click());
      expect(container.querySelector("textarea")?.value).toBe("New disk text");
    } else {
      expect(reload).toBeUndefined();
      expect(container.querySelector(".workspace-file-editor-alert")).not.toBeNull();
    }
  });

  it.each(["save", "discard"] as const)("keeps a dirty Files tab until the user can %s its draft", async finalChoice => {
    const path = "note.txt", entry = file(path);
    const session: SessionView = {
      id: `close-files-${finalChoice}`, backendId: "files-backend", targetId: "target-one", name: "Task",
      state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1
    };
    const backend: BackendView = {
      id: session.backendId, name: "Files backend", version: "1", health: "healthy",
      capabilities: new Map([
        ["workspace.files", { name: "workspace.files", supported: true, options: [] }],
        ["workspace.files.write", { name: "workspace.files.write", supported: true, options: [] }]
      ])
    };
    const writeWorkspaceTextFile = vi.fn().mockRejectedValueOnce(new Error("Save denied"))
      .mockResolvedValueOnce({ path, revision: "r2" });
    const snapshot = { ...emptySnapshot(), backends: [backend] };
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES, connectionGeneration: 1, snapshot },
      listWorkspaceEntries: async () => [entry],
      readWorkspaceFile: async () => ({ path, name: path, kind: "text", text: "Original text", revision: "r1", truncated: false }),
      writeWorkspaceTextFile
    } as unknown as AppController;
    const { container } = await mount(<Inspector controller={controller} snapshot={snapshot} session={session} workspace={workspace([entry])}
      timeline={[]} open t={t} runAction={() => undefined} onClose={() => undefined} onSelectionQuote={() => undefined} />);
    await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(button => button.textContent === t("workspace.files"))!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".file-tree__row")!.click());
    const editor = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "My unsaved text");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const tabClose = () => container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("inspector.closeNamedTab", { name: t("workspace.files") })}"]`
    );
    const choose = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find(button => button.textContent === label)!.click();
    await act(async () => tabClose()!.click());
    await act(async () => choose(t("common.cancel")));
    expect(editor.value).toBe("My unsaved text");
    expect(writeWorkspaceTextFile).not.toHaveBeenCalled();

    await act(async () => tabClose()!.click());
    await act(async () => choose(t("workspace.save")));
    expect(tabClose()).not.toBeNull();
    expect(editor.value).toBe("My unsaved text");
    await act(async () => choose(t(finalChoice === "save" ? "workspace.save" : "workspace.discardAndSwitch")));
    expect(tabClose()).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(writeWorkspaceTextFile).toHaveBeenCalledTimes(finalChoice === "save" ? 2 : 1);
  });

  it("shows and retries a child-directory failure", async () => {
    const listWorkspaceEntries = vi.fn(async (_workspaceId: string, parentPath: string) => {
      if (parentPath !== "src") return [];
      if (listWorkspaceEntries.mock.calls.filter((call) => call[1] === "src").length === 1) throw new Error("child denied");
      return [file("src/deep.ts")];
    });
    const { container } = await mount(<FileTreeNode
      controller={{ listWorkspaceEntries } as unknown as AppController}
      workspaceId="workspace-one"
      entry={{ path: "src", name: "src", kind: "directory", generated: false }}
      onSelect={() => undefined}
      level={1}
      t={t}
    />);

    await act(async () => container.querySelector<HTMLButtonElement>(".file-tree__row")?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("child denied");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("deep.ts");
  });

  it("distinguishes search failure from no matches and retries into a complete multi-page result", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const searchWorkspacePage = vi.fn(async (_workspaceId: string, request: { readonly pageToken?: string }) => {
      if (attempt++ === 0) throw new Error("search unavailable");
      return request.pageToken === undefined
        ? page(Array.from({ length: 100 }, (_, index) => match(index + 1)), "revision-1", "page-2", 101, 7)
        : page([match(101)], "revision-1", undefined, 101, 7, true);
    });
    const { container } = await mount(<FilesPanel
      controller={{
        state: { connectionGeneration: 1 },
        listWorkspaceEntries: vi.fn(async () => []),
        searchWorkspacePage
      } as unknown as AppController}
      workspace={workspace([])}
      sessionId="session-one"
      canWrite={false}
      t={t}
      onSelectionQuote={() => undefined}
    />);
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    await act(async () => { vi.advanceTimersByTime(251); });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("search unavailable");
    expect(container.textContent).not.toContain("No matches");
    await act(async () => container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click());
    await settle();
    await act(async () => { vi.advanceTimersByTime(251); });
    await settle(16);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll(".workspace-search-results > button")).toHaveLength(101);
    expect(container.textContent).toContain("101 matches in 7 files");
    expect(container.textContent).toContain("refine the search");
  });
});

async function mount(node: ReactNode): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  await settle();
  return { container };
}

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

const t: Translator = (key, values) => translate("en", key, values);

function workspace(entries: readonly WorkspaceEntryView[]): WorkspaceView {
  return {
    id: "workspace-one",
    targetId: "target-one",
    name: "Workspace",
    kind: "userProject",
    serverPath: "D:\\workspace",
    trusted: true,
    dirty: false,
    revision: "workspace-revision",
    entries
  };
}

function file(path: string): WorkspaceEntryView {
  return { path, name: path.split("/").at(-1) ?? path, kind: "file", generated: false };
}

function match(index: number): WorkspaceSearchMatchView {
  return {
    path: `src/file-${index}.ts`,
    line: index,
    preview: `match ${index}`,
    submatches: [{ startByte: 0, endByte: 5 }],
    range: { startByte: 0, endByte: 5, startLine: index, startColumn: 1, endLine: index, endColumn: 6 },
    revision: "revision-1"
  };
}

function page(
  matches: readonly WorkspaceSearchMatchView[],
  revision: string,
  nextPageToken: string | undefined,
  totalMatches: number,
  totalFiles: number,
  truncated = false
): WorkspaceSearchPageView {
  return { matches, ...(nextPageToken === undefined ? {} : { nextPageToken }), truncated, totalMatches, totalFiles, revision };
}
