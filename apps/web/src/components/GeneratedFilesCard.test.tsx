// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TimelineGeneratedFileView } from "../model.js";
import { GeneratedFilesCard } from "./GeneratedFilesCard.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const files: readonly TimelineGeneratedFileView[] = Array.from({ length: 8 }, (_, index) => ({
  relativePath: `reports/output-${index + 1}.txt`,
  displayName: `output-${index + 1}.txt`
}));
const t: Translator = (key, values) => {
  if (key === "timeline.generatedFiles") return "Generated files";
  if (key === "timeline.generatedFilesCount") return `${values?.["count"] ?? 0} files`;
  if (key === "timeline.openGeneratedFile") return `Open ${values?.["name"] ?? "file"}`;
  if (key === "timeline.showMore") return "Show details";
  if (key === "timeline.showLess") return "Hide details";
  return key;
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("GeneratedFilesCard", () => {
  it("opens files and expands a bounded six-chip summary", async () => {
    const onOpenFile = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<GeneratedFilesCard files={files} t={t} onOpenFile={onOpenFile} />));

    expect(container.querySelectorAll(".generated-file-chip")).toHaveLength(6);
    const first = container.querySelector<HTMLButtonElement>('.generated-file-chip[title="reports/output-1.txt"]');
    expect(first).not.toBeNull();
    await act(async () => first?.click());
    expect(onOpenFile).toHaveBeenCalledWith("reports/output-1.txt");

    const expand = container.querySelector<HTMLButtonElement>('[aria-label="Show details: 2 files"]');
    expect(expand).not.toBeNull();
    await act(async () => expand?.click());
    expect(container.querySelectorAll(".generated-file-chip")).toHaveLength(8);
    const collapse = container.querySelector<HTMLButtonElement>('[aria-label="Hide details"]');
    expect(collapse).not.toBeNull();
    await act(async () => collapse?.click());
    expect(container.querySelectorAll(".generated-file-chip")).toHaveLength(6);
  });
});
