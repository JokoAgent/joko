import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import type { CodexNativeExecutionInput, CodexNativeExecutionOptions, CodexHostedExecServerLease } from "@joko/adapter-codex";
import { redactSecrets, type AdapterContext, type NativeToolAuthorizationRequest } from "@joko/core";
import type { RemoteReverseForwardHandle } from "@joko/remote-ssh";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import { NotFoundError, type OperationalStore } from "@joko/store";
import { terminalEnvironment } from "@joko/tool-terminal";
import { HostedAgentCodexExecServerRelay, type HostedAgentCodexAction, type HostedAgentCodexAuthorization } from "./hosted-agent-codex-relay.js";
import { createCodexExecServerTunnel } from "./hosted-agent-codex-tunnel.js";
import { ExecutorWorkspace, realPathOrAncestor } from "./hosted-agent-workspace.js";
import { tightenNativeCodexFileSystemPolicy } from "./native-codex-filesystem-policy.js";
import type { RemoteExecutionRouter, RemoteWorkspaceAuthority } from "./remote-execution-router.js";

interface NativeCodexExecutionOptions {
  readonly store: Pick<OperationalStore, "getTarget" | "getSession">;
  readonly remoteExecution: Pick<RemoteExecutionRouter, "workspace">;
  readonly executable: string;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
}

/** The native engine keeps its own tools and ordinary permission controls.
 * This private environment gates their real fs/process primitives before execution. */
export function createNativeCodexExecution(options: NativeCodexExecutionOptions): CodexNativeExecutionOptions {
  return { openExecServer: input => openNativeExecServer(options, input) };
}

