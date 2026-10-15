import { parseTaskShareInvitation } from "@joko/contracts";
import { useSyncExternalStore } from "react";

let invitation: { readonly id: number; readonly invitation: string } | undefined;
let sequence = 0;
const listeners = new Set<() => void>();

/** Ephemeral explicit handoff. Never put the invitation into router state or storage. */
export function offerTaskSharingInvitation(value: string): boolean {
  try { parseTaskShareInvitation(value); } catch { return false; }
  invitation = { id: ++sequence, invitation: value }; for (const listener of listeners) listener(); return true;
}
export function clearTaskSharingInvitation(expected?: string): void {
  if (expected !== undefined && invitation?.invitation !== expected) return;
  invitation = undefined; for (const listener of listeners) listener();
}
export function useTaskSharingInvitation(): { readonly id: number; readonly invitation: string } | undefined {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => invitation);
}
