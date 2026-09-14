import type {
  EventPayload,
  ResourceUsageAction,
  ResourceUsageActivity,
  ResourceUsageEventPayload,
  ResourceUsageSource
} from "@joko/core";

import { StoreError } from "./errors.js";

type JsonRecord = Readonly<Record<string, unknown>>;

const SOURCE_SHAPES: Readonly<Record<ResourceUsageSource, {
  readonly activity: ResourceUsageActivity;
  readonly actions: readonly ResourceUsageAction[];
}>> = {
  structured_resource_mention: { activity: "passive", actions: ["exposure"] },
  native_skill_command: { activity: "strong_active", actions: ["command_succeeded", "command_failed"] },
  runtime_confirmed_resource_load: { activity: "passive", actions: ["exposure"] },
  exact_file_read: { activity: "semi_active", actions: ["read", "reread"] },
  runtime_tool_call: { activity: "strong_active", actions: ["tool_succeeded", "tool_failed"] }
};

/** Reject widened or legacy evidence before it can enter the durable Event log. */
export function parseCurrentResourceUsageEventPayload(value: unknown): EventPayload {
  if (!isRecord(value) || value["type"] !== "resource_usage") return value as EventPayload;
  requireExactKeys(value, [
    "type", "occurrenceId", "resourceId", "entityRevision", "contentRevision",
    "runtimeGeneration", "source", "activity", "action"
  ], ["version", "market"]);
  boundedIdentity(value["occurrenceId"], "Resource usage occurrence ID", 512);
  boundedIdentity(value["resourceId"], "Resource usage Resource ID", 4_096);
  decimalRevision(value["entityRevision"], "Resource usage entity revision");
  boundedIdentity(value["contentRevision"], "Resource usage content revision", 4_096);
  if (!Number.isSafeInteger(value["runtimeGeneration"]) || (value["runtimeGeneration"] as number) < 1) invalid();
  if (value["version"] !== undefined) boundedIdentity(value["version"], "Resource usage version", 256);
  const source = value["source"] as ResourceUsageSource;
  const shape = SOURCE_SHAPES[source];
  if (shape === undefined || value["activity"] !== shape.activity
    || !shape.actions.includes(value["action"] as ResourceUsageAction)) invalid();
  if (value["market"] !== undefined) parseMarket(value["market"]);
  return value as unknown as ResourceUsageEventPayload;
}

function parseMarket(value: unknown): void {
  if (!isRecord(value)) invalid();
  requireExactKeys(value, [
    "sourceId", "sourceRevision", "entryId", "entryRevision",
    "entryContentRevision", "installedContentRevision"
  ]);
  boundedIdentity(value["sourceId"], "Resource usage market Source ID", 512);
  decimalRevision(value["sourceRevision"], "Resource usage market Source revision");
  boundedIdentity(value["entryId"], "Resource usage market entry ID", 512);
  decimalRevision(value["entryRevision"], "Resource usage market entry revision");
  boundedIdentity(value["entryContentRevision"], "Resource usage market entry content revision", 4_096);
  boundedIdentity(value["installedContentRevision"], "Resource usage installed content revision", 4_096);
}

function decimalRevision(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)
    || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new StoreError(`${label} is invalid.`);
  }
}

function boundedIdentity(value: unknown, label: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || value !== value.trim() || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new StoreError(`${label} is invalid.`);
  }
}

function requireExactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) invalid();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new StoreError("Resource usage evidence does not match the current v1 shape.");
}
