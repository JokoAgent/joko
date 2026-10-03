import { useEffect, useRef } from "react";

import type { AppController } from "../controller.js";
import { setDesktopGlobalVoiceShortcut } from "../desktop-global-voice-shortcut.js";
import { recordVoiceInputSession } from "../voice-input-history.js";
import { VoiceInputMediaSession, type VoiceMediaErrorCode, type VoiceMediaSessionUpdate } from "../voice-input-media.js";
import {
  readVoiceInputPreferences,
  voiceInputRecognitionContext,
  subscribeVoiceInputPreferences,
  voiceInputLocale,
  type VoiceInputPreferences
} from "../voice-input-preferences.js";
import { publishGlobalVoiceShortcutRegistration } from "../global-voice-shortcut-store.js";

export function DesktopGlobalVoiceBridge({ controller }: { readonly controller: AppController }): null {
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  useEffect(() => {
    const desktop = window.jokoDesktop;
    if (desktop?.capabilities.includes("voice.globalDictation") !== true) return;
    let disposed = false;
    let shortcutSyncGeneration = 0;
    let shortcutRecoverySignalGeneration = 0;

    const publish = (status: JokoDesktopGlobalVoiceStatus): void => {
      if (!disposed) void desktop.globalVoice.publishStatus(status).catch(() => undefined);
    };
    const runtime = createDesktopGlobalVoiceGenerationRuntime({
      createSession: (onUpdate) => createDesktopGlobalVoiceSession(
        controllerRef.current,
        readVoiceInputPreferences(),
        onUpdate
      ),
      publish,
      commit: (request) => desktop.globalVoice.commit(request),
      recordSession: recordVoiceInputSession
    });

    const syncShortcut = (preferences: VoiceInputPreferences): void => {
      const generation = ++shortcutSyncGeneration;
      void desktop.globalVoice.setMuteSystemAudio(preferences.muteOtherSounds).catch(() => undefined);
      void setDesktopGlobalVoiceShortcut(desktop.globalVoice, preferences.shortcut).then((result) => {
        if (!disposed && generation === shortcutSyncGeneration) publishGlobalVoiceShortcutRegistration(result);
      }).catch(() => {
        if (!disposed && generation === shortcutSyncGeneration) {
          publishGlobalVoiceShortcutRegistration({ accepted: false, reason: "unsupported" });
        }
      });
    };

    syncShortcut(readVoiceInputPreferences());
    const unsubscribePreferences = subscribeVoiceInputPreferences(syncShortcut);
    const unsubscribeCommand = desktop.globalVoice.onCommand((command) => {
      runtime.handleCommand(command);
    });
    const unsubscribeShortcutRecovery = desktop.globalVoice.onShortcutRecoveryFailed(() => {
      shortcutRecoverySignalGeneration += 1;
      publishDesktopGlobalVoiceShortcutRecoveryFailure();
    });
    const unsubscribeShortcutRecovered = desktop.globalVoice.onShortcutRecovered(() => {
      shortcutRecoverySignalGeneration += 1;
      publishDesktopGlobalVoiceShortcutRecovered();
    });
    const recoverySnapshotGeneration = shortcutRecoverySignalGeneration;
    void consumeDesktopGlobalVoiceShortcutRecoveryFailure(
      () => desktop.globalVoice.consumeShortcutRecoveryFailure(),
      () => !disposed && recoverySnapshotGeneration === shortcutRecoverySignalGeneration
    ).catch(() => undefined);
    return () => {
      disposed = true;
      shortcutSyncGeneration += 1;
      unsubscribePreferences();
      unsubscribeCommand();
      unsubscribeShortcutRecovery();
      unsubscribeShortcutRecovered();
      runtime.dispose();
      void setDesktopGlobalVoiceShortcut(desktop.globalVoice, "disabled").catch(() => undefined);
    };
  }, []);
  return null;
}

