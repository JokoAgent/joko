import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { NotFoundError, StoreClosedError, type OperationalStore, type StoredSession } from "@joko/store";
import { TERMINAL_LIMITS, TerminalError, copyTerminalPalette, type TerminalDescriptor, type TerminalProvider, type TerminalReference, type TerminalScope, type TerminalViewAppearance } from "@joko/tool-terminal";

interface TerminalServiceDependencies {
  readonly terminals?: TerminalProvider;
  readonly store: OperationalStore;
  readonly effectiveTarget?: (session: StoredSession) => { readonly workspaceRoot: string };
  readonly authenticate: (context: HandlerContext) => { readonly id: string };
  readonly onRevoked: (connectionId: string, callback: () => void) => () => void;
  readonly registerCleanup?: (callback: () => void) => unknown;
}

interface MutationMemo {
  readonly parameters: string;
  readonly result: Promise<TerminalDescriptor>;
}

class ConfirmedTerminalStartFailure extends Error {
  constructor(readonly original: unknown) { super("The terminal start did not leave an active process."); }
}

/** This boundary deliberately uses no Operation, Event, setting or log for terminal bytes. */
export function createTerminalConnectService(dependencies: TerminalServiceDependencies): ServiceImpl<typeof contract.TerminalService> {
  const mutations = new Map<string, MutationMemo>();
  const writers = new Map<string, { next: bigint; uncertain: boolean; tail: Promise<void> }>();
  const views = new Map<string, { readonly token: string; readonly abort: AbortController }>();
  let pendingInputBytes = 0;
  dependencies.registerCleanup?.(() => { for (const view of views.values()) view.abort.abort(); views.clear(); mutations.clear(); writers.clear(); });

  const provider = (): TerminalProvider => {
    if (dependencies.terminals === undefined) throw new ConnectError("Interactive terminals are unavailable.", Code.Unimplemented);
    return dependencies.terminals;
  };
  const scope = (sessionId: string, mutate = false): TerminalScope => {
    identity(sessionId, "session_id");
    const session = dependencies.store.getSession(sessionId);
    if (session.descriptor.archived || session.descriptor.deletedAt !== undefined
      || dependencies.store.findPendingSessionLifecycleCleanup(sessionId) !== undefined) {
      throw new ConnectError("This task is closing or no longer active.", Code.FailedPrecondition);
    }
    if (mutate && dependencies.store.findSessionRuntimePolicy(sessionId)?.policy === "review_read_only") {
      throw new ConnectError("This task only permits review reads.", Code.PermissionDenied);
    }
    const target = dependencies.effectiveTarget?.(session)
      ?? dependencies.store.getTarget(session.descriptor.targetId).descriptor;
    const remote = session.descriptor.remoteWorkspace;
    const registeredRemote = dependencies.store.getTarget(session.descriptor.targetId).descriptor.remoteWorkspace;
    if (remote?.hostId !== registeredRemote?.hostId || remote?.workspaceRoot !== registeredRemote?.workspaceRoot) {
      throw new ConnectError("The task workspace changed during the terminal request.", Code.Aborted);
    }
    if (remote !== undefined) {
      const worktree = session.descriptor.worktree;
      if (worktree !== undefined && worktree.state !== "active") throw new ConnectError("The task workspace is no longer active.", Code.FailedPrecondition);
      return { sessionId, targetId: session.descriptor.targetId, remoteHostId: remote.hostId, workspaceRoot: worktree?.path ?? remote.workspaceRoot };
    }
    return { sessionId, targetId: session.descriptor.targetId, workspaceRoot: target.workspaceRoot };
  };
  const reference = (request: { sessionId: string; terminalId: string; generation: bigint }, mutate = false, observe = false): TerminalReference => {
    const current = scope(request.sessionId, mutate);
    identity(request.terminalId, "terminal_id");
    const generation = safeInteger(request.generation, observe ? 0 : 1, "generation");
    if (generation > 0) return { ...current, id: request.terminalId, generation };
    const terminal = provider().list(current).find((item) => item.id === request.terminalId);
    if (terminal === undefined) throw new ConnectError("The terminal no longer exists.", Code.NotFound);
    return { ...current, id: terminal.id, generation: terminal.generation };
  };
  const fence = (context: HandlerContext, initial: TerminalScope, mutate = false): void => {
    dependencies.authenticate(context);
    if (context.signal.aborted) throw new ConnectError("Terminal request cancelled.", Code.Canceled);
    const current = scope(initial.sessionId, mutate);
    if (current.targetId !== initial.targetId || current.workspaceRoot !== initial.workspaceRoot || current.remoteHostId !== initial.remoteHostId) {
      throw new ConnectError("The task workspace changed during the terminal request.", Code.Aborted);
    }
  };
  const mutation = (key: string, parameters: unknown, action: () => Promise<TerminalDescriptor>): Promise<TerminalDescriptor> => {
    const encoded = JSON.stringify(parameters);
    const existing = mutations.get(key);
    if (existing !== undefined) {
      if (existing.parameters !== encoded) throw new ConnectError("request_id already identifies different terminal parameters.", Code.AlreadyExists);
      return existing.result;
    }
    // Keep decisions for this service incarnation. Eviction could repeat a process creation.
    if (mutations.size >= 4096) throw new ConnectError("Terminal request capacity reached.", Code.ResourceExhausted);
    const result = action();
    mutations.set(key, { parameters: encoded, result });
    void result.catch((error: unknown) => {
      // A confirmed pre-effect failure can be retried. Unknown outcomes retain
      // their decision so a lost acknowledgement never starts another shell.
      if ((error instanceof ConfirmedTerminalStartFailure || error instanceof TerminalError && !error.stateMayHaveChanged)
        && mutations.get(key)?.result === result) mutations.delete(key);
    });
    return result;
  };
  const currentResult = (initial: TerminalScope, result: TerminalDescriptor): TerminalDescriptor => {
    const current = provider().list(initial).find((item) => item.id === result.id);
    if (current === undefined) throw new ConnectError("The terminal no longer exists.", Code.NotFound);
    if (current.generation !== result.generation) throw new ConnectError("The terminal request belongs to an earlier process generation.", Code.FailedPrecondition);
    return current;
  };
  const start = async (context: HandlerContext, initial: TerminalScope, action: (signal: AbortSignal, beforeSpawn: () => void) => Promise<TerminalDescriptor>): Promise<TerminalDescriptor> => {
    const revoked = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let attempted = false;
    try {
      const connection = dependencies.authenticate(context);
      unsubscribe = dependencies.onRevoked(connection.id, () => revoked.abort());
      fence(context, initial, true);
      attempted = true;
      const terminal = await action(AbortSignal.any([context.signal, revoked.signal]), () => {
        try {
          fence(context, initial, true);
          if (revoked.signal.aborted) throw new ConnectError("Connection revoked.", Code.Unauthenticated);
        } catch (error) { throw new ConfirmedTerminalStartFailure(error); }
      });
      try {
        fence(context, initial, true);
        if (revoked.signal.aborted) throw new ConnectError("Connection revoked.", Code.Unauthenticated);
      } catch (error) {
        await provider().close({ ...initial, id: terminal.id, generation: terminal.generation });
        throw new ConfirmedTerminalStartFailure(error);
      }
      return terminal;
    } catch (error) {
      if (!attempted) throw new ConfirmedTerminalStartFailure(error);
      throw error;
    } finally { unsubscribe?.(); }
  };

  return {
    getTerminalCapabilities: async (request, context) => rpc(async () => {
      dependencies.authenticate(context);
      const limits = { maximumTerminals: TERMINAL_LIMITS.maximumTerminals, maximumInputBytes: TERMINAL_LIMITS.maximumInputBytes,
        maximumColumns: TERMINAL_LIMITS.maximumColumns, maximumRows: TERMINAL_LIMITS.maximumRows };
      let initial: TerminalScope | undefined;
      if (request.sessionId !== "") {
        const session = dependencies.store.getSession(identity(request.sessionId, "session_id"));
        const reason = dependencies.store.findSessionRuntimePolicy(request.sessionId)?.policy === "review_read_only" ? "This task only permits review reads."
          : session.descriptor.archived || session.descriptor.deletedAt !== undefined || dependencies.store.findPendingSessionLifecycleCleanup(request.sessionId) !== undefined ? "This task is closing or no longer active." : "";
        if (reason !== "") return create(contract.GetTerminalCapabilitiesResponseSchema, { ...limits, support: contract.CapabilitySupport.DISABLED_BY_POLICY, reason });
        initial = scope(request.sessionId);
      }
      if (dependencies.terminals === undefined) return create(contract.GetTerminalCapabilitiesResponseSchema, { ...limits, support: contract.CapabilitySupport.PLATFORM_LIMITED, reason: "Interactive terminals are unavailable." });
      let shells;
      try { shells = await provider().discoverShells(initial, context.signal); }
      catch (error) {
        dependencies.authenticate(context);
        if (initial !== undefined) fence(context, initial, true);
        if (!(error instanceof TerminalError) || error.code !== "RUNTIME_UNAVAILABLE") throw error;
        return create(contract.GetTerminalCapabilitiesResponseSchema, { ...limits, support: contract.CapabilitySupport.PLATFORM_LIMITED,
          reason: "Connect the task host and ensure an interactive shell is available." });
      }
      dependencies.authenticate(context);
      if (initial !== undefined) fence(context, initial, true);
      return create(contract.GetTerminalCapabilitiesResponseSchema, {
        ...limits,
        support: shells.length === 0 ? contract.CapabilitySupport.PLATFORM_LIMITED : contract.CapabilitySupport.SUPPORTED,
        reason: shells.length === 0 ? "No interactive shell is available on this service host." : "",
        shells: shells.map((shell) => ({ id: shell.id, label: shell.label })),
        defaultShellId: shells.find((shell) => shell.isDefault)?.id ?? ""
      });
    }),
    listTerminals: async (request, context) => rpc(async () => {
      dependencies.authenticate(context);
      return create(contract.ListTerminalsResponseSchema, { terminals: provider().list(scope(request.sessionId)).map(toTerminal) });
    }),
    createTerminal: async (request, context) => rpc(async () => {
      dependencies.authenticate(context);
      identity(request.requestId, "request_id");
      const initial = scope(request.sessionId, true);
      const initialPalette = copyTerminalPalette(request.initialPalette!);
      const terminal = await mutation(JSON.stringify([request.sessionId, "create", request.requestId]), [initial, request.shellId, request.columns, request.rows, initialPalette],
        () => start(context, initial, (signal, beforeSpawn) => provider().create({ ...initial, initialPalette, id: randomUUID(),
          ...(request.shellId === "" ? {} : { shellId: request.shellId }),
          ...(request.columns === 0 ? {} : { cols: request.columns }), ...(request.rows === 0 ? {} : { rows: request.rows }) }, signal, beforeSpawn)));
      fence(context, initial, true);
      return create(contract.CreateTerminalResponseSchema, { terminal: toTerminal(currentResult(initial, terminal)) });
    }),
    getTerminal: async (request, context) => rpc(async () => {
      dependencies.authenticate(context);
      const initial = reference(request, false, true);
      const snapshot = await provider().snapshot(initial);
      fence(context, initial);
      return create(contract.GetTerminalResponseSchema, { terminal: toTerminal(snapshot.terminal), sequence: BigInt(snapshot.sequence), serialized: snapshot.serialized, activeColorOverrides: snapshot.activeColorOverrides, appearanceRevision: BigInt(snapshot.appearanceRevision) });
    }),
    watchTerminal: async function* (request, context) {
      let unsubscribe: (() => void) | undefined;
      let release: (() => void) | undefined;
      try {
        const connection = dependencies.authenticate(context);
        const initial = reference(request);
        const appearance = viewAppearance(request.appearance);
        const key = JSON.stringify([connection.id, initial.sessionId, initial.id, initial.generation, appearance.viewId]);
        if (views.has(key)) throw new ConnectError("The terminal view is already watching.", Code.AlreadyExists);
        if (views.size >= TERMINAL_LIMITS.maximumTerminals * TERMINAL_LIMITS.maximumStreamsPerTerminal) throw new ConnectError("Terminal view capacity reached.", Code.ResourceExhausted);
        const view = { token: randomUUID(), abort: new AbortController() };
        views.set(key, view);
        release = () => { view.abort.abort(); if (views.get(key) === view) views.delete(key); };
        const signal = AbortSignal.any([context.signal, view.abort.signal]);
        context.signal.addEventListener("abort", release, { once: true });
        const remove = release;
        release = () => { context.signal.removeEventListener("abort", remove); remove(); };
        unsubscribe = dependencies.onRevoked(connection.id, remove);
        const current = (): void => {
          fence(context, initial);
          if (signal.aborted || views.get(key) !== view || dependencies.authenticate(context).id !== connection.id) throw new ConnectError("Terminal view retired.", Code.Canceled);
        };
        current();
        for await (const frame of provider().stream({ ...initial, appearance: { ...appearance, viewId: view.token },
          ...(request.afterSequence === undefined ? {} : { afterSequence: safeInteger(request.afterSequence, 0, "after_sequence") }) }, signal, current)) {
          current();
          yield create(contract.WatchTerminalResponseSchema, { sequence: BigInt(frame.sequence), appearanceRevision: BigInt(frame.appearanceRevision),
            ...(frame.activeColorOverrides === undefined ? {} : { activeColorOverrides: frame.activeColorOverrides }),
            ...(frame.kind === "output" ? { kind: contract.TerminalUpdateKind.OUTPUT, data: frame.data }
              : { kind: frame.kind === "reset" ? contract.TerminalUpdateKind.RESET : contract.TerminalUpdateKind.STATE,
                terminal: toTerminal(frame.terminal), data: frame.kind === "reset" ? frame.serialized : "" }) });
        }
        dependencies.authenticate(context);
      } catch (error) { throw publicError(error); }
      finally { release?.(); unsubscribe?.(); }
    },
    updateTerminalAppearance: async (request, context) => rpc(async () => {
      const connection = dependencies.authenticate(context);
      const initial = reference(request, true);
      const appearance = viewAppearance(request.appearance);
      const key = JSON.stringify([connection.id, initial.sessionId, initial.id, initial.generation, appearance.viewId]);
      const view = views.get(key);
      if (view === undefined) throw new ConnectError("This terminal view is no longer watching.", Code.FailedPrecondition);
      const signal = AbortSignal.any([context.signal, view.abort.signal]);
      const current = (): void => {
        fence(context, initial, true);
        if (signal.aborted || views.get(key) !== view || dependencies.authenticate(context).id !== connection.id) throw new ConnectError("Terminal view retired.", Code.Canceled);
      };
      current();
      const result = await provider().updateAppearance({ ...initial, appearance: { ...appearance, viewId: view.token },
        claimFocus: request.claimFocus, expectedAppearanceRevision: safeInteger(request.expectedAppearanceRevision, request.claimFocus ? 1 : 0, "expected_appearance_revision") }, signal, current);
      current();
      return create(contract.UpdateTerminalAppearanceResponseSchema, { accepted: result.accepted, acceptedViewRevision: BigInt(result.acceptedViewRevision),
        appearanceRevision: BigInt(result.appearanceRevision), ownsDefaults: result.ownsDefaults });
    }),
    writeTerminal: async (request, context) => rpc(async () => {
      const connection = dependencies.authenticate(context);
      const initial = reference(request, true);
      identity(request.writerId, "writer_id");
      safeInteger(request.inputSequence, 1, "input_sequence");
      const bytes = Buffer.byteLength(request.data);
      if (request.data.length === 0 || bytes > TERMINAL_LIMITS.maximumInputBytes) {
        throw new ConnectError("Terminal input exceeds the advertised limits.", Code.InvalidArgument);
      }
      const key = JSON.stringify([connection.id, initial.sessionId, initial.id, initial.generation, request.writerId]);
      let writer = writers.get(key);
      if (writer === undefined) {
        if (writers.size >= 4096) throw new ConnectError("Terminal writer capacity reached.", Code.ResourceExhausted);
        writer = { next: 1n, uncertain: false, tail: Promise.resolve() };
        writers.set(key, writer);
      }
      if (pendingInputBytes + bytes > 1024 * 1024) throw new ConnectError("Terminal input is arriving faster than it can be delivered.", Code.ResourceExhausted);
      pendingInputBytes += bytes;
      const currentWriter = writer;
      const revoked = new AbortController();
      const unsubscribe = dependencies.onRevoked(connection.id, () => revoked.abort());
      const result = currentWriter.tail.then(async () => {
        if (currentWriter.uncertain) throw new ConnectError("Terminal input outcome is unknown. Reconnect before sending new input.", Code.FailedPrecondition);
        if (request.inputSequence > currentWriter.next) throw new ConnectError("Terminal input arrived out of order.", Code.FailedPrecondition);
        fence(context, initial, true);
        const terminal = provider().list(initial).find((item) => item.id === initial.id);
        if (terminal?.generation !== initial.generation) throw new ConnectError("The terminal generation is no longer current.", Code.FailedPrecondition);
        if (request.inputSequence === currentWriter.next) {
          try { await provider().input({ ...initial, data: request.data }, AbortSignal.any([context.signal, revoked.signal])); }
          catch (error) { if (error instanceof TerminalError && error.stateMayHaveChanged) currentWriter.uncertain = true; throw error; }
          currentWriter.next += 1n;
        }
        fence(context, initial, true);
        return create(contract.WriteTerminalResponseSchema, { nextInputSequence: currentWriter.next });
      });
      currentWriter.tail = result.then(() => undefined, () => undefined);
      try { return await result; } finally { pendingInputBytes -= bytes; unsubscribe(); }
    }),
    resizeTerminal: async (request, context) => rpc(async () => {
      const connection = dependencies.authenticate(context);
      const initial = reference(request, true);
      const revoked = new AbortController();
      const unsubscribe = dependencies.onRevoked(connection.id, () => revoked.abort());
      try {
        fence(context, initial, true);
        const terminal = await provider().resize({ ...initial, cols: request.columns, rows: request.rows }, AbortSignal.any([context.signal, revoked.signal]), () => fence(context, initial, true));
        fence(context, initial, true);
        return create(contract.ResizeTerminalResponseSchema, { terminal: toTerminal(terminal) });
      } finally { unsubscribe(); }
    }),
    restartTerminal: async (request, context) => rpc(async () => {
      dependencies.authenticate(context);
      identity(request.requestId, "request_id");
      const initial = reference(request, true);
      const terminal = await mutation(JSON.stringify([request.sessionId, "restart", request.requestId]), initial,
        () => start(context, initial, (signal, beforeSpawn) => provider().restart(initial, signal, beforeSpawn)));
      fence(context, initial, true);
      return create(contract.RestartTerminalResponseSchema, { terminal: toTerminal(currentResult(initial, terminal)) });
    }),
    closeTerminal: async (request, context) => rpc(async () => {
      dependencies.authenticate(context);
      const initial = reference(request);
      fence(context, initial);
      await provider().close(initial);
      return create(contract.CloseTerminalResponseSchema);
    })
  };
}

