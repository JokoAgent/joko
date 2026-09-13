import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  InteractionKind,
  InteractionState,
  OperationState,
  PermissionDecisionKind,
  PlanReviewDecisionKind,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, GatewayError } from "./gateway.js";
import type { AppSnapshot, InteractionResolutionDraft } from "./model.js";

describe("Interaction gateway exact submissions", () => {
  it("rejects non-canonical, unknown, and unadvertised permission and plan decisions before submit", async () => {
    const fixture = await connectedGateway([
      interaction("permission", InteractionKind.PERMISSION, {
        case: "permission",
        value: { allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.DENY_ONCE] }
      }),
      interaction("plan", InteractionKind.PLAN_REVIEW, {
        case: "planReview",
        value: { allowedDecisions: [PlanReviewDecisionKind.EXECUTE] }
      })
    ]);

    for (const decisionId of ["not-a-number", "1.0", "0", "9007199254740992", "6"]) {
      await expectGatewayError(fixture.gateway.resolveInteraction(fixture.view("permission"), {
        kind: "permission",
        decisionId
      }), /current|advertised/u);
    }
    for (const decisionId of ["not-a-number", "1.0", "0", "3"]) {
      await expectGatewayError(fixture.gateway.resolveInteraction(fixture.view("plan"), {
        kind: "plan",
        decisionId,
        feedback: ""
      }), /current|advertised/u);
    }
    await expectGatewayError(fixture.gateway.resolveInteraction(fixture.view("plan"), {
      kind: "plan",
      decisionId: "1",
      feedback: false
    } as unknown as InteractionResolutionDraft), /feedback must be text/u);

    expect(fixture.submitOperation).not.toHaveBeenCalled();
    fixture.gateway.disconnect();
  });

  it("validates question fields and every submitted field exactly before submit", async () => {
    const fixture = await connectedGateway([
      interaction("question", InteractionKind.QUESTION, {
        case: "question",
        value: { fields: [
          { fieldId: "summary", label: "Summary", required: true, input: { case: "text", value: {} } },
          { fieldId: "release", label: "Release", required: true, input: { case: "singleChoice", value: {
            choices: [{ choiceId: "stable", label: "Stable" }, { choiceId: "preview", label: "Preview" }],
            allowOther: true
          } } },
          { fieldId: "targets", label: "Targets", input: { case: "multipleChoice", value: {
            choices: [{ choiceId: "web", label: "Web" }, { choiceId: "desktop", label: "Desktop" }],
            minimumSelections: 1,
            maximumSelections: 2,
            allowOther: true
          } } },
          { fieldId: "publish", label: "Publish", required: true, input: { case: "boolean", value: {} } }
        ] }
      })
    ]);
    const view = fixture.view("question");
    const valid = {
      summary: { kind: "text", value: "Ready" },
      release: { kind: "single", selection: { kind: "choice", choiceId: "stable" } },
      targets: { kind: "multiple", choiceIds: ["web"] },
      publish: { kind: "boolean", value: false }
    } as const;
    const invalidAnswers: readonly Readonly<Record<string, unknown>>[] = [
      { ...valid, legacy: { kind: "text", value: "silently dropped before" } },
      { release: valid.release, targets: valid.targets, publish: valid.publish },
      { ...valid, summary: { kind: "text", value: "   " } },
      { ...valid, release: { kind: "single", selection: { kind: "choice", choiceId: "nightly" } } },
      { ...valid, release: { kind: "single", selection: { kind: "other", text: "   " } } },
      { ...valid, targets: { kind: "multiple", choiceIds: ["web", "web"] } },
      { ...valid, targets: { kind: "multiple", choiceIds: [] } },
      { ...valid, targets: { kind: "multiple", choiceIds: ["web", "desktop"], otherText: "custom" } },
      { ...valid, targets: { kind: "multiple", choiceIds: ["web"], otherText: "   " } },
      { ...valid, publish: { kind: "boolean", value: "yes" } }
    ];

    for (const answers of invalidAnswers) {
      await expectGatewayError(fixture.gateway.resolveInteraction(view, {
        kind: "question",
        answers
      } as unknown as InteractionResolutionDraft));
    }

    await fixture.gateway.resolveInteraction(view, {
      kind: "question",
      answers: {
        summary: valid.summary,
        release: { kind: "single", selection: { kind: "other", text: "stable" } },
        targets: { kind: "multiple", choiceIds: ["web"], otherText: "desktop" },
        publish: valid.publish
      }
    });
    expect(fixture.submittedDecisions).toMatchObject([{ case: "question", value: { answers: [
      { fieldId: "summary", value: { case: "text", value: "Ready" } },
      { fieldId: "release", value: { case: "singleChoice", value: {
        selection: { case: "otherText", value: "stable" }
      } } },
      { fieldId: "targets", value: { case: "multipleChoice", value: {
        choiceIds: ["web"], otherText: "desktop"
      } } },
      { fieldId: "publish", value: { case: "boolean", value: false } }
    ] } }]);
    fixture.gateway.disconnect();
  });

  it("rejects invalid durable question declarations even when their optional fields are unanswered", async () => {
    const malformed = [
      ["duplicate-fields", [
        textField("answer", true),
        textField("answer", false)
      ]],
      ["missing-input", [
        textField("answer", true),
        { fieldId: "optional", label: "Optional", input: {} }
      ]],
      ["duplicate-choices", [
        textField("answer", true),
        { fieldId: "optional", label: "Optional", input: { case: "singleChoice", value: {
          choices: [{ choiceId: "same", label: "One" }, { choiceId: "same", label: "Two" }], allowOther: false
        } } }
      ]],
      ["invalid-default", [
        textField("answer", true),
        { fieldId: "optional", label: "Optional", input: { case: "singleChoice", value: {
          choices: [{ choiceId: "one", label: "One" }], defaultChoiceId: "absent", allowOther: false
        } } }
      ]],
      ["invalid-bounds", [
        textField("answer", true),
        { fieldId: "optional", label: "Optional", input: { case: "multipleChoice", value: {
          choices: [{ choiceId: "one", label: "One" }],
          defaultChoiceIds: ["one", "one"], minimumSelections: 2, maximumSelections: 1, allowOther: false
        } } }
      ]]
    ] as const;

    for (const [id, fields] of malformed) {
      await expect(connectedGateway([malformedQuestion(id, fields)])).rejects.toThrow(/question|field|choice/u);
    }
  });

  it("rejects a choice field whose current snapshot omits explicit free-text authority", async () => {
    await expect(connectedGateway([
      malformedQuestion("missing-allow-other", [
        { fieldId: "answer", label: "Answer", input: { case: "singleChoice", value: {
          choices: [{ choiceId: "one", label: "One" }]
        } } }
      ])
    ])).rejects.toThrow(/explicit free-text authority/u);
  });

  it("matches extension results to the exact request branch and advertised selection", async () => {
    const fixture = await connectedGateway([
      extensionInteraction("select", { case: "select", value: { options: ["alpha", "beta"] } }),
      extensionInteraction("confirm", { case: "confirm", value: {} }),
      extensionInteraction("input", { case: "input", value: {} }),
      extensionInteraction("editor", { case: "editor", value: {} }),
      extensionInteraction("missing-extension-branch", {}),
      interaction("missing-interaction-branch", InteractionKind.QUESTION, {})
    ]);

    const invalid: readonly [string, InteractionResolutionDraft][] = [
      ["select", { kind: "extension", value: "gamma" }],
      ["select", { kind: "extension", value: true }],
      ["confirm", { kind: "extension", value: "yes" }],
      ["input", { kind: "extension", value: false }],
      ["editor", { kind: "extension", value: true }],
      ["missing-extension-branch", { kind: "extension", value: "anything" }],
      ["missing-interaction-branch", { kind: "question", answers: {} }]
    ];
    for (const [id, resolution] of invalid) {
      await expectGatewayError(fixture.gateway.resolveInteraction(fixture.view(id), resolution), /extension|interaction|advertised/u);
    }

    expect(fixture.submitOperation).not.toHaveBeenCalled();
    fixture.gateway.disconnect();
  });

  it("submits only exact advertised decisions and branch-matched values", async () => {
    const fixture = await connectedGateway([
      interaction("permission", InteractionKind.PERMISSION, {
        case: "permission", value: { allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE] }
      }),
      interaction("plan", InteractionKind.PLAN_REVIEW, {
        case: "planReview", value: { allowedDecisions: [PlanReviewDecisionKind.REFINE] }
      }),
      extensionInteraction("select", { case: "select", value: { options: ["alpha", "beta"] } }),
      extensionInteraction("confirm", { case: "confirm", value: {} }),
      extensionInteraction("input", { case: "input", value: {} }),
      extensionInteraction("editor", { case: "editor", value: {} })
    ]);

    await fixture.gateway.resolveInteraction(fixture.view("permission"), { kind: "permission", decisionId: "1" });
    await fixture.gateway.resolveInteraction(fixture.view("plan"), { kind: "plan", decisionId: "3", feedback: "Revise scope" });
    await fixture.gateway.resolveInteraction(fixture.view("select"), { kind: "extension", value: "beta" });
    await fixture.gateway.resolveInteraction(fixture.view("confirm"), { kind: "extension", value: false });
    await fixture.gateway.resolveInteraction(fixture.view("input"), { kind: "extension", value: "value" });
    await fixture.gateway.resolveInteraction(fixture.view("editor"), { kind: "extension", value: "edited" });

    expect(fixture.submittedDecisions).toMatchObject([
      { case: "permission", value: { decision: PermissionDecisionKind.ALLOW_ONCE } },
      { case: "planReview", value: { decision: PlanReviewDecisionKind.REFINE, feedback: "Revise scope" } },
      { case: "extensionUi", value: { result: { case: "value", value: "beta" } } },
      { case: "extensionUi", value: { result: { case: "confirmed", value: false } } },
      { case: "extensionUi", value: { result: { case: "value", value: "value" } } },
      { case: "extensionUi", value: { result: { case: "value", value: "edited" } } }
    ]);
    fixture.gateway.disconnect();
  });
});

