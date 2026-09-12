// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { JSONContent } from "@tiptap/core";
import { composerDocumentPlainText, emptyComposerDocument, plainTextToComposerDocument } from "../composer-quote-document.js";
import { remapComposerInlineMentionReplacement } from "../composer-mention-ranges.js";
import type { VoiceMediaSessionUpdate } from "../voice-input-media.js";
import { readVoiceInputPreferences } from "../voice-input-preferences.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type ComposerDraft,
  type ComposerInlineMentionRange,
  type ComposerMentionDraft,
  type NativeSessionCandidateView,
  type NewSessionLocalDraft,
  type ModelView,
  type ProviderRuntimeView,
  type SessionView,
  type VoiceInputDictionaryAdviceView
} from "../model.js";
import type { DelayedNewSessionDraft } from "../new-session-flow.js";
import { NewSessionPage } from "./NewSessionPage.js";

let latestEditorProps: { readonly knownWorkspacePaths?: readonly string[]; readonly document?: JSONContent; readonly onDocumentChange?: (document: JSONContent, isComposing: boolean, mapRanges?: (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[]) => void } | undefined;
let renderVoiceSelection = false;
const voiceCaptures: Array<{
  emit(update: VoiceMediaSessionUpdate): void;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("../voice-input-media.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../voice-input-media.js")>(),
  supportsVoiceMediaCapture: () => true,
  VoiceInputMediaSession: class {
    currentState = "idle";
    constructor(private readonly options: { onUpdate(update: VoiceMediaSessionUpdate): void }) { voiceCaptures.push(this); }
    emit(update: VoiceMediaSessionUpdate): void { this.currentState = update.state; this.options.onUpdate(update); }
    async start(): Promise<void> { this.emit({ state: "starting" }); }
    stop = vi.fn(async () => this.emit({ state: "submitting" }));
    cancel = vi.fn(async () => this.emit({ state: "cancelled" }));
    dispose = vi.fn(async () => this.emit({ state: "cancelled" }));
  }
}));

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: forwardRef(function Editor(props: { readonly knownWorkspacePaths?: readonly string[]; readonly document: JSONContent }, ref) {
    latestEditorProps = props;
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      focusFromBlankSurface: vi.fn(),
      insertRouteReference: vi.fn(),
      insertText: vi.fn(),
      editPastedText: vi.fn()
    }));
    return <div data-testid="editor" className={renderVoiceSelection ? "composer-rich-editor__content" : undefined}>{renderVoiceSelection ? composerDocumentPlainText(props.document) : null}</div>;
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
  renderVoiceSelection = false;
  voiceCaptures.length = 0;
  window.localStorage.clear();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "mediaDevices");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("new-task native draft recovery", () => {
  it("blocks a retained workspace mention when its type disappears during pending draft persistence", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const mention: ComposerMentionDraft = { id: "file", kind: "workspace", reference: "notes.txt", label: "Notes", token: "@notes.txt", workspaceId: "workspace-1" };
    const draft: NewSessionLocalDraft = { ...restoredDraft(), nativeStart: { kind: "fresh" }, text: "@notes.txt", editorDocument: plainTextToComposerDocument("@notes.txt"), mentions: [mention], inlineMentionRanges: [{ mentionId: "file", from: 0, to: 10 }] };
    const api = Object.assign(controller({ discover: async () => [], saveDraft: save }), { readNewSessionDraft: vi.fn(async () => draft) });
    const withOptions = (options: readonly string[]): AppController => ({ ...api, state: { ...api.state, snapshot: { ...api.state.snapshot,
      backends: api.state.snapshot.backends.map((backend) => ({ ...backend, capabilities: new Map([...backend.capabilities, ["input.mention", { name: "input.mention", supported: true, options }]]) }))
    } } });
    const onSubmit = vi.fn(async () => undefined);
    const { container, rerender } = await renderPage(withOptions(["workspace_file"]), onSubmit);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => sendButton(container).click());
    await rerender(withOptions(["artifact"]));
    await act(async () => { release(); await Promise.resolve(); });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(sendButton(container).disabled).toBe(true);
    expect(composerDocumentPlainText(latestEditorProps?.document)).toBe("@notes.txt");
    await rerender(withOptions(["workspace_file"]));
    expect(sendButton(container).disabled).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers no workspace or resource candidates in a new-task Artifact-only profile", async () => {
    const base = controller({ discover: async () => [] });
    const api = { ...base, state: { ...base.state, snapshot: { ...base.state.snapshot, backends: base.state.snapshot.backends.map((backend) => ({ ...backend,
      capabilities: new Map([...backend.capabilities, ["input.mention", { name: "input.mention", supported: true, options: ["artifact"] }]])
    })) } } };
    const { container } = await renderPage(api, vi.fn(async () => undefined));
    expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
    const add = container.querySelector<HTMLButtonElement>('button[aria-label="common.add"]');
    expect(add).toBeNull();
    await act(async () => required(latestEditorProps?.onDocumentChange)(plainTextToComposerDocument("@"), false, (ranges) => ranges));
    expect(document.body.querySelector('[role="option"]')).toBeNull();
  });

  it("submits the exact historical task selected from equal-title candidates", async () => {
    const base = controller({ discover: async () => [] });
    const api = Object.assign({
      ...base,
      state: { ...base.state, snapshot: {
        ...base.state.snapshot,
        sessions: [
          historicalSession({ id: "history-one", name: "Prior task", summary: "First conversation" }),
          historicalSession({ id: "history-two", name: "Prior task", summary: "Second conversation" }),
          historicalSession({ id: "history-closed", name: "Prior task", summary: "Closed conversation", state: "closed" })
        ],
        backends: base.state.snapshot.backends.map((backend) => ({
          ...backend,
          capabilities: new Map([...backend.capabilities, ["input.mention", {
            name: "input.mention", supported: true, options: ["session"]
          }]])
        }))
      } }
    }, {
      readNewSessionDraft: vi.fn(async () => ({
        ...restoredDraft(),
        nativeStart: { kind: "fresh" },
        text: "",
        editorDocument: emptyComposerDocument
      }))
    }) as unknown as AppController;
    const onSubmit = vi.fn(async () => undefined);
    const { container } = await renderPage(api, onSubmit);

    await openMentionMenu(container);
    await act(async () => setInput(required(document.body.querySelector<HTMLInputElement>('input[role="combobox"]')), "Prior task"));
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "Prior taskFirst conversation",
      "Prior taskSecond conversation"
    ]);
    await act(async () => required(options.find((option) => option.textContent?.includes("Second conversation") === true)).click());
    await act(async () => sendButton(container).click());

    const token = '@"Prior task"';
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      text: token,
      mentions: [{
        id: "session:history-two",
        kind: "session",
        reference: "history-two",
        label: "Prior task",
        token
      }],
      inlineMentionRanges: [{ mentionId: "session:history-two", from: 0, to: token.length }]
    }), expect.anything());
    expect(api.listWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("keeps repeated equal-name references at their persisted positions and sends only the occurrence left by the editor transaction", async () => {
    vi.useFakeTimers();
    const draft = repeatedMentionDraft();
    const api = Object.assign(controller({ discover: async () => [] }), { readNewSessionDraft: vi.fn(async () => draft) });
    const onSubmit = vi.fn(async () => undefined);
    const { container } = await renderPage(api, onSubmit);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      mentions: draft.mentions, inlineMentionRanges: draft.inlineMentionRanges
    }));
    await act(async () => required(latestEditorProps?.onDocumentChange)(plainTextToComposerDocument("@same"), false,
      (ranges) => remapComposerInlineMentionReplacement(ranges, 0, 12, 0)));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const retained = [draft.mentions[1]!];
    const ranges = [{ mentionId: "workspace:first", from: 0, to: 5 }];
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "@same", mentions: retained, inlineMentionRanges: ranges }));
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      text: "@same", mentions: retained, inlineMentionRanges: ranges
    }), expect.anything());
    onSubmit.mockClear();
    await act(async () => required(latestEditorProps?.onDocumentChange)(plainTextToComposerDocument("@same"), false));
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      text: "@same", mentions: [], inlineMentionRanges: []
    }), expect.anything());
  });

  it("persists exact palette append locations and clears them when a quick start or unowned text replaces the draft", async () => {
    vi.useFakeTimers();
    const draft = repeatedMentionDraft();
    const api = Object.assign(controller({ discover: async () => [], listWorkspaceFiles: async () => ({ paths: ["src/guide.md"], truncated: false, revision: "files" }) }), {
      readNewSessionDraft: vi.fn(async () => draft)
    });
    const onSubmit = vi.fn(async () => undefined);
    const { container } = await renderPage(api, onSubmit);
    await openMentionMenu(container);
    await act(async () => setInput(required(document.body.querySelector<HTMLInputElement>('input[role="combobox"]')), "guide"));
    await act(async () => required(document.body.querySelector<HTMLButtonElement>('[role="option"]')).click());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      text: "@same @same @same @src/guide.md",
      inlineMentionRanges: [...draft.inlineMentionRanges!, { mentionId: "workspace:workspace-1:src/guide.md", from: 18, to: 31 }]
    }));
    await act(async () => buttonWithText(container, "newTask.quickExplore").click());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ mentions: [], inlineMentionRanges: [] }));
    await act(async () => required(latestEditorProps?.onDocumentChange)(plainTextToComposerDocument("@same"), false));
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ text: "@same", mentions: [], inlineMentionRanges: [] }), expect.anything());
  });

  it("retires the selected mention when voice replaces it with the same spelling and preserves other occurrences for first send", async () => {
    vi.useFakeTimers();
    renderVoiceSelection = true;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
    const draft = repeatedMentionDraft();
    const api = Object.assign(controller({ discover: async () => [] }), {
      getVoiceInputCapabilities: vi.fn(async () => ({ support: "supported" })),
      readNewSessionDraft: vi.fn(async () => draft)
    });
    const onSubmit = vi.fn(async () => undefined);
    const { container } = await renderPage(api, onSubmit);
    const textNode = required(container.querySelector('[data-testid="editor"]')?.firstChild);
    const selection = document.createRange(); selection.setStart(textNode, 0); selection.setEnd(textNode, 5);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(selection);
    await act(async () => required(container.querySelector<HTMLButtonElement>('.voice-input-button button')).click());
    const capture = required(voiceCaptures.at(-1));
    await act(async () => sendButton(container).click());
    expect(capture.stop).toHaveBeenCalledOnce();
    await act(async () => capture.emit(voiceResult("@same")));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      text: "@same @same @same", mentions: draft.mentions,
      inlineMentionRanges: draft.inlineMentionRanges!.slice(1)
    }), expect.anything());
  });

  it.each(["before recovery", "after recovery"])("keeps a model removed from the catalog %s without choosing an available substitute", async (when) => {
    vi.useFakeTimers();
    const selectedModel: ModelView = {
      backendId: "backend-1", providerId: "source-one", providerName: "Source one", modelId: "original-model", name: "Original model",
      available: true, supportsImages: false, supportsFast: true, inputModalities: ["text"], outputModalities: ["text"],
      efforts: ["low", "high"], contextWindow: 8192, maximumOutputTokens: 2048, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD"
    };
    const base = snapshot();
    const makeSnapshot = (missing: boolean): AppSnapshot => ({ ...base,
      backends: base.backends.map((backend) => ({ ...backend, authenticationState: "authenticated", capabilities: new Map([...backend.capabilities,
        ...["model.switch", "model.effort", "model.fast_mode"].map((name) => [name, { name, supported: true, options: [] }] as const)]) })),
      models: [...(missing ? [] : [selectedModel]), { ...selectedModel, modelId: "substitute-model", name: "Available substitute" }]
    });
    const original = controller({ discover: async () => [] });
    const api = { ...original, state: { ...original.state, snapshot: makeSnapshot(when === "before recovery") },
      readNewSessionDraft: vi.fn(async () => ({ ...restoredDraft(), nativeStart: { kind: "fresh" }, providerId: selectedModel.providerId, modelId: selectedModel.modelId, effort: "high", fastMode: true })),
      refreshProviderModels: vi.fn(async () => undefined)
    } as unknown as AppController;
    const onSubmit = vi.fn(async () => undefined);
    const { container, rerender } = await renderPage(api, onSubmit);
    if (when === "after recovery") await rerender({ ...api, state: { ...api.state, snapshot: makeSnapshot(true) } });
    expect(sendButton(container).disabled).toBe(true);
    expect(container.querySelector('.composer__source-notice')?.textContent).toContain("original-model · source-one");
    expect(container.querySelector('.composer__source-notice')?.textContent).toContain("modelPicker.modelMissing");
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: "source-one", modelId: "original-model", effort: "high", fastMode: true, text: "Continue this task" }));
    vi.mocked(api.refreshProviderModels).mockRejectedValueOnce(new Error("Source cannot be reached"));
    await act(async () => { buttonWithText(container, "modelPicker.checkSource").click(); buttonWithText(container, "modelPicker.checkSource").click(); });
    expect(api.refreshProviderModels).toHaveBeenCalledExactlyOnceWith("backend-1", "source-one", false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("modelPicker.sourceCheckFailed");
    await act(async () => buttonWithText(container, "modelPicker.checkSource").click());
    expect(api.refreshProviderModels).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    await rerender({ ...api, state: { ...api.state, snapshot: makeSnapshot(false) } });
    expect(sendButton(container).disabled).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerId: "source-one", modelId: "original-model", effort: "high", fastMode: true }),
      expect.objectContaining({ text: "Continue this task" }), expect.anything());
  });

  it("recovers a native default without selecting another provider or automatically submitting the first input", async () => {
    vi.useFakeTimers();
    const base = snapshot();
    const makeSnapshot = (authenticationState: "expired" | "authenticated"): AppSnapshot => ({ ...base,
      backends: base.backends.map((backend) => ({ ...backend, authenticationState, capabilities: new Map([...backend.capabilities,
        ["model.switch", { name: "model.switch", supported: true, options: [] }]]) }))
    });
    const original = controller({ discover: async () => [] });
    const api = { ...original, state: { ...original.state, snapshot: makeSnapshot("expired") },
      readNewSessionDraft: vi.fn(async () => ({ ...restoredDraft(), nativeStart: { kind: "fresh" } })),
      refreshProviderModels: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined)
    } as unknown as AppController;
    const onSubmit = vi.fn(async () => undefined);
    const { container, rerender } = await renderPage(api, onSubmit);
    expect(sendButton(container).disabled).toBe(true);
    expect(container.querySelector('.composer__source-notice')?.textContent).toContain("settings.backendNativeDefault");
    expect(container.querySelector('.composer__source-notice')?.textContent).toContain("providerAuth.expired");
    await act(async () => buttonWithText(container, "modelPicker.checkSource").click());
    expect(api.refresh).toHaveBeenCalledOnce();
    expect(api.refreshProviderModels).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    await rerender({ ...api, state: { ...api.state, snapshot: makeSnapshot("authenticated") } });
    expect(sendButton(container).disabled).toBe(false);
    expect(container.querySelector('.composer__source-notice')).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerId: "", modelId: "", fastMode: false }),
      expect.objectContaining({ text: "Continue this task" }), expect.anything());
  });

  it("retains a disconnected draft model, authorizes its exact source and requires an explicit first send after recovery", async () => {
    vi.useFakeTimers();
    const selectedModel: ModelView = {
      backendId: "backend-1", providerId: "source-one", providerName: "Source one", modelId: "model-one", name: "Model one",
      available: false, supportsImages: false, supportsFast: true, inputModalities: ["text"], outputModalities: ["text"],
      efforts: ["low", "high"], contextWindow: 8192, maximumOutputTokens: 2048, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD"
    };
    const provider: ProviderRuntimeView = {
      backendId: "backend-1", id: "source-one", name: "Source one", kind: "oauth", compatibility: "native",
      authenticationState: "expired", endpoint: "", ownerManaged: false, supportsLogin: true, loginMethods: ["deviceCode"],
      supportsLogout: true, supportsRefresh: true, credentialSurfaces: [], capabilities: new Set()
    };
    const base = snapshot();
    const makeSnapshot = (ready: boolean): AppSnapshot => ({ ...base,
      backends: base.backends.map((backend) => ({ ...backend, capabilities: new Map([...backend.capabilities,
        ["model.switch", { name: "model.switch", supported: true, options: [] }],
        ["model.effort", { name: "model.effort", supported: true, options: [] }],
        ["model.fast_mode", { name: "model.fast_mode", supported: true, options: [] }]]) })),
      models: [{ ...selectedModel, available: ready }], providers: [{ ...provider, authenticationState: ready ? "authenticated" : "expired" }]
    });
    const original = controller({ discover: async () => [] });
    const api = { ...original, state: { ...original.state, snapshot: makeSnapshot(false) },
      readNewSessionDraft: vi.fn(async () => ({ ...restoredDraft(), nativeStart: { kind: "fresh" }, providerId: provider.id, modelId: selectedModel.modelId, effort: "high", fastMode: true })),
      beginProviderLogin: vi.fn(async () => ({ id: "login-one", providerId: provider.id, method: "deviceCode", state: "completed", updatedAt: 1 })),
      refresh: vi.fn(async () => undefined)
    } as unknown as AppController;
    const onSubmit = vi.fn(async () => undefined);
    const { container, rerender } = await renderPage(api, onSubmit);
    expect(container.querySelector('.composer__source-notice')?.textContent).toContain("Model one · Source one");
    expect(container.querySelector('.composer__source-notice')?.textContent).toContain("providerAuth.expired");
    expect(sendButton(container).disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ providerId: provider.id, modelId: selectedModel.modelId, effort: "high", fastMode: true, text: "Continue this task" }));
    await act(async () => buttonWithText(container, "providerLogin.signIn").click());
    await act(async () => buttonWithText(document.body, "providerLogin.start").click());
    expect(api.beginProviderLogin).toHaveBeenCalledExactlyOnceWith("backend-1", provider.id, "deviceCode");
    expect(api.refresh).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    await rerender({ ...api, state: { ...api.state, snapshot: makeSnapshot(true) } });
    expect(container.querySelector('.composer__source-notice')).toBeNull();
    expect(sendButton(container).disabled).toBe(false);
    expect(composerDocumentPlainText(required(latestEditorProps?.document))).toBe("Continue this task");
    await rerender({ ...api, state: { ...api.state, snapshot: makeSnapshot(false) } });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(api.beginProviderLogin).toHaveBeenCalledTimes(1);
    await rerender({ ...api, state: { ...api.state, snapshot: makeSnapshot(true) } });
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerId: provider.id, modelId: selectedModel.modelId, effort: "high", fastMode: true }),
      expect.objectContaining({ text: "Continue this task" }), expect.anything());
  });

  it("waits for the held capture's final success before first submission and cancels its send intent on target change", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
    const api = Object.assign(controller({ discover: async () => [] }), {
      getVoiceInputCapabilities: vi.fn(async () => ({ support: "supported" })),
      readNewSessionDraft: vi.fn(async () => ({ ...restoredDraft(), nativeStart: { kind: "fresh" }, text: "Existing:", editorDocument: plainTextToComposerDocument("Existing:") }))
    }) as unknown as AppController;
    const onSubmit = vi.fn(async () => undefined);
    const { container } = await renderPage(api, onSubmit);
    const start = async () => { await act(async () => required(container.querySelector<HTMLButtonElement>('.voice-input-button button')).click()); return required(voiceCaptures.at(-1)); };
    const first = await start();
    await act(async () => { sendButton(container).click(); sendButton(container).click(); });
    expect(first.stop).toHaveBeenCalledOnce(); expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => first.emit({ state: "submitting", session: { ...voiceResult("interim").session!, state: "refining", outcome: undefined } }));
    expect(container.querySelector('.voice-input-overlay[data-state="refining"]')).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => first.emit(voiceResult("final")));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ selection: { kind: "target", targetId: "target-1" } }), expect.objectContaining({ text: "Existing:final" }), expect.objectContaining({ ownerDocument: document, signal: expect.any(AbortSignal) }));
    const second = await start();
    await act(async () => sendButton(container).click());
    await act(async () => { const select = required(container.querySelector<HTMLSelectElement>(".new-task-context__control--target select")); select.value = "target:target-2"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => second.emit(voiceResult("late")));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(composerDocumentPlainText(required(latestEditorProps?.document))).toBe("Existing:final");
  });

  it("learns first-prompt voice corrections while fencing cancelled capture, target changes and task creation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaRecorder", class {});
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const adviceResults: Array<ReturnType<typeof deferred<VoiceInputDictionaryAdviceView>>> = [];
    const advice = vi.fn((_draft: unknown, _signal?: AbortSignal) => {
      const result = deferred<VoiceInputDictionaryAdviceView>();
      adviceResults.push(result);
      return result.promise;
    });
    const api = Object.assign(controller({ discover: async () => [] }), {
      getVoiceInputCapabilities: vi.fn(async () => ({ support: "supported" })),
      adviseVoiceInputDictionaryEdit: advice,
      readNewSessionDraft: vi.fn(async () => ({ ...restoredDraft(), nativeStart: { kind: "fresh" }, text: "", editorDocument: emptyComposerDocument() })),
      createSession: vi.fn()
    }) as unknown as AppController;
    const { container, rerender } = await renderPage(api, onSubmit);
    const edit = async (text: string, isComposing = false) => {
      await act(async () => required(latestEditorProps?.onDocumentChange)(plainTextToComposerDocument(text), isComposing));
    };
    const startCapture = async () => {
      await act(async () => required(container.querySelector<HTMLButtonElement>('button[aria-label="voice.start"]')).click());
      return required(voiceCaptures.at(-1));
    };
    const dictionaryAdvice = (term: string): VoiceInputDictionaryAdviceView => ({ actions: [{ action: "addEntry", term, aliases: ["voice kit"], type: "productName", confidence: "high" }] });
    await flush();
    await act(async () => required(container.querySelector<HTMLButtonElement>('button[aria-label="voice.start"]')).click());
    expect(container.querySelector('.voice-input-overlay[data-state="starting"]')).not.toBeNull();
    expect(sendButton(container).disabled).toBe(false);
    const first = required(voiceCaptures[0]);
    await act(async () => first.emit({ state: "listening" }));
    await act(async () => required(container.querySelector<HTMLButtonElement>('button[aria-label="voice.stop"]')).click());
    expect(first.stop).toHaveBeenCalledOnce();
    await act(async () => first.emit(voiceResult("voice kit", "raw voice kit")));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(composerDocumentPlainText(required(latestEditorProps?.document))).toBe("voice kit");
    expect(api.saveNewSessionDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "voice kit" }));
    expect(api.createSession).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(sendButton(container).disabled).toBe(false);
    expect(advice).not.toHaveBeenCalled();
    await edit("VoiceKit");
    await edit("VoiceKit unfinished", true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(advice).not.toHaveBeenCalled();
    await edit("VoiceKit");
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    const refreshedAdvice = vi.fn(advice);
    await rerender({ ...api, state: { ...api.state }, adviseVoiceInputDictionaryEdit: refreshedAdvice });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(advice).toHaveBeenCalledOnce();
    expect(refreshedAdvice).toHaveBeenCalledOnce();
    expect(api.getVoiceInputCapabilities).toHaveBeenCalledOnce();
    expect(advice.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ beforeText: "voice kit", afterText: "VoiceKit", rawTranscriptText: "raw voice kit" }));
    await act(async () => required(adviceResults[0]).resolve(dictionaryAdvice("VoiceKit")));
    expect(readVoiceInputPreferences().dictionary.entries.map((entry) => entry.text)).toEqual(["VoiceKit"]);

    const retired = await startCapture();
    await act(async () => retired.emit(voiceResult("sound kit")));
    await edit("VoiceKitSoundKit");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(advice).toHaveBeenCalledTimes(2);
    const selection = required(container.querySelector<HTMLSelectElement>(".new-task-context__control--target select"));
    await act(async () => {
      selection.value = "target:target-2";
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(retired.dispose).toHaveBeenCalledOnce();
    expect(advice.mock.calls[1]?.[1]?.aborted).toBe(true);
    await act(async () => required(adviceResults[1]).resolve(dictionaryAdvice("SoundKit")));
    await act(async () => retired.emit(voiceResult("Must not replace the retained draft")));
    expect(composerDocumentPlainText(required(latestEditorProps?.document))).toBe("VoiceKitSoundKit");
    expect(readVoiceInputPreferences().dictionary.entries.map((entry) => entry.text)).toEqual(["VoiceKit"]);
    expect(onSubmit).not.toHaveBeenCalled();

    const moved = await startCapture();
    await act(async () => {
      selection.value = "target:target-1";
      selection.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(moved.dispose).toHaveBeenCalledOnce();
    await act(async () => moved.emit(voiceResult("Late result from a different target")));
    expect(composerDocumentPlainText(required(latestEditorProps?.document))).toBe("VoiceKitSoundKit");

    const cancelled = await startCapture();
    await act(async () => required(container.querySelector<HTMLElement>('[data-testid="editor"]')).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(cancelled.cancel).toHaveBeenCalledOnce();
    await act(async () => cancelled.emit(voiceResult("Cancelled result")));
    expect(composerDocumentPlainText(required(latestEditorProps?.document))).toBe("VoiceKitSoundKit");
    await edit("VoiceKitSoundKit updated");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(advice).toHaveBeenCalledTimes(2);

    const submitted = await startCapture();
    await act(async () => submitted.emit(voiceResult("ship kit")));
    await edit("VoiceKitSoundKit updatedShipKit");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(advice).toHaveBeenCalledTimes(3);
    await act(async () => sendButton(container).click());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ selection: { kind: "target", targetId: "target-1" } }), expect.objectContaining({ text: "VoiceKitSoundKit updatedShipKit" }), expect.objectContaining({ ownerDocument: document, isCurrent: expect.any(Function) }));
    expect(advice.mock.calls[2]?.[1]?.aborted).toBe(true);
    await act(async () => required(adviceResults[2]).resolve(dictionaryAdvice("ShipKit")));
    expect(readVoiceInputPreferences().dictionary.entries.map((entry) => entry.text)).toEqual(["VoiceKit"]);
  });

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
      expect.objectContaining({ text: "Continue this task" }),
      expect.objectContaining({ ownerDocument: document, isCurrent: expect.any(Function) })
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
  const rerender = async (nextController: AppController) => act(async () => root.render(<NewSessionPage
    controller={nextController}
    snapshot={nextController.state.snapshot}
    initialTargetId={initialTargetId}
    initialDialogueBackendId={initialDialogueBackendId}
    navigationOpen
    t={(key) => key}
    onOpenNavigation={vi.fn()}
    onClose={vi.fn()}
    onSubmit={onSubmit}
  />));
  await rerender(controllerValue);
  return { container, root, rerender };
}

