// @vitest-environment jsdom
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "./controller.js";
import { GAMEPAD_VOICE_EVENT, useGamepadVoiceInput } from "./gamepad-client.js";
import { emptySnapshot } from "./model.js";
import type { VoiceMediaSessionOptions, VoiceMediaSessionUpdate } from "./voice-input-media.js";
import { useDraftVoiceInput } from "./components/use-draft-voice-input.js";

const captures: Array<{
  emit: (update: VoiceMediaSessionUpdate) => void;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}> = [];
vi.mock("./voice-input-media.js", async (original) => ({
  ...await original<typeof import("./voice-input-media.js")>(),
  supportsVoiceMediaCapture: () => true,
  VoiceInputMediaSession: class {
    currentState = "idle";
    currentSession: VoiceMediaSessionUpdate["session"];
    constructor(readonly options: VoiceMediaSessionOptions) { captures.push(this); }
    emit(update: VoiceMediaSessionUpdate) { this.currentState = update.state; this.currentSession = update.session; this.options.onUpdate?.(update); }
    async start() { this.emit({ state: "starting" }); }
    stop = vi.fn(async () => { this.emit({ state: "submitting" }); });
    cancel = vi.fn(async () => { this.emit({ state: "cancelled" }); });
    async dispose() { await this.cancel(); }
  }
}));
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); captures.length = 0;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn() } });
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); Reflect.deleteProperty(navigator, "mediaDevices"); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("finishes only the recording started by its gamepad press", async () => {
  const view = await mount();
  await view.input("press");
  expect(captures).toHaveLength(1);
  await view.input("release");
  expect(captures[0]!.stop).toHaveBeenCalledOnce();
  await view.input("release");
  await view.input("cancel");
  expect(captures[0]!.stop).toHaveBeenCalledOnce();
  expect(captures[0]!.cancel).not.toHaveBeenCalled();
  expect(view.applied).not.toHaveBeenCalled();
});

it.each(["release", "cancel"] as const)("does not %s a replacement recording after the original was cancelled from the UI", async (phase) => {
  const view = await mount();
  await view.input("press");
  await view.click("cancel");
  await view.click("start");
  expect(captures).toHaveLength(2);
  expect(captures[0]!.cancel).toHaveBeenCalledOnce();
  await view.input(phase);
  expect(captures[1]!.stop).not.toHaveBeenCalled();
  expect(captures[1]!.cancel).not.toHaveBeenCalled();
});

it("retires a held press when the draft capture scope changes without changing the session owner", async () => {
  const view = await mount();
  await view.input("press");
  await view.render(1);
  expect(captures[0]!.cancel).toHaveBeenCalledOnce();
  await view.click("start");
  expect(captures).toHaveLength(2);
  await view.input("release");
  expect(captures[1]!.stop).not.toHaveBeenCalled();
  expect(captures[1]!.cancel).not.toHaveBeenCalled();
});

async function mount() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const applied = vi.fn((text: string) => text);
  const controller = {
    state: { connectionState: "connected", snapshot: emptySnapshot() },
    getVoiceInputCapabilities: async () => ({}), getArtifactUrl: vi.fn()
  } as unknown as AppController;
  function Harness({ generation }: { readonly generation: number }) {
    const [element, setElement] = useState<HTMLDivElement>();
    const bind = useCallback((node: HTMLDivElement | null) => setElement(node ?? undefined), []);
    const voice = useDraftVoiceInput({
      controller: { ...controller, state: { ...controller.state, snapshot: { ...controller.state.snapshot, generation: BigInt(generation) } } },
      ownerKey: "session", root: element, enabled: true,
      capture: () => applied, focus: () => undefined, t: (key) => key
    });
    useGamepadVoiceInput(element, voice.scope, {
      enabled: voice.supported, isActive: voice.isActive, getCaptureIdentity: voice.getCaptureIdentity,
      start: voice.start, finish: voice.finish, cancel: voice.cancel
    });
    return <div ref={bind}><button data-action="start" onClick={() => voice.start()}>Start</button><button data-action="cancel" onClick={voice.cancel}>Cancel</button></div>;
  }
  const render = async (generation: number) => act(async () => root.render(<Harness generation={generation} />));
  await render(0);
  return {
    applied, render,
    input: async (phase: "press" | "release" | "cancel") => act(async () => {
      host.querySelector<HTMLElement>("[data-gamepad-voice]")?.dispatchEvent(new CustomEvent(GAMEPAD_VOICE_EVENT, { detail: phase }));
    }),
    click: async (action: string) => act(async () => { host.querySelector<HTMLButtonElement>(`[data-action='${action}']`)?.click(); })
  };
}
