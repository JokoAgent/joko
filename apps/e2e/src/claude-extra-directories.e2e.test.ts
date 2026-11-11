import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import { ExtraDirectoryAccess, OperationMutationSchema, OperationState, StateImpact } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";

import { ControlledClaudeRuntime } from "./controlled-claude-runtime.js";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const BACKEND_ID = "claude-directory-product";
let fixture: OrchestratorE2eFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  vi.restoreAllMocks();
});

it("defers an added directory to the next input of both active Claude tasks and immediately retires both on revocation", async () => {
  const setup = await directoryFixture();
  const { runtime, store, host, firstPath, secondPath, add, remove } = setup;
  const sessions = await Promise.all([setup.createSession("First task"), setup.createSession("Second task")]);
  const queries = sessions.map(sessionId => runtime.queries.find(query =>
    query.params.options.sessionId === store.getSession(sessionId).descriptor.binding.nativeSessionId)!);
  const originalBindings = sessions.map(sessionId => store.getSession(sessionId).descriptor.binding);
  const runs = await Promise.all(sessions.map(sessionId => setup.send(sessionId, "Continue the original work")));
  await waitFor(async () => runs.map(runId => store.getRun(runId).descriptor.state),
    states => states.every(state => state === "running"), "both original Claude turns");
  const observations = queries.map(query => ({ settings: vi.spyOn(query, "applyFlagSettings"),
    interrupt: vi.spyOn(query, "interrupt"), close: vi.spyOn(query, "close") }));

  const added = await add(secondPath);
  expect(added.state).toBe(OperationState.SUCCEEDED);
  const approvedPaths = host.extraDirectories.listForTarget(setup.targetId).map(directory => directory.path);
  expect(approvedPaths).toEqual([firstPath, secondPath]);
  for (const [index, query] of queries.entries()) {
    expect(query.params.options.additionalDirectories).toEqual([firstPath]);
    expect(observations[index]!.settings).not.toHaveBeenCalled();
    expect(observations[index]!.interrupt).not.toHaveBeenCalled();
    expect(observations[index]!.close).not.toHaveBeenCalled();
    expect(store.getRun(runs[index]!).descriptor.state).toBe("running");
    expect(host.isSessionActive(sessions[index]!)).toBe(true);
    query.complete("The original work finished with its original directory scope.");
  }
  await waitFor(async () => runs.map(runId => store.getRun(runId).descriptor.state),
    states => states.every(state => state === "completed"), "both original completions");

  const nextRuns = await Promise.all(sessions.map(sessionId => setup.send(sessionId, "Use the newly approved directory")));
  await waitFor(async () => nextRuns.map(runId => store.getRun(runId).descriptor.state),
    states => states.every(state => state === "running"), "both updated Claude turns");
  expect(runtime.queries).toHaveLength(2);
  for (const [index, sessionId] of sessions.entries()) {
    expect(store.getSession(sessionId).descriptor.binding).toEqual(originalBindings[index]);
    expect(queries[index]!.receivedInputs).toHaveLength(2);
    expect(observations[index]!.settings).toHaveBeenCalledWith({ permissions: { additionalDirectories: approvedPaths } });
    expect(observations[index]!.interrupt).not.toHaveBeenCalled();
    expect(observations[index]!.close).not.toHaveBeenCalled();
  }

  const grant = host.extraDirectories.listForTarget(setup.targetId).find(directory => directory.path === secondPath)!;
  const revoked = await remove(grant.id);
  expect(revoked).toMatchObject({ state: OperationState.FAILED,
    error: { code: "EXTRA_DIRECTORY_RUNTIME_REFRESH_FAILED", workspaceImpact: StateImpact.MAY_HAVE_CHANGED } });
  expect(host.extraDirectories.listForTarget(setup.targetId).map(directory => directory.path)).toEqual([firstPath]);
  for (const [index, sessionId] of sessions.entries()) {
    expect(host.isSessionActive(sessionId)).toBe(false);
    expect(observations[index]!.close).toHaveBeenCalled();
    const query = queries[index]!;
    const hook = query.params.options.hooks!.PreToolUse![0]!.hooks[0]!;
    await expect(hook({ hook_event_name: "PreToolUse", session_id: originalBindings[index]!.nativeSessionId!,
      transcript_path: "unused", cwd: query.params.options.cwd, tool_name: "Read", tool_use_id: "revoked-read",
      tool_input: { file_path: join(secondPath, "private.txt") } }, "revoked-read", { signal: new AbortController().signal }))
      .resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  }
}, 30_000);

