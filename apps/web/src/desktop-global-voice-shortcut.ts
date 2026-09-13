import type { VoiceInputShortcutPreference } from "./voice-input-preferences.js";

type DesktopGlobalVoiceShortcutApi = Pick<JokoDesktopApi["globalVoice"], "setShortcut">;
type DesktopGlobalVoiceShortcutResult = Awaited<ReturnType<DesktopGlobalVoiceShortcutApi["setShortcut"]>>;

let mutationTail: Promise<void> = Promise.resolve();

export function setDesktopGlobalVoiceShortcut(
  api: DesktopGlobalVoiceShortcutApi,
  preference: VoiceInputShortcutPreference
): Promise<DesktopGlobalVoiceShortcutResult> {
  const mutation = mutationTail.then(() => api.setShortcut(desktopGlobalVoiceShortcutPreference(preference)));
  mutationTail = mutation.then(() => undefined, () => undefined);
  return mutation;
}

export function desktopGlobalVoiceShortcutPreference(
  preference: VoiceInputShortcutPreference
): JokoDesktopGlobalVoiceShortcut | "disabled" {
  if (preference === "disabled") return preference;
  return Object.freeze({
    code: preference.code,
    meta: preference.meta,
    ctrl: preference.ctrl,
    alt: preference.alt,
    shift: preference.shift,
    fn: preference.fn
  });
}
