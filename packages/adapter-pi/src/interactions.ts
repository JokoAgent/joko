import {
  type AdapterEventMetadata,
  type AdapterContext,
  type InteractionDecision,
  type InteractionPayload,
  type PiExtensionUiMetadata,
  type PlanReviewDecision
} from "@joko/core";
import { redactManagedSecrets } from "./errors.js";
import { isRecord } from "./protocol.js";
import type { PiRpcTransport } from "./transport.js";

export async function handleExtensionUiRequest(
  event: Record<string, unknown>,
  context: AdapterContext,
  transport: PiRpcTransport,
  isCurrent: () => boolean,
  redactValues: readonly string[] = []
): Promise<void> {
  const eventId = stringValue(event.id);
  const method = stringValue(event.method);
  if (!eventId || !method) return;
  const timeoutMs = nativeDialogTimeout(event.timeout);
  // Pi starts its timer before writing the request to stdout, so the closest
  // safe local fence begins when the Adapter first receives that request, not
  // after durable Interaction registration has completed.
  const expiresAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  if (method === "notify") {
    const message = redact(stringValue(event.message), redactValues);
    const kind = extensionNotificationKind(event.notifyType);
    await context.emit(
      { type: "extension_ui_effect", effect: "notification", text: message, notificationKind: kind },
      extensionMetadata(method, event, {
        case: "notify",
        value: { message, kind }
      }, redactValues)
    );
    return;
  }
  if (method === "setStatus") {
    const key = redact(typeof event.statusKey === "string" ? event.statusKey : "status", redactValues);
    const statusText = typeof event.statusText === "string"
      ? redact(event.statusText, redactValues)
      : undefined;
    await context.emit(
      {
        type: "extension_status",
        key,
        ...(statusText === undefined ? {} : { text: statusText })
      },
      extensionMetadata(method, event, {
        case: "status",
        value: { statusKey: key, ...(statusText === undefined ? {} : { statusText }) }
      }, redactValues)
    );
    return;
  }
  if (method === "setWidget") {
    const lines = Array.isArray(event.widgetLines)
      ? event.widgetLines.filter((line): line is string => typeof line === "string")
          .map((line) => redact(line, redactValues))
      : [];
    const key = redact(typeof event.widgetKey === "string" ? event.widgetKey : eventId, redactValues);
    const placement = extensionWidgetPlacement(event.widgetPlacement);
    await context.emit(
      {
        type: "extension_widget",
        key,
        lines,
        placement: placement === "below_editor" ? "below_editor" : "above_editor",
        removed: !Array.isArray(event.widgetLines)
      },
      extensionMetadata(method, event, {
        case: "widget",
        value: {
          widgetKey: key,
          lines,
          placement,
          removed: !Array.isArray(event.widgetLines)
        }
      }, redactValues)
    );
    return;
  }
  if (method === "setTitle" || method === "set_editor_text") {
    const text = redact(stringValue(method === "setTitle" ? event.title : event.text), redactValues);
    await context.emit(
      {
        type: "extension_ui_effect",
        effect: method === "setTitle" ? "title" : "editor_text",
        text
      },
      extensionMetadata(method, event, method === "setTitle"
        ? { case: "title", value: { title: text } }
        : { case: "editorText", value: { text } }, redactValues)
    );
    return;
  }

  const interaction = toInteraction(event, context, redactValues);
  if (!interaction) {
    await transport.notify({ type: "extension_ui_response", id: eventId, cancelled: true });
    return;
  }
  try {
    // SessionHost/Store is the sole owner of the durable opened/terminal
    // lifecycle. The Adapter only bridges the resulting decision to Pi.
    const decisionPromise = context.requestInteraction(interaction);
    const result = expiresAt === undefined
      ? { kind: "decision", decision: await decisionPromise } as const
      : await decisionBeforeDeadline(decisionPromise, expiresAt);
    // Pi starts this timer before emitting the RPC request and resolves its
    // own select/input/confirm default when it expires. Do not replace that
    // native default with a Joko cancellation, and never submit a late Host
    // answer after our matching expiry fence has closed.
    if (result.kind === "expired" || !isCurrent() || transport.closed) return;
    const decision = result.decision;
    await transport.notify(toExtensionResponse(eventId, method, interaction, decision));
  } catch {
    if (isCurrent() && !transport.closed) {
      await transport.notify({ type: "extension_ui_response", id: eventId, cancelled: true }).catch(() => undefined);
    }
  }
}

