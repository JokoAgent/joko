import type { AdapterContext, DurableNativeDispatchPreparation, NativeHistoryProjection, NativeSessionBinding, NativeSessionState } from "@joko/core";
import { receiveHostedAgentArtifact } from "./hosted-agent-artifacts.js";
import { HostedAgentExecutor, HostedAgentExecutorError } from "./hosted-agent-executor.js";
import type { HostedAgentFrame } from "./hosted-agent-exchange.js";
import { HostedAgentProjection } from "./hosted-agent-projection.js";

export interface HostedAgentRunPort {
  poll(after: number, signal: AbortSignal): Promise<{ readonly frames: readonly HostedAgentFrame[]; readonly cursor: number; readonly finished: boolean }>;
  reply(id: string, result: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string }, signal: AbortSignal): Promise<void>;
  readArtifact(id: string, offset: number, maximum: number, signal: AbortSignal): Promise<{ readonly data: string }>;
}
export interface HostedAgentOperationOwner {
  readonly context: AdapterContext;
  readonly executor: HostedAgentExecutor;
  readonly executeTool?: (input: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;
  readonly persistFence?: (operationId: string, preparation: DurableNativeDispatchPreparation) => Promise<void>;
}

/** Original-task consumer. Events are persisted before its next poll advances
 * the remote cursor. Reverse effects start once and replies are retried only
 * with the already computed result, never by executing the native call again. */
export class HostedAgentController {
  readonly #port: HostedAgentRunPort;
  readonly #context: AdapterContext;
  readonly #executor: HostedAgentExecutor;
  readonly #projection: HostedAgentProjection;
  readonly #temporaryRoot: string;
  readonly #assertAuthority: () => void;
  readonly #persistFence: ((operationId: string, preparation: DurableNativeDispatchPreparation) => Promise<void>) | undefined;
  readonly #resolveOperation: ((operationId: string) => HostedAgentOperationOwner) | undefined;
  readonly #lifetime = new AbortController();
  readonly #requests = new Map<string, { readonly abort: AbortController; readonly promise: Promise<void> }>();
  readonly #seen = new Set<string>();
  #cursor = 0;
  #pump?: Promise<void>;

