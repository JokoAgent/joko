import { randomInt } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import Xterm from "@xterm/headless";
import XtermSerialize from "@xterm/addon-serialize";
import type { IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";
import { spawnTerminalHost } from "./host-pty.js";
import { TerminalOutputFramer, terminalDisplayOutput } from "./output-framer.js";
import { discoverTerminalShells, terminalEnvironment } from "./shells.js";
import { TERMINAL_COLOR_OSC_IDENTIFIERS, TerminalColorState, copyTerminalPalette } from "./terminal-color-state.js";
import {
  TerminalError,
  type TerminalPalette,
  type TerminalViewAppearance,
  type TerminalAppearanceResult,
  type TerminalCreateInput,
  type TerminalDescriptor,
  type TerminalFrame,
  type TerminalReference,
  type TerminalScope,
  type TerminalShell,
  type TerminalSnapshot,
  type TerminalStreamInput
} from "./types.js";

const { Terminal } = Xterm;
const { SerializeAddon } = XtermSerialize;
type Terminal = import("@xterm/headless").Terminal;
type SerializeAddon = import("@xterm/addon-serialize").SerializeAddon;

export const TERMINAL_LIMITS = Object.freeze({
  maximumTerminals: 16,
  maximumInputBytes: 64 * 1024,
  maximumColumns: 500,
  maximumRows: 200,
  maximumOutputBytes: 1024 * 1024,
  maximumOutputFrames: 1024,
  maximumStreamsPerTerminal: 8,
  maximumSnapshotBytes: 8 * 1024 * 1024,
  scrollbackLines: 1000
});
const MAXIMUM_PENDING_OUTPUT_BYTES = 1024 * 1024;
const PAUSE_OUTPUT_BYTES = 128 * 1024;
const RESUME_OUTPUT_BYTES = 32 * 1024;
export interface TerminalPty {
  readonly pid?: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number; failureCode?: string; processExitConfirmed?: boolean }) => void): { dispose(): void };
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  kill(): void | Promise<void>;
  pause(): void;
  resume(): void;
}
export type TerminalPtyFactory = (
  executable: string,
  args: string[],
  options: IPtyForkOptions | IWindowsPtyForkOptions,
  signal?: AbortSignal
) => TerminalPty | Promise<TerminalPty>;

export interface TerminalRuntime {
  discoverShells(): Promise<readonly TerminalShell[]>;
  canonicalDirectory(workspaceRoot: string, cwd: string): Promise<string>;
  spawn(shell: TerminalShell, options: { readonly cwd: string; readonly cols: number; readonly rows: number }, signal?: AbortSignal): TerminalPty | Promise<TerminalPty>;
}

export interface TerminalProviderOptions {
  readonly spawn?: TerminalPtyFactory;
  readonly shells?: () => Promise<readonly TerminalShell[]>;
  readonly resolveRemoteRuntime?: (scope: TerminalScope, signal?: AbortSignal) => Promise<TerminalRuntime>;
  /** Source to select OS/locale variables from. Arbitrary environment overrides are not accepted. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly now?: () => number;
  readonly onActivity?: () => void;
  readonly maximumTerminals?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumOutputFrames?: number;
  readonly scrollbackLines?: number;
}

interface TerminalViewLease {
  readonly id: string;
  readonly attached: number;
  live: boolean;
  focused: number;
  revision: number;
  parameters: string;
  palette: TerminalPalette;
}

interface TerminalRecord {
  readonly scope: TerminalScope;
  readonly createKey: string;
  readonly shell: TerminalShell;
  readonly pty: TerminalPty;
  readonly screen: Terminal;
  readonly serializer: SerializeAddon;
  readonly colors: TerminalColorState;
  readonly framer: TerminalOutputFramer;
  readonly lifetime: AbortController;
  readonly subscriptions: { dispose(): void }[];
  readonly wake: Set<() => void>;
  readonly frames: { frame: TerminalFrame; bytes: number }[];
  readonly views: Map<string, TerminalViewLease>;
  defaultViewId: string | undefined;
  controlViewId: string | undefined;
  appearanceRevision: number;
  viewOrder: number;
  descriptor: TerminalDescriptor;
  queue: Promise<unknown>;
  sequence: number;
  retainedBytes: number;
  pendingBytes: number;
  bytesSinceCapacityCheck: number;
  acceptingInput: boolean;
  outputPaused: boolean;
  processExited: boolean;
  processExitConfirmed: boolean;
  failurePending: boolean;
  readonly exited: Promise<void>;
  readonly notifyExit: () => void;
  removed: boolean;
  restarting: boolean;
  streams: number;
}

interface PendingCreation {
  readonly key: string;
  readonly scope: TerminalScope;
  readonly abort: AbortController;
  readonly result: Promise<TerminalDescriptor>;
}

/** Volatile process and terminal-state owner. Client streams never own process lifetime. */
export class TerminalProvider {
  readonly #spawn: TerminalPtyFactory;
  readonly #shells: () => Promise<readonly TerminalShell[]>;
  readonly #resolveRemoteRuntime: TerminalProviderOptions["resolveRemoteRuntime"];
  readonly #environment: Readonly<Record<string, string>>;
  readonly #now: () => number;
  readonly #onActivity: (() => void) | undefined;
  readonly #maximumTerminals: number;
  readonly #maximumOutputBytes: number;
  readonly #maximumOutputFrames: number;
  readonly #scrollbackLines: number;
  readonly #records = new Map<string, TerminalRecord>();
  readonly #creating = new Map<string, PendingCreation>();
  readonly #restarting = new Map<string, PendingCreation>();
  readonly #uncertainScopes = new Map<string, TerminalScope>();
  readonly #closedReferences = new Map<string, TerminalReference>();
  #generation = randomInt(1, 2 ** 48);
  #disposed = false;

