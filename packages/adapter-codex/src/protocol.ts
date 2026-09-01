export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RpcId = string | number;

export interface RpcNotification {
  readonly method: string;
  readonly params: JsonValue;
}

export interface RpcServerRequest extends RpcNotification {
  readonly id: RpcId;
}

export interface NativeThread {
  readonly id: string;
  readonly sessionId?: string;
  readonly preview?: string;
  readonly name?: string | null;
  readonly cwd?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly status?: JsonObject;
  readonly source?: JsonValue;
  readonly threadSource?: JsonValue;
  readonly parentThreadId?: string | null;
  readonly agentRole?: string | null;
  readonly ephemeral?: boolean;
  readonly turns: readonly NativeTurn[];
}

export interface NativeTurn {
  readonly id: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly items: readonly NativeThreadItem[];
  readonly error?: JsonObject | null;
  readonly durationMs?: number | null;
}

export interface NativeThreadItem extends JsonObject {
  readonly type: string;
  readonly id: string;
}

export interface NativeThreadHistoryBounds {
  readonly maximumTurns: number;
  readonly maximumItems: number;
}

export interface NativeModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly hidden: boolean;
  readonly supportedReasoningEfforts: readonly { readonly reasoningEffort: string }[];
  readonly inputModalities: readonly string[];
  readonly serviceTiers: readonly { readonly id: string }[];
  readonly defaultServiceTier?: string | null;
  readonly isDefault: boolean;
}

export interface NativeInitializeResult {
  readonly userAgent: string;
  readonly platformFamily: string;
  readonly platformOs: string;
  readonly codexHome?: string;
}

export interface NativeAccountUsageWindow {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetAt?: number;
}

export interface NativeAccountCreditsSnapshot {
  readonly hasCredits?: boolean;
  readonly unlimited?: boolean;
  readonly balance?: string;
  readonly observedAt: number;
}

export interface NativeAccountUsageSnapshot {
  readonly primaryWindow?: NativeAccountUsageWindow;
  readonly secondaryWindow?: NativeAccountUsageWindow;
  readonly limitReached?: boolean;
  readonly planType?: string;
  readonly credits?: NativeAccountCreditsSnapshot;
  readonly observedAt: number;
}

export type ScalarCommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CommandApprovalAvailability {
  readonly explicit: boolean;
  readonly malformed: boolean;
  readonly decisions: readonly ScalarCommandApprovalDecision[];
}

const MAX_COMMAND_APPROVAL_DECISIONS = 16;

export interface NativeUserInput extends JsonObject {
  readonly type: "text" | "image" | "localImage" | "mention";
}

export function objectValue(value: JsonValue | unknown, label = "value"): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolShapeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

export function arrayValue(value: JsonValue | unknown, label = "value"): JsonValue[] {
  if (!Array.isArray(value)) throw new ProtocolShapeError(`${label} must be an array`);
  return value as JsonValue[];
}

