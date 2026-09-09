// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { composerDocumentPlainText, plainTextToComposerDocument } from "../composer-quote-document.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type VoiceInputDictionaryAdviceView } from "../model.js";
import type { VoiceMediaSessionUpdate } from "../voice-input-media.js";
import { readVoiceInputPreferences } from "../voice-input-preferences.js";
import { Composer } from "./Composer.js";

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: (props: {
    document: JSONContent;
    onDocumentChange(document: JSONContent, isComposing: boolean): void;
  }) => <textarea aria-label="Draft" value={composerDocumentPlainText(props.document)}
    onChange={(event) => props.onDocumentChange(plainTextToComposerDocument(event.target.value), false)} />
}));

vi.mock("../voice-input-media.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../voice-input-media.js")>(),
  supportsVoiceMediaCapture: () => true,
  VoiceInputMediaSession: class {
    currentState = "idle";
    constructor(private readonly options: { onUpdate(update: VoiceMediaSessionUpdate): void }) { captures.push(this); }
    emit(update: VoiceMediaSessionUpdate) { this.currentState = update.state; this.options.onUpdate(update); }
    stop = vi.fn(async () => this.emit({ state: "submitting" }));
    async start(): Promise<void> {
      if (!autoComplete) { this.emit({ state: "starting" }); return; }
      this.emit({ state: "done", session: {
        id: "voice-one", state: "done", outcome: "success", nextChunkSequence: 1n,
        acceptedAudioBytes: 0, acceptedAudioDurationMs: 0, createdAt: 0, updatedAt: 0,
        recoveryAttempts: 0, stallWarning: false,
        result: { text: "voice kit", source: "stable", salvaged: false }
      } });
    }
    async cancel(): Promise<void> {}
    async dispose(): Promise<void> {}
  }
}));

const roots: Root[] = [];
let autoComplete = true;
const captures: Array<{ emit(update: VoiceMediaSessionUpdate): void; stop: ReturnType<typeof vi.fn> }> = [];
const session: SessionView = {
  id: "session-one", backendId: "backend-one", targetId: "target-one", name: "Task", state: "idle",
  pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask",
  planMode: false, updatedAt: 0
};