type SnapshotInteraction = NonNullable<MessageInitShape<typeof SnapshotSchema>["interactions"]>[number];

function interaction(id: string, kind: InteractionKind, request: unknown): SnapshotInteraction {
  return {
    interactionId: id,
    sessionId: "session",
    generation: 1n,
    kind,
    state: InteractionState.PENDING,
    request
  } as SnapshotInteraction;
}

function extensionInteraction(id: string, request: unknown): SnapshotInteraction {
  return interaction(id, InteractionKind.EXTENSION_UI, {
    case: "extensionUi",
    value: { requestId: id, extensionId: "extension", request }
  });
}

function malformedQuestion(id: string, fields: readonly unknown[]): SnapshotInteraction {
  return interaction(id, InteractionKind.QUESTION, { case: "question", value: { fields } });
}

function textField(fieldId: string, required: boolean): unknown {
  return { fieldId, label: fieldId, required, input: { case: "text", value: {} } };
}

async function connectedGateway(interactions: readonly SnapshotInteraction[]) {
  let snapshot: AppSnapshot | undefined;
  const submittedDecisions: unknown[] = [];
  const submitOperation = vi.fn((input: any) => {
    submittedDecisions.push(input.mutation?.payload?.value?.resolution?.decision);
    return create(SubmitOperationResponseSchema, {
      operation: { operationId: input.operationId, state: OperationState.SUCCEEDED }
    });
  });
  const transport = snapshotTransport(interactions, (method, input) => {
    if (method === "submitOperation") return submitOperation(input);
    throw new Error(`Unexpected method: ${method}`);
  });
  const gateway = createOrchestratorGateway(
    { id: "interaction-test", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
    "auth-key",
    { onSnapshot: (value) => { snapshot = value; } },
    () => transport
  );
  await gateway.connect();
  return {
    gateway,
    submitOperation,
    submittedDecisions,
    view: (id: string) => {
      const view = snapshot?.interactions.find((candidate) => candidate.id === id);
      if (view === undefined) throw new Error(`Missing projected interaction: ${id}`);
      return view;
    }
  };
}

function snapshotTransport(
  interactions: readonly SnapshotInteraction[],
  handler: (method: string, input: any) => unknown
): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            interactions: [...interactions]
          })
        }));
      }
      return response(method, await handler(method.localName, input));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

async function expectGatewayError(action: Promise<unknown>, message?: RegExp): Promise<void> {
  const rejection = await action.then(() => undefined, (error: unknown) => error);
  expect(rejection).toBeInstanceOf(GatewayError);
  if (message !== undefined) expect((rejection as Error).message).toMatch(message);
}
