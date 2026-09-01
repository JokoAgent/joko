// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PortableSessionExportDialog,
  PortableSessionImportDialog,
  type PortableSessionDialogLabels,
  type PortableSessionImportDraftView,
  type PortableSessionImportResultView
} from "./PortableSessionDialogs.js";

const roots: Root[] = [];
const labels: PortableSessionDialogLabels = {
  exportTitle: "Export task",
  sensitiveWarning: "The package may contain sensitive content.",
  encrypt: "Encrypt with a password",
  password: "Password",
  confirmPassword: "Confirm password",
  showPassword: "Show password",
  hidePassword: "Hide password",
  passwordMismatch: "Passwords do not match",
  passwordTooShort: "Use at least four characters",
  cancel: "Cancel",
  export: "Export",
  exportWithoutMedia: "Export without media",
  oversizeHint: (megabytes) => `${megabytes} MB of media cannot fit.`,
  oversizeFailure: "The task is too large to export.",
  exportFailed: "Export failed.",
  importTitle: "Import task",
  chooseFile: "Choose package",
  chooseAnotherFile: "Choose another package",
  passwordPrompt: "Enter the package password.",
  unlock: "Unlock",
  wrongPassword: "Wrong password",
  previewMeta: (preview) => `${preview.messageCount} messages`,
  workerSummary: (count) => `${count} workers`,
  fidelity: (value) => `Fidelity: ${value}`,
  riskWarning: "Imported history can influence later agent behavior.",
  destination: "Destination",
  createWorktree: "Create in a worktree",
  createWorktreeHint: "Keep the imported task isolated.",
  import: "Import",
  importFailed: "Import failed.",
  conflictTitle: "This task already exists",
  conflictBody: "Replace the existing task?",
  overwrite: "Replace and import",
  importComplete: "Import complete",
  activationFailedTitle: "Imported, activation incomplete",
  activationFailedBody: (reason) => `Activation failed: ${reason}`,
  retryActivation: "Retry activation",
  activationRetryFailed: "Activation retry failed.",
  fidelityResult: (value) => `Imported with ${value} fidelity.`,
  importedWorkers: (count) => `${count} workers imported`,
  close: "Close",
  openTask: "Open task"
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("PortableSessionExportDialog", () => {
  it("validates encryption and retries an oversized export without media", async () => {
    const onExport = vi.fn()
      .mockResolvedValueOnce({ status: "oversize", mediaBytes: 12 * 1024 * 1024, limitBytes: 10 * 1024 * 1024 })
      .mockResolvedValueOnce({ status: "exported", fidelity: "partial" });
    const onExported = vi.fn();
    const onClose = vi.fn();
    const container = await render(<PortableSessionExportDialog
      open
      labels={labels}
      onClose={onClose}
      onExport={onExport}
      onExported={onExported}
    />);

    await act(async () => checkbox(container).click());
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    await change(required(inputs[0]), "abc");
    expect(buttonWithText(container, "Export").disabled).toBe(true);
    expect(container.textContent).toContain("Use at least four characters");

    await change(required(inputs[0]), "secret");
    await change(required(inputs[1]), "secret");
    await act(async () => buttonWithText(container, "Export").click());

    expect(onExport).toHaveBeenNthCalledWith(1, { password: "secret", excludeMedia: false });
    expect(container.textContent).toContain("12 MB of media cannot fit.");
    await act(async () => buttonWithText(container, "Export without media").click());
    expect(onExport).toHaveBeenNthCalledWith(2, { password: "secret", excludeMedia: true });
    expect(onExported).toHaveBeenCalledWith("partial");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("PortableSessionImportDialog", () => {
  it("unlocks, previews, confirms replacement, and opens the imported task", async () => {
    const encryptedDraft: PortableSessionImportDraftView = {
      draftId: "draft-1",
      expiresAt: Date.now() + 60_000,
      encrypted: true,
      passwordRequired: true
    };
    const previewDraft: PortableSessionImportDraftView = {
      ...encryptedDraft,
      passwordRequired: false,
      preview: preview()
    };
    const imported: PortableSessionImportResultView = {
      sessionId: "session-new",
      fidelity: "full",
      messageCount: 7,
      mediaCount: 2,
      workerCount: 1,
      replacedSessionIds: ["session-old"],
      status: "ready"
    };
    const onUnlock = vi.fn()
      .mockRejectedValueOnce({ code: "DECRYPTION_FAILED" })
      .mockResolvedValueOnce(previewDraft);
    const onCommit = vi.fn()
      .mockRejectedValueOnce({ publicError: { code: "PORTABLE_SESSION_IMPORT_CONFLICT" } })
      .mockResolvedValueOnce(imported);
    const onOpenTask = vi.fn();
    const onClose = vi.fn();
    const container = await render(<PortableSessionImportDialog
      open
      initialFile={new File(["package"], "task.jshare", { type: "application/vnd.joko.session" })}
      labels={labels}
      targets={[{ id: "target-1", label: "Local project", worktreeSupported: true }]}
      defaultTargetId="target-1"
      executionForTarget={() => ({ fastMode: true, permissionMode: "ask", planMode: false })}
      onClose={onClose}
      onInspect={vi.fn().mockResolvedValue(encryptedDraft)}
      onUnlock={onUnlock}
      onCancelDraft={vi.fn().mockResolvedValue(undefined)}
      onCommit={onCommit}
      onRetryActivation={vi.fn()}
      onOpenTask={onOpenTask}
    />);

    await flush();
    const password = required(container.querySelector<HTMLInputElement>('input[type="password"]'));
    await change(password, "wrong");
    await act(async () => buttonWithText(container, "Unlock").click());
    expect(container.textContent).toContain("Wrong password");

    await change(password, "correct");
    await act(async () => buttonWithText(container, "Unlock").click());
    expect(container.textContent).toContain("Shared task");
    await act(async () => checkbox(container).click());
    await act(async () => buttonWithText(container, "Import").click());
    expect(container.textContent).toContain("This task already exists");
    expect(onCommit).toHaveBeenNthCalledWith(1, {
      draftId: "draft-1",
      targetId: "target-1",
      execution: { fastMode: true, permissionMode: "ask", planMode: false },
      overwrite: false,
      useWorktree: true
    });

    await act(async () => buttonWithText(container, "Replace and import").click());
    expect(onCommit).toHaveBeenNthCalledWith(2, expect.objectContaining({ overwrite: true }));
    expect(container.textContent).toContain("Import complete");
    await act(async () => buttonWithText(container, "Open task").click());
    expect(onOpenTask).toHaveBeenCalledWith("session-new");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels a draft returned after the dialog unmounts", async () => {
    const inspection = deferred<PortableSessionImportDraftView>();
    const onCancelDraft = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    await act(async () => root.render(<PortableSessionImportDialog
      open
      initialFile={new File(["package"], "late.jshare")}
      labels={labels}
      targets={[]}
      executionForTarget={() => ({ fastMode: false, permissionMode: "ask", planMode: false })}
      onClose={vi.fn()}
      onInspect={() => inspection.promise}
      onUnlock={vi.fn()}
      onCancelDraft={onCancelDraft}
      onCommit={vi.fn()}
      onRetryActivation={vi.fn()}
      onOpenTask={vi.fn()}
    />));

    roots.pop();
    await act(async () => root.unmount());
    await act(async () => inspection.resolve({
      draftId: "late-draft",
      expiresAt: Date.now() + 60_000,
      encrypted: false,
      passwordRequired: false,
      preview: preview()
    }));
    expect(onCancelDraft).toHaveBeenCalledWith("late-draft");
  });

  it("commits the capability-filtered execution defaults for the selected destination", async () => {
    const onCommit = vi.fn().mockResolvedValue({
      sessionId: "session-new",
      fidelity: "product_only",
      messageCount: 1,
      mediaCount: 0,
      workerCount: 0,
      replacedSessionIds: [],
      status: "ready"
    });
    const container = await render(<PortableSessionImportDialog
      open
      initialFile={new File(["package"], "task.jshare")}
      labels={labels}
      targets={[
        { id: "target-1", label: "First", worktreeSupported: false },
        { id: "target-2", label: "Second", worktreeSupported: false }
      ]}
      defaultTargetId="target-1"
      executionForTarget={(targetId) => targetId === "target-2"
        ? { providerId: "provider", modelId: "model", fastMode: true, permissionMode: "auto", planMode: true }
        : { fastMode: false, permissionMode: "ask", planMode: false }}
      onClose={vi.fn()}
      onInspect={vi.fn().mockResolvedValue({
        draftId: "draft-2",
        expiresAt: Date.now() + 60_000,
        encrypted: false,
        passwordRequired: false,
        preview: preview()
      })}
      onUnlock={vi.fn()}
      onCancelDraft={vi.fn()}
      onCommit={onCommit}
      onRetryActivation={vi.fn()}
      onOpenTask={vi.fn()}
    />);

    await flush();
    await select(required(container.querySelector("select")), "target-2");
    await act(async () => buttonWithText(container, "Import").click());
    expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "target-2",
      execution: { providerId: "provider", modelId: "model", fastMode: true, permissionMode: "auto", planMode: true }
    }));
  });

  it("warns when a native import was persisted but activation failed, then retries without importing again", async () => {
    const onCommit = vi.fn().mockResolvedValue({
      sessionId: "session-recovery",
      fidelity: "full",
      messageCount: 3,
      mediaCount: 0,
      workerCount: 0,
      replacedSessionIds: [],
      status: "imported_activation_failed",
      activationError: {
        code: "PORTABLE_SESSION_ACTIVATION_FAILED",
        message: "Runtime unavailable",
        phase: "session_activation",
        severity: "retryable",
        retryable: true,
        recovery: []
      }
    } satisfies PortableSessionImportResultView);
    const onRetryActivation = vi.fn().mockResolvedValue({
      sessionId: "session-recovery",
      status: "ready"
    });
    const container = await render(<PortableSessionImportDialog
      open
      initialFile={new File(["package"], "task.jshare")}
      labels={labels}
      targets={[{ id: "target-1", label: "Local", worktreeSupported: false }]}
      defaultTargetId="target-1"
      executionForTarget={() => ({ fastMode: false, permissionMode: "ask", planMode: false })}
      onClose={vi.fn()}
      onInspect={vi.fn().mockResolvedValue({
        draftId: "draft-recovery",
        expiresAt: Date.now() + 60_000,
        encrypted: false,
        passwordRequired: false,
        preview: preview()
      })}
      onUnlock={vi.fn()}
      onCancelDraft={vi.fn()}
      onCommit={onCommit}
      onRetryActivation={onRetryActivation}
      onOpenTask={vi.fn()}
    />);

    await flush();
    await act(async () => buttonWithText(container, "Import").click());
    expect(container.textContent).toContain("Imported, activation incomplete");
    expect(container.textContent).toContain("Runtime unavailable");
    expect(container.textContent).not.toContain("Import complete");
    expect(() => buttonWithText(container, "Open task")).toThrow();

    await act(async () => buttonWithText(container, "Retry activation").click());
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onRetryActivation).toHaveBeenCalledWith("session-recovery");
    expect(container.textContent).toContain("Import complete");
    expect(buttonWithText(container, "Open task")).toBeDefined();
  });
});

function preview() {
  return {
    title: "Shared task",
    workspaceKind: "project" as const,
    exportedAt: Date.now(),
    applicationVersion: "1.0.0",
    backendCapability: "pi",
    fidelity: "full" as const,
    messageCount: 7,
    mediaCount: 2,
    workerCount: 1,
    nativeHistory: true
  };
}

async function render(element: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

function checkbox(container: ParentNode): HTMLInputElement {
  return required(container.querySelector<HTMLInputElement>('input[type="checkbox"]'));
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === text);
  return required(match);
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function select(input: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value");
  return value;
}
