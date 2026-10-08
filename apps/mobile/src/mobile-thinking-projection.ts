import { MessageRole, type Event } from "@joko/contracts";

export interface MobileThinkingView {
  readonly key: string;
  readonly ownerScope: string;
  readonly messageScope: string;
  readonly runScope: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly contentIndex: number;
  readonly eventId: string;
  readonly sequence: bigint;
  readonly text: string;
  readonly redacted: boolean;
  readonly completed: boolean;
  readonly streaming: boolean;
  readonly startedAtMs?: number;
  readonly lastActivityAtMs?: number;
}

/** Current-v1 public thinking blocks have no authoritative independent duration. */
export function mobileThinkingViews(events: readonly Event[], sessionStreaming = false): MobileThinkingView[] {
  const views = new Map<string, MobileThinkingView>();
  const completedMessages = new Set<string>();
  const stoppedRuns = new Set<string>();
  const latestUser = new Map<string, bigint>();
  const seen = new Set<string>();
  const ordered = [...events].sort((a, b) => compareCursor(a, b));
  for (const event of ordered) {
    if (!event.eventId || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const kind = event.payload?.kind;
    const scope = mobileMessageEventScope(event);
    if (!scope || !kind?.case) continue;
    const sequence = event.cursor!.sequence;
    const at = mobileEventTimestamp(event);
    if (kind.case === "messageStarted" && kind.value.role === MessageRole.USER) {
      latestUser.set(scope.ownerScope, sequence);
    }
    if (kind.case === "runDone" || kind.case === "runAborted" || kind.case === "terminalError") {
      if (event.identity!.runId) stoppedRuns.add(scope.runScope);
      continue;
    }
    if (kind.case === "thinkingDelta") {
      const messageId = kind.value.messageId;
      if (!messageId || !Number.isSafeInteger(kind.value.contentIndex) || kind.value.contentIndex < 0) continue;
      const messageScope = mobileMessageScope(scope, messageId);
      if (completedMessages.has(messageScope) || stoppedRuns.has(scope.runScope)) continue;
      const key = mobileThinkingKey(messageScope, kind.value.contentIndex);
      const previous = views.get(key);
      const redacted = previous?.redacted === true || kind.value.hidden;
      views.set(key, {
        ...scope, messageScope, key, messageId, contentIndex: kind.value.contentIndex,
        eventId: event.eventId, sequence: previous?.sequence ?? sequence,
        text: redacted ? "" : (previous?.text ?? "") + kind.value.delta,
        redacted, completed: false, streaming: false,
        ...((previous?.startedAtMs ?? at) === undefined ? {} : { startedAtMs: Math.min(previous?.startedAtMs ?? at!, at ?? previous!.startedAtMs!) }),
        ...((previous?.lastActivityAtMs ?? at) === undefined ? {} : { lastActivityAtMs: Math.max(previous?.lastActivityAtMs ?? at!, at ?? previous!.lastActivityAtMs!) })
      });
      continue;
    }
    if (kind.case === "messageCompleted" && kind.value.role === MessageRole.ASSISTANT && kind.value.messageId) {
      const messageScope = mobileMessageScope(scope, kind.value.messageId);
      completedMessages.add(messageScope);
      const previous = new Map([...views].filter(([, view]) => view.messageScope === messageScope));
      for (const key of previous.keys()) views.delete(key);
      for (let contentIndex = 0; contentIndex < kind.value.blocks.length; contentIndex++) {
        const block = kind.value.blocks[contentIndex]!;
        if (block.content.case !== "thinking") continue;
        const redacted = block.content.value.redacted;
        const text = redacted ? "" : block.content.value.text;
        if (!redacted && text.trim() === "") continue;
        const key = mobileThinkingKey(messageScope, contentIndex);
        const prior = previous.get(key);
        views.set(key, {
          ...scope, messageScope, key, messageId: kind.value.messageId, contentIndex,
          eventId: event.eventId, sequence: prior?.sequence ?? sequence,
          text, redacted, completed: true, streaming: false,
          ...(prior?.startedAtMs === undefined ? {} : { startedAtMs: prior.startedAtMs }),
          ...(prior?.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: prior.lastActivityAtMs })
        });
      }
    }
  }
  return [...views.values()].filter((view) => view.redacted || view.text !== "").map((view) => ({
    ...view,
    streaming: sessionStreaming && !view.completed && !view.redacted && !stoppedRuns.has(view.runScope)
      && view.sequence > (latestUser.get(view.ownerScope) ?? -1n)
  })).sort((a, b) => a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1
    : a.messageScope === b.messageScope ? a.contentIndex - b.contentIndex : a.key.localeCompare(b.key));
}

export interface MobileMessageEventScope {
  readonly ownerScope: string;
  readonly runScope: string;
  readonly sessionId: string;
  readonly attemptId: string;
}

export function mobileMessageEventScope(event: Event): MobileMessageEventScope | undefined {
  const identity = event.identity;
  if (!identity?.sessionId || !event.cursor || identity.generation < 0n || event.cursor.generation < 0n) return undefined;
  const ownerScope = JSON.stringify([identity.sessionId, identity.generation.toString(), event.cursor.generation.toString()]);
  return { ownerScope, runScope: JSON.stringify([ownerScope, identity.runId]), sessionId: identity.sessionId, attemptId: identity.attemptId };
}

export function mobileMessageScope(scope: MobileMessageEventScope, messageId: string): string {
  return JSON.stringify([scope.runScope, scope.attemptId, messageId]);
}

function mobileThinkingKey(messageScope: string, contentIndex: number): string {
  return JSON.stringify(["thinking", messageScope, contentIndex]);
}

export function mobileEventTimestamp(event: Event): number | undefined {
  const at = event.occurredAt;
  if (!at || !Number.isInteger(at.nanos) || at.nanos < 0 || at.nanos >= 1_000_000_000 || at.nanos % 1_000_000 !== 0) return undefined;
  const value = at.seconds * 1_000n + BigInt(at.nanos / 1_000_000);
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function compareCursor(a: Event, b: Event): number {
  const first = a.cursor?.sequence ?? 0n;
  const second = b.cursor?.sequence ?? 0n;
  return first < second ? -1 : first > second ? 1 : a.eventId.localeCompare(b.eventId);
}
