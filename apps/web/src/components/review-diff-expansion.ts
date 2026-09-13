export const REVIEW_FILE_LIST_VIRTUAL_THRESHOLD = 100;
export const REVIEW_DIFF_ROW_VIRTUAL_THRESHOLD = 200;
export const REVIEW_FILE_TREE_MIN_CONTAINER_WIDTH = 620;

const MAX_RETAINED_REVIEW_SESSIONS = 20;
const diffsExpandedBySession = new Map<string, boolean>();

export type ReviewDiffExpansionAction = "expand" | "collapse" | "disabled";

export function getReviewDiffsExpanded(sessionId: string, fallback: boolean): boolean {
  return diffsExpandedBySession.get(sessionId) ?? fallback;
}

export function seedReviewDiffsExpanded(sessionId: string, expanded: boolean): void {
  if (sessionId === "" || diffsExpandedBySession.has(sessionId)) return;
  setReviewDiffsExpanded(sessionId, expanded);
}

export function setReviewDiffsExpanded(sessionId: string, expanded: boolean): void {
  if (sessionId === "") return;
  diffsExpandedBySession.delete(sessionId);
  diffsExpandedBySession.set(sessionId, expanded);
  while (diffsExpandedBySession.size > MAX_RETAINED_REVIEW_SESSIONS) {
    const oldestSessionId = diffsExpandedBySession.keys().next().value;
    if (oldestSessionId === undefined) break;
    diffsExpandedBySession.delete(oldestSessionId);
  }
}

export function getReviewDiffExpansionAction(
  fileKeys: readonly string[],
  diffsExpanded: boolean,
  overrides: ReadonlyMap<string, boolean> = new Map()
): ReviewDiffExpansionAction {
  if (fileKeys.length === 0) return "disabled";
  return fileKeys.every((key) => overrides.get(key) ?? diffsExpanded) ? "collapse" : "expand";
}

export function getExpandedReviewFileKeys(
  fileKeys: readonly string[],
  diffsExpanded: boolean,
  overrides: ReadonlyMap<string, boolean>
): ReadonlySet<string> {
  return new Set(fileKeys.filter((key) => overrides.get(key) ?? diffsExpanded));
}

export function shouldVirtualizeReviewFileList(fileCount: number): boolean {
  return fileCount > REVIEW_FILE_LIST_VIRTUAL_THRESHOLD;
}

export function shouldVirtualizeReviewDiffRows(rowCount: number): boolean {
  return rowCount > REVIEW_DIFF_ROW_VIRTUAL_THRESHOLD;
}

export function shouldShowReviewFileTree(
  preferredVisible: boolean,
  containerWidth: number,
  fileCount: number
): boolean {
  return preferredVisible
    && fileCount > 0
    && containerWidth >= REVIEW_FILE_TREE_MIN_CONTAINER_WIDTH;
}

export function resetReviewDiffExpansionPreferencesForTests(): void {
  diffsExpandedBySession.clear();
}
