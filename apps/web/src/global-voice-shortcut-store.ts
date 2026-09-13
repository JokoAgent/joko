export type GlobalVoiceShortcutRegistration =
  | { readonly accepted: true; readonly activation: "hold" | "toggle" }
  | { readonly accepted: false; readonly reason: "unsupported" | "in-use" | "permission" };

let snapshot: GlobalVoiceShortcutRegistration | undefined;
const listeners = new Set<() => void>();

export function readGlobalVoiceShortcutRegistration(): GlobalVoiceShortcutRegistration | undefined {
  return snapshot;
}

export function publishGlobalVoiceShortcutRegistration(value: GlobalVoiceShortcutRegistration): void {
  snapshot = Object.freeze(value);
  for (const listener of listeners) listener();
}

export function subscribeGlobalVoiceShortcutRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
