// @vitest-environment jsdom

import type { JSONContent } from "@tiptap/core";
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { emptySnapshot, type AppSnapshot, type ComposerDraft, type NewSessionLocalDraft } from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
import { NewSessionPage } from "./NewSessionPage.js";

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(_props: { readonly document: JSONContent }, ref) {
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      focusFromBlankSurface: vi.fn(),
      insertRouteReference: vi.fn(),
      insertText: vi.fn(),
      editPastedText: vi.fn()
    }));
    return <div data-testid="editor" />;
  })
}));
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => null }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ComposerPastedTextDialog.js", () => ({ ComposerPastedTextDialog: () => null }));

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("NewSessionPage Full Access confirmation", () => {
  it("keeps the prior mode on cancel and sends bypassPermissions only after explicit confirmation", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    const { container } = await renderPage(controller(snapshot()), onSubmit);

    await selectPermission(container, ".is-auto");
    expect(permissionTrigger(container).textContent).toContain("permission.auto");
    await requestFullAccess(container);
    expect(permissionTrigger(container).textContent).toContain("permission.auto");
    expect(sendButton(container).disabled).toBe(true);
    await act(async () => sendButton(container).click());
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => buttonWithText(required(document.querySelector('[role="alertdialog"]')), "common.cancel").click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(permissionTrigger(container).textContent).toContain("permission.auto");

    await requestFullAccess(container);
    await act(async () => buttonWithText(required(document.querySelector('[role="alertdialog"]')), "common.enable permission.full").click());
    expect(permissionTrigger(container).textContent).toContain("permission.full");
    expect(sendButton(container).disabled).toBe(false);

    await act(async () => sendButton(container).click());
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ permissionMode: "bypassPermissions" }));
  });

  it("retires pending confirmation across selection, Backend, and owner Document lifecycles", async () => {
    const onSubmit = vi.fn(async (_session: DelayedNewSessionDraft, _input: ComposerDraft) => undefined);
    const initial = controller(snapshot());
    const { container, rerender } = await renderPage(initial, onSubmit);

    await requestFullAccess(container);
    const selectionConfirmation = confirmButton();
    await act(async () => setSelect(required(container.querySelector<HTMLSelectElement>(".new-task-context__control--target select")), "target:target-2"));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => selectionConfirmation.click());
    expect(permissionTrigger(container).textContent).toContain("permission.ask");

    await requestFullAccess(container);
    const backendConfirmation = confirmButton();
    await rerender(controller(snapshot(2)));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => backendConfirmation.click());
    expect(permissionTrigger(container).textContent).toContain("permission.ask");

    await requestFullAccess(container);
    const documentConfirmation = confirmButton();
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => documentConfirmation.click());
    expect(permissionTrigger(container).textContent).toContain("permission.ask");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

async function renderPage(
  controllerValue: AppController,
  onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft) => Promise<void>
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const rerender = async (nextController: AppController): Promise<void> => {
    await act(async () => root.render(<NewSessionPage
      controller={nextController}
      snapshot={nextController.state.snapshot}
      navigationOpen
      t={(key) => key}
      onOpenNavigation={vi.fn()}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />));
    await flush();
  };
  await rerender(controllerValue);
  return { container, rerender };
}

function controller(snapshotValue: AppSnapshot): AppController {
  return {
    state: {
      connectionState: "connected",
      snapshot: snapshotValue,
      preferences: { locale: "en", composerSendShortcut: "enter", newSessionWorktreeEnabled: false }
    },
    readNewSessionDraft: vi.fn(async () => draft()),
    saveNewSessionDraft: vi.fn(async () => undefined),
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []),
    setNewSessionWorktreeEnabled: vi.fn(async () => undefined)
  } as unknown as AppController;
}

function snapshot(instanceGeneration = 1): AppSnapshot {
  const initial = emptySnapshot();
  return {
    ...initial,
    backends: [{
      id: "backend-1",
      name: "Backend",
      version: "1",
      instanceGeneration,
      health: "healthy",
      capabilities: new Map([
        ["input.text", { name: "input.text", supported: true, options: [] }],
        ["permission.modes", { name: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }]
      ])
    }],
    targets: [target("target-1", "workspace-1"), target("target-2", "workspace-2")],
    workspaces: [workspace("target-1", "workspace-1"), workspace("target-2", "workspace-2")]
  };
}

function target(id: string, workspaceId: string) {
  return {
    id,
    backendId: "backend-1",
    name: id,
    workspaceId,
    revision: 1n,
    workspaceName: id,
    trusted: true,
    pinned: false,
    archived: false
  };
}

function workspace(targetId: string, id: string) {
  return {
    id,
    targetId,
    name: id,
    kind: "userProject" as const,
    serverPath: `/${id}`,
    trusted: true,
    dirty: false,
    revision: id,
    entries: []
  };
}

function draft(): NewSessionLocalDraft {
  return {
    selection: { kind: "target", targetId: "target-1" },
    nativeStart: { kind: "fresh" },
    providerId: "",
    modelId: "",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    text: "Ship it",
    editorDocument: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ship it" }] }] },
    mentions: [],
    inlineMentionRanges: [],
    attachments: []
  };
}

async function requestFullAccess(container: ParentNode): Promise<void> {
  await selectPermission(container, ".is-danger");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
}

async function selectPermission(container: ParentNode, optionSelector: string): Promise<void> {
  await act(async () => permissionTrigger(container).click());
  const option = required(document.querySelector<HTMLButtonElement>(`.permission-selector__list > button${optionSelector}`));
  await act(async () => option.click());
}

function permissionTrigger(container: ParentNode): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>(".permission-selector__trigger"));
}

function sendButton(container: ParentNode): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>("button.send-button"));
}

function confirmButton(): HTMLButtonElement {
  return buttonWithText(required(document.querySelector('[role="alertdialog"]')), "common.enable permission.full");
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text));
}

function setSelect(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
