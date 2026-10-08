/**
 * Remove only a complete, trailing current-v1 Objective verdict from display.
 * The raw Timeline item remains unchanged for history, export, and recovery.
 */
const TRAILING_FENCED_VERDICT = /\n?\s*```(?:json|jsonc)?\s*\{[^{}]*"goal_status"[^{}]*\}\s*```\s*$/iu;
const TRAILING_BARE_VERDICT = /\n?\s*\{[^{}]*"goal_status"[^{}]*\}\s*$/iu;

export function stripObjectiveVerdict(content: string): string {
  if (!content.includes("goal_status")) return content;
  if (TRAILING_FENCED_VERDICT.test(content)) {
    return content.replace(TRAILING_FENCED_VERDICT, "").trimEnd();
  }
  if (TRAILING_BARE_VERDICT.test(content)) {
    return content.replace(TRAILING_BARE_VERDICT, "").trimEnd();
  }
  return content;
}
