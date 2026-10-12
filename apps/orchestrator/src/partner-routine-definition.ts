import type { Routine, RoutineEvent, RoutineInput, RoutineSource, RoutineTrigger, RoutinePreRunHook } from "@joko/core";
export type { Routine, RoutineEvent, RoutineInput, RoutineSource, RoutineTrigger } from "@joko/core";
import { nextOccurrence } from "./scheduler.js";
const nextRun = (expression: string, from: number, timezone: string) => nextOccurrence({ kind: "cron", expression, timezone }, from);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Expected nonempty text of at most ${max} characters`);
  }
  return value;
}

/** Validate on the host boundary as well as when restoring persisted definitions. */
export function parseRoutineInput(value: unknown): RoutineInput {
  const input = record(value);
  if (typeof input.enabled !== "boolean")
    throw new Error("enabled must be boolean");
  if (
    !Array.isArray(input.triggers) ||
    (input.enabled && input.triggers.length < 1) ||
    input.triggers.length > 32
  ) {
    throw new Error("An enabled routine requires between 1 and 32 triggers; disabled drafts allow none");
  }
  const triggers = input.triggers.map((raw): RoutineTrigger => {
    const trigger = record(raw);
    const id = string(trigger.id, 128);
    if (trigger.kind === "cron") {
      const expression = string(trigger.expression, 128);
      const timezone = string(trigger.timezone, 128);
      nextRun(expression, Date.now(), timezone);
      return { id, kind: "cron", expression, timezone };
    }
    if (trigger.kind === "interval") {
      if (
        !Number.isSafeInteger(trigger.intervalMs) ||
        Number(trigger.intervalMs) < 60_000
      ) {
        throw new Error("Interval must be an integer of at least one minute");
      }
      if (trigger.anchorMs !== undefined && (!Number.isSafeInteger(trigger.anchorMs) || Number(trigger.anchorMs) < 0))
        throw new Error("Invalid interval anchor");
      return { id, kind: "interval", intervalMs: Number(trigger.intervalMs),
        ...(trigger.anchorMs === undefined ? {} : { anchorMs: Number(trigger.anchorMs) }) };
    }
    if (trigger.kind === "once") {
      if (!Number.isSafeInteger(trigger.at) || Number(trigger.at) < 0)
        throw new Error("Invalid one-time trigger");
      return { id, kind: "once", at: Number(trigger.at) };
    }
    if (
      trigger.kind !== "event" ||
      !Array.isArray(trigger.filters) ||
      trigger.filters.length > 16
    ) {
      throw new Error("Invalid event trigger");
    }
    return {
      id,
      kind: "event",
      sourceId: string(trigger.sourceId, 200),
      eventType: string(trigger.eventType, 200),
      filters: trigger.filters.map((rawFilter) => {
        const filter = record(rawFilter);
        if (
          !["equals", "contains", "not-equals"].includes(
            String(filter.operator),
          )
        ) {
          throw new Error("Invalid filter operator");
        }
        return {
          field: string(filter.field, 128),
          operator: filter.operator as "equals" | "contains" | "not-equals",
          value: string(filter.value, 2000),
        };
      }),
    };
  });
  if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) {
    throw new Error("Trigger IDs must be unique");
  }
  if (typeof input.silentWhenIdle !== "boolean")
    throw new Error("silentWhenIdle must be boolean");
  let preRunHook: RoutinePreRunHook | undefined;
  if (input.preRunHook !== undefined) {
    const hook = record(input.preRunHook);
    if (hook.timeoutMs !== undefined && (!Number.isSafeInteger(hook.timeoutMs) || Number(hook.timeoutMs) <= 0))
      throw new Error("Invalid pre-run check timeout");
    preRunHook = { command: string(hook.command, 32_000),
      ...(hook.timeoutMs === undefined ? {} : { timeoutMs: Number(hook.timeoutMs) }) };
  }
  return {
    silentWhenIdle: input.silentWhenIdle as boolean,
    ...(preRunHook === undefined ? {} : { preRunHook }),
    name: string(input.name, 200),
    prompt: string(input.prompt, 100_000),
    enabled: input.enabled,
    triggers,
  };
}

/** Event payloads are bounded data, never an alternate instruction or tool call. */
export function parseRoutineEvent(value: unknown): RoutineEvent {
  const event = record(value);
  const rawData = record(event.data);
  if (Object.keys(rawData).length > 64)
    throw new Error("Too many event fields");
  const data: RoutineEvent["data"] = {};
  for (const [key, field] of Object.entries(rawData)) {
    string(key, 128);
    if (
      typeof field !== "string" &&
      typeof field !== "number" &&
      typeof field !== "boolean"
    ) {
      throw new Error(
        "Event fields must be strings, finite numbers or booleans",
      );
    }
    if (
      (typeof field === "number" && !Number.isFinite(field)) ||
      (typeof field === "string" && field.length > 8000)
    ) {
      throw new Error("Invalid event field");
    }
    Object.defineProperty(data, key, {
      value: field,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (JSON.stringify(data).length > 32_000)
    throw new Error("Event payload is too large");
  if (
    typeof event.occurredAt !== "number" ||
    !Number.isSafeInteger(event.occurredAt) ||
    event.occurredAt < 0
  ) {
    throw new Error("Invalid event timestamp");
  }
  return {
    id: string(event.id, 256),
    type: string(event.type, 200),
    occurredAt: event.occurredAt,
    data,
    ...(event.subject === undefined
      ? {}
      : { subject: string(event.subject, 1000) }),
    ...(event.originRoutineId === undefined
      ? {}
      : { originRoutineId: string(event.originRoutineId, 128) }),
  };
}

/** Exact source/type/scope filtering happens before any model execution. */
export function matchesRoutineEvent(
  routine: Routine,
  sourceId: string,
  event: RoutineEvent,
): string[] {
  if (!routine.enabled || event.originRoutineId === routine.id) return [];
  return routine.triggers
    .filter((trigger) => {
      if (
        trigger.kind !== "event" ||
        trigger.sourceId !== sourceId ||
        trigger.eventType !== event.type
      )
        return false;
      return trigger.filters.every((filter) => {
        const actual =
          filter.field === "subject"
            ? event.subject
            : Object.hasOwn(event.data, filter.field)
              ? event.data[filter.field]
              : undefined;
        if (actual === undefined) return false;
        switch (filter.operator) {
          case "equals":
            return String(actual) === filter.value;
          case "not-equals":
            return String(actual) !== filter.value;
          case "contains":
            return String(actual).includes(filter.value);
        }
      });
    })
    .map((trigger) => trigger.id);
}

export function nextRoutineTriggerAt(
  trigger: RoutineTrigger,
  from: number,
): number | undefined {
  if (trigger.kind === "event") return undefined;
  if (trigger.kind === "once") return trigger.at > from ? trigger.at : undefined;
  return trigger.kind === "interval"
    ? trigger.anchorMs === undefined ? from + trigger.intervalMs
      : trigger.anchorMs > from ? trigger.anchorMs
        : trigger.anchorMs + (Math.floor((from - trigger.anchorMs) / trigger.intervalMs) + 1) * trigger.intervalMs
    : nextRun(trigger.expression, from, trigger.timezone);
}