export function stringValue(value: JsonValue | unknown, label = "value"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolShapeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: JsonValue | unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: JsonValue | unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseInitializeResult(value: JsonValue): NativeInitializeResult {
  const record = objectValue(value, "initialize result");
  return {
    userAgent: stringValue(record["userAgent"], "initialize userAgent"),
    platformFamily: stringValue(record["platformFamily"], "initialize platformFamily"),
    platformOs: stringValue(record["platformOs"], "initialize platformOs"),
    ...(optionalString(record["codexHome"]) === undefined ? {} : { codexHome: optionalString(record["codexHome"]) })
  };
}

export function parseThreadResult(value: JsonValue): NativeThread {
  return parseThread(objectValue(value, "thread result")["thread"]);
}

export function parseBoundedThreadResult(
  value: JsonValue,
  bounds: NativeThreadHistoryBounds
): NativeThread {
  assertHistoryBound(bounds.maximumTurns);
  assertHistoryBound(bounds.maximumItems);
  const counter = { items: 0 };
  return parseThreadWithBounds(
    objectValue(value, "thread result")["thread"],
    bounds,
    counter
  );
}

export function parseThread(value: JsonValue | unknown): NativeThread {
  return parseThreadWithBounds(value);
}

function parseThreadWithBounds(
  value: JsonValue | unknown,
  bounds?: NativeThreadHistoryBounds,
  counter?: { items: number }
): NativeThread {
  const record = objectValue(value, "thread");
  const rawTurns = record["turns"] === undefined
    ? []
    : arrayValue(record["turns"], "thread turns");
  if (bounds !== undefined && rawTurns.length > bounds.maximumTurns) {
    throw new ProtocolShapeError("thread turns exceed the native history bound");
  }
  const turns = rawTurns.map((turn) => parseTurnWithBounds(turn, bounds, counter));
  return {
    id: stringValue(record["id"], "thread id"),
    ...(optionalString(record["sessionId"]) === undefined ? {} : { sessionId: optionalString(record["sessionId"]) }),
    ...(typeof record["preview"] === "string" ? { preview: record["preview"] } : {}),
    ...(record["name"] === null ? { name: null } : optionalString(record["name"]) === undefined ? {} : { name: optionalString(record["name"]) }),
    ...(optionalString(record["cwd"]) === undefined ? {} : { cwd: optionalString(record["cwd"]) }),
    ...(numberValue(record["createdAt"]) === undefined ? {} : { createdAt: numberValue(record["createdAt"]) }),
    ...(numberValue(record["updatedAt"]) === undefined ? {} : { updatedAt: numberValue(record["updatedAt"]) }),
    ...(isJsonObject(record["status"]) ? { status: record["status"] } : {}),
    ...(record["source"] === undefined ? {} : { source: record["source"] }),
    ...(record["threadSource"] === undefined ? {} : { threadSource: record["threadSource"] }),
    ...(record["parentThreadId"] === null
      ? { parentThreadId: null }
      : optionalString(record["parentThreadId"]) === undefined
        ? {}
        : { parentThreadId: optionalString(record["parentThreadId"]) }),
    ...(record["agentRole"] === null
      ? { agentRole: null }
      : optionalString(record["agentRole"]) === undefined
        ? {}
        : { agentRole: optionalString(record["agentRole"]) }),
    ...(typeof record["ephemeral"] === "boolean" ? { ephemeral: record["ephemeral"] } : {}),
    turns
  };
}

export function parseTurn(value: JsonValue | unknown): NativeTurn {
  return parseTurnWithBounds(value);
}

function parseTurnWithBounds(
  value: JsonValue | unknown,
  bounds?: NativeThreadHistoryBounds,
  counter?: { items: number }
): NativeTurn {
  const record = objectValue(value, "turn");
  const status = stringValue(record["status"], "turn status");
  if (status !== "completed" && status !== "interrupted" && status !== "failed" && status !== "inProgress") {
    throw new ProtocolShapeError("turn status is unsupported");
  }
  const rawItems = record["items"] === undefined
    ? []
    : arrayValue(record["items"], "turn items");
  if (bounds !== undefined && counter !== undefined) {
    counter.items += rawItems.length;
    if (counter.items > bounds.maximumItems) {
      throw new ProtocolShapeError("thread items exceed the native history bound");
    }
  }
  const items = rawItems.map(parseThreadItem);
  return {
    id: stringValue(record["id"], "turn id"),
    status,
    items,
    ...(record["error"] === null ? { error: null } : isJsonObject(record["error"]) ? { error: record["error"] } : {}),
    ...(numberValue(record["durationMs"]) === undefined ? {} : { durationMs: numberValue(record["durationMs"]) })
  };
}

export function parseThreadItem(value: JsonValue | unknown): NativeThreadItem {
  const record = objectValue(value, "thread item");
  return {
    ...record,
    type: stringValue(record["type"], "thread item type"),
    id: stringValue(record["id"], "thread item id")
  };
}

export function parseModels(
  value: JsonValue,
  maximumEntries = 100
): { readonly models: readonly NativeModel[]; readonly nextCursor?: string } {
  const record = objectValue(value, "model list result");
  const models = boundedArrayValue(record["data"], "model list data", maximumEntries).map((entry): NativeModel => {
    const model = objectValue(entry, "model");
    const efforts = Array.isArray(model["supportedReasoningEfforts"])
      ? model["supportedReasoningEfforts"].flatMap((effort) => {
          if (!isJsonObject(effort) || typeof effort["reasoningEffort"] !== "string") return [];
          return [{ reasoningEffort: effort["reasoningEffort"] }];
        })
      : [];
    const modalities = Array.isArray(model["inputModalities"])
      ? model["inputModalities"].filter((item): item is string => typeof item === "string")
      : [];
    const tiers = Array.isArray(model["serviceTiers"])
      ? model["serviceTiers"].flatMap((tier) => {
          if (!isJsonObject(tier) || typeof tier["id"] !== "string") return [];
          return [{ id: tier["id"] }];
        })
      : [];
    return {
      id: stringValue(model["id"], "model id"),
      model: stringValue(model["model"], "model slug"),
      displayName: stringValue(model["displayName"], "model display name"),
      hidden: model["hidden"] === true,
      supportedReasoningEfforts: efforts,
      inputModalities: modalities,
      serviceTiers: tiers,
      ...(typeof model["defaultServiceTier"] === "string" ? { defaultServiceTier: model["defaultServiceTier"] } : {}),
      isDefault: model["isDefault"] === true
    };
  });
  const nextCursor = paginationCursor(record["nextCursor"], "model list nextCursor");
  return {
    models,
    ...(nextCursor === undefined ? {} : { nextCursor })
  };
}

export function parseThreadList(
  value: JsonValue,
  maximumEntries = 100
): { readonly threads: readonly NativeThread[]; readonly nextCursor?: string } {
  const record = objectValue(value, "thread list result");
  const nextCursor = paginationCursor(record["nextCursor"], "thread list nextCursor");
  return {
    threads: boundedArrayValue(record["data"], "thread list data", maximumEntries).map(parseThread),
    ...(nextCursor === undefined ? {} : { nextCursor })
  };
}

export function parseTurnList(value: JsonValue): readonly NativeTurn[] {
  const record = objectValue(value, "turn list result");
  return arrayValue(record["data"], "turn list data").map(parseTurn);
}

export function parseTurnStart(value: JsonValue): NativeTurn {
  const record = objectValue(value, "turn start result");
  const turnRecord = objectValue(record["turn"], "turn start turn");
  if (turnRecord["items"] === undefined) {
    throw new ProtocolShapeError("turn start items are required");
  }
  return parseTurn(turnRecord);
}

export function parseTurnSteer(value: JsonValue): string {
  return stringValue(objectValue(value, "turn steer result")["turnId"], "turn steer turnId");
}

const MAXIMUM_ACCOUNT_WINDOW_MINUTES = 10 * 366 * 24 * 60;
const MAXIMUM_ACCOUNT_TEXT_LENGTH = 128;
const MAXIMUM_PROTO_TIMESTAMP_SECONDS = 253_402_300_799;

/**
 * Projects the stable account quota response into the small public shape used
 * by Joko. Per-limit buckets, reset-credit records, and unknown upstream fields
 * deliberately never leave this protocol boundary.
 */
export function parseAccountRateLimits(
  value: JsonValue,
  observedAt: number
): NativeAccountUsageSnapshot {
  if (!Number.isSafeInteger(observedAt)
    || observedAt < 0
    || observedAt > MAXIMUM_PROTO_TIMESTAMP_SECONDS * 1_000) {
    throw new TypeError("Account usage observation time must be a non-negative integer.");
  }
  const root = objectValue(value, "account rate limits result");
  const rateLimits = objectValue(root["rateLimits"], "account rate limits");
  const primaryWindow = accountUsageWindow(rateLimits["primary"], "primary account window");
  const secondaryWindow = accountUsageWindow(rateLimits["secondary"], "secondary account window");
  const planType = optionalBoundedProtocolText(rateLimits["planType"], "account plan type");
  const credits = accountCreditsSnapshot(rateLimits["credits"], observedAt);
  const reachedType = optionalBoundedProtocolText(
    rateLimits["rateLimitReachedType"],
    "account rate-limit reached type"
  );
  if (primaryWindow === undefined
    && secondaryWindow === undefined
    && planType === undefined
    && credits === undefined
    && reachedType === undefined) {
    throw new ProtocolShapeError("account rate limits contain no supported fields");
  }
  return {
    ...(primaryWindow === undefined ? {} : { primaryWindow }),
    ...(secondaryWindow === undefined ? {} : { secondaryWindow }),
    ...(reachedType === undefined ? {} : { limitReached: true }),
    ...(planType === undefined ? {} : { planType }),
    ...(credits === undefined ? {} : { credits }),
    observedAt
  };
}

function accountUsageWindow(
  value: JsonValue | undefined,
  label: string
): NativeAccountUsageWindow | undefined {
  if (value === undefined || value === null) return undefined;
  const window = objectValue(value, label);
  const rawUsedPercent = window["usedPercent"];
  if (typeof rawUsedPercent !== "number" || !Number.isFinite(rawUsedPercent)) {
    throw new ProtocolShapeError(`${label} used percentage is invalid`);
  }
  const usedPercent = Math.min(100, Math.max(0, rawUsedPercent));
  const rawWindowMinutes = window["windowMinutes"] ?? window["windowDurationMins"];
  const windowMinutes = rawWindowMinutes === undefined || rawWindowMinutes === null
    ? undefined
    : boundedPositiveProtocolInteger(rawWindowMinutes, MAXIMUM_ACCOUNT_WINDOW_MINUTES, `${label} duration`);
  const rawResetAt = window["resetsAt"];
  const resetSeconds = rawResetAt === undefined || rawResetAt === null
    ? undefined
    : boundedPositiveProtocolInteger(rawResetAt, MAXIMUM_PROTO_TIMESTAMP_SECONDS, `${label} reset time`);
  const resetAt = resetSeconds === undefined ? undefined : resetSeconds * 1_000;
  if (resetAt !== undefined && !Number.isSafeInteger(resetAt)) {
    throw new ProtocolShapeError(`${label} reset time is invalid`);
  }
  return {
    usedPercent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetAt === undefined ? {} : { resetAt })
  };
}

