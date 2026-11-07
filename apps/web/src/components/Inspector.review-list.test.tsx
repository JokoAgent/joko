// @vitest-environment jsdom

import { act, useState } from "react";
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

  it("releases both image acquisitions each time the virtualized Review row leaves the view", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("workspace-diff-preview") ? 180 : 45;
    });
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container); roots.push(root);
    const image = { ...file("photo.png"), binary: true };
    const files = [image, ...Array.from({ length: 100 }, (_, index) => file(`src/file-${index}.ts`))];
    const acquire = vi.fn((id: string) => ({ url: Promise.resolve(`blob:${id}`), release: vi.fn() }));
    const preview = {
      key: `revision-1:${reviewFileKey(image)}`, requestId: 1, loading: false,
      value: { repositoryRevision: "revision-1", maximumBytes: 4096,
        oldImage: { present: true, tooLarge: false, blobId: "old" }, newImage: { present: true, tooLarge: false, blobId: "new" } }
    };
    const render = (repositoryRevision: string) => act(async () => root.render(<WorkspaceDiffPreview
      diff={{ source: "unstaged", repositoryRevision, truncated: false, files }} fallback={[]} t={key => key}
      expandedFileKeys={new Set()} onFileExpandedChange={() => undefined} imagePreview={preview} acquireArtifactUrl={acquire} />));
    try {
      await render("revision-1");
      expect(container.querySelectorAll(".review-image-preview img")).toHaveLength(2);
      const list = container.querySelector<HTMLElement>('[data-virtualized-file-list="true"]')!;
      const scroll = (top: number) => act(async () => { list.scrollTop = top; list.dispatchEvent(new Event("scroll")); });
      await scroll(45 * 70);
      expect(container.querySelector(".review-image-preview")).toBeNull();
      expect(acquire.mock.results).toHaveLength(2);
      for (const entry of acquire.mock.results) expect(entry.value.release).toHaveBeenCalledOnce();

      await scroll(0);
      expect(container.querySelectorAll(".review-image-preview img")).toHaveLength(2);
      expect(acquire.mock.calls).toEqual([["old"], ["new"], ["old"], ["new"]]);
      await render("revision-2");
      for (const entry of acquire.mock.results) expect(entry.value.release).toHaveBeenCalledOnce();
    } finally {
      height.mockRestore();
    }
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

  it("defers collapsed diff content and restores it when expanded", async () => {
    const item: WorkspaceFileDiffView = {
      ...file("src/change.ts"),
      hunks: [{
        oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, heading: "",
        lines: [
          { kind: "removed", oldLine: 1, newLine: 0, text: "return oldValue;" },
          { kind: "added", oldLine: 0, newLine: 1, text: "return newValue;" }
        ]
      }]
    };
    function Preview() {
      const [expanded, setExpanded] = useState(false);
      return <WorkspaceDiffPreview diff={{ source: "unstaged", repositoryRevision: "revision-1", truncated: false, files: [item] }}
        fallback={[]} t={(key) => key} expandedFileKeys={new Set(expanded ? [reviewFileKey(item)] : [])}
        onFileExpandedChange={(_key, value) => setExpanded(value)} />;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<Preview />));
    expect(container.querySelector(".review-hunks")).toBeNull();
    expect(container.querySelector(".review-diff-stats")?.textContent).toBe("+1−1");
    await act(async () => container.querySelector<HTMLElement>("summary")!.click());
    expect([...container.querySelectorAll(".inline-word-change")].map((node) => node.textContent)).toEqual(["oldValue", "newValue"]);
    await act(async () => container.querySelector<HTMLElement>("summary")!.click());
    expect(container.querySelector(".review-hunks")).toBeNull();
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
