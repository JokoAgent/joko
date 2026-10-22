import { createHash, randomUUID } from "node:crypto";
import type { AdapterEventMetadata, BlobRef, DurableNativeDispatchPreparation, EventPayload, InteractionDecision, InteractionPayload } from "@joko/core";

export const HOSTED_AGENT_UNREAD_LIMIT = 64 * 1024 * 1024;
export interface HostedAgentArtifactOffer {
  readonly id: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly fileName: string;
  readonly mimeType?: string;
}
export type HostedAgentRequest =
  | { readonly kind: "tool"; readonly input: unknown }
  | { readonly kind: "interaction"; readonly interaction: InteractionPayload }
  | { readonly kind: "artifact"; readonly offer: HostedAgentArtifactOffer }
  | { readonly kind: "native_dispatch"; readonly operationId: string; readonly preparation: DurableNativeDispatchPreparation };
export type HostedAgentFrame = {
  readonly sequence: number;
  readonly payload:
    | { readonly kind: "event"; readonly event: EventPayload; readonly metadata?: AdapterEventMetadata; readonly operationId?: string }
    | { readonly kind: "request"; readonly id: string; readonly request: HostedAgentRequest; readonly operationId?: string }
    | { readonly kind: "cancel_request"; readonly id: string };
};
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly detach: () => void;
}
export class HostedAgentExchangeError extends Error {
  constructor(readonly code: "CLOSED" | "STALE_AUTHORITY" | "INVALID_CURSOR" | "UNKNOWN_REQUEST" | "CONFLICTING_REPLY" | "RESOURCE_EXHAUSTED") {
    super("Hosted Agent exchange is unavailable.");
  }
}

/** A volatile host-side log. The original task persists an event before
 * advancing its cursor; polling or UI disconnects never replay native calls. */
export class HostedAgentExchange {
  readonly #assertAuthority: () => void;
  readonly #onOverflow: () => void;
  readonly #maximumBytes: number;
  readonly #frames: { readonly frame: HostedAgentFrame; readonly bytes: number }[] = [];
  readonly #pending = new Map<string, PendingRequest>();
  readonly #replies = new Map<string, string>();
  readonly #cancelled = new Set<string>();
  readonly #wake = new Set<() => void>();
  #sequence = 0;
  #acknowledged = 0;
  #bytes = 0;
  #closed = false;
  #finished = false;

