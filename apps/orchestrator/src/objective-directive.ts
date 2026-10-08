function verdictContract(includeRefinement: boolean): string {
  const value = includeRefinement
    ? '{"goal_status":"complete|continue|blocked","reason":"<one short sentence>","refined_objective":"<optional clarified objective>"}'
    : '{"goal_status":"complete|continue|blocked","reason":"<one short sentence>"}';
  return [
    "When you finish working this turn, end your reply with exactly this fenced block and nothing after it:",
    "",
    "```json",
    value,
    "```",
    "",
    "Verdict rules:",
    '- "complete": the objective is verifiably done; run the relevant checks before claiming it.',
    '- "continue": meaningful work remains and you want another autonomous turn.',
    '- "blocked": progress requires human input, a credential, or an action you are not permitted to take.',
    ...(includeRefinement
      ? ['- "refined_objective": include only after clarifying a vague objective with the user; otherwise omit it.']
      : []),
    "Do real work with tools each turn. Emit the verdict block every turn."
  ].join("\n");
}

function clarificationContract(maximumTurns: number | undefined): string {
  return [
    "Before substantial work, perform a one-time sanity check: is the objective specific enough to pursue autonomously and verify?",
    ...(maximumTurns === undefined
      ? []
      : [`The available turn budget is ${maximumTurns}; check whether that is plausibly enough.`]),
    "If it is already clear, do not ask a question; begin working.",
    "If it is genuinely vague, use the available user-question interaction once before working. Offer concrete, self-contained candidate objectives and include the original objective verbatim as one option.",
    "After clarification, pursue the selected objective and return it in refined_objective.",
    'Do not use "blocked" merely because the objective is vague.'
  ].join("\n\n");
}

export function buildFirstObjectiveDirective(
  objective: string,
  limits: { readonly maximumTurns?: number } = {}
): string {
  return [
    "[Objective] Work autonomously toward this objective across turns until it is met:",
    "",
    objective.trim(),
    "",
    "---",
    clarificationContract(limits.maximumTurns),
    "",
    "---",
    verdictContract(true)
  ].join("\n");
}

export function buildObjectiveContinuationDirective(
  objective: string,
  lastReason?: string
): string {
  return [
    "[Objective] Continue working toward this objective:",
    "",
    objective.trim(),
    ...(lastReason === undefined || lastReason.trim() === ""
      ? []
      : ["", `Last status note: ${lastReason.trim()}`]),
    "",
    "---",
    verdictContract(false)
  ].join("\n");
}