function accountCreditsSnapshot(
  value: JsonValue | undefined,
  observedAt: number
): NativeAccountCreditsSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  const credits = objectValue(value, "account credits");
  const hasCredits = optionalProtocolBoolean(credits["hasCredits"], "account has-credits state");
  const unlimited = optionalProtocolBoolean(credits["unlimited"], "account unlimited-credit state");
  const balance = optionalBoundedProtocolText(credits["balance"], "account credit balance");
  if (hasCredits === undefined && unlimited === undefined && balance === undefined) return undefined;
  return {
    ...(hasCredits === undefined ? {} : { hasCredits }),
    ...(unlimited === undefined ? {} : { unlimited }),
    ...(balance === undefined ? {} : { balance }),
    observedAt
  };
}

function optionalProtocolBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ProtocolShapeError(`${label} is invalid`);
  return value;
}

function optionalBoundedProtocolText(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProtocolShapeError(`${label} is invalid`);
  const normalized = value.trim();
  if (normalized === "") return undefined;
  if (normalized.length > MAXIMUM_ACCOUNT_TEXT_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ProtocolShapeError(`${label} is invalid`);
  }
  return normalized;
}

function boundedPositiveProtocolInteger(value: JsonValue, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ProtocolShapeError(`${label} is invalid`);
  }
  return value;
}