async function openNativeExecServer(options: NativeCodexExecutionOptions, input: CodexNativeExecutionInput): Promise<CodexHostedExecServerLease> {
  const original = input.context, target = options.store.getTarget(original.target.id), lifetime = new AbortController();
  const creationSignal = AbortSignal.any([lifetime.signal, input.signal ?? original.signal]);
  if (target.descriptor.trusted !== original.target.trusted) throw new Error("The native Target authority is stale.");
  const paths = input.pathStyle === "win32" ? win32 : posix;
  let remote: RemoteWorkspaceAuthority | undefined, forwarding: RemoteReverseForwardHandle | undefined;
  let initialSession: ReturnType<NativeCodexExecutionOptions["store"]["getSession"]> | undefined;
  try { initialSession = options.store.getSession(original.sessionId); }
  catch (error) { if (!(error instanceof NotFoundError && error.resource === "Session" && error.id === original.sessionId)) throw error; }
  let adopted = false;
  const readSession = () => {
    try {
      const record = options.store.getSession(original.sessionId), session = record.descriptor;
      if (session.targetId !== original.target.id || session.archived || session.deletedAt !== undefined) throw new Error("The native task owner changed.");
      if (session.backendId === original.target.backendId && session.binding.generation === original.generation) {
        adopted = true; return session;
      }
      // Host-issued provisional contexts also initialize a pending handoff or
      // blank recovery before atomically adopting the new native binding.
      // The exact original row grants only initialization reads until adoption.
      if (!adopted && original.binding === undefined && initialSession !== undefined && record.revision === initialSession.revision
        && session.backendId === initialSession.descriptor.backendId && session.binding.opaqueRef === initialSession.descriptor.binding.opaqueRef
        && session.binding.generation === initialSession.descriptor.binding.generation) return undefined;
      throw new Error("The native task owner changed.");
    } catch (error) {
      if (!adopted && initialSession === undefined && error instanceof NotFoundError && error.resource === "Session" && error.id === original.sessionId) return undefined;
      throw error;
    }
  };
  const assertCurrent = () => {
    creationSignal.throwIfAborted(); input.assertCurrent();
    if (options.store.getTarget(original.target.id).revision !== target.revision) throw new Error("The native Target authority changed.");
    readSession(); remote?.assertCurrent();
    if (forwarding) remote!.assertForwardingCurrent();
  };
  assertCurrent();
  if (input.remote) {
    if (!original.target.remoteWorkspace || !input.openExecServerProcess) throw new Error("The native remote executor is unavailable.");
    remote = await options.remoteExecution.workspace(original.target.remoteWorkspace, creationSignal);
    assertCurrent();
    if (remote.pathStyle !== input.pathStyle || remote.forwarding === undefined) throw new Error("The native remote forwarding authority is unavailable.");
  }
  const canonical = async (path: string, signal: AbortSignal): Promise<string> => {
    if (!remote) return realPathOrAncestor(paths.resolve(input.workspaceRoot, path));
    let current = paths.resolve(input.workspaceRoot, path);
    const rest: string[] = [];
    for (;;) {
      assertCurrent(); signal.throwIfAborted(); remote.assertFilesCurrent();
      try {
        const resolved = await remote.files.realpath(current, signal);
        assertCurrent(); remote.assertFilesCurrent(); signal.throwIfAborted();
        if (!paths.isAbsolute(resolved)) throw new Error("The native remote path is invalid.");
        return paths.join(resolved, ...rest.reverse());
      } catch (error) {
        assertCurrent(); signal.throwIfAborted();
        if (!missing(error)) throw error;
        const parent = paths.dirname(current);
        if (parent === current) throw error;
        rest.push(paths.basename(current)); current = parent;
      }
    }
  };
  const authorize = async (actions: readonly HostedAgentCodexAction[], signal: AbortSignal,
    origin?: { readonly context: AdapterContext; readonly revision?: string; readonly activeTurn: boolean }): Promise<() => void> => {
    assertCurrent(); signal.throwIfAborted();
    if (actions.length > 256) throw new Error("Too many native execution actions.");
    const context = origin?.context ?? input.currentContext(), authority = context.nativeToolAuthorization;
    if (context.sessionId !== original.sessionId || context.generation !== original.generation
      || context.target.id !== original.target.id || context.target.backendId !== original.target.backendId
      || context.backendInstanceGeneration !== original.backendInstanceGeneration) throw new Error("The native turn owner changed.");
    const active = AbortSignal.any([signal, lifetime.signal, context.signal]);
    const session = readSession();
    const fences: Array<() => void> = [];
    const assert = () => {
      assertCurrent(); active.throwIfAborted();
      if (actions.length && input.currentContext() !== context) throw new Error("The originating native turn changed.");
      if (origin) authority?.assertCurrent(origin.revision);
      for (const fence of fences) fence();
    };
    for (const action of actions) {
      // Native task initialization may load instructions before Store commits
      // the Session. It cannot execute commands, write or obtain a permission grant.
      if ((!session || origin?.activeTurn === false) && action.kind !== "read") throw new Error("The native task has no active execution owner.");
      if (!authority) throw new Error("The native tool policy owner is unavailable.");
      const revision = authority.capture();
      const fence = () => { authority.assertCurrent(revision); };
      fences.push(fence); assert();
      const path = action.kind === "exec" ? action.cwd : action.kind === "network" ? action.url : action.path;
      const resolved = action.kind === "network" ? path : await canonical(path, active);
      assert();
      const requests: NativeToolAuthorizationRequest[] = [nativeRequest(action, path, active)];
      if (resolved !== path) requests.push(nativeRequest(action, resolved, active));
      let ask = false;
      for (const request of requests) {
        const decision = await authority.review(request);
        assert();
        if (decision.unavailable || decision.verdict === "block") throw new Error("The native tool was denied by policy.");
        if (decision.verdict === "ask") ask = true;
      }
      if (ask) {
        if (!session || origin?.activeTurn === false) throw new Error("Native initialization cannot request interactive permission.");
        const request = requests[0]!;
        const decision = await context.requestInteraction({ id: randomUUID(), kind: "permission", title: "Native tool permission",
          toolName: request.toolName, summary: redactSecrets(JSON.stringify(request.input)).slice(0, 8192),
          risk: action.kind === "exec" || action.kind === "network" ? "high" : "medium", choices: ["allow_once", "deny_once"] }, { signal: active });
        assert();
        if (!(decision.kind === "confirmed" && decision.confirmed || decision.kind === "selected" && decision.value === "allow_once")) throw new Error("The native tool permission was denied.");
      }
    }
    assert(); return assert;
  };
  const relay = new HostedAgentCodexExecServerRelay({ assertCurrent, authorize, identityPaths: true, pathStyle: input.pathStyle,
    codexExecutable: options.executable, cwd: input.workspaceRoot, sessionId: original.sessionId, env: terminalEnvironment(),
    workspace: new ExecutorWorkspace({ workingDir: input.workspaceRoot,
      ...(input.remote ? { remote: { pathStyle: input.pathStyle, home: input.workspaceRoot, temporary: input.workspaceRoot } } : {}) }),
    ...(input.openExecServerProcess ? { openProcess: input.openExecServerProcess } : {}),
    ...(options.commandConcurrencyGate ? { commandConcurrencyGate: options.commandConcurrencyGate } : {}) });
  let tunnel: CodexHostedExecServerLease | undefined;
  const cleanup = async () => {
    lifetime.abort();
    const results = await Promise.allSettled([forwarding?.close() ?? Promise.resolve(), tunnel?.close() ?? Promise.resolve(), relay.close()]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Native execution cleanup is unconfirmed.");
  };
  try {
    tunnel = await createCodexExecServerTunnel<HostedAgentCodexAuthorization>({ assertCurrent, capture: () => {
      assertCurrent();
      const context = input.currentContext(), revision = context.nativeToolAuthorization?.capture(), activeTurn = input.hasActiveTurn?.() ?? true;
      const assertOwner = () => {
        assertCurrent(); context.signal.throwIfAborted();
        if (input.currentContext() !== context) throw new Error("The originating native turn changed.");
        context.nativeToolAuthorization?.assertCurrent(revision);
      };
      assertOwner();
      return { assertCurrent: assertOwner,
        authorize: (actions, signal) => authorize(actions, signal, { context, activeTurn, ...(revision === undefined ? {} : { revision }) }),
        prepareParams: async (method, params, actions, signal) => {
          assertOwner(); signal.throwIfAborted();
          const snapshot = context.nativeToolAuthorization?.snapshot?.() ?? context.policySnapshot;
          const prepared = snapshot === undefined ? params : await tightenNativeCodexFileSystemPolicy({ snapshot, method, params, actions,
            pathStyle: input.pathStyle, enforcement: "native-os-sandbox", canonicalize: path => canonical(path, signal),
            assertCurrent: () => { assertOwner(); signal.throwIfAborted(); } });
          assertOwner(); signal.throwIfAborted(); return prepared;
        } };
    }, execute: (request, signal, owner) => {
      const { origin: _origin, ...primitive } = request;
      if ((primitive.payload as { kind: string }).kind === "message" && !owner) throw new Error("The native message owner is unavailable.");
      return relay.execute(primitive, signal, owner);
    } });
    assertCurrent();
    let execServerUrl = tunnel.execServerUrl;
    if (remote) {
      remote.assertForwardingCurrent();
      const local = new URL(execServerUrl);
      forwarding = await remote.forwarding!.listen({ localDestinationHost: "127.0.0.1", localDestinationPort: Number(local.port),
        remoteListenHost: "127.0.0.1", signal: creationSignal });
      assertCurrent();
      if (!["127.0.0.1", "::1"].includes(forwarding.remoteHost) || !Number.isInteger(forwarding.remotePort)
        || forwarding.remotePort < 1 || forwarding.remotePort > 65535) throw new Error("The native remote listener is invalid.");
      execServerUrl = `ws://${forwarding.remoteHost === "::1" ? "[::1]" : forwarding.remoteHost}:${forwarding.remotePort}/ws/exec-server`;
    }
    let closing: Promise<void> | undefined;
    return { execServerUrl, authBearerToken: tunnel.authBearerToken, assertCurrent,
      close: () => {
        if (closing) return closing;
        // Retirement is owned by this lease even after dispatch authority expires.
        const flight = cleanup();
        closing = flight;
        void flight.catch(() => { if (closing === flight) closing = undefined; });
        return flight;
      } };
  } catch (error) {
    try { await cleanup(); }
    catch (failure) {
      input.retainCleanup?.(cleanup);
      throw new AggregateError([error, failure], "Native execution initialization failed and cleanup is unconfirmed.");
    }
    throw error;
  }
}

function nativeRequest(action: HostedAgentCodexAction, path: string, signal: AbortSignal): NativeToolAuthorizationRequest {
  if (action.kind === "network") return { toolName: "WebFetch", input: { url: action.url, method: action.method }, signal };
  return action.kind === "exec" ? { toolName: "bash", input: { command: action.command, cwd: path }, signal }
    : { toolName: action.kind, input: { path, ...(action.scope === "tree" ? { recursive: true } : {}) }, signal };
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === 2);
}
