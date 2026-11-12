// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceTextEditor, type WorkspaceTextEditorHandle } from "./WorkspaceTextEditor.js";

vi.mock("./mermaid-render.js", () => ({
  mermaidDocumentTheme: () => "default",
  renderMermaid: async () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'
}));

const mounts: { root: Root; host: HTMLElement }[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  for (const { root, host } of mounts.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
});

async function mountEditor(path: string, value: string) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  mounts.push({ host, root });
  const ref = createRef<WorkspaceTextEditorHandle>();
  await act(async () => root.render(<WorkspaceTextEditor path={path} value={value} ref={ref} ariaLabel="File text" />));
  return { host, editor: ref.current! };
}

it("matches visible Markdown text and moves the active mark between a table and source text", async () => {
  const value = [
    "# Heading", "", "| Name | Value |", "| --- | --- |", "| **Needle** | Later | hidden needle |", "",
    "needle prose", "", "![needle](image.png)", "", "```mermaid", "graph TD; needle-->B", "```",
    "", "```text", "# literal code", "```"
  ].join("\n");
  const { host, editor } = await mountEditor("table.md", value);
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  const prose = value.indexOf("needle prose");
  view.dispatch({ selection: { anchor: prose, head: prose + "needle".length } });
  const sourceSelection = editor.getSelection();
  const table = host.querySelector("table");

  expect(editor.searchState("NEEDLE")).toMatchObject({ total: 2, activeIndex: 0 });
  expect(table?.querySelector("strong .cm-doc-search-active")?.textContent).toBe("Needle");
  expect(host.querySelector(".cm-line .cm-doc-search-match")?.textContent).toBe("needle");
  expect(editor.activateSearch("NEEDLE", 1)).toMatchObject({ total: 2, activeIndex: 1 });
  expect(host.querySelector("table")).toBe(table);
  expect(table?.querySelector(".cm-doc-search-active")).toBeNull();
  expect(table?.querySelector(".cm-doc-search-match")?.textContent).toBe("Needle");
  expect(host.querySelector(".cm-line .cm-doc-search-active")?.textContent).toBe("needle");
  expect(editor.getSelection()).toEqual(sourceSelection);
  expect(editor.searchState("|").total).toBe(0);
  expect(editor.searchState("**").total).toBe(0);
  expect(editor.searchState("#").total).toBe(1);
  expect(host.querySelector(".cm-doc-search-active")?.closest(".cm-line")?.textContent).toBe("# literal code");
  editor.clearSearch();
  expect(host.querySelector(".cm-doc-search-match")).toBeNull();
  expect(editor.getValue()).toBe(value);

  const plain = await mountEditor("table.txt", value);
  expect(plain.editor.searchState("#").total).toBe(2);
  expect(plain.editor.searchState("NEEDLE").total).toBe(5);
});

it("keeps the editing cell and composition selection through a search change", async () => {
  const { host, editor } = await mountEditor("draft.md", "| Name | Value |\n| --- | --- |\n| Alpha Beta | Other |");
  const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
  cell.tabIndex = 0;
  cell.focus();
  cell.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  const text = cell.firstChild!;
  text.textContent = "Alpha Beta draft";
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(text, 6, text, 10);
  expect(editor.searchState("Alpha").total).toBe(1);
  expect(editor.searchState("Beta").total).toBe(1);
  expect(host.querySelector("tbody td")).toBe(cell);
  expect(document.activeElement).toBe(cell);
  expect(selection.anchorNode).toBe(text);
  expect(selection.toString()).toBe("Beta");
  expect(cell.textContent).toBe("Alpha Beta draft");
  expect(cell.querySelector(".cm-doc-search-match")).toBeNull();
  expect(editor.getValue()).not.toContain("draft");

  cell.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  cell.blur();
  expect(editor.getValue()).toContain("Alpha Beta draft");
  expect(host.querySelector("tbody .cm-doc-search-active")?.textContent).toBe("Beta");
});
