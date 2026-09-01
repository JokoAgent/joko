import { useEffect, useRef } from "react";

import type { AppController } from "../controller.js";
import { setDesktopGlobalVoiceShortcut } from "../desktop-global-voice-shortcut.js";
import { recordVoiceInputSession } from "../voice-input-history.js";
import { VoiceInputMediaSession, type VoiceMediaErrorCode, type VoiceMediaSessionUpdate } from "../voice-input-media.js";
import {
  readVoiceInputPreferences,
  subscribeVoiceInputPreferences,
  voiceInputLocale,
  type VoiceInputPreferences
} from "../voice-input-preferences.js";
import { publishGlobalVoiceShortcutRegistration } from "../global-voice-shortcut-store.js";

export function DesktopGlobalVoiceBridge({ controller }: { readonly controller: AppController }): null {
  const controllerRef = useRef(controller);
  const sessionRef = useRef<VoiceInputMediaSession | undefined>(undefined);
  const generationRef = useRef(0);
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

    const acceptUpdate = (generation: number, update: VoiceMediaSessionUpdate): void => {
      if (disposed || generation !== generationRef.current) return;
      if (update.state === "starting") {
        publish({ state: "starting" });
        return;
      }
      if (update.state === "listening") {
        publish({ state: "listening", transcript: previewTranscript(update) });
        return;
      }
      if (update.state === "submitting") {
        publish({ state: "submitting", transcript: previewTranscript(update) });
        return;
      }
      if (update.state === "error") {
        if (update.session?.outcome !== undefined) recordVoiceInputSession(update.session);
        publish({ state: "error", errorKind: desktopGlobalVoiceErrorKind(update.error?.code) });
        return;
      }
      if (update.state === "cancelled") {
        publish({ state: "idle" });
        return;
      }
      if (update.state !== "done") return;
      if (update.session?.outcome !== undefined) recordVoiceInputSession(update.session);
      const text = update.session?.result?.text ?? "";
      if (text.trim() === "") {
        publish({ state: "error", errorKind: "empty" });
        return;
      }
      void desktop.globalVoice.commit({ text }).then((inserted) => {
        if (!inserted && !disposed && generation === generationRef.current) {
          publish({ state: "error", errorKind: "insertion" });
        }
      }).catch(() => {
        if (!disposed && generation === generationRef.current) {
          publish({ state: "error", errorKind: "insertion" });
        }
      });
    };

    const begin = (): void => {
      const previous = sessionRef.current;
      sessionRef.current = undefined;
      const generation = ++generationRef.current;
      void previous?.cancel();
      const preferences = readVoiceInputPreferences();
      let session: VoiceInputMediaSession;
      try {
        session = createDesktopGlobalVoiceSession(controllerRef.current, preferences, (update) => {
          acceptUpdate(generation, update);
        });
      } catch {
        publish({ state: "error", errorKind: "unsupported" });
        return;
      }
      sessionRef.current = session;
      void session.start().catch(() => undefined);
    };

    const cancel = (): void => {
      const active = sessionRef.current;
      sessionRef.current = undefined;
      generationRef.current += 1;
      void active?.cancel().finally(() => publish({ state: "idle" }));
    };

    const retry = (): void => {
      const active = sessionRef.current;
      sessionRef.current = undefined;
      generationRef.current += 1;
      void (active?.cancel() ?? Promise.resolve()).finally(() => {
        if (!disposed) begin();
      });
    };

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
      if (command.type === "start") begin();
      else if (command.type === "submit") void sessionRef.current?.stop().catch(() => undefined);
      else if (command.type === "cancel") cancel();
      else retry();
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
    const unsubscribeRelease = desktop.microphone.onRelease(cancel);
    return () => {
      disposed = true;
      shortcutSyncGeneration += 1;
      unsubscribePreferences();
      unsubscribeCommand();
      unsubscribeShortcutRecovery();
      unsubscribeShortcutRecovered();
      unsubscribeRelease();
      const active = sessionRef.current;
      sessionRef.current = undefined;
      generationRef.current += 1;
      void active?.dispose();
      void setDesktopGlobalVoiceShortcut(desktop.globalVoice, "disabled").catch(() => undefined);
    };
  }, []);
  return null;
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
    preferences: {
      ...(locale === undefined ? {} : { locale }),
      ...(preferences.deviceId === undefined ? {} : { deviceId: preferences.deviceId }),
      ...(preferences.refinementInstructions === "" ? {} : { refinementInstructions: preferences.refinementInstructions }),
      dictionaryTerms: preferences.dictionaryTerms,
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

function previewTranscript(update: VoiceMediaSessionUpdate): string {
  return (update.session?.result?.text ?? update.session?.draft?.text ?? "").slice(-4_096);
}