beforeEach(() => {
  vi.useFakeTimers(); autoComplete = true; captures.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MediaRecorder", class {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  window.localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("composer voice dictionary observation", () => {
  it("announces a local input mutation before its delayed save, without treating a render as an edit", async () => {
    const view = await mount("", vi.fn(async () => ({ actions: [] })));
    const before = view.mutations.mock.calls.length;
    await view.rerender(view.controller);
    expect(view.mutations).toHaveBeenCalledTimes(before);
    await act(async () => {
      const editor = view.host.querySelector<HTMLTextAreaElement>("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "New unsaved words");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      expect(view.mutations).toHaveBeenCalledTimes(before + 1);
      expect(view.controller.saveDraft).not.toHaveBeenCalled();
    });
  });

  it.each(["current", "connection", "generation", "model-aba"] as const)("sends terminal voice text once after durable clear, with owner change=%s", async (change) => {
    autoComplete = false;
    const view = await mount("Existing:", vi.fn(async () => ({ actions: [] })));
    vi.mocked(view.controller.readDraft).mockResolvedValue({ text: "", editorDocument: plainTextToComposerDocument(""), deliveryMode: "prompt", attachments: [], mentions: [] });
    let release!: () => void;
    const cleared = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(view.controller.saveDraft).mockImplementationOnce(async () => cleared);
    await act(async () => { view.host.querySelector<HTMLButtonElement>(".send-button")!.click(); view.host.querySelector<HTMLButtonElement>(".send-button")!.click(); });
    expect(captures[0]!.stop).toHaveBeenCalledOnce();
    expect(view.controller.send).not.toHaveBeenCalled();
    await act(async () => captures[0]!.emit({ state: "done", session: { id: "voice-send", state: "done", outcome: "success", nextChunkSequence: 1n, acceptedAudioBytes: 0, acceptedAudioDurationMs: 0, createdAt: 0, updatedAt: 0, recoveryAttempts: 0, stallWarning: false, result: { text: "final", source: "stable", salvaged: false } } }));
    expect(view.controller.send).not.toHaveBeenCalled();
    const replacement = { ...view.controller, getArtifactUrl: vi.fn(), send: vi.fn(async () => undefined), readDraft: vi.fn(async () => undefined) };
    if (change === "connection") await view.rerender(replacement);
    if (change === "generation") await view.rerender(view.controller, { ...session, generation: 2n });
    if (change === "model-aba") {
      const model = { providerId: "provider", modelId: "alternate", outputModalities: ["text"], available: true } as unknown as NonNullable<SessionView["model"]>;
      await view.rerender(view.controller, { ...session, model });
      await view.rerender(view.controller, session);
    }
    await act(async () => { release(); await Promise.all(view.actions); });
    if (change !== "current") {
      expect(view.controller.send).not.toHaveBeenCalled(); expect(replacement.send).not.toHaveBeenCalled();
      expect(view.controller.saveDraft).toHaveBeenLastCalledWith(session.id, expect.objectContaining({ text: "Existing:final" }));
      if (change === "model-aba") {
        expect(view.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("Existing:final");
        expect(view.host.querySelector<HTMLButtonElement>(".send-button")!.disabled).toBe(false);
      }
    } else {
      expect(view.controller.send).toHaveBeenCalledExactlyOnceWith(session.id, expect.objectContaining({ text: "Existing:final", deliveryMode: "prompt" }), { expectedGeneration: session.generation });
    }
  });

  it.each(["", "Use:"])("ends observation when the inserted transcript is deleted from %j", async (initialText) => {
    const advice = vi.fn(async (): Promise<VoiceInputDictionaryAdviceView> => ({ actions: [] }));
    const { host, edit } = await mount(initialText, advice);
    await edit(`${initialText}VoiceKit`);
    await edit(initialText);
    await edit(`${initialText}VoiceKit`);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(advice).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(`${initialText}VoiceKit`);
  });

  it("cancels a correction that is undone and ignores its late advice", async () => {
    let finish: ((value: VoiceInputDictionaryAdviceView) => void) | undefined;
    const advice = vi.fn((_input: unknown, _signal?: AbortSignal) => new Promise<VoiceInputDictionaryAdviceView>((resolve) => { finish = resolve; }));
    const { edit } = await mount("", advice);
    await edit("VoiceKit");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200); });
    expect(advice).toHaveBeenCalledOnce();
    await edit("voice kit");
    expect(advice.mock.calls[0]?.[1]?.aborted).toBe(true);
    await act(async () => finish?.({ actions: [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }] }));
    expect(readVoiceInputPreferences().dictionary.entries).toEqual([]);
  });
});

async function mount(initialText: string, advice: AppController["adviseVoiceInputDictionaryEdit"]): Promise<{
  host: HTMLElement;
  edit(text: string): Promise<void>;
  controller: AppController;
  rerender(controller: AppController, session?: SessionView): Promise<void>;
  actions: Promise<unknown>[];
  mutations: ReturnType<typeof vi.fn>;
}> {
  const snapshot = emptySnapshot();
  const controller = {
    state: { connectionState: "connected", snapshot: { ...snapshot, settings: { ...snapshot.settings, voiceInput: {
      ...snapshot.settings.voiceInput, refinementEnabled: true
    } } }, preferences: DEFAULT_UI_PREFERENCES },
    readDraft: vi.fn(async () => ({ text: initialText })),
    saveDraft: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    getVoiceInputCapabilities: vi.fn(async () => ({})),
    adviseVoiceInputDictionaryEdit: advice
  } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const actions: Promise<unknown>[] = [];
  const mutations = vi.fn();
  const backend = { capabilities: new Map([["input.text", { supported: true, options: [] }]]) } as unknown as BackendView;
  const rerender = async (current: AppController, currentSession = session) => { await act(async () => root.render(<Composer controller={current} session={currentSession} backend={backend}
    autoFocus={false} queue={[]} extraDirectories={[]} resources={[]} commands={[]} messageHistory={[]}
    t={(key) => key} runAction={(_key, action) => { actions.push(action().catch(() => undefined)); }} onLocalSend={() => undefined} onDraftMutation={mutations} />)); };
  await rerender(controller);
  const button = host.querySelector<HTMLButtonElement>('button[aria-label="voice.start"]');
  expect(button?.disabled).toBe(false);
  await act(async () => button?.click());
  expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(autoComplete ? `${initialText}voice kit` : initialText);
  return {
    host, controller, rerender, actions, mutations,
    async edit(text) {
      await act(async () => {
        const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, text);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  };
}