it("reports an unknown native update while refreshing the other materialized Claude task", async () => {
  const setup = await directoryFixture();
  const { runtime, store, host, secondPath } = setup;
  const sessions = await Promise.all([setup.createSession("First idle task"), setup.createSession("Second idle task")]);
  // Follow the Host's actual iteration order so the failed holder precedes the
  // healthy one; one failure must not cut short the target-wide refresh.
  const ordered = store.listSessions({ targetId: setup.targetId, includeArchived: true })
    .map(session => session.descriptor.id).filter(id => sessions.includes(id));
  const queries = ordered.map(sessionId => runtime.queries.find(query =>
    query.params.options.sessionId === store.getSession(sessionId).descriptor.binding.nativeSessionId)!);
  const calls: string[] = [];
  const failedUpdate = vi.spyOn(queries[0]!, "applyFlagSettings").mockImplementationOnce(async () => {
    calls.push(ordered[0]!);
    throw new Error("Native directory acknowledgement was lost");
  });
  const healthyUpdate = vi.spyOn(queries[1]!, "applyFlagSettings").mockImplementationOnce(async () => { calls.push(ordered[1]!); });
  const failedClose = vi.spyOn(queries[0]!, "close"), healthyClose = vi.spyOn(queries[1]!, "close");
  const operation = await setup.add(secondPath);
  expect(operation).toMatchObject({ state: OperationState.FAILED,
    error: { code: "NATIVE_CONTROL_UNKNOWN", nativeSessionImpact: StateImpact.MAY_HAVE_CHANGED } });
  expect(calls).toEqual(ordered);
  expect(failedUpdate).toHaveBeenCalledOnce();
  const approvedPaths = host.extraDirectories.listForTarget(setup.targetId).map(directory => directory.path);
  expect(approvedPaths).toContain(secondPath);
  expect(healthyUpdate).toHaveBeenCalledWith({ permissions: { additionalDirectories: approvedPaths } });
  expect(failedClose).toHaveBeenCalled();
  expect(host.isSessionActive(ordered[0]!)).toBe(false);
  expect(healthyClose).not.toHaveBeenCalled();
  expect(host.isSessionActive(ordered[1]!)).toBe(true);
  const runId = await setup.send(ordered[1]!, "Continue after the other task's unknown update");
  await waitFor(async () => store.getRun(runId).descriptor.state, state => state === "running", "the unaffected task");
  queries[1]!.complete("The unaffected task still completes.");
  await waitFor(async () => store.getRun(runId).descriptor.state, state => state === "completed", "the unaffected completion");
}, 30_000);

async function directoryFixture() {
  const runtime = new ControlledClaudeRuntime();
  fixture = await OrchestratorE2eFixture.start({ profiles: [], backendFactories: [{ instanceId: BACKEND_ID,
    adapterKind: "claude-agent-sdk-stdio", displayName: "Claude directory product fixture", create: ({ generation }) =>
      new ClaudeCodeAdapter({ id: BACKEND_ID, instanceGeneration: generation, runtime, environment: {},
        initializationTimeoutMs: 500, admissionTimeoutMs: 500, teardownTimeoutMs: 100 }) }] });
  const current = fixture;
  const paired = await current.pair("Claude directory owner");
  const targetId = current.targetId(BACKEND_ID), { store, sessionHost: host } = current.application;
  const paths = await Promise.all(["approved-first", "approved-second"].map(async name => {
    const path = join(current.rootDirectory, name);
    await mkdir(path);
    return realpath(path);
  }));
  const firstPath = paths[0]!, secondPath = paths[1]!;
  const add = (serverPath: string) => submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: { case: "addExtraDirectory", value: { workspaceId: "workspace-main", serverPath, access: ExtraDirectoryAccess.READ_WRITE } }
  }));
  const remove = (extraDirectoryId: string) => submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: { case: "removeExtraDirectory", value: { extraDirectoryId } }
  }));
  expect((await add(firstPath)).state).toBe(OperationState.SUCCEEDED);
  return { runtime, store, host, targetId, firstPath, secondPath, add, remove,
    createSession: async (displayName: string) => sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: BACKEND_ID, targetId, displayName }))),
    send: async (sessionId: string, text: string) => queueRunIdFrom(await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, BigInt(store.getSession(sessionId).descriptor.binding.generation), text))) };
}
