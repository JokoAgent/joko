import {
  parseDedicatedHardwareAction,
  type DedicatedHardwareAction
} from "./actions.js";
import type { DedicatedHardwareRoutedActionEvent } from "./routed-actions.js";

export type DedicatedHardwareFocusTask = Extract<DedicatedHardwareAction, { readonly kind: "task" }>;

export interface DedicatedHardwareActionDelivery {
  readonly version: 1;
  readonly event: DedicatedHardwareRoutedActionEvent;
  readonly focusRequestId: string | null;
}

export interface DedicatedHardwareTaskFocusAcknowledgement {
  readonly version: 1;
  readonly focusRequestId: string;
  readonly task: DedicatedHardwareFocusTask;
}

const MAX_FOCUS_REQUEST_ID = (10n ** 64n) - 1n;

/** One-shot acknowledgement fence between main-process delivery and renderer navigation. */
export class DedicatedHardwareTaskFocusFence<Owner> {
  #nextRequestId = 0n;
  #request: {
    readonly owner: Owner;
    readonly focusRequestId: string;
    readonly task: DedicatedHardwareFocusTask;
  } | undefined;

  arm(owner: Owner, task: DedicatedHardwareFocusTask): string {
    if (!task.focusWindow) throw new TypeError("A background task action cannot request window focus.");
    if (this.#nextRequestId >= MAX_FOCUS_REQUEST_ID) {
      throw new RangeError("Dedicated hardware task focus request identity is exhausted.");
    }
    const focusRequestId = (this.#nextRequestId += 1n).toString(10);
    this.#request = Object.freeze({ owner, focusRequestId, task: Object.freeze({ ...task }) });
    return focusRequestId;
  }

  clear(focusRequestId?: string): boolean {
    if (this.#request === undefined
      || (focusRequestId !== undefined && this.#request.focusRequestId !== focusRequestId)) return false;
    this.#request = undefined;
    return true;
  }

  retireOwner(owner: Owner): void {
    if (this.#request?.owner === owner) this.#request = undefined;
  }

  consume(owner: Owner, focusRequestId: string, task: DedicatedHardwareFocusTask): boolean {
    const request = this.#request;
    if (request === undefined || request.owner !== owner || request.focusRequestId !== focusRequestId
      || !sameTask(request.task, task)) return false;
    this.#request = undefined;
    return true;
  }
}

/**
 * Builds and sends the strict renderer delivery while keeping the one-shot
 * focus authority coupled to the exact send attempt.
 */
export function sendDedicatedHardwareActionDelivery<Owner>(options: {
  readonly fence: DedicatedHardwareTaskFocusFence<Owner>;
  readonly owner: Owner;
  readonly event: DedicatedHardwareRoutedActionEvent;
  readonly send: (delivery: DedicatedHardwareActionDelivery) => void;
}): boolean {
  let focusRequestId: string | null = null;
  if (options.event.kind === "button" && options.event.phase === "press"
    && options.event.action.kind === "task") {
    options.fence.clear();
    if (options.event.action.focusWindow) {
      focusRequestId = options.fence.arm(options.owner, options.event.action);
    }
  }
  const delivery: DedicatedHardwareActionDelivery = Object.freeze({
    version: 1,
    event: options.event,
    focusRequestId
  });
  try {
    options.send(delivery);
    return true;
  } catch {
    if (focusRequestId !== null) options.fence.clear(focusRequestId);
    return false;
  }
}

export function parseDedicatedHardwareTaskFocusAcknowledgement(
  value: unknown
): DedicatedHardwareTaskFocusAcknowledgement {
  if (!hasExactKeys(value, ["version", "focusRequestId", "task"])
    || value.version !== 1 || !isFocusRequestId(value.focusRequestId)) {
    throw new TypeError("Dedicated hardware task focus acknowledgement is invalid.");
  }
  let task: DedicatedHardwareAction;
  try {
    task = parseDedicatedHardwareAction(value.task);
  } catch {
    throw new TypeError("Dedicated hardware task focus acknowledgement is invalid.");
  }
  if (task.kind !== "task" || !task.focusWindow) {
    throw new TypeError("Dedicated hardware task focus acknowledgement is invalid.");
  }
  return Object.freeze({ version: 1, focusRequestId: value.focusRequestId, task });
}

function sameTask(left: DedicatedHardwareFocusTask, right: DedicatedHardwareFocusTask): boolean {
  return left.profileId === right.profileId
    && left.serverId === right.serverId
    && left.connectionGeneration === right.connectionGeneration
    && left.snapshotRevision === right.snapshotRevision
    && left.sessionId === right.sessionId
    && left.sessionGeneration === right.sessionGeneration
    && left.targetId === right.targetId
    && left.focusWindow === right.focusWindow;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isFocusRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,63}$/u.test(value);
}