  constructor(options: TerminalProviderOptions = {}) {
    this.#spawn = options.spawn ?? spawnTerminalHost;
    this.#shells = options.shells ?? (() => discoverTerminalShells(options.environment));
    this.#resolveRemoteRuntime = options.resolveRemoteRuntime;
    this.#environment = terminalEnvironment(options.environment);
    this.#now = options.now ?? Date.now;
    this.#onActivity = options.onActivity;
    this.#maximumTerminals = integer(options.maximumTerminals ?? TERMINAL_LIMITS.maximumTerminals, 1, 64, "Terminal capacity");
    this.#maximumOutputBytes = integer(options.maximumOutputBytes ?? TERMINAL_LIMITS.maximumOutputBytes, 1024, 16 * 1024 * 1024, "Output capacity");
    this.#maximumOutputFrames = integer(options.maximumOutputFrames ?? TERMINAL_LIMITS.maximumOutputFrames, 2, 8192, "Output frame capacity");
    this.#scrollbackLines = integer(options.scrollbackLines ?? TERMINAL_LIMITS.scrollbackLines, 0, 10_000, "Scrollback capacity");
  }

  async discoverShells(scope?: TerminalScope, signal?: AbortSignal): Promise<readonly TerminalShell[]> {
    this.#assertOpen();
    signal?.throwIfAborted();
    if (scope !== undefined) validateScope(scope);
    const runtime = scope?.remoteHostId === undefined ? this.#localRuntime() : await this.#runtime(scope, signal);
    const result = await (signal === undefined ? runtime.discoverShells() : abortable(runtime.discoverShells(), signal));
    this.#assertOpen();
    return result.map((shell) => ({ ...shell, args: [...shell.args] }));
  }

  hasActiveTerminals(): boolean {
    return this.#creating.size > 0 || this.#restarting.size > 0 || this.#uncertainScopes.size > 0 || [...this.#records.values()].some((record) => !record.processExitConfirmed || record.restarting);
  }

  async create(input: TerminalCreateInput, signal?: AbortSignal, beforeSpawn?: () => void): Promise<TerminalDescriptor> {
    this.#assertOpen();
    validateScope(input);
    identity(input.id, "Terminal identity");
    const initialPalette = copyTerminalPalette(input.initialPalette);
    if (this.#uncertainScopes.has(input.id)) throw new TerminalError("CLEANUP_UNKNOWN", "A previous terminal process exit could not be confirmed.", true);
    const cols = integer(input.cols ?? 80, 2, TERMINAL_LIMITS.maximumColumns, "Columns");
    const rows = integer(input.rows ?? 24, 1, TERMINAL_LIMITS.maximumRows, "Rows");
    const cwd = input.cwd ?? ".";
    const paths = scopePaths(input);
    if (typeof cwd !== "string" || cwd.includes("\0") || cwd.length > 8192 || paths.isAbsolute(cwd)) {
      throw new TerminalError("WORKSPACE_PATH_DENIED", "The initial directory must be relative to the workspace.");
    }
    const requestedShell = input.shellId === undefined || input.shellId === "" ? "auto" : input.shellId;
    identity(requestedShell, "Shell identity");
    const key = JSON.stringify([input.sessionId, input.targetId, input.remoteHostTargetId ?? null, input.remoteHostId ?? null, paths.resolve(input.workspaceRoot), paths.resolve(input.workspaceRoot, cwd), requestedShell, input.fallbackToDefaultShell === true, cols, rows, initialPalette]);
    const existing = this.#records.get(input.id);
    if (existing !== undefined) {
      this.#assertScope(existing, input);
      if (existing.createKey !== key) throw new TerminalError("TERMINAL_CONFLICT", "The terminal identity already belongs to different creation parameters.");
      return { ...existing.descriptor };
    }
    const pending = this.#creating.get(input.id);
    if (pending !== undefined) {
      if (pending.key !== key) throw new TerminalError("TERMINAL_CONFLICT", "The terminal identity already belongs to another creation.");
      try {
        const result = await pending.result;
        signal?.throwIfAborted();
        return { ...result };
      } catch (error) { throw cancelledStart(error, signal); }
    }
    if (this.#records.size + this.#creating.size + this.#uncertainScopes.size >= this.#maximumTerminals) {
      throw new TerminalError("TERMINAL_LIMIT", "Close an existing terminal before creating another.");
    }
    const abort = new AbortController();
    const combined = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal]);
    const scope: TerminalScope = { sessionId: input.sessionId, targetId: input.targetId, workspaceRoot: paths.resolve(input.workspaceRoot),
      ...(input.remoteHostId === undefined ? {} : { remoteHostId: input.remoteHostId, remoteHostTargetId: input.remoteHostTargetId }) };
    const result = this.#create(scope, input.id, key, cwd, requestedShell, input.fallbackToDefaultShell === true, cols, rows, initialPalette, combined, beforeSpawn);
    this.#creating.set(input.id, { key, scope, abort, result });
    this.#activity();
    try { return { ...await result }; }
    catch (error) {
      if (error instanceof TerminalError && error.stateMayHaveChanged) this.#uncertainScopes.set(input.id, scope);
      throw cancelledStart(error, combined);
    }
    finally {
      if (this.#creating.get(input.id)?.result === result) this.#creating.delete(input.id);
      this.#activity();
    }
  }

