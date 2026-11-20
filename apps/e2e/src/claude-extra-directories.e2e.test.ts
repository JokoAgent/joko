import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { create, fromBinary } from "@bufbuild/protobuf";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import { capabilityNames, EntityKind, ExtraDirectoryAccess, InputMentionRangeSchema, InputPartSchema, ListWorkspaceEntriesRequestSchema, ListWorkspaceEntriesResponseSchema, OperationMutationSchema, OperationPreconditionSchema, OperationState, PerTurnOverridesSchema, QueueItemState, StateImpact, WorkspaceEntryKind } from "@joko/contracts";
import { chromium } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";

import { ControlledClaudeRuntime } from "./controlled-claude-runtime.js";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueItemIdFrom, queueRunIdFrom, retryRunMutation, runIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const BACKEND_ID = "claude-directory-product";
const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;
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

it("rejects a new read-only approval and keeps an existing record out of the Claude runtime", async () => {
  const setup = await directoryFixture();
  const { paired, runtime, store, host, targetId, firstPath, secondPath } = setup;
  const { backend } = await paired.clients.backend.getBackend({ backendId: BACKEND_ID });
  expect(backend?.capabilities?.capabilities.find(capability => capability.name === capabilityNames.workspaceExtraDirs))
    .toMatchObject({ options: { kind: { case: "workspace", value: {
      extraDirectories: true, extraDirectoryAccess: [ExtraDirectoryAccess.READ_WRITE]
    } } } });
  await expect(setup.add(secondPath, ExtraDirectoryAccess.READ_ONLY)).resolves.toMatchObject({
    state: OperationState.FAILED, error: { code: "UNSUPPORTED_CAPABILITY" }
  });
  expect(host.extraDirectories.listForTarget(targetId).map(directory => directory.path)).toEqual([firstPath]);
  expect(runtime.queries).toHaveLength(0);

  // Insert the approval shape formerly accepted by the service before opening a native task.
  const retained = await host.extraDirectories.add({ workspaceId: "workspace-main", serverPath: secondPath, access: "read_only" });
  const sessionId = await setup.createSession("Task with an older approval");
  const binding = store.getSession(sessionId).descriptor.binding;
  const query = runtime.queries.find(candidate => candidate.params.options.sessionId === binding.nativeSessionId)!;
  expect(query.params.options.additionalDirectories).toEqual([firstPath]);
  const settings = vi.spyOn(query, "applyFlagSettings");
  const closed = vi.spyOn(query, "close");
  await expect(setup.add(secondPath, ExtraDirectoryAccess.READ_ONLY)).resolves.toMatchObject({ state: OperationState.FAILED });
  const input = sendInputMutation(sessionId, BigInt(binding.generation), "Use only the previously approved read-only directory");
  if (input.payload.case !== "sendInput") throw new Error("Expected the normal input mutation.");
  input.payload.value.overrides = create(PerTurnOverridesSchema, { extraDirectoryIds: [retained.id] });
  await expect(submit(paired.clients.operation, paired.connectionId, input)).resolves.toMatchObject({
    state: OperationState.FAILED, error: { code: "TURN_OVERRIDE_EXTRA_DIRECTORY_ACCESS_UNSUPPORTED" }
  });
  expect(store.listQueueItems({ sessionId })).toEqual([]);
  expect(host.extraDirectories.get(retained.id).access).toBe("read_only");
  expect(query.receivedInputs).toEqual([]);
  expect(settings).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();

  const runId = await setup.send(sessionId, "Use the supported directory in this same task");
  await waitFor(async () => store.getRun(runId).descriptor.state, state => state === "running", "the original task's supported turn");
  await expect(setup.add(secondPath, ExtraDirectoryAccess.READ_ONLY)).resolves.toMatchObject({ state: OperationState.FAILED });
  query.complete("The original task keeps working.");
  await waitFor(async () => store.getRun(runId).descriptor.state, state => state === "completed", "the successful supported turn");
  expect(query.receivedInputs).toHaveLength(1);
  expect(settings).not.toHaveBeenCalled();
  expect(closed).not.toHaveBeenCalled();
  await expect(setup.remove(retained.id)).resolves.toMatchObject({ state: OperationState.SUCCEEDED });
  expect(host.extraDirectories.listForTarget(targetId).map(directory => directory.path)).toEqual([firstPath]);
}, 30_000);

