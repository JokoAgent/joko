import type { PartnerDelegationView, ToolCallView } from "../model.js";

const PARTNER_DELEGATION_TOOL = "mcp__joko_partners__start_delegation";
const CLAUDE_PARTNER_DELEGATION_TOOL = /^mcp__joko_[0-9a-f]{24}__start_delegation$/u;

export interface PartnerDelegationCardData {
  readonly delegation: PartnerDelegationView;
  readonly targetName: string;
}

/** Accepts only the current Partner provider's public success shape. */
export function readPartnerDelegationCardData(tool: ToolCallView): PartnerDelegationCardData | undefined {
  if ((tool.name !== PARTNER_DELEGATION_TOOL && !CLAUDE_PARTNER_DELEGATION_TOOL.test(tool.name))
    || tool.state !== "succeeded" || tool.isError || tool.output === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(tool.output);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  const target = asRecord(record?.["target_partner"]);
  const status = selectedStatus(record?.["status"]);
  const revision = decimalBigInt(record?.["revision"]);
  const targetProfileVersion = decimalBigInt(record?.["target_profile_version"]);
  const artifactCount = nonNegativeInteger(record?.["artifact_count"]);
  const createdAt = timestamp(record?.["created_at"]);
  const updatedAt = timestamp(record?.["updated_at"]);
  const id = selectedId(record?.["id"]);
  const requesterPartnerId = selectedId(record?.["requester_partner_id"]);
  const targetPartnerId = selectedId(record?.["target_partner_id"]);
  const parentSessionId = selectedId(record?.["parent_session_id"]);
  const title = selectedText(record?.["title"], 200);
  const objective = selectedText(record?.["objective"], 12_000);
  const targetName = selectedText(target?.["display_name"], 200);
  const childSessionId = optionalSelectedId(record, "child_session_id");
  const runId = optionalSelectedId(record, "run_id");
  const resultSummary = optionalSelectedText(record, "result_summary", 12_000);
  const error = optionalSelectedText(record, "error", 4_000);
  const startedAt = optionalSelectedTimestamp(record, "started_at");
  const completedAt = optionalSelectedTimestamp(record, "completed_at");
  const dispatched = status === "queued" || status === "running" || status === "waiting" || status === "completed";
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  if (record === undefined || status === undefined || revision === undefined
    || targetProfileVersion === undefined || artifactCount === undefined
    || createdAt === undefined || updatedAt === undefined || id === undefined
    || requesterPartnerId === undefined || targetPartnerId === undefined
    || parentSessionId === undefined || title === undefined || objective === undefined
    || targetName === undefined || selectedId(target?.["id"]) !== targetPartnerId
    || selectedText(target?.["avatar"], 256) === undefined
    || !["active", "archived", "deleted"].includes(String(target?.["status"]))
    || typeof target?.["ready"] !== "boolean"
    || childSessionId.valid === false || runId.valid === false
    || resultSummary.valid === false || error.valid === false
    || startedAt.valid === false || completedAt.valid === false
    || updatedAt < createdAt
    || (startedAt.value !== undefined && startedAt.value < createdAt)
    || (completedAt.value !== undefined && completedAt.value < createdAt)
    || (dispatched && (childSessionId.value === undefined || runId.value === undefined))
    || (terminal !== (completedAt.value !== undefined))
    || ((status === "running" || status === "waiting" || status === "completed") && startedAt.value === undefined)
    || ((status === "completed") !== (resultSummary.value !== undefined))
    || (status === "failed" && error.value === undefined)
    || (status !== "failed" && status !== "unknown" && error.value !== undefined)
    || !hasOnlyKeys(record, [
      "id", "revision", "requester_partner_id", "target_partner_id", "parent_session_id",
      "target_profile_version", "target_partner", "title", "objective", "status",
      "child_session_id", "run_id", "artifact_count", "result_summary", "error",
      "created_at", "updated_at", "started_at", "completed_at"
    ]) || !hasOnlyKeys(target, ["id", "display_name", "avatar", "status", "ready"])) {
    return undefined;
  }
  return {
    targetName,
    delegation: {
      id,
      revision,
      requesterPartnerId,
      targetPartnerId,
      parentSessionId,
      targetProfileVersion,
      title,
      objective,
      status,
      ...(childSessionId.value === undefined ? {} : { childSessionId: childSessionId.value }),
      ...(runId.value === undefined ? {} : { runId: runId.value }),
      ...(resultSummary.value === undefined ? {} : { resultSummary: resultSummary.value }),
      ...(error.value === undefined ? {} : { error: error.value }),
      artifactCount,
      createdAt,
      updatedAt,
      ...(startedAt.value === undefined ? {} : { startedAt: startedAt.value }),
      ...(completedAt.value === undefined ? {} : { completedAt: completedAt.value })
    }
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function selectedId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) ? value : undefined;
}

function selectedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized !== "" && normalized.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function decimalBigInt(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function selectedStatus(value: unknown): PartnerDelegationView["status"] | undefined {
  return typeof value === "string" && [
    "preparing", "queued", "running", "waiting", "completed", "failed", "cancelled", "unknown"
  ].includes(value) ? value as PartnerDelegationView["status"] : undefined;
}

function optionalSelectedId(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): { readonly valid: boolean; readonly value?: string } {
  const raw = record?.[key];
  if (raw === undefined) return { valid: true };
  const value = selectedId(raw);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function optionalSelectedText(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
  maximum: number
): { readonly valid: boolean; readonly value?: string } {
  const raw = record?.[key];
  if (raw === undefined) return { valid: true };
  const value = selectedText(raw, maximum);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function optionalSelectedTimestamp(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): { readonly valid: boolean; readonly value?: number } {
  const raw = record?.[key];
  if (raw === undefined) return { valid: true };
  const value = timestamp(raw);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function hasOnlyKeys(record: Readonly<Record<string, unknown>> | undefined, allowed: readonly string[]): boolean {
  if (record === undefined) return false;
  const accepted = new Set(allowed);
  return Object.keys(record).every((key) => accepted.has(key));
}
