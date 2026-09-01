// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceDiffView, WorkspaceFileDiffView } from "../model.js";
import { WorkspaceDiffPreview } from "./Inspector.js";
import { reviewFileKey } from "./review-diff.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Workspace Review file list", () => {
  it("keeps every changed file mounted when file-tree preference is enabled", async () => {
    const files = [file("src/one.ts"), file("src/two.ts")];
    const { container } = await renderPreview(files, true);
    expect(container.querySelectorAll("[data-review-file-key]")).toHaveLength(2);
    expect([...container.querySelectorAll(".workspace-review-file strong")].map((node) => node.textContent))
      .toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("reports a controlled per-file collapse from its summary", async () => {
    const item = file("src/one.ts");
    const onFileExpandedChange = vi.fn();
    const { container } = await renderPreview([item], false, onFileExpandedChange);
    await act(async () => container.querySelector<HTMLElement>("summary")!.click());
    expect(onFileExpandedChange).toHaveBeenCalledWith(reviewFileKey(item), false);
  });

  it("switches large file sets to the virtualized list path", async () => {
    const files = Array.from({ length: 101 }, (_, index) => file(`src/file-${index}.ts`));
    const { container } = await renderPreview(files, false);
    expect(container.querySelector('[data-virtualized-file-list="true"]')).not.toBeNull();
  });

  it("switches long text diffs to row virtualization", async () => {
    const item: WorkspaceFileDiffView = {
      ...file("src/long.ts"),
      hunks: [{
        oldStart: 1,
        oldCount: 201,
        newStart: 1,
        newCount: 201,
        heading: "",
        lines: Array.from({ length: 201 }, (_, index) => ({
          kind: "context" as const,
          oldLine: index + 1,
          newLine: index + 1,
          text: `line ${index + 1}`
        }))
      }]
    };
    const { container } = await renderPreview([item], false);
    expect(container.querySelector('[data-virtualized-diff="true"]')).not.toBeNull();
  });

  it("filters and selects files from the keyboard jump control", async () => {
    const items = [file("src/one.ts"), file("src/two.ts")];
    const onSelectFile = vi.fn();
    const { container } = await renderPreview(items, false, vi.fn(), onSelectFile);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="workspace.reviewJumpToFile"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="workspace.reviewFilterFiles"]')!;
    await act(async () => {
      setNativeValue(input, "two");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSelectFile).toHaveBeenLastCalledWith(reviewFileKey(items[1]!));
  });
});

async function renderPreview(
  files: readonly WorkspaceFileDiffView[],
  fileTreeVisible: boolean,
  onFileExpandedChange = vi.fn(),
  onSelectFile = vi.fn()
): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const diff: WorkspaceDiffView = {
    source: "unstaged",
    repositoryRevision: "revision-1",
    truncated: false,
    files
  };
  await act(async () => root.render(<WorkspaceDiffPreview
    diff={diff}
    fallback={[]}
    t={(key) => key}
    fileTreeVisible={fileTreeVisible}
    onSelectFile={onSelectFile}
    expandedFileKeys={new Set(files.map(reviewFileKey))}
    onFileExpandedChange={onFileExpandedChange}
  />));
  return { container };
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

function file(path: string): WorkspaceFileDiffView {
  return {
    path,
    source: "unstaged",
    status: "modified",
    binary: false,
    text: "",
    hunks: []
  };
}