function toTerminal(terminal: TerminalDescriptor): contract.Terminal {
  const status = { running: contract.TerminalStatus.RUNNING, exited: contract.TerminalStatus.EXITED,
    failed: contract.TerminalStatus.FAILED, closed: contract.TerminalStatus.CLOSED }[terminal.status];
  return create(contract.TerminalSchema, { id: terminal.id, sessionId: terminal.sessionId, targetId: terminal.targetId,
    generation: BigInt(terminal.generation), status, shellId: terminal.shellId, shellLabel: terminal.shellLabel,
    cwd: terminal.cwd, columns: terminal.cols, rows: terminal.rows, exitConfirmed: terminal.exitConfirmed,
    failureCode: terminal.failureCode ?? "",
    ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
    ...(terminal.exitSignal === undefined ? {} : { exitSignal: terminal.exitSignal }),
    createdAt: timestampFromDate(new Date(terminal.createdAt)), updatedAt: timestampFromDate(new Date(terminal.updatedAt)) });
}

function viewAppearance(value: contract.TerminalViewAppearance | undefined): TerminalViewAppearance {
  if (value === undefined) throw new ConnectError("Terminal appearance is required.", Code.InvalidArgument);
  return { viewId: identity(value.viewId, "view_id"), viewRevision: safeInteger(value.viewRevision, 1, "view_revision"), palette: copyTerminalPalette(value.palette!) };
}