export interface DesktopGlobalVoiceMediaSessionPort {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<unknown>;
  readonly cancel: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

export interface DesktopGlobalVoiceGenerationRuntime {
  readonly handleCommand: (command: JokoDesktopGlobalVoiceCommand) => boolean;
  readonly dispose: () => void;
}

export function createDesktopGlobalVoiceGenerationRuntime(options: {
  readonly createSession: (
    onUpdate: (update: VoiceMediaSessionUpdate) => void
  ) => DesktopGlobalVoiceMediaSessionPort;
  readonly publish: (status: JokoDesktopGlobalVoiceStatus) => void;
  readonly commit: (request: {
    readonly generation: JokoDesktopGlobalVoiceGeneration;
    readonly text: string;
  }) => Promise<boolean>;
  readonly recordSession: (session: NonNullable<VoiceMediaSessionUpdate["session"]>) => void;
}): DesktopGlobalVoiceGenerationRuntime {
  interface Binding {
    readonly generation: JokoDesktopGlobalVoiceGeneration;
    readonly session: DesktopGlobalVoiceMediaSessionPort;
    terminal: boolean;
  }

  let disposed = false;
  let latestGeneration: JokoDesktopGlobalVoiceGeneration = "0";
  let active: Binding | undefined;

  const publish = (status: JokoDesktopGlobalVoiceStatus): void => {
    if (!disposed) options.publish(status);
  };

  const retire = (binding: Binding): void => {
    binding.terminal = true;
    if (active === binding) active = undefined;
  };

  const publishInsertionFailure = (binding: Binding): void => {
    if (disposed || active !== binding || latestGeneration !== binding.generation) return;
    retire(binding);
    publish({ state: "error", generation: binding.generation, errorKind: "insertion" });
  };

  const acceptUpdate = (binding: Binding, update: VoiceMediaSessionUpdate): void => {
    if (disposed || active !== binding || binding.terminal) return;
    const generation = binding.generation;
    if (update.state === "starting") {
      publish({ state: "starting", generation });
      return;
    }
    if (update.state === "listening") {
      publish({ state: "listening", generation, transcript: previewTranscript(update) });
      return;
    }
    if (update.state === "submitting") {
      publish({ state: "submitting", generation, transcript: previewTranscript(update) });
      return;
    }
    if (update.state === "error") {
      if (update.session?.outcome !== undefined) options.recordSession(update.session);
      retire(binding);
      publish({ state: "error", generation, errorKind: desktopGlobalVoiceErrorKind(update.error?.code) });
      return;
    }
    if (update.state === "cancelled") {
      retire(binding);
      publish({ state: "idle", generation });
      return;
    }
    if (update.state !== "done") return;
    if (update.session?.outcome !== undefined) options.recordSession(update.session);
    const text = update.session?.result?.text ?? "";
    if (text.trim() === "") {
      retire(binding);
      publish({ state: "error", generation, errorKind: "empty" });
      return;
    }
    binding.terminal = true;
    void Promise.resolve().then(() => options.commit({ generation, text })).then((inserted) => {
      if (inserted) {
        if (active === binding && latestGeneration === generation) active = undefined;
        return;
      }
      publishInsertionFailure(binding);
    }).catch(() => publishInsertionFailure(binding));
  };

  const begin = (generation: JokoDesktopGlobalVoiceGeneration): boolean => {
    if (disposed || !isDesktopGlobalVoiceCommandGeneration(generation)
      || compareDesktopGlobalVoiceGeneration(generation, latestGeneration) <= 0) return false;
    latestGeneration = generation;
    const previous = active;
    active = undefined;
    if (previous !== undefined) {
      previous.terminal = true;
      void Promise.resolve().then(() => previous.session.cancel()).catch(() => undefined);
    }
    let binding: Binding | undefined;
    let session: DesktopGlobalVoiceMediaSessionPort;
    try {
      session = options.createSession((update) => {
        if (binding !== undefined) acceptUpdate(binding, update);
      });
    } catch {
      publish({ state: "error", generation, errorKind: "unsupported" });
      return true;
    }
    binding = { generation, session, terminal: false };
    active = binding;
    void Promise.resolve().then(() => session.start()).catch(() => undefined);
    return true;
  };

  const cancel = (generation: JokoDesktopGlobalVoiceGeneration): boolean => {
    const binding = active;
    if (disposed || binding === undefined || binding.generation !== generation || binding.terminal) return false;
    retire(binding);
    void Promise.resolve().then(() => binding.session.cancel()).catch(() => undefined).finally(() => {
      if (!disposed && active === undefined && latestGeneration === generation) {
        publish({ state: "idle", generation });
      }
    });
    return true;
  };

  return Object.freeze({
    handleCommand: (command: JokoDesktopGlobalVoiceCommand): boolean => {
      if (!isDesktopGlobalVoiceCommandGeneration(command.generation)) return false;
      if (command.type === "start" || command.type === "retry") return begin(command.generation);
      if (command.type === "cancel") return cancel(command.generation);
      const binding = active;
      if (disposed || binding === undefined || binding.generation !== command.generation || binding.terminal) return false;
      void Promise.resolve().then(() => binding.session.stop()).catch(() => undefined);
      return true;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      const binding = active;
      active = undefined;
      if (binding !== undefined) {
        binding.terminal = true;
        void Promise.resolve().then(() => binding.session.dispose()).catch(() => undefined);
      }
    }
  });
}

export function publishDesktopGlobalVoiceShortcutRecoveryFailure(): void {
  publishGlobalVoiceShortcutRegistration({ accepted: false, reason: "unsupported" });
}

export function publishDesktopGlobalVoiceShortcutRecovered(): void {
  publishGlobalVoiceShortcutRegistration({ accepted: true, activation: "hold" });
}

export async function consumeDesktopGlobalVoiceShortcutRecoveryFailure(
  consume: () => Promise<{ readonly failed: boolean }>,
  isActive: () => boolean = () => true
): Promise<void> {
  const snapshot = await consume();
  if (snapshot.failed && isActive()) publishDesktopGlobalVoiceShortcutRecoveryFailure();
}

export { desktopGlobalVoiceShortcutPreference } from "../desktop-global-voice-shortcut.js";

export function createDesktopGlobalVoiceSession(
  controller: AppController,
  preferences: VoiceInputPreferences,
  onUpdate: (update: VoiceMediaSessionUpdate) => void
): VoiceInputMediaSession {
  const locale = voiceInputLocale(preferences);
  return new VoiceInputMediaSession({
    api: controller,
    ownerWindow: window,
    subscribeMicrophoneRelease: window.jokoDesktop?.microphone?.onRelease,
    preferences: {
      ...(locale === undefined ? {} : { locale }),
      ...(preferences.deviceId === undefined ? {} : { deviceId: preferences.deviceId }),
      ...(preferences.refinementInstructions === "" ? {} : { refinementInstructions: preferences.refinementInstructions }),
      recognitionContext: voiceInputRecognitionContext(preferences),
      playInteractionSound: preferences.playInteractionSound
    },
    onUpdate
  });
}

export function desktopGlobalVoiceErrorKind(code: VoiceMediaErrorCode | undefined): "unsupported" | "permission" | "microphone" | "service" {
  if (code === "unsupported") return "unsupported";
  if (code === "permissionDenied") return "permission";
  if (code === "deviceUnavailable" || code === "deviceBusy" || code === "captureFailed") return "microphone";
  return "service";
}

function isDesktopGlobalVoiceCommandGeneration(value: unknown): value is JokoDesktopGlobalVoiceGeneration {
  return typeof value === "string" && value.length > 0 && value.length <= 16
    && /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function compareDesktopGlobalVoiceGeneration(
  left: JokoDesktopGlobalVoiceGeneration,
  right: JokoDesktopGlobalVoiceGeneration
): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function previewTranscript(update: VoiceMediaSessionUpdate): string {
  return (update.session?.result?.text ?? update.session?.draft?.text ?? "").slice(-4_096);
}