async function decisionBeforeDeadline(
  decision: Promise<InteractionDecision>,
  expiresAt: number
): Promise<{ readonly kind: "decision"; readonly decision: InteractionDecision } | { readonly kind: "expired" }> {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return { kind: "expired" };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      decision.then((value) => ({ kind: "decision", decision: value }) as const),
      new Promise<{ readonly kind: "expired" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "expired" }), remainingMs);
      })
    ]);
    return result.kind === "decision" && Date.now() >= expiresAt ? { kind: "expired" } : result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function toInteraction(
  event: Record<string, unknown>,
  context: AdapterContext,
  redactValues: readonly string[]
): InteractionPayload | undefined {
  const eventId = stringValue(event.id);
  const method = stringValue(event.method);
  const rawTitle = stringValue(event.title);
  const id = `pi:${context.sessionId}:${context.generation}:${eventId}`;
  if (method === "confirm" && rawTitle.startsWith("joko:permission:")) {
    const toolName = rawTitle.slice("joko:permission:".length) || "unknown";
    const summary = redact(stringValue(event.message), redactValues);
    return {
      id,
      kind: "permission",
      title: `Allow Pi tool: ${toolName}`,
      toolName,
      summary,
      risk: riskForTool(toolName, summary),
      choices: ["allow_once", "deny"]
    };
  }
  if (method === "select" && rawTitle.startsWith("joko:plan-review\n")) {
    return {
      id,
      kind: "plan_review",
      title: "Review Pi plan",
      markdown: redact(rawTitle.slice("joko:plan-review\n".length), redactValues),
      choices: planChoices(event.options)
    };
  }
  if (method === "editor" && rawTitle.startsWith("joko:question\n")) {
    return questionInteraction(id, rawTitle.slice("joko:question\n".length), redactValues);
  }
  if (method === "select") {
    return {
      id,
      kind: "extension_select",
      extensionId: "pi",
      title: redact(rawTitle || "Pi extension selection", redactValues),
      options: stringArray(event.options).map((option) => redact(option, redactValues)),
      timeoutMs: nativeDialogTimeout(event.timeout)
    };
  }
  if (method === "confirm") {
    return {
      id,
      kind: "extension_confirm",
      extensionId: "pi",
      title: redact(rawTitle || "Pi extension confirmation", redactValues),
      message: redact(stringValue(event.message), redactValues),
      timeoutMs: nativeDialogTimeout(event.timeout)
    };
  }
  if (method === "input") {
    return {
      id,
      kind: "extension_input",
      extensionId: "pi",
      title: redact(rawTitle || "Pi extension input", redactValues),
      placeholder: redact(stringValue(event.placeholder), redactValues) || undefined,
      timeoutMs: nativeDialogTimeout(event.timeout)
    };
  }
  if (method === "editor") {
    return {
      id,
      kind: "extension_editor",
      extensionId: "pi",
      title: redact(rawTitle || "Pi extension editor", redactValues),
      prefill: redact(stringValue(event.prefill), redactValues) || undefined
    };
  }
  return undefined;
}

function toExtensionResponse(
  id: string,
  method: string,
  interaction: InteractionPayload,
  decision: InteractionDecision
): { readonly type: "extension_ui_response"; readonly id: string; readonly value: string } | {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly confirmed: boolean;
} | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true } {
  if (decision.kind === "cancelled") return { type: "extension_ui_response", id, cancelled: true };
  if (interaction.kind === "plan_review") {
    if (decision.kind !== "plan_review" || !interaction.choices.includes(decision.decision)) {
      return { type: "extension_ui_response", id, cancelled: true };
    }
    return {
      type: "extension_ui_response",
      id,
      value: JSON.stringify({ decision: decision.decision, feedback: decision.feedback })
    };
  }
  if (interaction.kind === "question") {
    if (decision.kind !== "question") return { type: "extension_ui_response", id, cancelled: true };
    const answers = validatedQuestionAnswers(interaction, decision.answers);
    if (answers === undefined) return { type: "extension_ui_response", id, cancelled: true };
    return { type: "extension_ui_response", id, value: JSON.stringify({ answers }) };
  }
  if (method === "confirm") {
    const confirmed = decision.kind === "confirmed"
      ? decision.confirmed
      : decision.kind === "selected" && (decision.value === "allow_once" || decision.value === "yes");
    return { type: "extension_ui_response", id, confirmed };
  }
  if (decision.kind === "plan_review" || decision.kind === "question") {
    return { type: "extension_ui_response", id, cancelled: true };
  }
  const value = decision.kind === "selected" ? decision.value : decision.confirmed ? "Yes" : "No";
  return { type: "extension_ui_response", id, value };
}

