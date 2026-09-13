import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { OperationalStore, PersistedEvent } from "@joko/store";

import { protoToolResult, toProtoTimestamp } from "./proto-mapper.js";

export interface ProjectedToolCall {
  readonly value: contract.ToolCall;
  readonly backendId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly firstCursor: bigint;
  readonly lastCursor: bigint;
}

interface Accumulator {
  readonly callId: string;
  readonly backendId: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly name: string;
  readonly input: string;
  readonly startedAt: number;
  readonly firstCursor: bigint;
  lastCursor: bigint;
  state: contract.ToolCallState;
  output?: string;
  outputBlob?: import("@joko/core").BlobRef;
  outputParts?: readonly import("@joko/core").ToolResultContentPart[];
  endedAt?: number;
  isError: boolean;
}

export function listProjectedToolCalls(
  store: OperationalStore,
  filter: { readonly sessionId?: string; readonly runId?: string } = {}
): readonly ProjectedToolCall[] {
  const events: PersistedEvent[] = [];
  let cursor = 0n;
  for (;;) {
    const page = store.listEvents({
      afterCursor: cursor,
      ...(filter.sessionId === undefined ? {} : { sessionId: filter.sessionId }),
      limit: 1_000
    });
    if (page.length === 0) break;
    events.push(...page);
    const next = page.at(-1)?.globalCursor ?? cursor;
    if (next <= cursor) throw new Error("Tool Call event projection could not advance its durable cursor.");
    cursor = next;
  }
  return projectToolCalls(events).filter((item) => filter.runId === undefined || item.runId === filter.runId);
}

export function projectToolCalls(events: readonly PersistedEvent[]): readonly ProjectedToolCall[] {
  const calls = new Map<string, Accumulator>();
  const ordered = [...events].sort((left, right) => left.globalCursor < right.globalCursor ? -1 : left.globalCursor > right.globalCursor ? 1 : 0);
  for (const event of ordered) {
    const payload = event.payload;
    if (payload.type === "tool_start") {
      const key = callKey(event.sessionId, payload.callId);
      if (!calls.has(key)) calls.set(key, {
        callId: payload.callId,
        backendId: event.backendId,
        sessionId: event.sessionId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
        name: payload.name,
        input: payload.input,
        startedAt: event.emittedAt,
        firstCursor: event.globalCursor,
        lastCursor: event.globalCursor,
        state: contract.ToolCallState.RUNNING,
        isError: false
      });
      continue;
    }
    if (payload.type === "tool_update" || payload.type === "tool_result") {
      const key = callKey(event.sessionId, payload.callId);
      const current = calls.get(key) ?? {
        callId: payload.callId,
        backendId: event.backendId,
        sessionId: event.sessionId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
        name: payload.name,
        input: "",
        startedAt: event.emittedAt,
        firstCursor: event.globalCursor,
        lastCursor: event.globalCursor,
        state: contract.ToolCallState.RUNNING,
        isError: false
      } satisfies Accumulator;
      current.lastCursor = event.globalCursor;
      const appendDelta = payload.type === "tool_update" && payload.outputMode === "append";
      current.output = appendDelta ? `${current.output ?? ""}${payload.output}` : payload.output;
      current.outputBlob = payload.artifact;
      current.outputParts = payload.parts;
      if (payload.type === "tool_result") {
        current.state = payload.isError ? contract.ToolCallState.FAILED : contract.ToolCallState.SUCCEEDED;
        current.isError = payload.isError;
        current.endedAt = event.emittedAt;
      }
      calls.set(key, current);
      continue;
    }
    if (payload.type === "done" && event.runId !== undefined) {
      for (const current of calls.values()) {
        if (current.runId !== event.runId || isTerminal(current.state)) continue;
        current.lastCursor = event.globalCursor;
        current.endedAt = event.emittedAt;
        current.state = payload.outcome === "aborted" ? contract.ToolCallState.ABORTED : contract.ToolCallState.FAILED;
        current.isError = payload.outcome !== "aborted";
      }
    }
  }
  return [...calls.values()]
    .sort((left, right) => right.startedAt - left.startedAt || right.callId.localeCompare(left.callId, "en"))
    .map((item) => ({
      backendId: item.backendId,
      sessionId: item.sessionId,
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      firstCursor: item.firstCursor,
      lastCursor: item.lastCursor,
      value: create(contract.ToolCallSchema, {
        toolCallId: item.callId,
        toolId: item.name,
        toolProviderId: `backend:${item.backendId}`,
        sessionId: item.sessionId,
        runId: item.runId ?? "",
        attemptId: item.attemptId ?? "",
        state: item.state,
        arguments: item.input === "" ? [] : [create(contract.DisplayArgumentSchema, {
          fieldPath: "$",
          value: { case: "text", value: item.input },
          redacted: false,
          redactedPlaceholder: ""
        })],
        startedAt: toProtoTimestamp(item.startedAt),
        endedAt: item.endedAt === undefined ? undefined : toProtoTimestamp(item.endedAt),
        result: item.output === undefined && item.outputBlob === undefined && item.outputParts === undefined
          ? undefined
          : protoToolResult(item.output ?? "", item.outputBlob, item.outputParts)
      })
    }));
}

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\0${callId}`;
}

function isTerminal(state: contract.ToolCallState): boolean {
  return state === contract.ToolCallState.SUCCEEDED || state === contract.ToolCallState.FAILED || state === contract.ToolCallState.ABORTED;
}
