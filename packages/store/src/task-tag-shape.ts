import { TASK_TAG_COLORS, type EventPayload, type TaskTagCatalog, type TaskTagColor } from "@joko/core";

import { StoreError } from "./errors.js";

type JsonRecord = Readonly<Record<string, unknown>>;

/** Parse the one current-v1 durable task-tag catalog Event shape. */
export function parseCurrentTaskTagEventPayload(value: unknown): EventPayload {
  if (!isRecord(value) || value["type"] !== "task_tag_catalog_changed") return value as EventPayload;
  requireKeys(value, ["type", "catalog"]);
  return {
    type: "task_tag_catalog_changed",
    catalog: parseTaskTagCatalog(value["catalog"])
  };
}

function parseTaskTagCatalog(value: unknown): TaskTagCatalog {
  const catalog = record(value);
  requireKeys(catalog, ["tags", "revision"]);
  if (!Array.isArray(catalog["tags"]) || catalog["tags"].length > 256) invalid();
  const tags = catalog["tags"].map((entry, index) => {
    const tag = record(entry);
    requireKeys(tag, [
      "id", "name", "color", "nameCustomized", "sortOrder", "revision",
      "associationRevision", "createdAt", "updatedAt"
    ], ["presetKey"]);
    const id = boundedText(tag["id"], 128);
    const name = boundedText(tag["name"], 80);
    const color = tag["color"];
    if (typeof color !== "string" || !TASK_TAG_COLORS.includes(color as TaskTagColor)) invalid();
    if (tag["presetKey"] !== undefined) boundedText(tag["presetKey"], 32);
    if (typeof tag["nameCustomized"] !== "boolean" || tag["sortOrder"] !== index) invalid();
    const createdAt = unsignedNumber(tag["createdAt"]);
    const updatedAt = unsignedNumber(tag["updatedAt"]);
    if (updatedAt < createdAt) invalid();
    return {
      id,
      name,
      color: color as TaskTagColor,
      ...(tag["presetKey"] === undefined ? {} : { presetKey: tag["presetKey"] as string }),
      nameCustomized: tag["nameCustomized"],
      sortOrder: index,
      revision: unsignedBigInt(tag["revision"]),
      associationRevision: unsignedBigInt(tag["associationRevision"]),
      createdAt,
      updatedAt
    };
  });
  if (new Set(tags.map((tag) => tag.id)).size !== tags.length) invalid();
  if (new Set(tags.map((tag) => tag.name.normalize("NFKC").toLocaleLowerCase("en-US"))).size !== tags.length) invalid();
  return { tags, revision: unsignedBigInt(catalog["revision"]) };
}

function record(value: unknown): JsonRecord {
  if (!isRecord(value)) invalid();
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) invalid();
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value.trim() !== value || value.length < 1 ||
    value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)
  ) invalid();
  return value;
}

function unsignedNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function unsignedBigInt(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) return BigInt(value);
  return invalid();
}

function invalid(): never {
  throw new StoreError("Task tag catalog Event uses an unsupported durable shape.");
}
