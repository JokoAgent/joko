import { redactSecrets, type PartnerLearningReceipt, type PartnerLearningTurnSource } from "@joko/core";
import { StoreError } from "./errors.js";

export interface PartnerLearningTurnRecord {
  readonly source: PartnerLearningTurnSource;
  readonly partnerId: string;
  readonly accepted: boolean;
  readonly completionEventId?: string;
  readonly messageId?: string;
  readonly reviewClaimed: boolean;
  readonly receipts: readonly PartnerLearningReceipt[];
  readonly revision: bigint;
}

export function learningIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || redactSecrets(value) !== value) {
    throw new StoreError(`Invalid learning ${label}.`);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoreError("Invalid learning record.");
  return value as Record<string, unknown>;
}

export function learningSource(value: unknown): PartnerLearningTurnSource {
  const source = object(value);
  const identities = ["occurrenceId", "sessionId", "targetId", "backendId", "bindingFingerprint", "sourceRunId",
    "sourceAttemptId", "sourceQueueItemId", "nativeOccurrence"] as const;
  const optional = ["operationId", "nativeTurnId"] as const;
  if (Object.keys(source).some(key => ![...identities, ...optional, "backendInstanceGeneration", "bindingGeneration"].includes(key))) {
    throw new StoreError("Invalid learning source fields.");
  }
  for (const key of identities) learningIdentity(source[key], key);
  for (const key of optional) if (source[key] !== undefined) learningIdentity(source[key], key);
  for (const key of ["backendInstanceGeneration", "bindingGeneration"] as const) {
    if (typeof source[key] !== "number" || !Number.isSafeInteger(source[key]) || source[key] < 0) {
      throw new StoreError("Invalid learning generation.");
    }
  }
  if (typeof source["bindingFingerprint"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(source["bindingFingerprint"])) {
    throw new StoreError("Invalid learning binding fingerprint.");
  }
  return {
    occurrenceId: learningIdentity(source["occurrenceId"], "occurrence"),
    sessionId: learningIdentity(source["sessionId"], "Session"),
    targetId: learningIdentity(source["targetId"], "Target"),
    backendId: learningIdentity(source["backendId"], "Backend"),
    backendInstanceGeneration: Number(source["backendInstanceGeneration"]),
    bindingGeneration: Number(source["bindingGeneration"]),
    bindingFingerprint: learningIdentity(source["bindingFingerprint"], "binding"),
    sourceRunId: learningIdentity(source["sourceRunId"], "Run"),
    sourceAttemptId: learningIdentity(source["sourceAttemptId"], "Attempt"),
    sourceQueueItemId: learningIdentity(source["sourceQueueItemId"], "Queue item"),
    nativeOccurrence: learningIdentity(source["nativeOccurrence"], "native occurrence"),
    ...(source["operationId"] === undefined ? {} : { operationId: learningIdentity(source["operationId"], "Operation") }),
    ...(source["nativeTurnId"] === undefined ? {} : { nativeTurnId: learningIdentity(source["nativeTurnId"], "native turn") })
  };
}

export function learningReceipt(value: unknown): PartnerLearningReceipt {
  const item = object(value);
  if (Object.keys(item).some(key => !["kind", "entryId", "title", "action"].includes(key))
    || item["kind"] !== "memory" && item["kind"] !== "skill"
    || item["action"] !== "created" && item["action"] !== "updated") throw new StoreError("Invalid learning receipt.");
  const entryId = learningIdentity(item["entryId"], "entry identity");
  const title = learningIdentity(item["title"], "title");
  if (entryId.length > 256 || Array.from(title).length > 100) throw new StoreError("Invalid learning receipt size.");
  return { kind: item["kind"], action: item["action"], entryId, title };
}

export function learningReceipts(value: unknown): PartnerLearningReceipt[] {
  if (!Array.isArray(value)) throw new StoreError("Invalid learning receipts.");
  return value.map(learningReceipt);
}

export function mergeLearningReceipts(previous: readonly PartnerLearningReceipt[], incoming: readonly PartnerLearningReceipt[]): PartnerLearningReceipt[] {
  const merged = new Map(previous.map(item => [`${item.kind}:${item.entryId}`, learningReceipt(item)]));
  for (const item of incoming) merged.set(`${item.kind}:${item.entryId}`, learningReceipt(item));
  return [...merged.values()].sort((a, b) => Number(a.kind === "skill") - Number(b.kind === "skill"));
}
