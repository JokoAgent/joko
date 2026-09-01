import type { SessionView, TimelineHistoryCursorView } from "./model.js";

export interface SessionNotificationCandidate {
  readonly sessionId: string;
  readonly title: string;
  readonly kind: "done" | "awaiting" | "error";
}

export function shouldDispatchSessionNotifications(options: {
  readonly enabled: boolean;
  readonly desktopAvailable: boolean;
  readonly windowFocused: boolean;
}): boolean {
  return options.enabled && options.desktopAvailable && !options.windowFocused;
}

/**
 * Converts durable attention edges into one-shot client notifications.
 * The first authoritative snapshot for each owner seeds state, so reconnects
 * and application restarts never replay old unread attention as fresh work.
 */
export class SessionNotificationTracker {
  #ownerId: string | undefined;
  #initialized = false;
  readonly #seen = new Map<string, string | undefined>();

  observe(ownerId: string, sessions: readonly SessionView[]): readonly SessionNotificationCandidate[] {
    if (this.#ownerId !== ownerId) {
      this.#ownerId = ownerId;
      this.#initialized = false;
      this.#seen.clear();
    }

    if (!this.#initialized) {
      this.#replaceBaseline(sessions);
      this.#initialized = true;
      return [];
    }

    const candidates: SessionNotificationCandidate[] = [];
    const retained = new Set<string>();
    for (const session of sessions) {
      retained.add(session.id);
      const fingerprint = attentionFingerprint(session);
      const previous = this.#seen.get(session.id);
      const wasKnown = this.#seen.has(session.id);
      this.#seen.set(session.id, fingerprint);
      if (
        fingerprint !== undefined
        && session.attention?.unread === true
        && (!wasKnown || previous !== fingerprint)
      ) {
        candidates.push({
          sessionId: session.id,
          title: session.name,
          kind: session.attention.kind
        });
      }
    }
    for (const sessionId of this.#seen.keys()) {
      if (!retained.has(sessionId)) this.#seen.delete(sessionId);
    }
    return candidates;
  }

  reset(): void {
    this.#ownerId = undefined;
    this.#initialized = false;
    this.#seen.clear();
  }

  #replaceBaseline(sessions: readonly SessionView[]): void {
    this.#seen.clear();
    for (const session of sessions) this.#seen.set(session.id, attentionFingerprint(session));
  }
}

function attentionFingerprint(session: SessionView): string | undefined {
  const attention = session.attention;
  if (attention === undefined) return undefined;
  return [
    attention.kind,
    cursorFingerprint(attention.subjectCursor),
    cursorFingerprint(attention.attentionCursor)
  ].join("\u0000");
}

function cursorFingerprint(cursor: TimelineHistoryCursorView): string {
  return `${cursor.generation}:${cursor.sequence}:${cursor.opaqueToken}`;
}
