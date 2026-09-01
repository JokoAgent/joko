import type { EventEnvelope } from "@joko/core/events";

export interface EventRepository {
  appendEvent(event: Omit<EventEnvelope, "sequence" | "revision">): Promise<EventEnvelope>;
  listEvents(afterSequence: bigint, limit: number, sessionId?: string): Promise<readonly EventEnvelope[]>;
  oldestEventSequence(): Promise<bigint | undefined>;
}

interface Subscriber {
  readonly id: number;
  readonly sessionId?: string;
  readonly enqueue: (event: EventEnvelope) => void;
}

export class EventCursorExpiredError extends Error {
  constructor() {
    super("The durable event cursor has expired; request a fresh snapshot.");
    this.name = "EventCursorExpiredError";
  }
}

export class DurableEventHub {
  readonly #repository: EventRepository;
  readonly #subscribers = new Map<number, Subscriber>();
  #nextSubscriberId = 1;

  constructor(repository: EventRepository) {
    this.#repository = repository;
  }

  async publish(event: Omit<EventEnvelope, "sequence" | "revision">): Promise<EventEnvelope> {
    const durable = await this.#repository.appendEvent(event);
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.sessionId === undefined || subscriber.sessionId === durable.sessionId) subscriber.enqueue(durable);
    }
    return durable;
  }

  async *watch(afterSequence: bigint, options?: { sessionId?: string; signal?: AbortSignal }): AsyncGenerator<EventEnvelope> {
    const oldest = await this.#repository.oldestEventSequence();
    if (oldest !== undefined && afterSequence > 0n && afterSequence < oldest - 1n) throw new EventCursorExpiredError();

    let cursor = afterSequence;
    while (true) {
      const replay = await this.#repository.listEvents(cursor, 500, options?.sessionId);
      if (replay.length === 0) break;
      for (const event of replay) {
        cursor = event.sequence;
        yield event;
      }
    }

    const queue: EventEnvelope[] = [];
    let wake: (() => void) | undefined;
    const id = this.#nextSubscriberId++;
    const subscriber: Subscriber = {
      id,
      ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      enqueue: (event) => {
        queue.push(event);
        wake?.();
        wake = undefined;
      }
    };
    this.#subscribers.set(id, subscriber);
    const abort = (): void => {
      wake?.();
      wake = undefined;
    };
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (options?.signal?.aborted !== true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      this.#subscribers.delete(id);
    }
  }
}
