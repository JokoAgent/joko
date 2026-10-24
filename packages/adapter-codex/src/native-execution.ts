import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AdapterContext } from "@joko/core";
import type { AppServerHost } from "./host.js";
import type { JsonObject } from "./protocol.js";
import type { CodexHostedExecServerLease } from "./hosted-execution.js";

/** Structural private process port; the Adapter owns no SSH implementation. */
export interface CodexNativeProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface CodexNativeExecutionInput {
  readonly context: AdapterContext;
  readonly workspaceRoot: string;
  readonly pathStyle: "posix" | "win32";
  readonly remote: boolean;
  /** Lifetime of this environment, independent of an individual native turn. */
  readonly signal?: AbortSignal;
  readonly assertCurrent: () => void;
  /** Read at each primitive. The creation context is never a later turn grant. */
  readonly currentContext: () => AdapterContext;
  /** False during native setup: only bounded initialization reads are valid. */
  readonly hasActiveTurn?: () => boolean;
  /** Register a partially-created private resource before throwing, so its
   * original owner can retry cleanup even when no lease could be returned. */
  readonly retainCleanup?: (close: () => Promise<void>) => void;
  readonly openExecServerProcess?: (signal: AbortSignal) => Promise<CodexNativeProcess>;
}

export interface CodexNativeExecutionOptions {
  readonly openExecServer: (input: CodexNativeExecutionInput) => Promise<CodexHostedExecServerLease>;
}

/** One task's native environment. It routes the engine's own fs/process
 * primitives through the service; an unavailable relay cannot execute locally. */
export class CodexNativeExecutionEnvironment {
  readonly #id = "joko-task-" + randomUUID();
  readonly #input: CodexNativeExecutionInput;
  readonly #options: CodexNativeExecutionOptions;
  readonly #lifetime = new AbortController();
  readonly #pendingCleanup = new Set<() => Promise<void>>();
  #lease?: CodexHostedExecServerLease;
  #prepared?: { readonly host: AppServerHost; readonly generation: number };
  #flight?: Promise<void>;
  #closed = false;
  #close?: Promise<void>;
  constructor(input: CodexNativeExecutionInput, options: CodexNativeExecutionOptions) {
    this.#input = { ...input, signal: this.#lifetime.signal,
      retainCleanup: close => { this.#pendingCleanup.add(close); } }; this.#options = options;
  }
  assertCurrent(): void {
    if (this.#closed) throw new Error("The native task execution environment is closed.");
    this.#input.assertCurrent(); this.#lease?.assertCurrent();
  }
  environments(context: AdapterContext): JsonObject {
    this.assertCurrent();
    return { environments: [{ environmentId: this.#id, cwd: this.#input.workspaceRoot,
      runtimeWorkspaceRoots: [this.#input.workspaceRoot, ...(context.extraDirectories ?? []).map(directory => directory.path)] }] };
  }
  async prepare(host: AppServerHost, signal: AbortSignal): Promise<void> {
    this.assertCurrent(); signal.throwIfAborted();
    const generation = await host.ensureStarted();
    if (this.#prepared?.host === host && this.#prepared.generation === generation) return;
    if (this.#flight) { await this.#flight; return this.prepare(host, signal); }
    const flight = (async () => {
      const assert = () => {
        this.assertCurrent(); signal.throwIfAborted();
        if (!host.isActiveGeneration(generation)) throw new Error("The native task execution process changed.");
      };
      assert();
      if (!this.#lease) {
        const lease = await this.#options.openExecServer(this.#input);
        this.#lease = lease;
      }
      assert();
      const url = new URL(this.#lease.execServerUrl);
      if (url.protocol !== "ws:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port
        || url.username || url.password || url.search || url.hash || url.pathname !== "/ws/exec-server"
        || !/^[A-Za-z0-9_-]{32,256}$/u.test(this.#lease.authBearerToken)) throw new Error("The native execution relay is invalid.");
      await host.request("environment/add", { environmentId: this.#id,
        execServerUrl: this.#lease.execServerUrl, authBearerToken: this.#lease.authBearerToken }, { signal, beforeDispatch: assert });
      assert(); this.#prepared = { host, generation };
    })();
    this.#flight = flight;
    try { await flight; } finally { if (this.#flight === flight) this.#flight = undefined; }
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closed = true; this.#lifetime.abort();
    const pending = this.#flight;
    const flight = (async () => {
      await pending?.catch(() => undefined);
      const errors: unknown[] = [];
      if (this.#lease) try { await this.#lease.close(); this.#lease = undefined; } catch (error) { errors.push(error); }
      for (const close of [...this.#pendingCleanup]) {
        try { await close(); this.#pendingCleanup.delete(close); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Native executor cleanup is unconfirmed.");
    })();
    this.#close = flight;
    void flight.catch(() => { if (this.#close === flight) this.#close = undefined; });
    return flight;
  }
}
