import { useSyncExternalStore } from "react";

const titles = new Map<string, string>(), listeners = new Set<() => void>();
const key = (profileId: string, sessionId: string, draftId: string) => JSON.stringify([profileId, sessionId, draftId]);

/** Presentation only. The unsent body and its title never enter service state. */
export function previewProvisionalTask(profileId: string, sessionId: string, draftId: string, text: string): void {
  const identity = key(profileId, sessionId, draftId), title = [...text.trim().replace(/\s+/gu, " ")].slice(0, 100).join("");
  if (titles.get(identity) === title) return;
  if (titles.size >= 64 && !titles.has(identity)) titles.delete(titles.keys().next().value!);
  titles.set(identity, title); for (const listener of listeners) listener();
}

export function useProvisionalTaskPreview(profileId: string | undefined, sessionId: string, draftId: string | undefined): string {
  const identity = profileId && draftId ? key(profileId, sessionId, draftId) : "";
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => titles.get(identity) ?? "", () => "");
}
