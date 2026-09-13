import type {
  EventPayload,
  InteractionDecision,
  InteractionPayload,
  InteractionQuestionAnswer,
  InteractionQuestionField
} from "@joko/core";

import { StoreError } from "./errors.js";

type JsonRecord = Readonly<Record<string, unknown>>;
type QuestionPayload = Extract<InteractionPayload, { readonly kind: "question" }>;

/**
 * Parse the one current-v1 durable Interaction request shape. This is a Store
 * boundary, so structurally old or widened JSON is rejected instead of being
 * returned under a TypeScript assertion.
 */
export function parseCurrentInteractionPayload(value: unknown): InteractionPayload {
  const payload = recordWithKeys(value, ["id", "kind"]);
  requireNonBlankString(payload["id"]);
  switch (payload["kind"]) {
    case "permission":
      requireExactKeys(payload, ["id", "kind", "title", "toolName", "summary", "risk", "choices"]);
      requireStrings(payload, ["title", "toolName", "summary"]);
      requireEnum(payload["risk"], ["low", "medium", "high"] as const);
      requireStringArray(payload["choices"]);
      return payload as unknown as InteractionPayload;
    case "question": {
      requireExactKeys(payload, ["id", "kind", "title", "prompt", "fields"]);
      requireStrings(payload, ["title", "prompt"]);
      if (!Array.isArray(payload["fields"]) || payload["fields"].length === 0) invalidPayload();
      const fieldIds = new Set<string>();
      for (const fieldValue of payload["fields"]) {
        const field = parseQuestionField(fieldValue);
        if (fieldIds.has(field.id)) invalidPayload();
        fieldIds.add(field.id);
      }
      return payload as unknown as InteractionPayload;
    }
    case "plan_review":
      requireExactKeys(payload, ["id", "kind", "title", "markdown", "choices"]);
      requireStrings(payload, ["title", "markdown"]);
      requireEnumArray(payload["choices"], ["execute", "stay", "refine"] as const);
      return payload as unknown as InteractionPayload;
    case "extension_select":
    case "extension_confirm":
    case "extension_input":
    case "extension_editor":
      requireExactKeys(
        payload,
        ["id", "kind", "extensionId", "title"],
        ["message", "options", "prefill", "placeholder", "timeoutMs"]
      );
      requireStrings(payload, ["extensionId", "title"]);
      requireOptionalStrings(payload, ["message", "prefill", "placeholder"]);
      if (payload["options"] !== undefined) requireStringArray(payload["options"]);
      if (payload["timeoutMs"] !== undefined
        && (!Number.isSafeInteger(payload["timeoutMs"]) || (payload["timeoutMs"] as number) < 0)) {
        invalidPayload();
      }
      return payload as unknown as InteractionPayload;
    default:
      return invalidPayload();
  }
}

/** Parse and correlate one current-v1 durable decision with its open request. */
export function parseCurrentInteractionDecision(
  payload: InteractionPayload,
  value: unknown
): InteractionDecision {
  const decision = recordWithKeys(value, ["kind"]);
  switch (payload.kind) {
    case "permission":
      requireExactKeys(decision, ["kind", "value"]);
      if (decision["kind"] !== "selected" || typeof decision["value"] !== "string"
        || !payload.choices.includes(decision["value"])) {
        invalidDecision();
      }
      return decision as unknown as InteractionDecision;
    case "question":
      return parseQuestionDecision(payload, decision);
    case "plan_review":
      requireExactKeys(decision, ["kind", "decision", "feedback"]);
      if (decision["kind"] !== "plan_review" || typeof decision["feedback"] !== "string"
        || !isOneOf(decision["decision"], ["execute", "stay", "refine"] as const)
        || !payload.choices.includes(decision["decision"])) {
        invalidDecision();
      }
      return decision as unknown as InteractionDecision;
    case "extension_confirm":
      if (decision["kind"] === "cancelled") return parseCancelledDecision(decision);
      requireExactKeys(decision, ["kind", "confirmed"]);
      if (decision["kind"] !== "confirmed" || typeof decision["confirmed"] !== "boolean") invalidDecision();
      return decision as unknown as InteractionDecision;
    case "extension_select":
      if (decision["kind"] === "cancelled") return parseCancelledDecision(decision);
      requireExactKeys(decision, ["kind", "value"]);
      if (decision["kind"] !== "selected" || typeof decision["value"] !== "string"
        || !(payload.options ?? []).includes(decision["value"])) {
        invalidDecision();
      }
      return decision as unknown as InteractionDecision;
    case "extension_input":
    case "extension_editor":
      if (decision["kind"] === "cancelled") return parseCancelledDecision(decision);
      requireExactKeys(decision, ["kind", "value"]);
      if (decision["kind"] !== "selected" || typeof decision["value"] !== "string") invalidDecision();
      return decision as unknown as InteractionDecision;
  }
}

