// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { WorkspaceEntryView, WorkspaceSearchMatchView, WorkspaceSearchPageView, WorkspaceView } from "../model.js";
import { collectCompleteWorkspaceSearch, FileTreeNode, FilesPanel } from "./Inspector.js";
import type { Translator } from "./types.js";

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
      controller={{ listWorkspaceEntries } as unknown as AppController}
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
