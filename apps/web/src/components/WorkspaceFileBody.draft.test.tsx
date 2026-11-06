// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { WorkspaceFilePreviewView } from "../model.js";
import { workspaceDocumentController } from "../workspace-document-controller.js";
import { WorkspaceFileBody } from "./WorkspaceFileBody.js";

vi.mock("./WorkspaceTextEditor.js", async () => {
  const { forwardRef } = await import("react");
  return {
    WorkspaceTextEditor: forwardRef<HTMLTextAreaElement, {
      readonly value: string;
      readonly onChange?: (value: string) => void;
    }>(function Editor({ value, onChange }, ref) {
      return <textarea ref={ref} value={value} readOnly={onChange === undefined} onChange={event => onChange?.(event.target.value)} />;
    })
  };
});

it("keeps the same dirty document through a truncated refresh and waits for an explicit conflict decision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const identity = { sessionId: "draft-task", workspaceId: "draft-workspace", path: "note.md" };
  const write = vi.fn<AppController["writeWorkspaceTextFile"]>(async () => ({ path: identity.path, name: identity.path, revision: "saved" }));
  const controller = {
    state: { effectiveLocale: "en", preferences: {} },
    writeWorkspaceTextFile: write, getArtifactUrl: vi.fn(), releaseArtifactUrl: vi.fn()
  } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const original: WorkspaceFilePreviewView = {
    path: identity.path, name: identity.path, kind: "text", text: "Original text", revision: "old", truncated: false
  };
  const render = (preview: WorkspaceFilePreviewView) => act(async () => root.render(
    <WorkspaceFileBody {...identity} controller={controller} preview={preview} canWrite labels={{ overwriteDisk: "Overwrite confirmed disk" }} />
  ));
  try {
    await render(original);
    const editor = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "My unsaved draft");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render({ ...original, text: "Truncated external prefix", revision: "partial", truncated: true });
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("My unsaved draft");
    expect(host.querySelector(".workspace-file-body__truncated")).not.toBeNull();
    expect(workspaceDocumentController.dirtyDocuments()).toContainEqual(identity);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(workspaceDocumentController.requestLeave({ reason: "switch-file", prompt: async () => "save" })).resolves.toBe(false);
    });
    expect(write).not.toHaveBeenCalled();

    await render({ ...original, text: "Restored complete external text", revision: "recovered" });
    expect(host.querySelector("textarea")).toBe(editor);
    expect(editor.value).toBe("My unsaved draft");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(write).not.toHaveBeenCalled();
    const overwrite = [...host.querySelectorAll("button")].find((button) => button.textContent === "Overwrite confirmed disk")!;
    await act(async () => overwrite.click());
    expect(write).toHaveBeenCalledExactlyOnceWith(identity.workspaceId, { path: identity.path, text: "My unsaved draft", expectedRevision: "recovered" });
    expect(workspaceDocumentController.dirtyDocuments()).not.toContainEqual(identity);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