/** Validate only the Interaction branch while leaving other Event unions to their owners. */
export function parseCurrentInteractionEventPayload(value: unknown): EventPayload {
  if (!isRecord(value) || value["type"] !== "interaction_opened") return value as EventPayload;
  requireExactKeys(value, ["type", "interaction"]);
  return {
    type: "interaction_opened",
    interaction: parseCurrentInteractionPayload(value["interaction"])
  };
}

function parseQuestionField(value: unknown): InteractionQuestionField {
  const field = recordWithKeys(value, ["id", "kind", "label", "required"]);
  requireNonBlankString(field["id"]);
  if (typeof field["label"] !== "string" || typeof field["required"] !== "boolean") invalidPayload();
  if (field["description"] !== undefined && typeof field["description"] !== "string") invalidPayload();
  const optionalBase = ["description"] as const;
  switch (field["kind"]) {
    case "text":
      requireExactKeys(
        field,
        ["id", "kind", "label", "required", "multiline"],
        [...optionalBase, "placeholder", "defaultValue"]
      );
      if (typeof field["multiline"] !== "boolean") invalidPayload();
      requireOptionalStrings(field, ["placeholder", "defaultValue"]);
      return field as unknown as InteractionQuestionField;
    case "single": {
      requireExactKeys(
        field,
        ["id", "kind", "label", "required", "choices", "allowOther"],
        [...optionalBase, "defaultChoiceId"]
      );
      if (typeof field["allowOther"] !== "boolean") invalidPayload();
      const choiceIds = parseQuestionChoices(field["choices"]);
      if (field["defaultChoiceId"] !== undefined
        && (typeof field["defaultChoiceId"] !== "string" || !choiceIds.has(field["defaultChoiceId"]))) {
        invalidPayload();
      }
      return field as unknown as InteractionQuestionField;
    }
    case "multiple": {
      requireExactKeys(
        field,
        [
          "id", "kind", "label", "required", "choices", "defaultChoiceIds",
          "minimumSelections", "allowOther"
        ],
        [...optionalBase, "maximumSelections"]
      );
      if (typeof field["allowOther"] !== "boolean") invalidPayload();
      const choiceIds = parseQuestionChoices(field["choices"]);
      const defaults = requireStringArray(field["defaultChoiceIds"]);
      if (new Set(defaults).size !== defaults.length || defaults.some((id) => !choiceIds.has(id))) invalidPayload();
      const minimum = field["minimumSelections"];
      const maximum = field["maximumSelections"];
      const effectiveMinimum = Math.max(field["required"] ? 1 : 0, minimum as number);
      const capacity = choiceIds.size + (field["allowOther"] ? 1 : 0);
      if (!Number.isSafeInteger(minimum) || (minimum as number) < 0 || effectiveMinimum > capacity
        || (maximum !== undefined && (!Number.isSafeInteger(maximum)
          || (maximum as number) < effectiveMinimum || (maximum as number) > capacity))
        || (maximum !== undefined && defaults.length > (maximum as number))) {
        invalidPayload();
      }
      return field as unknown as InteractionQuestionField;
    }
    case "boolean":
      requireExactKeys(
        field,
        ["id", "kind", "label", "required", "defaultValue"],
        optionalBase
      );
      if (typeof field["defaultValue"] !== "boolean") invalidPayload();
      return field as unknown as InteractionQuestionField;
    default:
      return invalidPayload();
  }
}

function parseQuestionChoices(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) invalidPayload();
  const ids = new Set<string>();
  for (const choiceValue of value) {
    const choice = exactRecord(choiceValue, ["id", "label"], ["description"]);
    requireNonBlankString(choice["id"]);
    if (typeof choice["label"] !== "string"
      || (choice["description"] !== undefined && typeof choice["description"] !== "string")
      || ids.has(choice["id"] as string)) {
      invalidPayload();
    }
    ids.add(choice["id"] as string);
  }
  return ids;
}

function parseQuestionDecision(payload: QuestionPayload, value: JsonRecord): InteractionDecision {
  requireExactKeys(value, ["kind", "answers"]);
  if (value["kind"] !== "question" || !isRecord(value["answers"])) invalidDecision();
  const answers = value["answers"] as JsonRecord;
  const fields = new Map(payload.fields.map((field) => [field.id, field]));
  for (const [fieldId, answer] of Object.entries(answers)) {
    const field = fields.get(fieldId);
    if (field === undefined) invalidDecision();
    parseQuestionAnswer(field, answer);
  }
  for (const field of payload.fields) {
    if (field.required && !Object.hasOwn(answers, field.id)) invalidDecision();
  }
  return value as unknown as InteractionDecision;
}

