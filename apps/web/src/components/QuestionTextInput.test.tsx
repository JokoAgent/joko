// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { QuestionTextInput } from "./QuestionTextInput.js";

const media = vi.hoisted(() => ({ sessions: [] as { onUpdate: (value: unknown) => void; cancel: ReturnType<typeof vi.fn> }[] }));
vi.mock("../voice-input-media.js", () => ({
  supportsVoiceMediaCapture: () => true,
  VoiceInputMediaSession: class {
    currentState = "idle";
    cancel = vi.fn(async () => { this.currentState = "cancelled"; });
    dispose = this.cancel;
    constructor(readonly options: { onUpdate: (value: unknown) => void }) { media.sessions.push({ onUpdate: options.onUpdate, cancel: this.cancel }); }
    async start() { this.currentState = "listening"; this.options.onUpdate({ state: "listening" }); }
    async stop() { this.currentState = "submitting"; }
  }
}));
vi.mock("../voice-input-preferences.js", () => ({
  readVoiceInputPreferences: () => ({ fastActivationEnabled: false, refinementInstructions: "", playInteractionSound: false }),
  subscribeVoiceInputPreferences: () => () => undefined,
  voiceInputLocale: () => undefined,
  voiceInputRecognitionContext: () => undefined
}));
vi.mock("../voice-input-history.js", () => ({ recordVoiceInputSession: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
  media.sessions.length = 0;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe("question answer dictation", () => {
  it("replaces the captured selection without submitting an answer", async () => {
    const view = await mount("keep old tail");
    view.input().setSelectionRange(5, 8);
    await view.start();
    await act(async () => media.sessions[0]!.onUpdate(success("new")));
    expect(view.changed).toHaveBeenCalledExactlyOnceWith("keep new tail");
  });

  it("retains manual edits made while transcription is pending", async () => {
    const view = await mount("original"); await view.start(); await view.render("edited");
    await act(async () => media.sessions[0]!.onUpdate(success("late")));
    expect(view.changed).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("voice.errors.draftChanged");
  });

  it.each(["owner", "disabled", "blur"])("retires a capture after %s and ignores its late result", async reason => {
    const view = await mount("original"); await view.start();
    if (reason === "owner") await view.render("original", "next-question");
    else if (reason === "disabled") await view.render("original", "question", false);
    else await act(async () => { window.dispatchEvent(new Event("blur")); });
    await act(async () => media.sessions[0]!.onUpdate(success("late")));
    expect(media.sessions[0]!.cancel).toHaveBeenCalled();
    expect(view.changed).not.toHaveBeenCalled();
  });
});

async function mount(initial: string) {
  const changed = vi.fn();
  const controller = { state: { connectionState: "connected", snapshot: { generation: 1n } },
    getVoiceInputCapabilities: vi.fn(async () => ({})) } as unknown as AppController;
  const render = async (value: string, ownerKey = "question", enabled = true) => {
    await act(async () => root.render(<QuestionTextInput controller={controller} ownerKey={ownerKey} enabled={enabled} label="Answer"
      value={value} onChange={changed} t={key => key} />));
  };
  await render(initial);
  return { changed, render, input: () => host.querySelector("textarea")!, start: async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="voice.start"]')!.click());
  } };
}
function success(text: string) { return { state: "done", session: { id: "voice", state: "done", outcome: "success", result: { text } } }; }
