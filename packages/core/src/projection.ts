import type { EventEnvelope, EventPayload, InteractionPayload, MessageAutomationOrigin, MessageBlock, MessageInputDelivery } from "./events.js";
import type { RunState, SessionAttention, UsageSnapshot } from "./types.js";

export interface TimelineItem {
  readonly id: string;
  readonly kind: EventPayload["type"] | "streaming_message";
  readonly sequence: bigint;
  readonly runId?: string;
  readonly text?: string;
  readonly role?: "user" | "assistant";
  readonly blocks?: readonly MessageBlock[];
  readonly automationOrigin?: MessageAutomationOrigin;
  readonly inputDelivery?: MessageInputDelivery;
  readonly usage?: UsageSnapshot;
  readonly payload?: EventPayload;
}

export interface SessionProjection {
  readonly revision: bigint;
  readonly cursor: bigint;
  readonly timeline: readonly TimelineItem[];
  readonly runState?: RunState;
  readonly usage?: UsageSnapshot;
  readonly interactions: ReadonlyMap<string, InteractionPayload>;
  readonly streamingBlocks: ReadonlyMap<string, { readonly kind: "text" | "thinking"; readonly text: string }>;
  readonly nativeLeafId?: string;
  readonly attention?: SessionAttention;
}

export function emptyProjection(): SessionProjection {
  return {
    revision: 0n,
    cursor: 0n,
    timeline: [],
    interactions: new Map(),
    streamingBlocks: new Map()
  };
}

export function reduceEvent(state: SessionProjection, event: EventEnvelope): SessionProjection {
  if (event.sequence <= state.cursor) return state;
  if (state.cursor !== 0n && event.sequence !== state.cursor + 1n) {
    throw new ProjectionGapError(state.cursor + 1n, event.sequence);
  }

  const interactions = new Map(state.interactions);
  const streamingBlocks = new Map(state.streamingBlocks);
  let timeline = state.timeline;
  let runState = state.runState;
  let usage = state.usage;
  let nativeLeafId = state.nativeLeafId;
  let attention = state.attention;
  const payload = event.payload;

  if (payload.type === "text_delta" || payload.type === "thinking_delta") {
    const kind = payload.type === "text_delta" ? "text" : "thinking";
    const current = streamingBlocks.get(payload.blockId);
    streamingBlocks.set(payload.blockId, { kind, text: `${current?.text ?? ""}${payload.delta}` });
  } else if (payload.type === "message_complete") {
    timeline = [
      ...timeline,
      {
        id: event.id,
        kind: "message_complete",
        sequence: event.sequence,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        role: payload.role,
        blocks: payload.blocks,
        ...(payload.usage === undefined ? {} : { usage: payload.usage }),
        ...(payload.automationOrigin === undefined ? {} : { automationOrigin: payload.automationOrigin }),
        ...(payload.inputDelivery === undefined ? {} : { inputDelivery: payload.inputDelivery })
      }
    ];
    streamingBlocks.clear();
  } else if (payload.type === "interaction_opened") {
    interactions.set(payload.interaction.id, payload.interaction);
    timeline = appendPayload(timeline, event);
  } else if (payload.type === "interaction_resolved" || payload.type === "interaction_dismissed") {
    interactions.delete(payload.interactionId);
    timeline = appendPayload(timeline, event);
  } else if (payload.type === "run_state") {
    runState = payload.state;
    timeline = appendPayload(timeline, event);
  } else if (payload.type === "done") {
    runState = payload.outcome === "completed" ? "completed" : payload.outcome;
    timeline = appendPayload(timeline, event);
  } else if (payload.type === "usage") {
    usage = payload.usage;
  } else if (payload.type === "context_cleared") {
    usage = undefined;
  } else if (payload.type === "native_session_changed") {
    nativeLeafId = payload.leafId;
    timeline = appendPayload(timeline, event);
  } else if (payload.type === "session_attention") {
    attention = {
      kind: payload.kind,
      unread: payload.unread,
      subjectCursor: BigInt(payload.subjectCursor),
      subjectGeneration: payload.subjectGeneration,
      attentionCursor: BigInt(payload.attentionCursor),
      attentionGeneration: payload.attentionGeneration,
      readThroughCursor: BigInt(payload.readThroughCursor),
      readThroughGeneration: payload.readThroughGeneration,
      updatedAt: event.emittedAt
    };
  } else {
    timeline = appendPayload(timeline, event);
  }

  return {
    revision: event.revision,
    cursor: event.sequence,
    timeline,
    interactions,
    streamingBlocks,
    ...(runState === undefined ? {} : { runState }),
    ...(usage === undefined ? {} : { usage }),
    ...(nativeLeafId === undefined ? {} : { nativeLeafId }),
    ...(attention === undefined ? {} : { attention })
  };
}

function appendPayload(timeline: readonly TimelineItem[], event: EventEnvelope): readonly TimelineItem[] {
  return [
    ...timeline,
    {
      id: event.id,
      kind: event.payload.type,
      sequence: event.sequence,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      payload: event.payload
    }
  ];
}

export class ProjectionGapError extends Error {
  readonly expected: bigint;
  readonly received: bigint;

  constructor(expected: bigint, received: bigint) {
    super(`Event gap: expected sequence ${expected}, received ${received}`);
    this.name = "ProjectionGapError";
    this.expected = expected;
    this.received = received;
  }
}
