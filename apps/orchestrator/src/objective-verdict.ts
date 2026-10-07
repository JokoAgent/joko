export type ObjectiveVerdictStatus = "complete" | "continue" | "blocked";

export interface ObjectiveVerdict {
  readonly status: ObjectiveVerdictStatus;
  readonly reason: string;
  readonly refinedObjective?: string;
}

const VALID_STATUSES = new Set<ObjectiveVerdictStatus>(["complete", "continue", "blocked"]);

function fencedBlocks(text: string): readonly string[] {
  const blocks: string[] = [];
  const pattern = /```(?:json|jsonc)?\s*([\s\S]*?)```/giu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) blocks.push(match[1].trim());
  }
  return blocks;
}

function candidateVerdict(candidate: string): ObjectiveVerdict | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const status = value["goal_status"];
  if (typeof status !== "string" || !VALID_STATUSES.has(status as ObjectiveVerdictStatus)) {
    return undefined;
  }
  const reason = typeof value["reason"] === "string" ? value["reason"].trim() : "";
  const refined = typeof value["refined_objective"] === "string"
    ? value["refined_objective"].trim()
    : "";
  return {
    status: status as ObjectiveVerdictStatus,
    reason,
    ...(refined === "" ? {} : { refinedObjective: refined })
  };
}

/** Deterministically reads the last valid structured verdict. */
export function parseObjectiveVerdict(text: string | null | undefined): ObjectiveVerdict | undefined {
  if (text === undefined || text === null || text === "") return undefined;
  let last: ObjectiveVerdict | undefined;
  for (const block of fencedBlocks(text)) {
    last = candidateVerdict(block) ?? last;
  }
  if (last !== undefined) return last;

  const bare = /\{[^{}]*"goal_status"[^{}]*\}/giu;
  let match: RegExpExecArray | null;
  while ((match = bare.exec(text)) !== null) {
    last = candidateVerdict(match[0]) ?? last;
  }
  return last;
}