function questionInteraction(id: string, encoded: string, redactValues: readonly string[]): InteractionPayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > 8) return undefined;
  const fields: Extract<InteractionPayload, { readonly kind: "question" }>["fields"][number][] = [];
  const ids = new Set<string>();
  for (const candidate of value.fields) {
    if (!isRecord(candidate)) return undefined;
    const fieldId = boundedText(candidate.id, 128);
    const label = boundedText(candidate.label, 512);
    const kind = stringValue(candidate.kind);
    if (!fieldId || !label || ids.has(fieldId)) return undefined;
    ids.add(fieldId);
    const base = {
      id: fieldId,
      label: redact(label, redactValues),
      ...(boundedText(candidate.description, 4_096) === "" ? {} : { description: redact(boundedText(candidate.description, 4_096), redactValues) }),
      required: candidate.required !== false
    };
    if (kind === "text") {
      fields.push({
        ...base,
        kind: "text",
        ...(boundedText(candidate.placeholder, 512) === "" ? {} : { placeholder: redact(boundedText(candidate.placeholder, 512), redactValues) }),
        multiline: candidate.multiline !== false,
        sensitive: false
      });
      continue;
    }
    if (kind === "boolean") {
      fields.push({ ...base, kind: "boolean", defaultValue: candidate.defaultValue === true });
      continue;
    }
    if ((kind === "single" || kind === "multiple") && Array.isArray(candidate.choices) && candidate.choices.length > 0 && candidate.choices.length <= 16) {
      const choices = candidate.choices.map((choice) => {
        if (!isRecord(choice)) return undefined;
        const choiceId = boundedText(choice.id, 128);
        const choiceLabel = boundedText(choice.label, 512);
        if (!choiceId || !choiceLabel) return undefined;
        const description = boundedText(choice.description, 2_048);
        return {
          id: choiceId,
          label: redact(choiceLabel, redactValues),
          ...(description === "" ? {} : { description: redact(description, redactValues) })
        };
      });
      if (choices.some((choice) => choice === undefined)) return undefined;
      const typedChoices = choices as Array<{ readonly id: string; readonly label: string; readonly description?: string }>;
      if (new Set(typedChoices.map((choice) => choice.id)).size !== typedChoices.length) return undefined;
      if (kind === "single") {
        fields.push({ ...base, kind: "single", choices: typedChoices });
      } else {
        fields.push({
          ...base,
          kind: "multiple",
          choices: typedChoices,
          defaultChoiceIds: [],
          minimumSelections: base.required ? 1 : 0,
          // One additional slot is reserved for the free-form "Other"
          // answer, which is carried as the sole non-choice string.
          maximumSelections: typedChoices.length + 1
        });
      }
      continue;
    }
    return undefined;
  }
  return {
    id,
    kind: "question",
    title: redact(boundedText(value.title, 512) || "Pi question", redactValues),
    prompt: redact(boundedText(value.prompt, 4_096), redactValues),
    fields
  };
}

