// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { BrowserCommentDesignBaselineView } from "../model.js";
import { BrowserCommentPopover, browserCommentDesignPreview, browserCommentStyleChanges, emptyBrowserCommentEditorDraft, hasBrowserCommentDesignDraft, hasBrowserCommentEditorDraft, type BrowserCommentEditorDraft } from "./BrowserCommentPopover.js";

const baseline: BrowserCommentDesignBaselineView = {
  styles: {
    color: "rgb(38, 38, 38)",
    "background-color": "rgba(0, 0, 0, 0)",
    "font-size": "14px",
    "font-weight": "400",
    padding: "8px 12px",
    "border-radius": "6px"
  },
  editableText: "Save",
  provenance: { color: "selector .button, /app.css" }
};

describe("Browser comment styling feedback", () => {
  it("distinguishes recoverable text and design drafts from an empty editor", () => {
    expect(hasBrowserCommentEditorDraft(emptyBrowserCommentEditorDraft())).toBe(false);
    expect(hasBrowserCommentDesignDraft({ text: "keep me", styleEdits: {} })).toBe(false);
    expect(hasBrowserCommentEditorDraft({ text: "keep me", styleEdits: {} })).toBe(true);
    expect(hasBrowserCommentDesignDraft({ text: "", styleEdits: { padding: "12px" } })).toBe(true);
    expect(hasBrowserCommentDesignDraft({ text: "", styleEdits: { padding: "" } })).toBe(true);
    expect(hasBrowserCommentEditorDraft({ text: "", styleEdits: {}, textEdit: "replacement" })).toBe(true);
  });

  it("emits only visual changes while treating computed and picker colors as equivalent", () => {
    expect(browserCommentStyleChanges(baseline, {
      text: "Increase emphasis",
      textEdit: "Save now",
      styleEdits: { color: "#262626", "font-weight": "600", padding: "8px 12px" }
    })).toEqual([
      { property: "text content", previousValue: "Save", value: "Save now" },
      { property: "font-weight", previousValue: "400", value: "600" }
    ]);
  });

  it("derives a full current preview and supports deleting editable text", () => {
    expect(browserCommentDesignPreview(baseline, {
      text: "",
      textEdit: "",
      styleEdits: { "background-color": "#000000", "font-size": "16px" }
    })).toEqual({
      text: "",
      styles: { "background-color": "#000000", "font-size": "16px" }
    });
  });

  it("uses Enter to submit, Shift+Enter for a newline, and keeps IME Escape inside composition", async () => {
    const container = document.createElement("div");
    Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    document.body.append(container);
    const root = createRoot(container);
    const submit = vi.fn();
    const cancel = vi.fn();
    const preview = vi.fn();
    function Harness() {
      const [editor, setEditor] = useState<BrowserCommentEditorDraft>({ text: "Update this", styleEdits: {} });
      return <BrowserCommentPopover
        target={{ kind: "element", point: { x: 320, y: 180 }, viewport: { width: 1280, height: 720 }, designBaseline: baseline }}
        baseline={baseline}
        editor={editor}
        saving={false}
        t={(key, values) => translate("en", key, values)}
        onChange={setEditor}
        onSubmit={submit}
        onCancel={cancel}
        onPreview={preview}
        onReset={() => undefined}
      />;
    }
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
    expect(submit).not.toHaveBeenCalled();
    const composingEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(composingEscape, "isComposing", { value: true });
    await act(async () => textarea.dispatchEvent(composingEscape));
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(submit).toHaveBeenCalledWith("Update this", []);

    const styleButton = container.querySelector<HTMLButtonElement>('button[aria-label="Adjust styles"]')!;
    await act(async () => styleButton.click());
    expect(container.textContent).toContain("font-weight");
    expect(container.textContent).toContain("border-radius");
    await act(async () => root.unmount());
    container.remove();
  });
});
