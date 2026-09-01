import { redactSecrets, type EventPayload } from "@joko/core";

export const EXTENSION_WIDGETS_SETTING_KEY = "runtime.pi.extension_widgets";
export const EXTENSION_STATUSES_SETTING_KEY = "runtime.pi.extension_statuses";

export interface ExtensionWidgetState {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "above_editor" | "below_editor";
  readonly updatedAt: number;
}

export interface ExtensionStatusState {
  readonly key: string;
  readonly text: string;
  readonly updatedAt: number;
}

type WidgetPayload = Extract<EventPayload, { readonly type: "extension_widget" }>;
type StatusPayload = Extract<EventPayload, { readonly type: "extension_status" }>;

/** Treat extension graphical state as untrusted Backend input and redact it
 * before it can enter SQLite or a reconnect snapshot. */
export function updateExtensionWidgets(
  current: unknown,
  payload: WidgetPayload,
  updatedAt: number
): readonly ExtensionWidgetState[] {
  const widgets = new Map(readExtensionWidgets(current).map((widget) => [widget.key, widget] as const));
  const key = redactSecrets(payload.key);
  const lines = payload.lines.map((line) => redactSecrets(String(line)));
  if (payload.removed) widgets.delete(key);
  else {
    widgets.set(key, {
      key,
      lines,
      placement: payload.placement === "below_editor" ? "below_editor" : "above_editor",
      updatedAt: finiteTimestamp(updatedAt)
    });
  }
  return [...widgets.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function readExtensionWidgets(value: unknown): readonly ExtensionWidgetState[] {
  if (!Array.isArray(value)) return [];
  const widgets = new Map<string, ExtensionWidgetState>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate["key"] !== "string" || !Array.isArray(candidate["lines"])) continue;
    const key = redactSecrets(candidate["key"]);
    const lines = candidate["lines"]
      .filter((line): line is string => typeof line === "string")
      .map((line) => redactSecrets(line));
    widgets.set(key, {
      key,
      lines,
      placement: candidate["placement"] === "below_editor" ? "below_editor" : "above_editor",
      updatedAt: finiteTimestamp(candidate["updatedAt"])
    });
  }
  return [...widgets.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function updateExtensionStatuses(
  current: unknown,
  payload: StatusPayload,
  updatedAt: number
): readonly ExtensionStatusState[] {
  const statuses = new Map(readExtensionStatuses(current).map((status) => [status.key, status] as const));
  const key = redactSecrets(payload.key);
  if (payload.text === undefined) statuses.delete(key);
  else statuses.set(key, { key, text: redactSecrets(payload.text), updatedAt: finiteTimestamp(updatedAt) });
  return [...statuses.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function readExtensionStatuses(value: unknown): readonly ExtensionStatusState[] {
  if (!Array.isArray(value)) return [];
  const statuses = new Map<string, ExtensionStatusState>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    if (typeof candidate["key"] !== "string" || typeof candidate["text"] !== "string") continue;
    const key = redactSecrets(candidate["key"]);
    const text = redactSecrets(stringValue(candidate["text"]));
    statuses.set(key, { key, text, updatedAt: finiteTimestamp(candidate["updatedAt"]) });
  }
  return [...statuses.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function finiteTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
