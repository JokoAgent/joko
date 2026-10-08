import type { JSONContent } from "@tiptap/core";

import type { SkillLearningRunView } from "./model.js";

export type StartedSkillLearningRunView = SkillLearningRunView & {
  readonly state: "distilling";
  readonly distillationSessionId: string;
};

export type SkillLearningStartExpectation = {
  readonly backendId: string;
  readonly targetId: string;
  readonly source: { readonly kind: "session"; readonly sessionId: string }
    | { readonly kind: "text" };
};

/** Application commands only consume a fail-closed text document shape. */
export function composerDocumentIsPlainTextInvocation(document: JSONContent): boolean {
  if (document.type !== "doc" || !Array.isArray(document.content)) return false;
  return document.content.every((block) => block.type === "paragraph"
    && (block.content ?? []).every((inline) => inline.type === "text" && typeof inline.text === "string"
      || inline.type === "hardBreak"));
}

/** Validate the synchronous result of a fresh start, before consuming UI state. */
export function requireStartedSkillLearningRun(
  run: SkillLearningRunView,
  expected: SkillLearningStartExpectation
): StartedSkillLearningRunView {
  const sourceMatches = expected.source.kind === "session"
    ? run.sourceKind === "session" && run.sourceSessionId === expected.source.sessionId
    : run.sourceKind === "text" && run.sourceSessionId === undefined;
  if (
    run.state !== "distilling"
    || run.distillationSessionId === undefined
    || run.distillationSessionId.trim() === ""
    || run.backendId !== expected.backendId
    || run.targetId !== expected.targetId
    || !sourceMatches
  ) {
    throw new Error(run.state === "failed" && run.error?.trim()
      ? run.error
      : "Skill learning did not return an active distillation task.");
  }
  return run as StartedSkillLearningRunView;
}
