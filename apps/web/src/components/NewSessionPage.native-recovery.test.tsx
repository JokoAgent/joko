// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type ComposerDraft,
  type NativeSessionCandidateView,
  type NewSessionLocalDraft
} from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
import { NewSessionPage } from "./NewSessionPage.js";

let latestEditorProps: { readonly knownWorkspacePaths?: readonly string[] } | undefined;

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(props: { readonly knownWorkspacePaths?: readonly string[] }, ref) {
    latestEditorProps = props;
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
vi.mock("./ModelPicker.js", () => ({ ModelPicker: () => <div data-testid="model-picker" /> }));
vi.mock("./HomeUsageDashboard.js", () => ({ HomeUsageDashboard: () => null }));
vi.mock("./ComposerPastedTextDialog.js", () => ({ ComposerPastedTextDialog: () => null }));

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  latestEditorProps = undefined;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("new-task native draft recovery", () => {
  it("lets a project-scoped route override the saved draft location without discarding the draft", async () => {
    const discover = vi.fn(async () => [candidate()]);
    const { container } = await renderPage(controller({ discover }), vi.fn().mockResolvedValue(undefined), "target-2");
    await flush();
    expect(container.querySelector<HTMLSelectElement>(".new-task-context__control--target select")?.value).toBe("target:target-2");
    expect(discover).toHaveBeenCalledWith("target-2");
  });

  it("lets the dialogue rail action override a saved project location", async () => {
    const discover = vi.fn(async () => [candidate()]);
    const { container } = await renderPage(controller({ discover }), vi.fn().mockResolvedValue(undefined), undefined, "backend-1");
    await flush();
    expect(container.querySelector<HTMLSelectElement>(".new-task-context__control--target select")?.value).toBe("dialogue:backend-1");
    expect(discover).not.toHaveBeenCalled();
  });

  it("keeps task naming out of the draft header", async () => {
    const { container } = await renderPage(controller({ discover: async () => [candidate()] }), vi.fn().mockResolvedValue(undefined));
    await flush();
    expect(container.querySelector(".new-task-context__control--name")).toBeNull();
    expect(container.querySelector('input[aria-label="session.taskName"]')).toBeNull();
  });

  it("blocks a restored native reference while discovery is loading and submits only after authoritative validation", async () => {
    const discovery = deferred<readonly NativeSessionCandidateView[]>();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { container } = await renderPage(controller({ discover: () => discovery.promise }), onSubmit);

    await flush();
    expect(sendButton(container).disabled).toBe(true);
    await act(async () => sendButton(container).click());
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => discovery.resolve([candidate()]));
    await flush();
    expect(sendButton(container).disabled).toBe(false);
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ nativeStart: { kind: "attach", reference: "native://restored" } }),
      expect.objectContaining({ text: "Continue this task" })
    );
  });

  it("loads the recursive workspace index for nested and post-500 mentions and discloses truncation", async () => {
    const index = deferred<{ readonly paths: readonly string[]; readonly truncated: boolean; readonly revision: string }>();
    const indexedPaths = [
      ...Array.from({ length: 501 }, (_, item) => `root-${item + 1}.ts`),
      "src/deep.ts"
    ];
    const { container } = await renderPage(controller({
      discover: async () => [candidate()],
      listWorkspaceFiles: () => index.promise
    }), vi.fn().mockResolvedValue(undefined));
    await flush();

    await openMentionMenu(container);
    expect(document.body.textContent).toContain("common.loading");
    await act(async () => index.resolve({ paths: indexedPaths, truncated: true, revision: "index-1" }));
    await flush();

    expect(latestEditorProps?.knownWorkspacePaths).toEqual(expect.arrayContaining(["root-501.ts", "src/deep.ts"]));
    const filter = required(document.body.querySelector<HTMLInputElement>('input[role="combobox"]'));
    await act(async () => setInput(filter, "deep.ts"));
    expect(document.body.textContent).toContain("src/deep.ts");
    expect(document.body.textContent).toContain("common.more");
  });

  it("keeps a workspace-index failure visible and retries it explicitly", async () => {
    const listWorkspaceFiles = vi.fn()
      .mockRejectedValueOnce(new Error("index unavailable"))
      .mockResolvedValueOnce({ paths: ["src/recovered.ts"], truncated: false, revision: "index-2" });
    const { container } = await renderPage(controller({
      discover: async () => [candidate()],
      listWorkspaceFiles
    }), vi.fn().mockResolvedValue(undefined));
    await flush();

    await openMentionMenu(container);
    expect(document.body.textContent).toContain("composer.mentionLoadFailed");
    await act(async () => buttonWithText(document.body, "common.retry").click());
    await flush();
    const filter = required(document.body.querySelector<HTMLInputElement>('input[role="combobox"]'));
    await act(async () => setInput(filter, "recovered"));
    expect(document.body.textContent).toContain("src/recovered.ts");
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it("keeps send disabled after discovery fails and exposes an explicit retry", async () => {
    const discover = vi.fn()
      .mockRejectedValueOnce(new Error("Discovery unavailable"))
      .mockResolvedValueOnce([candidate()]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { container } = await renderPage(controller({ discover }), onSubmit);

    await flush();
    expect(container.textContent).toContain("Discovery unavailable");
    expect(sendButton(container).disabled).toBe(true);
    await act(async () => buttonWithText(container, "session.nativeRetry").click());
    await flush();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(sendButton(container).disabled).toBe(false);
  });

  it.each([
    ["missing", []],
    ["bound", [candidate({ boundSessionId: "task-existing" })]],
    ["error", [candidate({ state: "error" })]]
  ] as const)("clears a restored reference when the authoritative candidate is %s", async (_label, candidates) => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    const { container } = await renderPage(controller({ discover: async () => candidates, saveDraft }), onSubmit);

    await flush();
    expect(container.textContent).toContain("session.nativeSelectionUnavailable");
    expect(sendButton(container).disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('input[name="new-task-native-session"]:checked')).toBeNull();
    await act(async () => sendButton(container).click());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

async function renderPage(
  controllerValue: AppController,
  onSubmit: (session: DelayedNewSessionDraft, input: ComposerDraft) => Promise<void>,
  initialTargetId?: string,
  initialDialogueBackendId?: string
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<NewSessionPage
    controller={controllerValue}
    snapshot={snapshot()}
    initialTargetId={initialTargetId}
    initialDialogueBackendId={initialDialogueBackendId}
    navigationOpen
    t={(key) => key}
    onOpenNavigation={vi.fn()}
    onClose={vi.fn()}
    onSubmit={onSubmit}
  />));
  return { container, root };
}

function controller(options: {
  readonly discover: () => Promise<readonly NativeSessionCandidateView[]>;
  readonly saveDraft?: (draft: NewSessionLocalDraft) => Promise<void>;
  readonly listWorkspaceFiles?: () => Promise<{ readonly paths: readonly string[]; readonly truncated: boolean; readonly revision: string }>;
}): AppController {
  return {
    state: {
      preferences: {
        locale: "en",
        composerSendShortcut: "enter",
        newSessionWorktreeEnabled: false
      }
    },
    readNewSessionDraft: vi.fn(async () => restoredDraft()),
    saveNewSessionDraft: vi.fn(options.saveDraft ?? (async () => undefined)),
    discoverNativeSessions: vi.fn(options.discover),
    probeTargetWorktree: vi.fn(async () => ({
      targetId: "target-1",
      eligibility: "unavailable",
      canRefreshRemote: false
    })),
    listTargetWorktreeSources: vi.fn(async () => []),
    listWorkspaceFiles: vi.fn(options.listWorkspaceFiles ?? (async () => ({ paths: [], truncated: false, revision: "index-empty" }))),
    setNewSessionWorktreeEnabled: vi.fn(async () => undefined)
  } as unknown as AppController;
}

function snapshot(): AppSnapshot {
  return {
    ...emptySnapshot(),
    backends: [{
      id: "backend-1",
      name: "Backend",
      version: "1",
      health: "healthy",
      capabilities: new Map([
        ["input.text", { name: "input.text", supported: true, options: [] }],
        ["input.mention", { name: "input.mention", supported: true, options: [] }],
        ["session.discovery", { name: "session.discovery", supported: true, options: [] }],
        ["session.resume", { name: "session.resume", supported: true, options: [] }]
      ])
    }],
    targets: [{
      id: "target-1",
      backendId: "backend-1",
      name: "Project",
      workspaceId: "workspace-1",
      workspaceName: "Project",
      trusted: true,
      pinned: false,
      archived: false
    }, {
      id: "target-2",
      backendId: "backend-1",
      name: "Second project",
      workspaceId: "workspace-2",
      workspaceName: "Second project",
      trusted: true,
      pinned: false,
      archived: false
    }],
    workspaces: [{
      id: "workspace-1",
      targetId: "target-1",
      name: "Project",
      kind: "userProject",
      serverPath: "/workspace",
      trusted: true,
      dirty: false,
      revision: "workspace-1",
      entries: []
    }, {
      id: "workspace-2",
      targetId: "target-2",
      name: "Second project",
      kind: "userProject",
      serverPath: "/workspace-2",
      trusted: true,
      dirty: false,
      revision: "workspace-2",
      entries: []
    }]
  };
}

function restoredDraft(): NewSessionLocalDraft {
  return {
    selection: { kind: "target", targetId: "target-1" },
    nativeStart: { kind: "attach", reference: "native://restored" },
    providerId: "",
    modelId: "",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    text: "Continue this task",
    editorDocument: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Continue this task" }] }]
    },
    mentions: [],
    attachments: []
  };
}

function candidate(overrides: Partial<NativeSessionCandidateView> = {}): NativeSessionCandidateView {
  return {
    id: "native-1",
    reference: "native://restored",
    name: "Restored native task",
    workspaceRoot: "/workspace",
    messageCount: 3,
    modifiedAt: 1,
    state: "ready",
    ...overrides
  };
}

function sendButton(container: ParentNode): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>('button[aria-label="composer.send"]'));
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === text));
}

async function openMentionMenu(container: ParentNode): Promise<void> {
  await act(async () => required(container.querySelector<HTMLButtonElement>('button[aria-label="common.add"]')).click());
  await flush();
  const mention = required([...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.includes("composer.mention") === true));
  await act(async () => mention.click());
  await flush();
}

function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