  constructor(options: { readonly port: HostedAgentRunPort; readonly context: AdapterContext; readonly executor: HostedAgentExecutor;
    readonly binding: () => NativeSessionBinding;
    readonly resolveOperation?: (operationId: string) => HostedAgentOperationOwner;
    readonly temporaryRoot: string; readonly assertCurrent: () => void; readonly persistFence?: (operationId: string, preparation: DurableNativeDispatchPreparation) => Promise<void> }) {
    this.#port = options.port; this.#context = options.context; this.#executor = options.executor; this.#temporaryRoot = options.temporaryRoot;
    this.#assertAuthority = options.assertCurrent; this.#persistFence = options.persistFence;
    this.#resolveOperation = options.resolveOperation;
    this.#projection = new HostedAgentProjection(options.executor.workspace, options.context, options.binding);
  }
  start(): Promise<void> { return this.#pump ??= this.#consume(); }
  projectResult<T>(value: T): T { return this.#projection.value(value); }
  projectState(value: NativeSessionState): NativeSessionState { return this.#projection.state(value); }
  projectHistory(value: NativeHistoryProjection): NativeHistoryProjection { return this.#projection.history(value); }
  /** The original Host calls this synchronously before sending a remote abort. */
  abortPending(): void { for (const request of this.#requests.values()) request.abort.abort(); }
  async stop(): Promise<void> {
    this.#lifetime.abort(); this.abortPending();
    await this.#pump?.catch(() => {});
    await Promise.all([...this.#requests.values()].map(value => value.promise.catch(() => {})));
  }
  async #consume(): Promise<void> {
    const signal = AbortSignal.any([this.#lifetime.signal, this.#context.signal]);
    try {
      for (;;) {
        this.#assertCurrent(signal);
        const batch = await this.#port.poll(this.#cursor, signal); this.#assertCurrent(signal);
        if (!Number.isSafeInteger(batch.cursor) || batch.cursor < this.#cursor || !Array.isArray(batch.frames)) throw new Error("Hosted Agent cursor is invalid.");
        for (const frame of batch.frames) {
          this.#assertCurrent(signal);
          if (frame.sequence !== this.#cursor + 1) throw new Error("Hosted Agent output has a cursor gap.");
          if (frame.payload.kind === "event") {
            const owner = this.#owner(frame.payload.operationId);
            const event = this.#projection.event(frame.payload.event);
            await owner.context.emit(event, frame.payload.metadata === undefined ? undefined : this.#projection.metadata(frame.payload.metadata)); this.#assertCurrent(signal);
          } else if (frame.payload.kind === "cancel_request") this.#requests.get(frame.payload.id)?.abort.abort();
          else if (frame.payload.kind === "request") this.#startRequest(frame, signal);
          else throw new Error("Hosted Agent output has an unknown frame.");
          this.#cursor = frame.sequence;
        }
        if (this.#cursor !== batch.cursor) throw new Error("Hosted Agent output has an invalid final cursor.");
        if (batch.finished) return;
      }
    } finally { this.#lifetime.abort(); this.abortPending(); }
  }
  #startRequest(frame: HostedAgentFrame, signal: AbortSignal): void {
    if (frame.payload.kind !== "request") throw new Error("Hosted Agent request is invalid.");
    const { id, request } = frame.payload, owner = this.#owner(frame.payload.operationId);
    if (!id || id.length > 128 || this.#seen.has(id) || this.#seen.size >= 65_536 || this.#requests.size >= 256) throw new Error("Hosted Agent reverse request identity is invalid.");
    this.#seen.add(id); const abort = new AbortController(), activeSignal = AbortSignal.any([signal, abort.signal, owner.context.signal]);
    const promise = Promise.resolve().then(async () => {
      let reply: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };
      try {
        this.#assertCurrent(activeSignal); let value: unknown;
        switch (request.kind) {
          case "tool": value = await (owner.executeTool?.(request.input, activeSignal) ?? owner.executor.execute(request.input, activeSignal)); break;
          case "interaction": value = await owner.context.requestInteraction(this.#projection.interaction(request.interaction), { signal: activeSignal }); break;
          case "artifact": value = await receiveHostedAgentArtifact({ offer: request.offer, context: owner.context, temporaryRoot: this.#temporaryRoot,
            signal: activeSignal, assertCurrent: () => this.#assertCurrent(activeSignal),
            readChunk: (id, offset, maximum, signal) => this.#port.readArtifact(id, offset, maximum, signal) }); break;
          case "native_dispatch": if (!owner.persistFence) throw new Error("The original native dispatch owner is unavailable.");
            if (frame.payload.kind !== "request" || frame.payload.operationId !== undefined && frame.payload.operationId !== request.operationId) throw new Error("Hosted native dispatch owner conflicts.");
            await owner.persistFence(request.operationId, this.#projection.dispatch(request.preparation)); value = { committed: true }; break;
          default: throw new Error("Hosted Agent reverse request is unsupported.");
        }
        this.#assertCurrent(activeSignal); reply = { ok: true, value };
      } catch (error) { reply = { ok: false, code: error instanceof HostedAgentExecutorError ? error.code : activeSignal.aborted ? "STALE_AUTHORITY" : "EXECUTOR_FAILED" }; }
      // Losing an acknowledgement never repeats a file write, shell command,
      // user question or Artifact materialization. The host deduplicates replies.
      for (let attempt = 0; attempt < 3; attempt++) {
        this.#assertCurrent(signal);
        try { await this.#port.reply(id, reply, signal); return; }
        catch { this.#assertCurrent(signal); if (attempt === 2) throw new Error("Hosted Agent reply could not be confirmed.");
          await delay(100 * (attempt + 1), signal); }
      }
    }).finally(() => { if (this.#requests.get(id)?.promise === promise) this.#requests.delete(id); });
    this.#requests.set(id, { abort, promise });
    void promise.catch(() => { this.#lifetime.abort(); this.abortPending(); });
  }
  #owner(operationId: string | undefined): HostedAgentOperationOwner {
    if (!this.#resolveOperation) return { context: this.#context, executor: this.#executor, ...(this.#persistFence === undefined ? {} : { persistFence: this.#persistFence }) };
    if (!operationId || operationId.length > 512 || /[\0\r\n]/u.test(operationId)) throw new Error("Hosted Agent operation owner is unavailable.");
    const owner = this.#resolveOperation(operationId), context = owner.context;
    if (context.sessionId !== this.#context.sessionId || context.generation !== this.#context.generation || context.target.id !== this.#context.target.id
      || context.target.workspaceRoot !== this.#context.target.workspaceRoot) throw new Error("Hosted Agent operation belongs to another task.");
    return owner;
  }
  #assertCurrent(signal: AbortSignal): void { signal.throwIfAborted(); this.#assertAuthority(); }
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("Hosted Agent connection closed.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms); timer.unref();
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}