  constructor(options: { readonly assertCurrent: () => void; readonly onOverflow: () => void; readonly maximumBytes?: number }) {
    const maximum = options.maximumBytes ?? HOSTED_AGENT_UNREAD_LIMIT;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > HOSTED_AGENT_UNREAD_LIMIT) throw new HostedAgentExchangeError("RESOURCE_EXHAUSTED");
    this.#assertAuthority = options.assertCurrent; this.#onOverflow = options.onOverflow; this.#maximumBytes = maximum;
    this.#assertCurrent();
  }

  emit(event: EventPayload, metadata?: AdapterEventMetadata, operationId?: string): void {
    this.#append({ kind: "event", event, ...(metadata === undefined ? {} : { metadata }), ...(operationId === undefined ? {} : { operationId }) });
  }
  async tool(input: unknown, signal: AbortSignal, operationId?: string): Promise<Record<string, unknown>> {
    const result = await this.#request({ kind: "tool", input }, signal, operationId);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new HostedAgentExchangeError("CONFLICTING_REPLY");
    return result as Record<string, unknown>;
  }
  async interaction(interaction: InteractionPayload, signal: AbortSignal, operationId?: string): Promise<InteractionDecision> {
    // The controller and original SessionHost validate the closed decision shape.
    // This port keeps the exact request identity and never guesses an answer.
    return await this.#request({ kind: "interaction", interaction }, signal, operationId) as InteractionDecision;
  }
  async artifact(offer: HostedAgentArtifactOffer, signal: AbortSignal, operationId?: string): Promise<BlobRef> {
    const result = await this.#request({ kind: "artifact", offer }, signal, operationId) as Partial<BlobRef> | null;
    if (!result || typeof result.id !== "string" || !result.id || result.sha256 !== offer.sha256 || result.byteLength !== offer.byteLength
      || typeof result.mimeType !== "string") throw new HostedAgentExchangeError("CONFLICTING_REPLY");
    return result as BlobRef;
  }
  async nativeDispatch(operationId: string, preparation: DurableNativeDispatchPreparation, signal: AbortSignal): Promise<void> {
    const result = await this.#request({ kind: "native_dispatch", operationId, preparation }, signal, operationId) as { committed?: unknown } | null;
    if (!result || result.committed !== true) throw new HostedAgentExchangeError("CONFLICTING_REPLY");
  }
  /** One connection-level poll subscribes to every run before inspecting any
   * cursor, so output between inspection and waiting cannot be lost. */
  onOutput(listener: () => void): () => void {
    this.#assertCurrent(); this.#wake.add(listener); return () => { this.#wake.delete(listener); };
  }
  async poll(after: number, signal: AbortSignal, waitMs = 30_000, maximumBytes = HOSTED_AGENT_UNREAD_LIMIT): Promise<{ readonly frames: readonly HostedAgentFrame[]; readonly cursor: number; readonly finished: boolean }> {
    this.#assertCurrent(); signal.throwIfAborted();
    if (!Number.isSafeInteger(after) || after < this.#acknowledged || after > this.#sequence
      || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HOSTED_AGENT_UNREAD_LIMIT) throw new HostedAgentExchangeError("INVALID_CURSOR");
    this.#acknowledged = after;
    while (this.#frames[0]?.frame.sequence !== undefined && this.#frames[0].frame.sequence <= after) this.#bytes -= this.#frames.shift()!.bytes;
    if (this.#frames.length === 0 && !this.#finished && waitMs > 0) await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const detach = () => { clearTimeout(timer); this.#wake.delete(wake); signal.removeEventListener("abort", abort); };
      const wake = () => { detach(); resolve(); }, abort = () => { detach(); reject(new HostedAgentExchangeError("CLOSED")); };
      timer = setTimeout(wake, waitMs); timer.unref(); this.#wake.add(wake); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    this.#assertCurrent(); signal.throwIfAborted();
    const frames: HostedAgentFrame[] = []; let bytes = 0;
    for (const value of this.#frames) {
      if (value.frame.sequence <= after) continue;
      const wireBytes = Buffer.byteLength(JSON.stringify(value.frame)) + 1;
      if (bytes + wireBytes > maximumBytes) break;
      frames.push(value.frame); bytes += wireBytes;
    }
    const cursor = frames.at(-1)?.sequence ?? after;
    return { frames, cursor, finished: this.#finished && cursor === this.#sequence };
  }
  reply(id: string, result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string }): "accepted" | "cancelled" {
    this.#assertCurrent();
    if (typeof id !== "string" || id.length > 128) throw new HostedAgentExchangeError("UNKNOWN_REQUEST");
    const body = JSON.stringify(result);
    if (body === undefined || Buffer.byteLength(body) > this.#maximumBytes) throw new HostedAgentExchangeError("RESOURCE_EXHAUSTED");
    const digest = createHash("sha256").update(body).digest("hex"), previous = this.#replies.get(id);
    if (previous !== undefined) {
      if (previous !== digest) throw new HostedAgentExchangeError("CONFLICTING_REPLY");
      return "accepted";
    }
    if (this.#cancelled.has(id)) return "cancelled";
    const pending = this.#pending.get(id);
    if (!pending) throw new HostedAgentExchangeError("UNKNOWN_REQUEST");
    if (this.#replies.size >= 65_536) this.#overflow();
    this.#pending.delete(id); pending.detach(); this.#replies.set(id, digest);
    if (result.ok) pending.resolve(result.value);
    else pending.reject(Object.assign(new Error("The task rejected the hosted Agent request."), {
      code: /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.code) ? result.code : "ACCESS_DENIED"
    }));
    return "accepted";
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { pending.detach(); pending.reject(new HostedAgentExchangeError("CLOSED")); }
    this.#pending.clear(); this.#frames.splice(0); this.#bytes = 0;
    this.#replies.clear(); this.#cancelled.clear();
    for (const wake of [...this.#wake]) wake();
    this.#wake.clear();
  }
  /** Native closure retains its final frames for the original task to drain. */
  finish(): void {
    if (this.#closed || this.#finished) return;
    this.#finished = true;
    for (const [id, pending] of this.#pending) { pending.detach(); this.#cancelled.add(id); pending.reject(new HostedAgentExchangeError("CLOSED")); }
    this.#pending.clear();
    for (const wake of [...this.#wake]) wake();
  }
  #assertCurrent(): void {
    if (this.#closed) throw new HostedAgentExchangeError("CLOSED");
    try { this.#assertAuthority(); } catch { this.close(); throw new HostedAgentExchangeError("STALE_AUTHORITY"); }
  }
  #append(payload: HostedAgentFrame["payload"]): void {
    this.#assertCurrent();
    if (this.#finished) throw new HostedAgentExchangeError("CLOSED");
    // Clone through the actual wire shape before publication. A native producer
    // retaining a reference cannot change an already observed event or request.
    const body = JSON.stringify(payload);
    const frame: HostedAgentFrame = { sequence: this.#sequence + 1, payload: JSON.parse(body) as HostedAgentFrame["payload"] };
    const bytes = Buffer.byteLength(JSON.stringify(frame)) + 1;
    if (bytes > this.#maximumBytes || this.#bytes + bytes > this.#maximumBytes || this.#sequence >= Number.MAX_SAFE_INTEGER) this.#overflow();
    this.#sequence++;
    this.#frames.push({ frame, bytes }); this.#bytes += bytes;
    for (const wake of [...this.#wake]) wake();
  }
  #overflow(): never {
    this.close();
    try { this.#onOverflow(); } catch { /* Shutdown ownership remains with the host. */ }
    throw new HostedAgentExchangeError("RESOURCE_EXHAUSTED");
  }
  #request(request: HostedAgentRequest, signal: AbortSignal, operationId?: string): Promise<unknown> {
    this.#assertCurrent(); signal.throwIfAborted();
    if (this.#finished) throw new HostedAgentExchangeError("CLOSED");
    if (this.#pending.size >= 256 || this.#cancelled.size >= 65_536) this.#overflow();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(id); if (!pending) return;
        this.#pending.delete(id); pending.detach(); this.#cancelled.add(id); reject(new HostedAgentExchangeError("CLOSED"));
        try { this.#append({ kind: "cancel_request", id }); } catch { /* Closing the run already cancels its requests. */ }
      };
      this.#pending.set(id, { resolve, reject, detach: () => signal.removeEventListener("abort", abort) });
      signal.addEventListener("abort", abort, { once: true });
      try { this.#append({ kind: "request", id, request, ...(operationId === undefined ? {} : { operationId }) }); if (signal.aborted) abort(); }
      catch (error) { this.#pending.delete(id); signal.removeEventListener("abort", abort); reject(error); }
    });
  }
}
