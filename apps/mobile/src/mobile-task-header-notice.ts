import { QueueDispatchState, type QueueControl, type Session } from "@joko/contracts";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import { mobileSideChatCopy } from "./mobile-side-chat";
import type { MobileTaskHeaderRole } from "./mobile-task-header-role";

export function mobileTaskHeaderNotice(input: {
  readonly status: "starting" | "unpaired" | "connecting" | "connected" | "offline" | "revoked";
  readonly session?: Session;
  readonly pendingCount: number;
  readonly role?: MobileTaskHeaderRole;
  readonly queueControls: readonly QueueControl[];
  readonly locale: MobileSupportedLocale;
}): string | undefined {
  const { status, session, locale } = input;
  if (status === "revoked") return mobileMessage(locale, "devices.status.revoked");
  if (!session) return undefined;
  if (status !== "connected") return mobileMessage(locale, status === "offline" ? "home.offline" : "home.reconnecting");
  const controls = input.queueControls.filter(control => control.sessionId === session.sessionId
    && control.backendId === session.backendId && control.targetId === session.targetId);
  const control = controls.length === 1 ? controls[0] : undefined;
  const count = control?.queuedItemCount ?? BigInt(input.pendingCount);
  if (count > 0n) return mobileMessage(locale, "task.headerPending", { count: count.toString() });
  if (input.role === "worker" || input.role === "lead") return mobileMessage(locale, input.role === "worker" ? "task.headerWorker" : "task.headerLead");
  if (session.archived) return mobileMessage(locale, "common.archived");
  if (control?.dispatchState === QueueDispatchState.PAUSED) return mobileMessage(locale, "task.headerQueuePaused");
  if (session.derivationOrigin?.sideChat) return [mobileSideChatCopy(locale).context,
    session.worktree === undefined ? mobileSideChatCopy(locale).readOnly : ""].filter(Boolean).join(" ");
  return undefined;
}