it.each(["missing before preparation", "replaced during the native history read"] as const)(
  "retries the original Claude directory input when its directory was %s", async (failure) => {
    const setup = await directoryFixture();
    const { paired, runtime, store } = setup;
    const sessionId = await setup.createSession("Claude referenced directory");
    const binding = store.getSession(sessionId).descriptor.binding;
    const query = runtime.queries[0]!;
    const firstRun = await setup.send(sessionId, "Keep the original Claude context");
    await waitFor(async () => store.getRun(firstRun).descriptor.state, state => state === "running", "original Claude Run");
    query.complete("Original Claude turn completed.");
    await waitFor(async () => store.getRun(firstRun).descriptor.state, state => state === "completed", "original Claude completion");

    const docs = join(fixture!.workspaceDirectory, "docs");
    const preserved = join(fixture!.workspaceDirectory, "original-docs");
    await mkdir(docs);
    let replacedDuringHistory = false;
    if (failure === "missing before preparation") {
      await rename(docs, preserved);
    } else {
      const sendWithFence = ClaudeCodeAdapter.prototype.sendWithDurableNativeDispatchFence;
      vi.spyOn(ClaudeCodeAdapter.prototype, "sendWithDurableNativeDispatchFence").mockImplementation(function (this: ClaudeCodeAdapter, input, context, persistFence) {
        return sendWithFence.call(this, input, context, async preparation => {
          await persistFence(preparation);
          if (replacedDuringHistory || context.sessionId !== sessionId
            || !input.mentions.some(mention => mention.kind === "workspace_directory" && mention.reference === "docs")) return;
          // The actual dispatch baseline now exists. Change the directory in
          // the next SDK read that confirms it, after input preparation.
          const readHistory = runtime.getSessionMessages.bind(runtime);
          vi.spyOn(runtime, "getSessionMessages").mockImplementationOnce(async (...args) => {
            await rename(docs, preserved);
            await writeFile(docs, "A replacement regular file");
            replacedDuringHistory = true;
            return readHistory(...args);
          });
        });
      });
    }
    const mutation = sendInputMutation(sessionId, BigInt(binding.generation), "Inspect the selected docs directory");
    if (mutation.payload.case !== "sendInput") throw new Error("Expected the original directory input.");
    mutation.payload.value.input!.parts.push(create(InputPartSchema, { content: { case: "workspaceMention", value: {
      workspaceId: "workspace-main", relativePath: "docs", displayText: "docs", directory: true
    } } }));
    const accepted = await submit(paired.clients.operation, paired.connectionId, mutation);
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    const queueItemId = queueItemIdFrom(accepted), runId = queueRunIdFrom(accepted);
    const list = async () => (await paired.clients.queue.listQueueItems({ sessionId })).queueItems;
    const original = await waitFor(async () => (await list()).find(item => item.queueItemId === queueItemId),
      item => item?.state === QueueItemState.FAILED, "the original known failed directory input");
    expect(original).toMatchObject({ runId, retryBeforeDispatch: true, error: { code: "WORKSPACE_DIRECTORY_UNAVAILABLE", retryable: true } });
    expect(store.getQueueItem(queueItemId).error).toMatchObject({ stateMayHaveChanged: false });
    expect(query.receivedInputs).toHaveLength(1);

    if (failure === "replaced during the native history read") {
      expect(replacedDuringHistory).toBe(true);
      await unlink(docs);
    }
    await rename(preserved, docs);
    const retry = retryRunMutation(runId);
    retry.preconditions.push(create(OperationPreconditionSchema, {
      entity: { kind: EntityKind.QUEUE_ITEM, id: queueItemId },
      expectedRevision: original!.version!.revision!, expectedGeneration: original!.version!.generation
    }));
    const continued = await submit(paired.clients.operation, paired.connectionId, retry);
    expect(continued.state).toBe(OperationState.SUCCEEDED);
    const continuation = runIdFrom(continued);
    await waitFor(async () => store.getRun(continuation).descriptor.state, state => state === "running", "exact directory retry");
    expect(store.getRun(continuation).descriptor.parentRunId).toBe(runId);
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(query.receivedInputs).toHaveLength(2);
    expect(query.receivedInputs[1]!.message.content).toBe([
      "Inspect the selected docs directory",
      `Workspace directory reference: ${JSON.stringify({ name: "docs", path: await realpath(docs) })}`
    ].join("\n\n"));
    query.complete("The restored directory was used once.");
    await waitFor(async () => store.getRun(continuation).descriptor.state, state => state === "completed", "directory retry completion");
  }, 30_000);

