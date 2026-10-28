import type { SessionView, SessionWorktreeRemovalPreviewView } from "./model.js";
import { summarizeSessionArchivePreflights, type WorktreeRemovalPreflightSummary } from "./worktree-removal-preflight.js";

export interface NativeTaskStatusCompletionSource {
  readonly session: SessionView;
  readonly canArchive?: boolean;
  isCurrent(): boolean;
  readArchivePreview(signal: AbortSignal): Promise<SessionWorktreeRemovalPreviewView>;
  archive(confirmation: string): Promise<void>;
  markRead(): Promise<void>;
}

/** Presentation dismissal is acknowledged only after the original node accepts
 * the original action. Unknown effects stay in the Gateway's Operation owner. */
export async function executeNativeTaskStatusCompletion(source: NativeTaskStatusCompletionSource,
  action: "archive" | "markRead", confirm: (session: SessionView, summary: WorktreeRemovalPreflightSummary) => Promise<boolean>): Promise<boolean> {
  const assertCurrent = () => { if (!source.isCurrent()) throw new Error("The completion source changed. Open the current task again."); };
  assertCurrent();
  if (action === "markRead") { await source.markRead(); return true; }
  if (source.canArchive === false) throw new Error("This conversation cannot be archived from task status.");
  const summary = await summarizeSessionArchivePreflights([source.session.id], (_id, signal) => source.readArchivePreview(signal));
  assertCurrent();
  if (summary.archiveUnavailable) throw new Error("Active automation bindings could not be verified. Retry before archiving.");
  if ((summary.dirty > 0 || (summary.activeBoundScheduleCount ?? 0) > 0) && !await confirm(source.session, summary)) return false;
  assertCurrent();
  const confirmation = summary.archiveConfirmations?.[source.session.id];
  if (confirmation === undefined) throw new Error("The archive preview is incomplete.");
  await source.archive(confirmation);
  return true;
}
