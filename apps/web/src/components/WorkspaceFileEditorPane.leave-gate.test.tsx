// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceDocumentController, type WorkspaceLeaveChoice } from "../workspace-document-controller.js";
import { WorkspaceFileEditorPane, type WorkspaceFileEditorLabels, type WorkspaceFileEditorPaneHandle } from "./WorkspaceFileEditorPane.js";

vi.mock("./WorkspaceTextEditor.js", async () => {
  const { forwardRef, useImperativeHandle, useRef } = await import("react");
  return { WorkspaceTextEditor: forwardRef(function Editor({ value, onChange, ariaLabel }: { readonly value: string; readonly onChange: (value: string) => void; readonly ariaLabel: string }, ref) {
    const element = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({ focus: () => element.current?.focus() }));
    return <textarea ref={element} aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />;
  }) };
});

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each(["cancel", "save", "discard"] as const)("respects %s after an external file update arrives during the actual editor's leave prompt", async choice => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const controller = new WorkspaceDocumentController(), ref = createRef<WorkspaceFileEditorPaneHandle>();
  const save = vi.fn(async () => ({ revision: "saved" }));
  const documentGuard = { controller, sessionId: "session", workspaceId: "workspace" };
  const file = { path: "note.txt", revision: "original", text: "Original text" };
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const render = (revision: string, text: string) => root!.render(<WorkspaceFileEditorPane ref={ref} file={{ ...file, revision, text }} labels={labels} documentGuard={documentGuard} onSave={save} />);
  await act(async () => render(file.revision, file.text));
  const editor = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "My unsaved text");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let resolve!: (choice: WorkspaceLeaveChoice) => void;
  const prompt = vi.fn(() => new Promise<WorkspaceLeaveChoice>(finish => { resolve = finish; }));
  let leave!: Promise<boolean>;
  await act(async () => { leave = controller.requestLeave({ reason: "switch-file", prompt }); await Promise.resolve(); });
  expect(prompt).toHaveBeenCalledOnce();
  await act(async () => render("external", "External update"));
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  if (choice === "save") save.mockRejectedValueOnce(new Error("The file revision changed."));
  await act(async () => resolve(choice));
  await expect(leave).resolves.toBe(choice === "discard");
  if (choice === "cancel") {
    expect(ref.current?.getValue()).toBe("My unsaved text");
    expect(ref.current?.isDirty()).toBe(true);
    expect(save).not.toHaveBeenCalled();
  } else if (choice === "save") {
    expect(save).toHaveBeenCalledExactlyOnceWith({ path: "note.txt", text: "My unsaved text", expectedRevision: "original" });
    expect(ref.current?.getValue()).toBe("My unsaved text");
    expect(ref.current?.isDirty()).toBe(true);
  } else {
    expect(ref.current?.getValue()).toBe("External update");
    expect(save).not.toHaveBeenCalled();
  }
});

const labels: WorkspaceFileEditorLabels = { editor: "Editor", unsaved: "Unsaved", saving: "Saving", save: "Save", saveFailed: "Save failed", externalChange: "External change",
  reloadDisk: "Reload", keepEditing: "Keep editing", overwriteDisk: "Overwrite", insertTable: "Insert table", addRowAbove: "Add row above", addRowBelow: "Add row below", deleteRow: "Delete row",
  addColumnLeft: "Add column left", addColumnRight: "Add column right", deleteColumn: "Delete column", deleteTable: "Delete table", mermaidZoom: "Zoom", mermaidCopy: "Copy",
  mermaidCopied: "Copied", mermaidCopyFailed: "Copy failed", mermaidEditSource: "Edit source", mermaidRenderFailed: "Render failed" };