function validatedQuestionAnswers(
  interaction: Extract<InteractionPayload, { readonly kind: "question" }>,
  answers: Readonly<Record<string, string | boolean | readonly string[]>>
): Record<string, string | boolean | readonly string[]> | undefined {
  const result: Record<string, string | boolean | readonly string[]> = {};
  for (const field of interaction.fields) {
    const answer = answers[field.id];
    if (answer === undefined) {
      if (field.required) return undefined;
      continue;
    }
    if (field.kind === "text") {
      if (typeof answer !== "string" || (field.required && answer.trim() === "")) return undefined;
      result[field.id] = answer;
      continue;
    }
    if (field.kind === "boolean") {
      if (typeof answer !== "boolean") return undefined;
      result[field.id] = answer;
      continue;
    }
    const allowed = new Set(field.choices.map((choice) => choice.id));
    if (field.kind === "single") {
      if (typeof answer !== "string" || answer.trim() === "") return undefined;
      result[field.id] = answer;
      continue;
    }
    if (!Array.isArray(answer) || answer.some((choice) => typeof choice !== "string" || choice.trim() === "") || new Set(answer).size !== answer.length) return undefined;
    if (answer.filter((choice) => !allowed.has(choice)).length > 1) return undefined;
    if (answer.length < field.minimumSelections || (field.maximumSelections !== undefined && answer.length > field.maximumSelections)) return undefined;
    result[field.id] = [...answer];
  }
  return result;
}

function planChoices(value: unknown): PlanReviewDecision[] {
  const choices: PlanReviewDecision[] = [];
  for (const option of stringArray(value)) {
    const decision = planChoice(option);
    if (decision !== undefined && !choices.includes(decision)) choices.push(decision);
  }
  return choices;
}

function planChoice(value: string): PlanReviewDecision | undefined {
  switch (value.trim().toLowerCase().replace(/[ _-]+/gu, " ")) {
    case "execute":
    case "execute plan":
      return "execute";
    case "stay":
    case "stay in plan mode":
      return "stay";
    case "refine":
    case "refine plan":
      return "refine";
    default:
      return undefined;
  }
}

function riskForTool(toolName: string, summary: string): "low" | "medium" | "high" {
  if (toolName.startsWith("mcp__") || toolName === "bash" || toolName === "write" || toolName === "edit") return "high";
  if (/delete|remove|credential|secret|publish|deploy|payment/i.test(`${toolName} ${summary}`)) return "high";
  return "medium";
}

function extensionMetadata(
  method: string,
  event: Record<string, unknown>,
  effect: PiExtensionUiMetadata["effect"],
  redactValues: readonly string[]
): AdapterEventMetadata {
  const fields: Record<string, string | number | boolean> = { rpcEventType: "extension_ui_request", method };
  const requestId = redact(stringValue(event.id), redactValues);
  if (requestId !== "") fields.requestId = requestId;
  return {
    namespace: "pi",
    fields,
    pi: {
      rpcEventType: "extension_ui_effect",
      payload: {
        case: "extensionUiEffect",
        value: extensionUiMetadata(requestId, effect)
      }
    }
  };
}

function extensionUiMetadata(
  requestId: string,
  effect: PiExtensionUiMetadata["effect"]
): PiExtensionUiMetadata {
  // Pi's RPC wire does not identify the originating extension. Keep the
  // absence explicit instead of inventing an unstable identity.
  const common = { requestId, extensionId: "" } as const;
  switch (effect.case) {
    case "notify": return { ...common, effect };
    case "status": return { ...common, effect };
    case "widget": return { ...common, effect };
    case "title": return { ...common, effect };
    case "editorText": return { ...common, effect };
  }
}

function extensionNotificationKind(value: unknown): "unknown" | "info" | "warning" | "error" {
  return value === undefined || value === "info"
    ? "info"
    : value === "warning" || value === "error"
      ? value
      : "unknown";
}

function extensionWidgetPlacement(value: unknown): "unknown" | "above_editor" | "below_editor" {
  return value === undefined || value === "aboveEditor"
    ? "above_editor"
    : value === "belowEditor"
      ? "below_editor"
      : "unknown";
}

function redact(value: string, secrets: readonly string[]): string {
  return redactManagedSecrets(value, secrets);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedText(value: unknown, maximum: number): string {
  return stringValue(value).trim().slice(0, maximum);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nativeDialogTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return undefined;
  // Pi passes the extension timeout directly to setTimeout. Preserve its
  // immediate-default behavior for a malformed negative timeout while still
  // registering the product Interaction before the timer gets a turn.
  if (value > 2_147_483_647) return 1;
  return Math.max(0, Math.trunc(value));
}

export function parsePermissionInput(message: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(message) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