  list(scope: TerminalScope): TerminalDescriptor[] {
    this.#assertOpen();
    validateScope(scope);
    return [...this.#records.values()].filter((record) => sameScope(record.scope, scope)).map((record) => ({ ...record.descriptor }));
  }

  async snapshot(reference: TerminalReference): Promise<TerminalSnapshot> {
    const record = this.#require(reference);
    return this.#enqueue(record, () => this.#snapshot(record));
  }

  stream(input: TerminalStreamInput, signal?: AbortSignal, beforeCommit?: () => void): AsyncIterableIterator<TerminalFrame> {
    const abort = new AbortController();
    const combined = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal]);
    const appearance = validatedAppearance(input.appearance);
    const generator = this.#stream({ ...input, appearance }, combined, beforeCommit);
    return {
      next: () => generator.next(),
      return: async () => { abort.abort(); return generator.return(undefined); },
      throw: async (error) => { abort.abort(); return generator.throw(error); },
      [Symbol.asyncIterator]() { return this; }
    };
  }

  async updateAppearance(input: TerminalReference & { readonly appearance: TerminalViewAppearance; readonly claimFocus: boolean; readonly expectedAppearanceRevision: number }, signal?: AbortSignal, beforeCommit?: () => void): Promise<TerminalAppearanceResult> {
    const record = this.#require(input);
    const appearance = validatedAppearance(input.appearance);
    integer(input.expectedAppearanceRevision, input.claimFocus ? 1 : 0, Number.MAX_SAFE_INTEGER, "Appearance revision");
    const parameters = JSON.stringify([appearance.palette, input.claimFocus, input.expectedAppearanceRevision]);
    return this.#enqueue(record, () => {
      signal?.throwIfAborted();
      beforeCommit?.();
      this.#require(input);
      const view = record.views.get(appearance.viewId);
      if (view === undefined || !view.live || record.restarting) throw new TerminalError("VIEW_UNAVAILABLE", "The terminal view is no longer attached.");
      const result = (accepted: boolean): TerminalAppearanceResult => ({ accepted, acceptedViewRevision: view.revision, appearanceRevision: record.appearanceRevision, ownsDefaults: record.defaultViewId === view.id });
      if (appearance.viewRevision < view.revision) throw new TerminalError("VIEW_REVISION_STALE", "The terminal view update is stale.");
      if (appearance.viewRevision === view.revision) {
        if (parameters !== view.parameters) throw new TerminalError("VIEW_REVISION_CONFLICT", "The view revision already identifies different appearance parameters.");
        return result(true);
      }
      if (input.claimFocus && input.expectedAppearanceRevision !== record.appearanceRevision) return result(false);
      view.revision = appearance.viewRevision;
      view.parameters = parameters;
      view.palette = appearance.palette;
      if (input.claimFocus) {
        view.focused = ++record.viewOrder;
        record.controlViewId = view.id;
        this.#useViewDefaults(record, view, true);
      } else if (record.defaultViewId === view.id) this.#useViewDefaults(record, view);
      return result(true);
    });
  }

  #useViewDefaults(record: TerminalRecord, view: TerminalViewLease | undefined, focused = false): void {
    const changed = record.defaultViewId !== view?.id || focused
      || view !== undefined && JSON.stringify(record.colors.defaults()) !== JSON.stringify(view.palette);
    record.defaultViewId = view?.id;
    if (view !== undefined) record.colors.replaceDefaults(view.palette);
    if (changed) { record.appearanceRevision += 1; this.#state(record); }
  }

  #remainingView(record: TerminalRecord): TerminalViewLease | undefined {
    return [...record.views.values()].filter((view) => view.live).sort((left, right) => right.focused - left.focused || left.attached - right.attached)[0];
  }

  async input(input: TerminalReference & { readonly data: string; readonly viewId?: string }, signal?: AbortSignal, beforeCommit?: () => void): Promise<void> {
    signal?.throwIfAborted();
    const record = this.#requireRunning(input);
    if (typeof input.data !== "string" || input.data.length === 0 || Buffer.byteLength(input.data) > TERMINAL_LIMITS.maximumInputBytes) {
      throw new TerminalError("INPUT_LIMIT", "Terminal input must be nonempty and fit within the advertised byte limit.");
    }
    return this.#enqueue(record, async () => {
      signal?.throwIfAborted();
      beforeCommit?.();
      this.#requireRunning(input);
      this.#assertControlView(record, input.viewId);
      try { await record.pty.write(input.data); this.#activity(); }
      catch (error) {
        if (error instanceof TerminalError) throw error;
        throw new TerminalError("INPUT_UNKNOWN", "The terminal input outcome could not be confirmed.", true);
      }
    });
  }

  async resize(input: TerminalReference & { readonly cols: number; readonly rows: number; readonly viewId?: string }, signal?: AbortSignal, beforeCommit?: () => void): Promise<TerminalDescriptor> {
    const record = this.#requireRunning(input);
    const cols = integer(input.cols, 2, TERMINAL_LIMITS.maximumColumns, "Columns");
    const rows = integer(input.rows, 1, TERMINAL_LIMITS.maximumRows, "Rows");
    return this.#enqueue(record, async () => {
      signal?.throwIfAborted();
      beforeCommit?.();
      this.#requireRunning(input);
      this.#assertControlView(record, input.viewId);
      if (cols === record.descriptor.cols && rows === record.descriptor.rows) return { ...record.descriptor };
      try { await record.pty.resize(cols, rows); record.screen.resize(cols, rows); }
      catch { throw new TerminalError("RESIZE_UNKNOWN", "The terminal resize outcome could not be confirmed.", true); }
      record.descriptor = { ...record.descriptor, cols, rows, updatedAt: this.#timestamp() };
      this.#state(record);
      return { ...record.descriptor };
    });
  }

  async kill(reference: TerminalReference): Promise<TerminalDescriptor> {
    const record = this.#require(reference);
    if (record.descriptor.status === "closed") return { ...record.descriptor };
    record.acceptingInput = false;
    try { await this.#stopProcess(record); }
    catch { this.#fail(record, "KILL_UNKNOWN"); throw new TerminalError("KILL_UNKNOWN", "The terminal process stop could not be confirmed.", true); }
    return this.#enqueue(record, () => {
      record.descriptor = { ...record.descriptor, status: "closed", updatedAt: this.#timestamp() };
      this.#state(record);
      this.#disposeSubscriptions(record);
      return { ...record.descriptor };
    });
  }

  async restart(reference: TerminalReference, signal?: AbortSignal, beforeSpawn?: () => void): Promise<TerminalDescriptor> {
    const old = this.#require(reference);
    if (old.acceptingInput || old.descriptor.status === "running" || old.restarting) {
      throw new TerminalError("TERMINAL_BUSY", "Stop the terminal before restarting it.");
    }
    old.restarting = true;
    this.#activity();
    const abort = new AbortController();
    const combined = AbortSignal.any([old.lifetime.signal, abort.signal, ...(signal === undefined ? [] : [signal])]);
    const result = this.#restartRecord(old, reference, combined, beforeSpawn);
    this.#restarting.set(reference.id, { key: old.createKey, scope: old.scope, abort, result });
    try { return await result; }
    catch (error) {
      if (error instanceof TerminalError && error.stateMayHaveChanged) this.#uncertainScopes.set(reference.id, old.scope);
      throw cancelledStart(error, combined);
    }
    finally {
      if (this.#restarting.get(reference.id)?.result === result) this.#restarting.delete(reference.id);
      old.restarting = false; this.#activity();
    }
  }

  async #restartRecord(old: TerminalRecord, reference: TerminalReference, signal: AbortSignal, beforeSpawn?: () => void): Promise<TerminalDescriptor> {
    try {
      await old.queue;
      await this.#stopProcess(old);
      signal.throwIfAborted();
      const checkpoint = this.#serialize(old);
      const runtime = await this.#runtime(old.scope, signal);
      const shell = old.scope.remoteHostId === undefined ? old.shell : await this.#selectShell(runtime, old.shell.id, signal);
      const directory = await abortable(runtime.canonicalDirectory(old.scope.workspaceRoot, scopePaths(old.scope).relative(old.scope.workspaceRoot, old.descriptor.cwd)), signal);
      signal.throwIfAborted();
      this.#require(reference);
      const replacement = await this.#spawnRecord(runtime, old.scope, old.descriptor.id, old.createKey, directory, shell, old.descriptor.cols, old.descriptor.rows, old.colors.defaults(), signal, beforeSpawn);
      try {
        await abortable(writeScreen(replacement, checkpoint), signal);
        signal.throwIfAborted(); this.#require(reference);
      } catch (error) {
        await this.#discardUnpublished(replacement);
        throw error;
      }
      this.#removeRecord(old, false);
      this.#records.set(reference.id, replacement);
      this.#attach(replacement);
      return { ...replacement.descriptor };
    } finally { this.#activity(); }
  }

  async close(reference: TerminalReference): Promise<void> {
    this.#assertOpen();
    if (!this.#records.has(reference.id)) {
      const closed = this.#closedReferences.get(reference.id);
      if (closed !== undefined && closed.generation === reference.generation && sameScope(closed, reference)) return;
      throw new TerminalError("TERMINAL_NOT_FOUND", "The terminal no longer exists.");
    }
    await this.kill(reference);
    const record = this.#require(reference);
    this.#removeRecord(record, true);
    this.#closedReferences.set(reference.id, this.#reference(record));
    this.#activity();
    while (this.#closedReferences.size > 1024) this.#closedReferences.delete(this.#closedReferences.keys().next().value!);
  }

  async closeSession(sessionId: string): Promise<void> {
    identity(sessionId, "Session identity");
    const pending = [...this.#creating.values(), ...this.#restarting.values()].filter((creation) => creation.scope.sessionId === sessionId);
    for (const creation of pending) creation.abort.abort();
    const references = [...this.#records.values()].filter((record) => record.scope.sessionId === sessionId).map((record) => this.#reference(record));
    const outcomes = await Promise.allSettled(references.map((reference) => this.close(reference)));
    const pendingOutcomes = await Promise.allSettled(pending.map((creation) => creation.result));
    if (outcomes.some((outcome) => outcome.status === "rejected") || pendingOutcomes.some(unknownCleanup) || [...this.#uncertainScopes.values()].some((scope) => scope.sessionId === sessionId)) throw new TerminalError("CLEANUP_UNKNOWN", "Some terminal processes could not be closed.", true);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      if (this.#uncertainScopes.size > 0) throw new TerminalError("CLEANUP_UNKNOWN", "Some native terminal process exits remain unconfirmed.", true);
      return;
    }
    this.#disposed = true;
    const pending = [...this.#creating.values(), ...this.#restarting.values()];
    for (const creation of pending) creation.abort.abort();
    const records = [...this.#records.values()];
    const outcomes = await Promise.allSettled(records.map(async (record) => {
      record.acceptingInput = false;
      try { await this.#stopProcess(record); }
      catch (error) { this.#uncertainScopes.set(record.descriptor.id, record.scope); throw error; }
      finally { this.#removeRecord(record, true); }
    }));
    this.#closedReferences.clear();
    const pendingOutcomes = await Promise.allSettled(pending.map((creation) => creation.result));
    if (outcomes.some((outcome) => outcome.status === "rejected") || pendingOutcomes.some(unknownCleanup) || this.#uncertainScopes.size > 0) throw new TerminalError("CLEANUP_UNKNOWN", "Some terminal processes could not be stopped during shutdown.", true);
  }

  async #create(scope: TerminalScope, id: string, key: string, cwd: string, shellId: string, fallbackToDefaultShell: boolean, cols: number, rows: number, initialPalette: TerminalPalette, signal: AbortSignal, beforeSpawn?: () => void): Promise<TerminalDescriptor> {
    signal.throwIfAborted();
    const runtime = await this.#runtime(scope, signal);
    const shell = await this.#selectShell(runtime, shellId, signal, fallbackToDefaultShell);
    const directory = await abortable(runtime.canonicalDirectory(scope.workspaceRoot, cwd), signal);
    signal.throwIfAborted();
    this.#assertOpen();
    const record = await this.#spawnRecord(runtime, scope, id, key, directory, shell, cols, rows, initialPalette, signal, beforeSpawn);
    try { signal.throwIfAborted(); this.#assertOpen(); }
    catch (error) { await this.#discardUnpublished(record); throw error; }
    this.#records.set(id, record);
    this.#closedReferences.delete(id);
    this.#attach(record);
    return record.descriptor;
  }

  async #spawnRecord(runtime: TerminalRuntime, scope: TerminalScope, id: string, createKey: string, cwd: string, shell: TerminalShell, cols: number, rows: number, initialPalette: TerminalPalette, signal: AbortSignal, beforeSpawn?: () => void): Promise<TerminalRecord> {
    signal.throwIfAborted();
    // This authority check remains outside spawn error translation and has no async gap before dispatch.
    beforeSpawn?.();
    const screen = new Terminal({ cols, rows, scrollback: this.#scrollbackLines, allowProposedApi: true, logLevel: "off" });
    const serializer = new SerializeAddon();
    const colors = new TerminalColorState(initialPalette);
    screen.loadAddon(serializer);
    let pty: TerminalPty;
    try {
      pty = await runtime.spawn(shell, { cwd, cols, rows }, signal);
    } catch (error) {
      screen.dispose();
      if (error instanceof TerminalError || signal.aborted) throw error;
      throw new TerminalError("SPAWN_FAILED", "The selected terminal process could not be started.");
    }
    const timestamp = this.#timestamp();
    let notifyExit!: () => void;
    const exited = new Promise<void>((done) => { notifyExit = done; });
    const record: TerminalRecord = {
      scope: { ...scope }, createKey, shell: { ...shell, args: [...shell.args] }, pty, screen, serializer, colors,
      framer: new TerminalOutputFramer(), lifetime: new AbortController(), subscriptions: [], wake: new Set(), frames: [],
      views: new Map(), defaultViewId: undefined, controlViewId: undefined, appearanceRevision: 1, viewOrder: 0,
      descriptor: { id, sessionId: scope.sessionId, targetId: scope.targetId, generation: ++this.#generation, status: "running", exitConfirmed: false, shellId: shell.id, shellLabel: shell.label, cwd, cols, rows,
        ...(pty.pid === undefined ? {} : { pid: pty.pid }), createdAt: timestamp, updatedAt: timestamp },
      queue: Promise.resolve(), sequence: 0, retainedBytes: 0, pendingBytes: 0, bytesSinceCapacityCheck: 0,
      acceptingInput: true, outputPaused: false, processExited: false, processExitConfirmed: false, failurePending: false, exited, notifyExit, removed: false, restarting: false, streams: 0
    };
    for (const identifier of TERMINAL_COLOR_OSC_IDENTIFIERS) record.subscriptions.push(screen.parser.registerOscHandler(identifier, (data) => {
      const result = colors.consumeOsc(identifier, data);
      if (result.replies.length > 0) this.#protocol(record, result.replies.join(""));
      return result.handled;
    }));
    return record;
  }

  #localRuntime(): TerminalRuntime {
    return {
      discoverShells: this.#shells,
      canonicalDirectory,
      spawn: (shell, { cwd, cols, rows }, signal) => this.#spawn(shell.executable, [...shell.args], {
        name: "xterm-256color", cwd, cols, rows, env: { ...this.#environment },
        ...(process.platform === "win32" ? { useConpty: true, useConptyDll: true } : { encoding: "utf8" })
      }, signal)
    };
  }

  async #runtime(scope: TerminalScope, signal?: AbortSignal): Promise<TerminalRuntime> {
    signal?.throwIfAborted();
    if (scope.remoteHostId === undefined) return this.#localRuntime();
    if (this.#resolveRemoteRuntime === undefined) throw new TerminalError("RUNTIME_UNAVAILABLE", "No terminal runtime is configured for this remote host.");
    const result = this.#resolveRemoteRuntime({ ...scope }, signal);
    const runtime = await (signal === undefined ? result : abortable(result, signal));
    this.#assertOpen();
    return runtime;
  }

  async #selectShell(runtime: TerminalRuntime, shellId: string, signal: AbortSignal, fallbackToDefault = false): Promise<TerminalShell> {
    const shells = await abortable(runtime.discoverShells(), signal);
    const candidates = shells.filter((shell) => shellId === "auto" ? shell.isDefault : shell.id === shellId);
    const defaults = fallbackToDefault && shellId !== "auto" && candidates.length === 0
      ? shells.filter((shell) => shell.isDefault)
      : [];
    const selected = candidates.length === 1 ? candidates[0] : defaults.length === 1 ? defaults[0] : undefined;
    if (selected === undefined) throw new TerminalError("SHELL_UNAVAILABLE", "The selected shell is not uniquely available on the terminal host.");
    return { ...selected, args: [...selected.args] };
  }

  async #discardUnpublished(record: TerminalRecord): Promise<void> {
    record.acceptingInput = false;
    const subscription = record.pty.onExit(({ failureCode, processExitConfirmed }) => {
      record.processExited = true;
      record.processExitConfirmed ||= processExitConfirmed ?? failureCode === undefined;
      record.notifyExit();
    });
    try { await this.#stopProcess(record); }
    catch { throw new TerminalError("CLEANUP_UNKNOWN", "The cancelled terminal process exit could not be confirmed.", true); }
    finally { subscription.dispose(); this.#removeRecord(record, false); }
  }

  #attach(record: TerminalRecord): void {
    record.subscriptions.push(record.screen.onData((data) => {
      this.#protocol(record, data);
    }));
    record.subscriptions.push(record.pty.onData((data) => this.#output(record, data)));
    record.subscriptions.push(record.pty.onExit(({ exitCode, signal, failureCode, processExitConfirmed }) => {
      record.processExited = true;
      record.processExitConfirmed ||= processExitConfirmed ?? failureCode === undefined;
      record.notifyExit();
      this.#activity();
      if (!this.#current(record)) return;
      if (record.processExitConfirmed) this.#uncertainScopes.delete(record.descriptor.id);
      const wasAccepting = record.acceptingInput;
      record.acceptingInput = false;
      void this.#enqueue(record, () => {
        record.descriptor = { ...record.descriptor,
          ...(wasAccepting ? { status: failureCode === undefined ? "exited" as const : "failed" as const, exitCode,
            ...(failureCode === undefined ? {} : { failureCode }), ...(signal === undefined ? {} : { exitSignal: signal }) } : {}),
          exitConfirmed: record.processExitConfirmed, updatedAt: this.#timestamp() };
        this.#state(record);
        if (record.processExitConfirmed) this.#disposeSubscriptions(record);
      }).catch(() => undefined);
    }));
    this.#state(record);
  }

  #output(record: TerminalRecord, data: string): void {
    if (!this.#current(record) || !record.acceptingInput) return;
    if (Buffer.byteLength(data) + record.pendingBytes > MAXIMUM_PENDING_OUTPUT_BYTES) { this.#fail(record, "OUTPUT_LIMIT"); return; }
    let chunks: string[];
    try { chunks = record.framer.push(data); } catch { this.#fail(record, "OUTPUT_LIMIT"); return; }
    for (const chunk of chunks) {
      const bytes = Buffer.byteLength(chunk);
      record.pendingBytes += bytes;
      if (record.pendingBytes > PAUSE_OUTPUT_BYTES && !record.outputPaused) {
        try { record.pty.pause(); record.outputPaused = true; } catch { this.#fail(record, "OUTPUT_FLOW_FAILED"); return; }
      }
      void this.#enqueue(record, async () => {
        try {
          const previousColors = record.colors.replayColors();
          await writeScreen(record, chunk);
          if (!this.#current(record)) return;
          record.bytesSinceCapacityCheck += bytes;
          if (record.bytesSinceCapacityCheck >= 256 * 1024) {
            record.bytesSinceCapacityCheck = 0;
            this.#serialize(record);
          }
          const display = terminalDisplayOutput(chunk);
          const activeColorOverrides = record.colors.replayColors();
          if (display.length > 0) this.#publish(record, { kind: "output", terminalId: record.descriptor.id, generation: record.descriptor.generation, sequence: ++record.sequence, data: display,
            appearanceRevision: record.appearanceRevision, ...(activeColorOverrides === previousColors ? {} : { activeColorOverrides }) }, Buffer.byteLength(display) + (activeColorOverrides === previousColors ? 0 : Buffer.byteLength(activeColorOverrides)));
        } finally {
          record.pendingBytes -= bytes;
          if (this.#current(record) && record.outputPaused && record.pendingBytes < RESUME_OUTPUT_BYTES) {
            record.outputPaused = false;
            try { record.pty.resume(); } catch { this.#fail(record, "OUTPUT_FLOW_FAILED"); }
          }
        }
      }).catch(() => { if (this.#current(record)) this.#fail(record, "OUTPUT_LIMIT"); });
    }
  }

  #state(record: TerminalRecord): void {
    this.#publish(record, { kind: "state", terminalId: record.descriptor.id, generation: record.descriptor.generation, sequence: ++record.sequence, terminal: { ...record.descriptor }, appearanceRevision: record.appearanceRevision }, 512);
    this.#activity();
  }

  #publish(record: TerminalRecord, frame: TerminalFrame, bytes: number): void {
    if (!this.#current(record)) return;
    record.frames.push({ frame, bytes });
    record.retainedBytes += bytes;
    while (record.frames.length > this.#maximumOutputFrames || record.retainedBytes > this.#maximumOutputBytes) {
      record.retainedBytes -= record.frames.shift()!.bytes;
    }
    for (const wake of record.wake) wake();
  }

  #enqueue<T>(record: TerminalRecord, action: () => T | Promise<T>): Promise<T> {
    const next = record.queue.then(() => {
      if (!this.#current(record)) throw new TerminalError("GENERATION_MISMATCH", "The terminal runtime changed before the operation finished.");
      return action();
    });
    record.queue = next.catch(() => undefined);
    return next;
  }

  #snapshot(record: TerminalRecord): TerminalSnapshot {
    return { terminal: { ...record.descriptor }, sequence: record.sequence, serialized: this.#serialize(record), activeColorOverrides: record.colors.replayColors(), appearanceRevision: record.appearanceRevision };
  }

  #serialize(record: TerminalRecord): string {
    const serialized = record.colors.replayColors() + record.serializer.serialize({ scrollback: this.#scrollbackLines });
    if (Buffer.byteLength(serialized) > TERMINAL_LIMITS.maximumSnapshotBytes) {
      throw new TerminalError("OUTPUT_LIMIT", "The terminal screen exceeds the bounded snapshot limit.");
    }
    return serialized;
  }

  #protocol(record: TerminalRecord, data: string): void {
    if (!this.#current(record) || !record.acceptingInput) return;
    try { void Promise.resolve(record.pty.write(data)).catch(() => this.#fail(record, "PROTOCOL_RESPONSE_FAILED")); }
    catch { this.#fail(record, "PROTOCOL_RESPONSE_FAILED"); }
  }

  #assertControlView(record: TerminalRecord, viewId: string | undefined): void {
    if (viewId === undefined) return;
    identity(viewId, "Terminal view identity");
    const view = record.views.get(viewId);
    if (view === undefined || !view.live || record.controlViewId !== viewId) {
      throw new TerminalError("VIEW_CONTROL_REQUIRED", "The terminal view does not own interactive control.");
    }
  }

  async *#stream(input: TerminalStreamInput, signal: AbortSignal, beforeCommit?: () => void): AsyncGenerator<TerminalFrame> {
    const record = this.#require(input);
    if (record.streams >= TERMINAL_LIMITS.maximumStreamsPerTerminal) throw new TerminalError("STREAM_LIMIT", "Too many clients are watching this terminal.");
    let cursor = input.afterSequence;
    if (cursor !== undefined) integer(cursor, 0, Number.MAX_SAFE_INTEGER, "Output cursor");
    if (cursor !== undefined && cursor > record.sequence) throw new TerminalError("CURSOR_INVALID", "The output cursor is ahead of this terminal.");
    record.streams += 1;
    const appearance = input.appearance;
    const view: TerminalViewLease = { id: appearance.viewId, palette: appearance.palette, revision: appearance.viewRevision,
      parameters: JSON.stringify([appearance.palette, false, 0]), attached: ++record.viewOrder, focused: 0, live: true };
    const release = (): void => {
      if (!view.live) return;
      view.live = false;
      if (record.views.get(view.id) !== view) return;
      record.views.delete(view.id);
      void this.#enqueue(record, () => {
        if (record.controlViewId === view.id) record.controlViewId = undefined;
        if (record.defaultViewId === view.id) this.#useViewDefaults(record, this.#remainingView(record));
      }).catch(() => undefined);
    };
    signal.addEventListener("abort", release, { once: true });
    try {
    await this.#enqueue(record, () => {
      signal.throwIfAborted(); beforeCommit?.();
      if (!view.live || record.restarting) throw new TerminalError("VIEW_UNAVAILABLE", "The terminal view cannot attach to this generation.");
      if (record.views.has(view.id)) throw new TerminalError("VIEW_REVISION_CONFLICT", "The terminal view already has an active stream.");
      record.views.set(view.id, view);
      const previousSequence = record.sequence;
      if (record.defaultViewId === undefined) this.#useViewDefaults(record, view);
      if (record.sequence === previousSequence) this.#state(record);
    });
    for (;;) {
      if (signal.aborted) return;
      this.#require(input);
      await record.queue;
      if (signal.aborted) return;
      this.#require(input);
      if (cursor !== undefined && cursor > record.sequence) throw new TerminalError("CURSOR_INVALID", "The output cursor is ahead of this terminal.");
      const oldest = record.frames[0]?.frame.sequence ?? record.sequence + 1;
      if (cursor === undefined || cursor < oldest - 1) {
        const snapshot = await this.snapshot(input);
        cursor = snapshot.sequence;
        yield { kind: "reset", terminalId: input.id, generation: input.generation, sequence: cursor, terminal: snapshot.terminal, serialized: snapshot.serialized, activeColorOverrides: snapshot.activeColorOverrides, appearanceRevision: snapshot.appearanceRevision };
        continue;
      }
      const frame = record.frames.find((entry) => entry.frame.sequence > cursor!)?.frame;
      if (frame !== undefined) {
        cursor = frame.sequence;
        yield frame;
        continue;
      }
      if (record.descriptor.status !== "running" && record.processExitConfirmed) return;
      await waitForOutput(record, signal);
    }
    } finally { signal.removeEventListener("abort", release); release(); record.streams -= 1; }
  }

  #fail(record: TerminalRecord, code: string): void {
    if (!this.#current(record) || record.failurePending || record.descriptor.status === "failed") return;
    record.failurePending = true;
    record.acceptingInput = false;
    void this.#stopProcess(record).catch(() => undefined);
    void this.#enqueue(record, () => {
      record.descriptor = { ...record.descriptor, status: "failed", failureCode: code, updatedAt: this.#timestamp() };
      this.#state(record);
    }).catch(() => undefined);
  }

  async #stopProcess(record: TerminalRecord): Promise<void> {
    if (record.processExited) {
      if (!record.processExitConfirmed) throw new TerminalError("CLEANUP_UNKNOWN", "The native terminal process did not confirm exit.", true);
      return;
    }
    await record.pty.kill();
    if (record.processExited) {
      if (!record.processExitConfirmed) throw new TerminalError("CLEANUP_UNKNOWN", "The native terminal process did not confirm exit.", true);
      return;
    }
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new TerminalError("KILL_UNKNOWN", "The terminal process did not confirm exit.", true)), 2000);
      void record.exited.then(() => { clearTimeout(timer); done(); });
    });
    if (!record.processExitConfirmed) throw new TerminalError("CLEANUP_UNKNOWN", "The native terminal process did not confirm exit.", true);
  }

  #removeRecord(record: TerminalRecord, removeMapEntry: boolean): void {
    record.removed = true;
    record.acceptingInput = false;
    record.lifetime.abort();
    this.#disposeSubscriptions(record);
    record.screen.dispose();
    for (const wake of record.wake) wake();
    record.frames.length = 0;
    if (removeMapEntry && this.#records.get(record.descriptor.id) === record) this.#records.delete(record.descriptor.id);
  }

  #disposeSubscriptions(record: TerminalRecord): void {
    for (const subscription of record.subscriptions.splice(0)) subscription.dispose();
  }

  #require(reference: TerminalReference): TerminalRecord {
    this.#assertOpen();
    validateScope(reference);
    const record = this.#records.get(reference.id);
    if (record === undefined) throw new TerminalError("TERMINAL_NOT_FOUND", "The terminal no longer exists.");
    this.#assertScope(record, reference);
    if (reference.generation !== record.descriptor.generation) throw new TerminalError("GENERATION_MISMATCH", "The terminal generation is stale.");
    return record;
  }

  #requireRunning(reference: TerminalReference): TerminalRecord {
    const record = this.#require(reference);
    if (!record.acceptingInput || record.descriptor.status !== "running") throw new TerminalError("TERMINAL_EXITED", "This terminal no longer accepts input.");
    return record;
  }

  #assertScope(record: TerminalRecord, scope: TerminalScope): void {
    if (!sameScope(record.scope, scope)) throw new TerminalError("TERMINAL_SCOPE_MISMATCH", "The terminal belongs to a different task or workspace.");
  }

  #reference(record: TerminalRecord): TerminalReference {
    return { ...record.scope, id: record.descriptor.id, generation: record.descriptor.generation };
  }

  #current(record: TerminalRecord): boolean { return !this.#disposed && !record.removed && this.#records.get(record.descriptor.id) === record; }
  #activity(): void { try { this.#onActivity?.(); } catch { /* Activity observation cannot change process ownership. */ } }
  #timestamp(): string { return new Date(this.#now()).toISOString(); }
  #assertOpen(): void { if (this.#disposed) throw new TerminalError("PROVIDER_CLOSED", "The terminal provider has shut down."); }
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TerminalError("INVALID_ARGUMENT", `${label} is outside the supported range.`);
  return value;
}

function validatedAppearance(value: TerminalViewAppearance): TerminalViewAppearance {
  if (value === undefined) throw new TerminalError("INVALID_ARGUMENT", "A live terminal view appearance is required.");
  identity(value.viewId, "View identity");
  integer(value.viewRevision, 1, Number.MAX_SAFE_INTEGER, "View revision");
  return { viewId: value.viewId, viewRevision: value.viewRevision, palette: copyTerminalPalette(value.palette) };
}

function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TerminalError("INVALID_ARGUMENT", `${label} is invalid.`);
}

function validateScope(scope: TerminalScope): void {
  identity(scope.sessionId, "Session identity");
  identity(scope.targetId, "Target identity");
  if (scope.remoteHostId !== undefined) identity(scope.remoteHostId, "Remote host identity");
  if (scope.remoteHostTargetId !== undefined) identity(scope.remoteHostTargetId, "Remote host Target identity");
  if (scope.remoteHostId === undefined && scope.remoteHostTargetId !== undefined) throw new TerminalError("INVALID_ARGUMENT", "Remote Host Target requires a Remote Host.");
  if (typeof scope.workspaceRoot !== "string" || !scopePaths(scope).isAbsolute(scope.workspaceRoot) || scope.workspaceRoot.includes("\0")) throw new TerminalError("WORKSPACE_PATH_DENIED", "A canonical workspace root is required.");
}

function sameScope(left: TerminalScope, right: TerminalScope): boolean {
  return left.sessionId === right.sessionId && left.targetId === right.targetId
    && left.remoteHostTargetId === right.remoteHostTargetId && left.remoteHostId === right.remoteHostId
    && scopePaths(left).relative(left.workspaceRoot, right.workspaceRoot) === "";
}

function scopePaths(scope: TerminalScope): Pick<typeof posix, "resolve" | "relative" | "isAbsolute"> {
  return scope.remoteHostId === undefined ? { resolve, relative, isAbsolute } : posix;
}

async function canonicalDirectory(root: string, cwd: string): Promise<string> {
  try {
    const rootInfo = await lstat(root);
    const canonicalRoot = await realpath(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || relative(root, canonicalRoot) !== "") throw new Error();
    const candidate = resolve(root, cwd);
    const relativeCandidate = relative(root, candidate);
    if (relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`) || isAbsolute(relativeCandidate)) throw new Error();
    const info = await lstat(candidate);
    const canonical = await realpath(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(candidate, canonical) !== "") throw new Error();
    return canonical;
  } catch { throw new TerminalError("WORKSPACE_PATH_DENIED", "The initial terminal directory is not a canonical directory inside the workspace."); }
}

function waitForOutput(record: TerminalRecord, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((done) => {
    const wake = () => { signal.removeEventListener("abort", wake); record.wake.delete(wake); done(); };
    record.wake.add(wake);
    signal.addEventListener("abort", wake, { once: true });
  });
}

function writeScreen(record: TerminalRecord, data: string): Promise<void> {
  const signal = record.lifetime.signal;
  if (signal.aborted) return Promise.reject(new TerminalError("GENERATION_MISMATCH", "The terminal runtime has ended."));
  return new Promise<void>((done, reject) => {
    const aborted = () => reject(new TerminalError("GENERATION_MISMATCH", "The terminal runtime ended while parsing output."));
    signal.addEventListener("abort", aborted, { once: true });
    record.screen.write(data, () => { signal.removeEventListener("abort", aborted); done(); });
  });
}

function abortable<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void result.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise((done, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void result.then(done, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function unknownCleanup(result: PromiseSettledResult<unknown>): boolean {
  return result.status === "rejected" && result.reason instanceof TerminalError && result.reason.stateMayHaveChanged;
}

function cancelledStart(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof TerminalError && error.stateMayHaveChanged) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return new TerminalError("ABORTED", "Terminal startup was cancelled and its process cleanup is confirmed.");
  return error;
}