function controller(options: {
  readonly discover: () => Promise<readonly NativeSessionCandidateView[]>;
  readonly saveDraft?: (draft: NewSessionLocalDraft) => Promise<void>;
  readonly listWorkspaceFiles?: () => Promise<{ readonly paths: readonly string[]; readonly truncated: boolean; readonly revision: string }>;
}): AppController {
  return {
    state: {
      connectionState: "connected",
      snapshot: snapshot(),
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
  const initial = emptySnapshot();
  return {
    ...initial,
    settings: { ...initial.settings, voiceInput: { ...initial.settings.voiceInput, refinementEnabled: true } },
    backends: [{
      id: "backend-1",
      name: "Backend",
      version: "1",
      health: "healthy",
      capabilities: new Map([
        ["input.text", { name: "input.text", supported: true, options: [] }],
        ["input.mention", { name: "input.mention", supported: true, options: ["workspace_file", "resource"] }],
        ["session.discovery", { name: "session.discovery", supported: true, options: [] }],
        ["session.resume", { name: "session.resume", supported: true, options: [] }]
      ])
    }],
    targets: [{
      id: "target-1",
      backendId: "backend-1",
      name: "Project",
      workspaceId: "workspace-1",
      revision: 1n,
      workspaceName: "Project",
      trusted: true,
      pinned: false,
      archived: false
    }, {
      id: "target-2",
      backendId: "backend-1",
      name: "Second project",
      workspaceId: "workspace-2",
      revision: 1n,
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
    inlineMentionRanges: [],
    attachments: []
  };
}

function repeatedMentionDraft(): NewSessionLocalDraft {
  const mentions: readonly ComposerMentionDraft[] = [
    { id: "workspace:second", kind: "workspace", reference: "second.ts", label: "same", token: "@same", workspaceId: "workspace-1" },
    { id: "workspace:first", kind: "workspace", reference: "first.ts", label: "same", token: "@same", workspaceId: "workspace-1" }
  ];
  return { ...restoredDraft(), nativeStart: { kind: "fresh" }, text: "@same @same @same",
    editorDocument: plainTextToComposerDocument("@same @same @same"), mentions,
    inlineMentionRanges: [
      { mentionId: "workspace:first", from: 0, to: 5 },
      { mentionId: "workspace:second", from: 6, to: 11 },
      { mentionId: "workspace:first", from: 12, to: 17 }
    ]
  };
}

function historicalSession(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "history-one",
    backendId: "backend-1",
    targetId: "target-1",
    name: "Prior task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1,
    ...overrides
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

function voiceResult(text: string, rawTranscriptText?: string): VoiceMediaSessionUpdate {
  return { state: "done", session: {
    id: "voice-draft", state: "done", outcome: "success", nextChunkSequence: 1n,
    acceptedAudioBytes: 0, acceptedAudioDurationMs: 0, createdAt: 0, updatedAt: 0,
    recoveryAttempts: 0, stallWarning: false,
    result: { text, source: "stable", salvaged: false, ...(rawTranscriptText === undefined ? {} : { rawTranscriptText }) }
  } };
}

function sendButton(container: ParentNode): HTMLButtonElement {
  return required(container.querySelector<HTMLButtonElement>('button.send-button'));
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
