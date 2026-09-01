import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { PersistedEvent } from "@joko/store";

import { toProtoEvent, toProtoTimestamp } from "./proto-mapper.js";

interface BackgroundTaskAggregate {
  readonly task: contract.BackgroundTask;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

/**
 * Projects the durable event history into one current observation per native
 * task identity. Optional metadata is carried forward only after a producer
 * has supplied it, so an entirely unknown progress ratio stays absent.
 */
export function projectBackgroundTaskHistory(
  events: readonly PersistedEvent[]
): contract.BackgroundTask[] {
  const aggregates = new Map<string, BackgroundTaskAggregate>();
  for (const event of events) {
    if (event.payload.type !== "background_task") continue;
    const observed = backgroundTaskFromEvent(event);
    const current = aggregates.get(observed.backgroundTaskId);
    const startedAt = earliestDefined(current?.startedAt, event.payload.startedAt);
    const endedAt = isTerminal(observed.state)
      ? event.payload.endedAt ?? current?.endedAt
      : undefined;
    const createdAt = current?.createdAt ?? event.emittedAt;
    const error = observed.error ?? (
      observed.state === contract.BackgroundTaskState.SUCCEEDED ? undefined : current?.task.error
    );
    const task = create(contract.BackgroundTaskSchema, {
      backgroundTaskId: observed.backgroundTaskId,
      parentTaskId: observed.parentTaskId || current?.task.parentTaskId || "",
      backendId: observed.backendId,
      targetId: observed.targetId,
      sessionId: observed.sessionId,
      runId: observed.runId || current?.task.runId || "",
      displayName: observed.displayName || current?.task.displayName || "",
      state: observed.state,
      statusText: observed.statusText,
      progressRatio: observed.progressRatio ?? current?.task.progressRatio,
      startedAt: startedAt === undefined ? undefined : toProtoTimestamp(startedAt),
      endedAt: endedAt === undefined ? undefined : toProtoTimestamp(endedAt),
      version: observed.version,
      error,
      createdAt: toProtoTimestamp(createdAt),
      updatedAt: toProtoTimestamp(event.emittedAt)
    });
    aggregates.set(observed.backgroundTaskId, {
      task,
      createdAt,
      updatedAt: event.emittedAt,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt })
    });
  }

  return [...aggregates.values()]
    .sort(compareBackgroundTasks)
    .map((aggregate) => aggregate.task);
}

function backgroundTaskFromEvent(event: PersistedEvent): contract.BackgroundTask {
  const payload = toProtoEvent(event).payload?.kind;
  const task = payload?.case === "backgroundTaskChanged"
    ? payload.value.backgroundTask
    : undefined;
  if (task === undefined) {
    throw new Error("A durable background task event did not map to a BackgroundTask.");
  }
  return task;
}

function compareBackgroundTasks(left: BackgroundTaskAggregate, right: BackgroundTaskAggregate): number {
  const leftTerminal = isTerminal(left.task.state);
  const rightTerminal = isTerminal(right.task.state);
  if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
  const leftSortAt = leftTerminal
    ? left.endedAt ?? left.updatedAt ?? left.createdAt
    : left.startedAt ?? left.createdAt;
  const rightSortAt = rightTerminal
    ? right.endedAt ?? right.updatedAt ?? right.createdAt
    : right.startedAt ?? right.createdAt;
  const timeOrder = leftTerminal ? rightSortAt - leftSortAt : leftSortAt - rightSortAt;
  return timeOrder || left.task.backgroundTaskId.localeCompare(right.task.backgroundTaskId);
}

function isTerminal(state: contract.BackgroundTaskState): boolean {
  return state === contract.BackgroundTaskState.SUCCEEDED ||
    state === contract.BackgroundTaskState.FAILED ||
    state === contract.BackgroundTaskState.ABORTED;
}

function earliestDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
