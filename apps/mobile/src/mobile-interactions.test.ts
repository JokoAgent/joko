import { create } from "@bufbuild/protobuf";
import {
  DisplayArgumentSchema,
  EntityVersionSchema,
  InteractionKind,
  InteractionSchema,
  InteractionState,
  PermissionDecisionKind,
  McpPermissionSubjectSchema,
  PermissionRequestSchema,
  PermissionSubjectSchema,
  PermissionRisk,
  PlanReviewDecisionKind,
  QuestionFieldSchema,
  SnapshotSchema,
  type Interaction,
  type QuestionField
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  createMobileInteractionResolution,
  initialMobileInteractionDraft,
  mobilePermissionDecisionNeedsConfirmation,
  mobilePermissionDetails,
  mobileQuestionCanSubmit,
  mobileQuestionFieldError,
  pendingMobileInteractions,
  setMobileQuestionOther,
  toggleMobileQuestionChoice
} from "./mobile-interactions";

const text = create(QuestionFieldSchema, {
  fieldId: "summary",
  label: "Summary",
  required: true,
  input: { case: "text", value: { defaultValue: "", multiline: true } }
});
const single = create(QuestionFieldSchema, {
  fieldId: "release",
  label: "Release",
  required: true,
  input: { case: "singleChoice", value: {
    choices: [{ choiceId: "stable", label: "Stable" }, { choiceId: "preview", label: "Preview" }],
    allowOther: true
  } }
});
const multiple = create(QuestionFieldSchema, {
  fieldId: "targets",
  label: "Targets",
  required: true,
  input: { case: "multipleChoice", value: {
    choices: [{ choiceId: "web", label: "Web" }, { choiceId: "mobile", label: "Mobile" }],
    minimumSelections: 2,
    maximumSelections: 2,
    allowOther: true
  } }
});
const boolean = create(QuestionFieldSchema, {
  fieldId: "publish",
  label: "Publish",
  required: true,
  input: { case: "boolean", value: { defaultValue: false } }
});