function identity(value: string, field: string): string {
  if (value.length === 0 || value.length > 256 || value !== value.trim() || /[\p{Cc}\u2028\u2029]/u.test(value)) {
    throw new ConnectError(`${field} is invalid.`, Code.InvalidArgument);
  }
  return value;
}

function safeInteger(value: bigint, minimum: number, field: string): number {
  if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError(`${field} is out of range.`, Code.InvalidArgument);
  return Number(value);
}

async function rpc<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw publicError(error); }
}

function publicError(error: unknown): ConnectError {
  if (error instanceof ConfirmedTerminalStartFailure) return publicError(error.original);
  if (error instanceof ConnectError) return error;
  if (error instanceof NotFoundError) return new ConnectError("The requested task or terminal was not found.", Code.NotFound);
  if (error instanceof StoreClosedError) return new ConnectError("Terminal authority is unavailable.", Code.Unavailable);
  if (error instanceof TerminalError) {
    if (error.code === "VIEW_REVISION_CONFLICT") return new ConnectError("Terminal view revision was reused with different parameters.", Code.AlreadyExists);
    if (error.code === "VIEW_UNAVAILABLE" || error.code === "VIEW_REVISION_STALE") return new ConnectError("Terminal view is no longer current.", Code.FailedPrecondition);
    if (error.code === "ABORTED") return new ConnectError("Terminal request cancelled.", Code.Canceled);
    if (error.code === "TERMINAL_NOT_FOUND") return new ConnectError("The terminal no longer exists.", Code.NotFound);
    if (error.code === "RUNTIME_UNAVAILABLE") return new ConnectError("Connect the task host and ensure an interactive shell is available.", Code.Unimplemented);
    if (["INVALID_ARGUMENT", "INPUT_LIMIT", "WORKSPACE_PATH_DENIED"].includes(error.code)) return new ConnectError("Terminal request parameters are invalid.", Code.InvalidArgument);
    if (error.code === "TERMINAL_LIMIT") return new ConnectError("Close an existing terminal before creating another.", Code.ResourceExhausted);
    if (error.stateMayHaveChanged) return new ConnectError("The terminal operation outcome is unknown. Refresh its current state before continuing.", Code.FailedPrecondition);
    return new ConnectError("The terminal cannot perform this operation in its current state.", Code.FailedPrecondition);
  }
  if (error instanceof Error && error.name === "AbortError") return new ConnectError("Terminal request cancelled.", Code.Canceled);
  return new ConnectError("The terminal operation failed.", Code.Internal);
}
