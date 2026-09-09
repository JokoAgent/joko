// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot } from "../model.js";
import type { VoiceMediaSessionOptions, VoiceMediaSessionUpdate } from "../voice-input-media.js";
import { VoiceInputButton } from "./VoiceInputButton.js";
import { useDraftVoiceInput, type VoiceDraftCompletion } from "./use-draft-voice-input.js";
import { useHeldVoiceInput } from "./use-held-voice-input.js";

const captures: Array<{ readonly options: VoiceMediaSessionOptions; emit(value: VoiceMediaSessionUpdate): void; stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = [];
vi.mock("../voice-input-media.js", async (original) => ({
  ...await original<typeof import("../voice-input-media.js")>(),
  supportsVoiceMediaCapture: () => true,
  VoiceInputMediaSession: class {
    currentState = "idle";
    currentSession: VoiceMediaSessionUpdate["session"];
    constructor(readonly options: VoiceMediaSessionOptions) { captures.push(this); }
    emit(value: VoiceMediaSessionUpdate) { this.currentState = value.state; this.currentSession = value.session; this.options.onUpdate?.(value); }
    async start() { this.emit({ state: "starting" }); }
    stop = vi.fn(async () => { this.emit({ state: "submitting" }); });
    cancel = vi.fn(async () => { this.emit({ state: "cancelled" }); });
    async dispose() { await this.cancel(); }
  }
}));
const roots: Root[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear(); captures.length = 0;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); Reflect.deleteProperty(navigator, "mediaDevices"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

it.each([["mouse", 450], ["touch", 320]])("owns %s tap/hold, target movement and terminal success before sending", async (pointerType, threshold) => {
  const view = await mount();
  await pointer(view.mic(), "pointerdown", { pointerType });
  expect(captures).toHaveLength(1);
  await tick(threshold - 1);
  await pointer(view.mic(), "pointerup", { pointerType });
  await click(view.mic(), 1);
  expect(captures[0]!.stop).not.toHaveBeenCalled();
  // Keyboard/assistive click is independent of the pointer click suppression window.
  await click(view.mic(), 0);
  expect(captures[0]!.stop).toHaveBeenCalledOnce();
  await emit(0, result("first"));
  expect(view.applied).toHaveBeenCalledExactlyOnceWith("first", undefined);
  expect(view.sent).not.toHaveBeenCalled();
  await pointer(view.mic(), "pointerdown", { pointerType });
  await tick(threshold);
  expect(view.mic().getAttribute("aria-label")).toBe("voice.releaseToStop");
  await pointer(view.mic(), "pointermove", { clientX: 105, clientY: 105 });
  expect(view.host.querySelector("[data-send-target=true]")).not.toBeNull();
  await view.render({ canSend: false });
  expect(view.host.querySelector("[data-send-target=true]")).toBeNull();
  await view.render({ canSend: true });
  await pointer(view.mic(), "pointerup", { clientX: 105, clientY: 105 });
  await pointer(view.mic(), "lostpointercapture");
  expect(captures[1]!.cancel).not.toHaveBeenCalled();
  expect(captures[1]!.stop).toHaveBeenCalledOnce();
  expect(view.sent).not.toHaveBeenCalled();
  await emit(1, { ...result("draft"), state: "submitting", session: { ...result("draft").session!, state: "refining", outcome: undefined } });
  expect(view.mic().getAttribute("aria-label")).toBe("voice.refining");
  expect(view.sent).not.toHaveBeenCalled();
  await emit(1, result("final")); await emit(1, result("final"));
  expect(view.applied).toHaveBeenCalledTimes(2);
  expect(view.sent).toHaveBeenCalledExactlyOnceWith("final");
});

it("scopes keyboard to its actual Document, respects IME/nested surfaces and retires pending capture on pagehide/owner ABA", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe")); const doc = iframe.contentDocument!;
  Object.defineProperty(doc.defaultView!.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
  const view = await mount(doc);
  const editor = view.host.querySelector("textarea")!;
  await key(document.body, "keydown", { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
  await key(editor, "keydown", { key: " ", code: "Space", ctrlKey: true, shiftKey: true, isComposing: true });
  expect(captures).toHaveLength(0);
  await key(editor, "keydown", { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
  expect(captures[0]!.options.ownerWindow).toBe(doc.defaultView);
  await tick(449); await key(editor, "keyup", { key: " ", code: "Space" });
  expect(captures[0]!.stop).not.toHaveBeenCalled();
  await key(view.host.querySelector("[aria-modal] button")!, "keydown", { key: "Escape" });
  expect(captures[0]!.cancel).not.toHaveBeenCalled();
  await key(editor, "keydown", { key: "Enter", shiftKey: true });
  expect(captures[0]!.stop).not.toHaveBeenCalled();
  await key(editor, "keydown", { key: "Enter" });
  expect(captures[0]!.stop).toHaveBeenCalledOnce();
  await act(async () => doc.defaultView!.dispatchEvent(new Event("pagehide")));
  await act(async () => doc.defaultView!.dispatchEvent(new Event("pageshow")));
  await emit(0, result("late")); expect(view.applied).not.toHaveBeenCalled(); expect(view.sent).not.toHaveBeenCalled();
  await pointer(view.mic(), "pointerdown"); await tick(450);
  await act(async () => doc.defaultView!.dispatchEvent(new Event("blur")));
  expect(captures[1]!.cancel).toHaveBeenCalledOnce();
  await view.render({ owner: "B" }); await view.render({ owner: "A" });
  await emit(1, result("ABA")); expect(view.applied).not.toHaveBeenCalled();
  await key(editor, "keydown", { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
  await emit(2, { state: "listening" }); await tick(450); await key(editor, "keyup", { key: "Control", code: "ControlLeft" });
  expect(captures[2]!.stop).toHaveBeenCalledOnce();
  await emit(2, result("kept")); expect(view.sent).not.toHaveBeenCalled();
});

it("settles cancel and failure without sending existing text; an equivalent controller render keeps the same terminal promise", async () => {
  const view = await mount();
  await click(view.mic());
  let completion!: Promise<VoiceDraftCompletion<string>>;
  await act(async () => { completion = view.voice().finish(); });
  await view.render({ facade: 1 });
  await emit(0, { ...result(""), session: { ...result("").session!, outcome: "noSpeech" } });
  expect(await completion).toEqual({ kind: "failed" }); expect(view.applied).not.toHaveBeenCalled();
  await click(view.mic());
  await act(async () => { completion = view.voice().finish(); });
  await view.render({ owner: "B" });
  expect(await completion).toEqual({ kind: "cancelled" });
  await emit(1, result("retired")); expect(view.applied).not.toHaveBeenCalled();
  await click(view.mic()); await pointer(view.mic(), "pointercancel"); // no press was owned by a keyboard click
  await act(async () => { completion = view.voice().finish(); });
  await view.render({ facade: 2 }); await emit(2, result("current"));
  expect(await completion).toMatchObject({ kind: "applied", value: "current" });
  expect(view.applied).toHaveBeenCalledExactlyOnceWith("current", undefined);
});

it("does not turn the initiating pointer's release into an automatic retry after a permission failure", async () => {
  const view = await mount();
  await pointer(view.mic(), "pointerdown");
  await emit(0, { state: "error" });
  await tick(600);
  await pointer(view.mic(), "pointerup"); await click(view.mic(), 1);
  expect(captures).toHaveLength(1);
  await click(view.mic(), 0);
  expect(captures).toHaveLength(2);
});

async function mount(doc = document) {
  const host = doc.body.appendChild(doc.createElement("div")); const root = createRoot(host); roots.push(root);
  const applied = vi.fn((text: string) => text); const sent = vi.fn(); const get = vi.fn();
  const api = { getArtifactUrl: get, getVoiceInputCapabilities: vi.fn(async () => ({})), state: { connectionState: "connected", snapshot: emptySnapshot() } } as unknown as AppController;
  let current!: ReturnType<typeof useDraftVoiceInput<string>>;
  let props = { owner: "A", canSend: true, facade: 0 };
  function Probe({ owner, canSend, facade }: typeof props) {
    const [node, setNode] = useState<HTMLDivElement>(); const [send, setSend] = useState<HTMLButtonElement>();
    const bind = useCallback((value: HTMLDivElement | null) => setNode(value ?? undefined), []);
    const bindSend = useCallback((value: HTMLButtonElement | null) => setSend(value ?? undefined), []);
    const voice = useDraftVoiceInput({ controller: { ...api, state: { ...api.state } }, ownerKey: owner, root: node, enabled: true, capture: () => applied, focus: () => node?.querySelector("textarea")?.focus(), t: key => key });
    current = voice;
    const held = useHeldVoiceInput({ scope: voice.scope, root: node, sendTarget: send, canSend, enabled: voice.supported, phase: voice.phase, shortcut: { code: "Space", ctrl: true, shift: true, alt: false, meta: false, fn: false }, nativeShortcut: false, isActive: voice.isActive, start: voice.start, finish: voice.finish, cancel: voice.cancel,
      onSend: () => { void voice.finish().then(result => { if (result.kind === "applied" && result.isCurrent()) sent(result.value); }); },
      isSendKey: event => event.key === "Enter" && !event.shiftKey
    });
    return <div ref={bind} data-facade={facade}><textarea /><div aria-modal="true"><button>Nested</button></div>
      <VoiceInputButton phase={voice.phase} held={held.held} sendTargetActive={held.sendTargetActive} startedAt={voice.startedAt} ownerWindow={voice.ownerWindow} enabled buttonProps={held.buttonProps} t={key => key} />
      <button ref={bindSend} disabled={!canSend} data-send-target={held.sendTargetActive}>Send</button></div>;
  }
  const render = async (update: Partial<typeof props> = {}) => { props = { ...props, ...update }; await act(async () => root.render(<Probe {...props} />)); };
  await render();
  const microphone = host.querySelector<HTMLButtonElement>(".voice-input-button button")!;
  const captured = new Set<number>();
  microphone.setPointerCapture = id => { captured.add(id); };
  microphone.hasPointerCapture = id => captured.has(id);
  microphone.releasePointerCapture = id => {
    captured.delete(id);
    const event = new doc.defaultView!.Event("lostpointercapture", { bubbles: true }); Object.assign(event, { pointerId: id });
    microphone.dispatchEvent(event);
  };
  const send = host.querySelector<HTMLButtonElement>("[data-send-target]")!;
  vi.spyOn(send, "getBoundingClientRect").mockReturnValue({ x: 100, y: 100, left: 100, top: 100, right: 140, bottom: 140, width: 40, height: 40, toJSON: () => ({}) });
  return { host, applied, sent, render, voice: () => current, mic: () => host.querySelector<HTMLButtonElement>(".voice-input-button button")! };
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function click(node: HTMLElement, detail = 0) { await act(async () => node.dispatchEvent(new node.ownerDocument.defaultView!.MouseEvent("click", { bubbles: true, detail }))); }
async function pointer(node: HTMLElement, type: string, extra: Record<string, unknown> = {}) {
  const event = new node.ownerDocument.defaultView!.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 0, clientY: 0, ...extra });
  await act(async () => node.dispatchEvent(event));
}
async function key(node: HTMLElement, type: string, init: KeyboardEventInit) { await act(async () => node.dispatchEvent(new node.ownerDocument.defaultView!.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))); }
async function emit(index: number, update: VoiceMediaSessionUpdate) { await act(async () => captures[index]!.emit(update)); }
function result(text: string): VoiceMediaSessionUpdate { return { state: "done", session: { id: "capture", state: "done", outcome: "success", nextChunkSequence: 1n, acceptedAudioBytes: 0, acceptedAudioDurationMs: 0, createdAt: 0, updatedAt: 0, recoveryAttempts: 0, stallWarning: false, result: { text, source: "stable", salvaged: false } } }; }