export function commandApprovalAvailability(
  value: JsonValue | unknown,
  request: JsonObject = {}
): CommandApprovalAvailability {
  if (value === undefined || value === null) {
    const networkContext = request["networkApprovalContext"];
    const additionalPermissions = request["additionalPermissions"];
    if ((networkContext !== undefined && networkContext !== null && !isJsonObject(networkContext))
      || (additionalPermissions !== undefined && additionalPermissions !== null && !isJsonObject(additionalPermissions))) {
      return { explicit: false, malformed: true, decisions: [] };
    }
    return {
      explicit: false,
      malformed: false,
      decisions: networkContext === undefined || networkContext === null
        ? ["accept", "cancel"]
        : ["accept", "acceptForSession", "cancel"]
    };
  }
  if (!Array.isArray(value) || value.length > MAX_COMMAND_APPROVAL_DECISIONS) {
    return { explicit: true, malformed: true, decisions: [] };
  }
  const decisions: ScalarCommandApprovalDecision[] = [];
  for (const decision of value) {
    if (decision === "accept"
      || decision === "acceptForSession"
      || decision === "decline"
      || decision === "cancel") {
      if (!decisions.includes(decision)) decisions.push(decision);
      continue;
    }
    // Structured amendment decisions are valid upstream variants, but this
    // adapter does not advertise or synthesize their policy payloads. Only
    // recognize their exact stable envelopes; unknown objects fail closed.
    if (isKnownStructuredCommandApprovalDecision(decision)) continue;
    return { explicit: true, malformed: true, decisions: [] };
  }
  return { explicit: true, malformed: false, decisions };
}

function isKnownStructuredCommandApprovalDecision(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  if (keys[0] === "acceptWithExecpolicyAmendment") {
    const envelope = value["acceptWithExecpolicyAmendment"];
    if (!isJsonObject(envelope) || Object.keys(envelope).length !== 1) return false;
    const amendment = envelope["execpolicy_amendment"];
    return Array.isArray(amendment) && amendment.every((part) => typeof part === "string");
  }
  if (keys[0] === "applyNetworkPolicyAmendment") {
    const envelope = value["applyNetworkPolicyAmendment"];
    if (!isJsonObject(envelope) || Object.keys(envelope).length !== 1) return false;
    const amendment = envelope["network_policy_amendment"];
    return isJsonObject(amendment)
      && typeof amendment["host"] === "string"
      && (amendment["action"] === "allow" || amendment["action"] === "deny");
  }
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedArrayValue(
  value: JsonValue | unknown,
  label: string,
  maximumEntries: number
): JsonValue[] {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 0) {
    throw new TypeError("Protocol collection bound must be a non-negative integer.");
  }
  const values = arrayValue(value, label);
  if (values.length > maximumEntries) {
    throw new ProtocolShapeError(`${label} exceeds the requested page bound`);
  }
  return values;
}

function assertHistoryBound(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Native history bounds must be positive integers.");
  }
}

function paginationCursor(value: JsonValue | unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringValue(value, label);
}

export class ProtocolShapeError extends Error {
  constructor(_detail: string) {
    super("The Codex app-server returned an incompatible stable protocol shape.");
    this.name = "ProtocolShapeError";
  }
}
