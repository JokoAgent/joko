const TERMINAL_PREFERENCES_KEY = "joko.terminal.preferences.v1";
const TERMINAL_PREFERENCES_EVENT = "joko:terminal-preferences";

export function readTerminalShellPreference(): string {
  try {
    const raw = window.localStorage.getItem(TERMINAL_PREFERENCES_KEY);
    if (raw === null) return "auto";
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Object.keys(value).join(",") !== "shellId" || !("shellId" in value)) return "auto";
    return typeof value.shellId === "string" && value.shellId.length > 0 && value.shellId.length <= 128 ? value.shellId : "auto";
  } catch { return "auto"; }
}

export function writeTerminalShellPreference(shellId: string): void {
  if (shellId.length === 0 || shellId.length > 128) throw new Error("Invalid terminal shell preference.");
  window.localStorage.setItem(TERMINAL_PREFERENCES_KEY, JSON.stringify({ shellId }));
  window.dispatchEvent(new Event(TERMINAL_PREFERENCES_EVENT));
}

export function subscribeTerminalShellPreference(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => { if (event.key === null || event.key === TERMINAL_PREFERENCES_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(TERMINAL_PREFERENCES_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(TERMINAL_PREFERENCES_EVENT, listener);
  };
}