function parseQuestionAnswer(field: InteractionQuestionField, value: unknown): InteractionQuestionAnswer {
  const answer = recordWithKeys(value, ["kind"]);
  switch (field.kind) {
    case "text":
      requireExactKeys(answer, ["kind", "value"]);
      if (answer["kind"] !== "text" || typeof answer["value"] !== "string"
        || (field.required && answer["value"].trim() === "")) {
        invalidDecision();
      }
      return answer as unknown as InteractionQuestionAnswer;
    case "single": {
      requireExactKeys(answer, ["kind", "selection"]);
      if (answer["kind"] !== "single") invalidDecision();
      const selection = recordWithKeys(answer["selection"], ["kind"]);
      if (selection["kind"] === "choice") {
        requireExactKeys(selection, ["kind", "choiceId"]);
        if (typeof selection["choiceId"] !== "string"
          || !field.choices.some((choice) => choice.id === selection["choiceId"])) {
          invalidDecision();
        }
      } else if (selection["kind"] === "other") {
        requireExactKeys(selection, ["kind", "text"]);
        if (!field.allowOther || typeof selection["text"] !== "string" || selection["text"].trim() === "") {
          invalidDecision();
        }
      } else {
        invalidDecision();
      }
      return answer as unknown as InteractionQuestionAnswer;
    }
    case "multiple": {
      requireExactKeys(answer, ["kind", "choiceIds"], ["otherText"]);
      if (answer["kind"] !== "multiple") invalidDecision();
      const choiceIds = requireStringArray(answer["choiceIds"]);
      if (new Set(choiceIds).size !== choiceIds.length
        || choiceIds.some((id) => !field.choices.some((choice) => choice.id === id))) {
        invalidDecision();
      }
      const otherText = answer["otherText"];
      if (otherText !== undefined
        && (!field.allowOther || typeof otherText !== "string" || otherText.trim() === "")) {
        invalidDecision();
      }
      const selectionCount = choiceIds.length + (otherText === undefined ? 0 : 1);
      const minimum = Math.max(field.required ? 1 : 0, field.minimumSelections);
      if (selectionCount < minimum
        || (field.maximumSelections !== undefined && selectionCount > field.maximumSelections)) {
        invalidDecision();
      }
      return answer as unknown as InteractionQuestionAnswer;
    }
    case "boolean":
      requireExactKeys(answer, ["kind", "value"]);
      if (answer["kind"] !== "boolean" || typeof answer["value"] !== "boolean") invalidDecision();
      return answer as unknown as InteractionQuestionAnswer;
  }
}

function parseCancelledDecision(value: JsonRecord): InteractionDecision {
  requireExactKeys(value, ["kind"]);
  return value as unknown as InteractionDecision;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): JsonRecord {
  if (!isRecord(value)) return invalidShape();
  requireExactKeys(value, required, optional);
  return value;
}

function recordWithKeys(value: unknown, required: readonly string[]): JsonRecord {
  if (!isRecord(value) || !required.every((key) => Object.hasOwn(value, key))) return invalidShape();
  return value;
}

function requireExactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    invalidShape();
  }
}

function requireStrings(value: JsonRecord, keys: readonly string[]): void {
  if (keys.some((key) => typeof value[key] !== "string")) invalidShape();
}

function requireOptionalStrings(value: JsonRecord, keys: readonly string[]): void {
  if (keys.some((key) => value[key] !== undefined && typeof value[key] !== "string")) invalidShape();
}

function requireNonBlankString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") invalidShape();
}

function requireStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return invalidShape();
  return value as readonly string[];
}

function requireEnumArray<const T extends string>(value: unknown, allowed: readonly T[]): readonly T[] {
  const entries = requireStringArray(value);
  if (entries.some((entry) => !allowed.includes(entry as T))) invalidShape();
  return entries as readonly T[];
}

function requireEnum<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!isOneOf(value, allowed)) return invalidShape();
  return value;
}

function isOneOf<const T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidPayload(): never {
  throw new StoreError("Interaction payload does not match the current-v1 durable shape.");
}

function invalidDecision(): never {
  throw new StoreError("Interaction decision does not match its current-v1 durable request.");
}

function invalidShape(): never {
  throw new StoreError("Interaction JSON does not match the current-v1 durable shape.");
}