describe("mobile interactions", () => {
  it("selects only exact current-task pending requests and preserves plan-permission-question priority", () => {
    const snapshot = create(SnapshotSchema, {
      sessions: [{ sessionId: "session", backendId: "backend", targetId: "target", nativeBinding: { runtimeGeneration: 8n } }],
      interactions: [
        questionInteraction("question", [text], 1n),
        permissionInteraction("permission", PermissionRisk.LOW, 3n),
        planInteraction("plan", 2n),
        create(InteractionSchema, { ...permissionInteraction("wrong-generation", PermissionRisk.LOW, 0n), generation: 7n,
          version: create(EntityVersionSchema, { revision: { value: 4n }, generation: 7n }) }),
        create(InteractionSchema, { ...permissionInteraction("resolved", PermissionRisk.LOW, 0n), state: InteractionState.RESOLVED }),
        create(InteractionSchema, { ...permissionInteraction("other-task", PermissionRisk.LOW, 0n), sessionId: "other" })
      ]
    });

    expect(pendingMobileInteractions(snapshot, "session").map((value) => value.interactionId))
      .toEqual(["plan", "permission", "question"]);
    expect(pendingMobileInteractions(snapshot, "other")).toEqual([]);
  });

  it("builds defaults and emits exact typed question answers in declaration order", () => {
    const interaction = questionInteraction("question", [text, single, multiple, boolean]);
    const initial = initialMobileInteractionDraft(interaction);
    expect(initial).toMatchObject({
      kind: "question",
      fieldIndex: 0,
      answers: { summary: { kind: "text", value: "" }, targets: { kind: "multiple", choiceIds: [] }, publish: { kind: "boolean", value: false } }
    });
    if (initial?.kind !== "question") throw new Error("missing question draft");
    const answers = {
      ...initial.answers,
      summary: { kind: "text", value: "Ready" } as const,
      release: { kind: "single", selection: { kind: "other", text: "Candidate" } } as const,
      targets: { kind: "multiple", choiceIds: ["web"], otherText: "Desktop" } as const
    };
    expect(mobileQuestionCanSubmit(interaction, answers)).toBe(true);
    const resolution = createMobileInteractionResolution(interaction, { kind: "question", answers }, "connection");
    expect(resolution.decision).toMatchObject({ case: "question", value: { answers: [
      { fieldId: "summary", value: { case: "text", value: "Ready" } },
      { fieldId: "release", value: { case: "singleChoice", value: { selection: { case: "otherText", value: "Candidate" } } } },
      { fieldId: "targets", value: { case: "multipleChoice", value: { choiceIds: ["web"], otherText: "Desktop" } } },
      { fieldId: "publish", value: { case: "boolean", value: false } }
    ] } });
  });

  it("fails closed on invalid declarations, unknown answers, bounds, and unadvertised decisions", () => {
    const missingOther = create(QuestionFieldSchema, {
      fieldId: "choice", label: "Choice",
      input: { case: "singleChoice", value: { choices: [{ choiceId: "one", label: "One" }] } }
    });
    expect(() => initialMobileInteractionDraft(questionInteraction("missing-other", [missingOther]))).toThrow(/explicit/u);
    expect(() => initialMobileInteractionDraft(questionInteraction("duplicate", [text, create(QuestionFieldSchema, { ...text })]))).toThrow(/duplicate/u);

    const interaction = questionInteraction("question", [text, multiple]);
    const invalid = {
      summary: { kind: "text", value: "Ready" } as const,
      targets: { kind: "multiple", choiceIds: ["web", "web"] } as const
    };
    expect(mobileQuestionCanSubmit(interaction, invalid)).toBe(false);
    expect(() => createMobileInteractionResolution(interaction, { kind: "question", answers: { ...invalid, legacy: { kind: "text", value: "x" } } }, "connection"))
      .toThrow(/not in the current request/u);

    const permission = permissionInteraction("permission", PermissionRisk.LOW);
    expect(() => createMobileInteractionResolution(permission, { kind: "permission", decision: PermissionDecisionKind.ALLOW_FOR_SESSION }, "connection"))
      .toThrow(/not currently available/u);
    const plan = planInteraction("plan");
    expect(() => createMobileInteractionResolution(plan, { kind: "plan", decision: PlanReviewDecisionKind.REFINE, feedback: "  " }, "connection"))
      .toThrow(/Describe what should change/u);
  });

  it("enforces multiple-choice capacity while preserving exact Other authority", () => {
    let answer = toggleMobileQuestionChoice(multiple, undefined, "web");
    answer = setMobileQuestionOther(multiple, answer, "Desktop");
    expect(answer).toEqual({ kind: "multiple", choiceIds: ["web"], otherText: "Desktop" });
    expect(toggleMobileQuestionChoice(multiple, answer, "mobile")).toEqual(answer);
    expect(mobileQuestionFieldError(multiple, answer, "en")).toBeUndefined();
    expect(setMobileQuestionOther(multiple, answer, "")).toEqual({ kind: "multiple", choiceIds: ["web"] });
  });

  it("requires confirmation for high-impact approvals and never exposes redacted argument values", () => {
    const permission = create(InteractionSchema, {
      ...permissionInteraction("permission", PermissionRisk.CRITICAL),
      request: { case: "permission", value: create(PermissionRequestSchema, {
        risk: PermissionRisk.CRITICAL,
        allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.DENY_ONCE],
        subject: create(PermissionSubjectSchema, { kind: { case: "mcp", value: create(McpPermissionSubjectSchema, {
          serverId: "server",
          toolName: "deploy",
          arguments: [create(DisplayArgumentSchema, {
            fieldPath: "token",
            redacted: true,
            redactedPlaceholder: "Secret value",
            value: { case: "text", value: "must-not-render" }
          })]
        }) } })
      }) }
    });
    expect(mobilePermissionDecisionNeedsConfirmation(permission, PermissionDecisionKind.ALLOW_ONCE)).toBe(true);
    expect(mobilePermissionDecisionNeedsConfirmation(permission, PermissionDecisionKind.DENY_ONCE)).toBe(false);
    expect(mobilePermissionDecisionNeedsConfirmation(
      permissionInteraction("unspecified", PermissionRisk.UNSPECIFIED),
      PermissionDecisionKind.ALLOW_ONCE
    )).toBe(true);
    const details = mobilePermissionDetails(
      permission.request.case === "permission" ? permission.request.value.subject : undefined,
      "en"
    );
    expect(details).toContainEqual({ label: "token", value: "Secret value", redacted: true });
    expect(JSON.stringify(details)).not.toContain("must-not-render");
  });
});

function questionInteraction(id: string, fields: readonly QuestionField[], created = 0n): Interaction {
  return create(InteractionSchema, {
    interactionId: id,
    kind: InteractionKind.QUESTION,
    state: InteractionState.PENDING,
    backendId: "backend",
    targetId: "target",
    sessionId: "session",
    generation: 8n,
    createdAt: { seconds: created },
    request: { case: "question", value: { title: "Questions", prompt: "Answer each field", fields: [...fields] } },
    version: { revision: { value: 4n }, generation: 8n }
  });
}

function permissionInteraction(id: string, risk: PermissionRisk, created = 0n): Interaction {
  return create(InteractionSchema, {
    interactionId: id,
    kind: InteractionKind.PERMISSION,
    state: InteractionState.PENDING,
    backendId: "backend",
    targetId: "target",
    sessionId: "session",
    generation: 8n,
    createdAt: { seconds: created },
    request: { case: "permission", value: {
      risk,
      title: "Permission",
      allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.DENY_ONCE]
    } },
    version: { revision: { value: 4n }, generation: 8n }
  });
}

function planInteraction(id: string, created = 0n): Interaction {
  return create(InteractionSchema, {
    interactionId: id,
    kind: InteractionKind.PLAN_REVIEW,
    state: InteractionState.PENDING,
    backendId: "backend",
    targetId: "target",
    sessionId: "session",
    generation: 8n,
    createdAt: { seconds: created },
    request: { case: "planReview", value: {
      title: "Review plan",
      markdown: "# Plan",
      steps: [{ stepId: "one", title: "First" }],
      allowedDecisions: [PlanReviewDecisionKind.EXECUTE, PlanReviewDecisionKind.REFINE]
    } },
    version: { revision: { value: 4n }, generation: 8n }
  });
}