mountedIt("replaces the selected directory of an existing queued Claude input from its mounted editor", { timeout: 90_000 }, async () => {
  const setup = await directoryFixture(process.env.JOKO_MOUNTED_WEB_DIR);
  const system = fixture!;
  const { runtime, store, paired } = setup;
  await Promise.all(["docs", "notes"].map(path => mkdir(join(system.workspaceDirectory, path))));
  const sessionId = await setup.createSession("Queued directory edit");
  const activeRun = await setup.send(sessionId, "Finish the current work first.");
  await waitFor(async () => store.getRun(activeRun).descriptor.state, value => value === "running", "the active original Claude turn");
  const initial = sendInputMutation(sessionId, BigInt(store.getSession(sessionId).descriptor.binding.generation), "Review @docs/ for decisions.");
  if (initial.payload.case !== "sendInput") throw new Error("Expected the original queued input.");
  initial.payload.value.input!.parts.push(create(InputPartSchema, { content: { case: "workspaceMention", value: {
    workspaceId: "workspace-main", relativePath: "docs", displayText: "docs", directory: true
  } } }));
  initial.payload.value.input!.mentionRanges.push(create(InputMentionRangeSchema, { start: 7, end: 13, mentionIndex: 0 }));
  const submitted = await submit(paired.clients.operation, paired.connectionId, initial);
  expect(submitted.state).toBe(OperationState.SUCCEEDED);
  const queuedId = queueItemIdFrom(submitted);
  const original = store.getQueueItem(queuedId);
  expect(original.state).toBe("accepted");

  const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  try {
    const device = "Queued directory Browser";
    const challenge = (await system.anonymous.connection.beginPairing({ deviceDisplayName: device })).challenge!;
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: system.baseUrl });
    await page.goto(`${system.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(system.baseUrl);
    await page.getByLabel("Pairing code").fill(system.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill(device);
    await page.locator("form.pair-form button[type=submit]").click();

    const row = page.locator(`[data-queue-item-id="${queuedId}"]`);
    await row.getByRole("button", { name: "Edit queued input", exact: true }).click();
    const editor = row.getByRole("textbox", { name: "Queued input text" });
    const save = row.getByRole("button", { name: "Save", exact: true });
    await waitFor(() => save.isEnabled(), value => value, "the saved edit lease before pasting");
    await editor.focus();
    await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(7, 13));
    const newPath = join(system.workspaceDirectory, "notes");
    await page.evaluate(value => navigator.clipboard.writeText(value), newPath);
    const listed = page.waitForResponse(response => {
      if (!response.url().endsWith("/joko.v1.WorkspaceService/ListWorkspaceEntries")) return false;
      const body = response.request().postDataBuffer();
      if (body === null) return false;
      const request = fromBinary(ListWorkspaceEntriesRequestSchema, body);
      return request.workspaceId === "workspace-main" && request.parentRelativePath === "" && request.includeHidden;
    }, { timeout: 10_000 });
    await editor.press("ControlOrMeta+V");
    const listing = await listed;
    expect(listing.ok()).toBe(true);
    expect(fromBinary(ListWorkspaceEntriesResponseSchema, await listing.body()).entries).toContainEqual(expect.objectContaining({
      relativePath: "notes", kind: WorkspaceEntryKind.DIRECTORY
    }));
    const updatedText = "Review @notes/ for decisions.";
    await waitFor(() => editor.inputValue(), value => value === updatedText, "the selected replacement directory in the original editor");
    await save.click();
    const edited = await waitFor(async () => store.getQueueItem(queuedId), item => item.body.text === updatedText && !item.editLocked,
      "the original queued input to save and unlock");
    expect(edited).toMatchObject({ id: original.id, runId: original.runId, position: original.position, state: "accepted",
      body: { text: updatedText, mentions: [{ kind: "workspace_directory", workspaceId: "workspace-main", reference: "notes", label: "notes" }],
        mentionRanges: [{ start: 7, end: 14, mentionIndex: 0 }] } });
    expect(edited.body.mentions).toHaveLength(1);
    const query = runtime.queries[0]!;
    expect(query.receivedInputs).toHaveLength(1);
    query.complete("The original turn is finished.");
    await waitFor(async () => store.getQueueItem(queuedId).state, value => value === "backend_accepted", "the edited input's native handoff");
    expect(query.receivedInputs).toHaveLength(2);
    expect(query.receivedInputs[1]?.message.content).toBe(`${updatedText}\n\nWorkspace directory reference: ${JSON.stringify({ name: "notes", path: newPath })}`);
    query.complete("The notes directory was selected.");
    await waitFor(async () => store.getRun(original.runId).descriptor.state, value => value === "completed", "the edited original Run to settle");
  } finally { await browser.close(); }
});

async function directoryFixture(webDirectory?: string) {
  const runtime = new ControlledClaudeRuntime();
  fixture = await OrchestratorE2eFixture.start({ profiles: [], webDirectory, backendFactories: [{ instanceId: BACKEND_ID,
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
  const add = (serverPath: string, access = ExtraDirectoryAccess.READ_WRITE) => submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: { case: "addExtraDirectory", value: { workspaceId: "workspace-main", serverPath, access } }
  }));
  const remove = (extraDirectoryId: string) => submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: { case: "removeExtraDirectory", value: { extraDirectoryId } }
  }));
  expect((await add(firstPath)).state).toBe(OperationState.SUCCEEDED);
  return { paired, runtime, store, host, targetId, firstPath, secondPath, add, remove,
    createSession: async (displayName: string) => sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: BACKEND_ID, targetId, displayName }))),
    send: async (sessionId: string, text: string) => queueRunIdFrom(await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, BigInt(store.getSession(sessionId).descriptor.binding.generation), text))) };
}
