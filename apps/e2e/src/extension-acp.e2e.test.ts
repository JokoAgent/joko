import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  BackendHealth, ExtensionPackageAction, MessageRole, OperationMutationSchema, OperationState, RunState, ScheduleRunOutcome, ScheduleSessionMode, ToolCallState
} from "@joko/contracts";
import { expect, it } from "vitest";
import { waitFor } from "./fixture.js";
import {
  abortRunMutation, archiveMutation, createManualScheduleMutation, createSessionMutation, modelMutation, queueRunIdFrom,
  resolvePermissionMutation, scheduleIdFrom, sendInputMutation, sessionIdFrom, submit, triggerScheduleMutation
} from "./operations.js";
import { RealPiSystemFixture } from "./real-pi-fixture.js";

it("starts only an approved packaged ACP engine and keeps task, permission, schedule and native resume ownership", { timeout: 90_000 }, async () => {
  const fixture = await RealPiSystemFixture.start();
  try {
    const { clients, connectionId } = await fixture.pair("Approve plugin execution");
    const { store, sessionHost } = fixture.application;
    const sourceRoot = join(fixture.rootDirectory, "task-engines");
    const packageRoot = join(sourceRoot, "engine");
    await mkdir(join(sourceRoot, ".agents", "plugins"), { recursive: true });
    await mkdir(join(packageRoot, "extensions"), { recursive: true });
    await mkdir(join(packageRoot, "acp"));
    await writeFile(join(sourceRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
      name: "joko-acp-fixture", plugins: [{ name: "Managed ACP fixture", source: "engine" }]
    }));
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@joko-e2e/acp-task-engine", version: "1.0.0", pi: { extensions: ["extensions/index.js"] },
      joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{
        entry: "extensions/index.js",
        taskEngines: [
          { id: "fixture", name: "ACP fixture", protocol: "acp", entry: "acp/approved.mjs" },
          { id: "other", name: "Unapproved ACP fixture", protocol: "acp", entry: "acp/unapproved.mjs" }
        ]
      }] } }
    }));
    await writeFile(join(packageRoot, "extensions", "index.js"), "export default function setup() {}");
    await writeFile(join(packageRoot, "acp", "approved.mjs"), ENGINE_SOURCE, "utf8");
    await writeFile(join(packageRoot, "acp", "unapproved.mjs"), "throw new Error('Unapproved engine ran');");
    const mutate = (payload: MessageInitShape<typeof OperationMutationSchema>["payload"]) =>
      submit(clients.operation, connectionId, create(OperationMutationSchema, { payload }));
    const sourceRevision = (await clients.extension.listExtensionSources({ page: { pageSize: 100 } })).catalogRevision!;
    const added = await mutate({ case: "addExtensionSource", value: {
      expectedCatalogRevision: sourceRevision, source: { kind: { case: "local", value: { path: sourceRoot } } }
    } });
    expect(added.state, added.error?.message).toBe(OperationState.SUCCEEDED);
    const available = (await clients.extension.listExtensions({ query: "Managed ACP fixture", page: { pageSize: 100 } }))
      .extensions.find(entry => entry.owner?.kind.case === "source")!;
    const preview = (await clients.extension.getExtensionPackagePreview({
      extensionId: available.extensionId, expectedRevision: available.revision, backendId: "pi"
    })).preview!;
    expect(preview.action).toBe(ExtensionPackageAction.INSTALL);
    const adopted = await mutate({ case: "adoptExtensionPackage", value: {
      extensionId: available.extensionId, backendId: "pi", expectedRevision: preview.extensionRevision,
      expectedAction: preview.action, expectedCurrentResourceId: "", allowSourceReplacement: false
    } });
    if (adopted.result?.payload.case !== "resource") throw new Error(adopted.error?.message ?? "No installed Resource.");
    const resourceId = adopted.result.payload.value.resourceId;
    const original = (await clients.extension.listExtensions({ installed: true, page: { pageSize: 100 } }))
      .extensions.find(entry => entry.owner?.kind.case === "resource" && entry.owner.kind.value.resourceId === resourceId)!;
    const extensionId = original.extensionId;
    const extension = async () => (await clients.extension.getExtension({ extensionId })).extension!;
    if (!original.enabled) {
      const enabled = await mutate({ case: "setExtensionEnabled", value: { extensionId, enabled: true, expectedRevision: original.revision } });
      expect(enabled.state, enabled.error?.message).toBe(OperationState.SUCCEEDED);
    }
    const engines = async () => (await clients.backend.listBackends({ page: { pageSize: 100 } })).backends
      .filter(backend => backend.backendId.startsWith("plugin-acp-"));
    expect(await engines()).toHaveLength(0);
    const begin = await mutate({ case: "beginExtensionSetup", value: { extensionId, expectedRevision: (await extension()).revision } });
    expect(begin.state, begin.error?.message).toBe(OperationState.SUCCEEDED);
    const setup = await extension();
    expect(setup.setup?.fields.map(field => field.fieldId)).toEqual(["task-engine:fixture", "task-engine:other"]);
    const attemptId = setup.setup!.attemptId;
    const confirmed = await mutate({ case: "submitExtensionSetupInteraction", value: {
      extensionId, attemptId, fieldId: "task-engine:fixture", expectedRevision: setup.revision,
      value: { case: "confirmed", value: true }
    } });
    expect(confirmed.state, confirmed.error?.message).toBe(OperationState.SUCCEEDED);
    const finalized = await mutate({ case: "completeExtensionSetup", value: { extensionId, attemptId, expectedRevision: (await extension()).revision } });
    expect(finalized.state, finalized.error?.message).toBe(OperationState.SUCCEEDED);
    const [backend] = await waitFor(engines, items => items.length === 1, "the approved engine registered as a Backend");
    const backendId = backend!.backendId;
    const [target] = await waitFor(async () => (await clients.target.listTargets({ backendId })).targets,
      items => items.length > 0, "the original plugin Backend's local project");
    const targetId = target!.targetId;
    const storedTarget = store.getTarget(targetId);
    await sessionHost.registerTarget({ ...storedTarget.descriptor, trusted: true }, storedTarget.metadata);
    const launches = join(fixture.workspaceDirectory, "acp-launches.txt");
    await expect(access(launches)).rejects.toMatchObject({ code: "ENOENT" });
    const created = await submit(clients.operation, connectionId, createSessionMutation({
      backendId, targetId, providerId: backendId, modelId: "default", displayName: "Task owned by the plugin engine"
    }));
    expect(created.state, created.error?.message).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(created);
    const binding = store.getSession(sessionId).descriptor.binding;
    expect(binding.nativeSessionId).toBe("managed-acp-session");
    const models = async (id: string) => (await clients.session.getSession({ sessionId: id })).session?.modelCatalog?.models.map(model => model.key?.modelId);
    const switchModel = (id: string, model: string) => submit(clients.operation, connectionId, modelMutation(id, backendId, model, "", false));
    expect(await models(sessionId)).toEqual(["alpha", "beta"]);
    for (const model of ["beta", "alpha"]) {
      const operation = await switchModel(sessionId, model);
      expect(operation.state, operation.error?.message).toBe(OperationState.SUCCEEDED);
    }
    const generation = BigInt(binding.generation);
    const send = async (input: string) => queueRunIdFrom(await submit(clients.operation, connectionId, sendInputMutation(sessionId, generation, input)));
    const blocked = await send("Prompt requiring permission");
    const pending = await waitFor(() => clients.interaction.listInteractions({ sessionId, runId: blocked }),
      result => result.interactions.length === 1, "the ACP permission was projected to the original Run");
    const interaction = pending.interactions[0]!;
    const decided = await submit(clients.operation, connectionId, resolvePermissionMutation({
      connectionId, interactionId: interaction.interactionId, generation: interaction.generation
    }));
    expect(decided.state, decided.error?.message).toBe(OperationState.SUCCEEDED);
    await waitFor(() => clients.run.getRun({ runId: blocked }), result => result.run?.state === RunState.SUCCEEDED, "completed ACP permission");
    const timeline = async () => (await clients.session.listSessionTimeline({ sessionId, limit: 200 })).events;
    const completedTools = async () => {
      return (await timeline()).flatMap(event => {
        const kind = event.payload?.kind;
        const call = kind?.case === "toolCallCompleted" ? kind.value.toolCall : undefined;
        return call === undefined ? [] : [{ id: call.toolCallId, state: call.state, runId: call.runId,
          output: call.result?.parts.map(part => part.content.case === "text" ? part.content.value : "").join("") }];
      });
    };
    await waitFor(completedTools, results => results.some(result => result.id === "bg-audit"), "the background tool on the original task");
    const expectToolOutputs = async () => {
      const results = await completedTools();
      expect(results).toEqual(expect.arrayContaining([
        { id: "fixture-tool", output: expect.stringMatching(/Verified result[\s\S]*--- notes\.txt[\s\S]*-old[\s\S]*\+new/u), runId: blocked, state: ToolCallState.SUCCEEDED },
        { id: "failed-tool", output: "Permission denied for another file", runId: blocked, state: ToolCallState.FAILED },
        { id: "implicit-tool", output: "file:///project/result.txt\n[image]\n[audio]", runId: blocked, state: ToolCallState.SUCCEEDED },
        { id: "bg-audit", output: "background result", runId: "", state: ToolCallState.SUCCEEDED }
      ]));
      for (const id of ["fixture-tool", "failed-tool", "implicit-tool", "bg-audit"]) expect(results.filter(result => result.id === id)).toHaveLength(1);
      expect(results.some(result => result.id === "another-session")).toBe(false);
    };
    await expectToolOutputs();
    expect(store.listEvents({ sessionId, limit: 200 })).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ type: "tool_result", callId: "bg-audit" }),
      metadata: expect.objectContaining({ fields: expect.objectContaining({ turnScope: "background" }) })
    }));
    expect(store.listEvents({ sessionId, limit: 200 }).map(event => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "new: allow-once" }] })
    ]));
    for (const stopReason of ["max_tokens", "max_turn_requests", "refusal"]) {
      const runId = await send(stopReason);
      await waitFor(() => clients.run.getRun({ runId }), result => result.run?.state === RunState.SUCCEEDED, `completed ACP ${stopReason}`);
      expect((await timeline()).find(event => event.identity?.runId === runId && event.payload?.kind.case === "messageCompleted"
        && event.payload.kind.value.role === MessageRole.ASSISTANT)?.payload?.kind)
        .toMatchObject({ case: "messageCompleted", value: { stopReason, blocks: [expect.objectContaining({ content: { case: "text", value: "new: " + stopReason } })] } });
    }
    const cancelledRun = await send("cancel-check");
    await waitFor(timeline, events => events.some(event => event.identity?.runId === cancelledRun && event.payload?.kind.case === "toolCallStarted"), "the incomplete tool before cancellation");
    const cancelled = await submit(clients.operation, connectionId, abortRunMutation(cancelledRun));
    expect(cancelled.state, cancelled.error?.message).toBe(OperationState.SUCCEEDED);
    await waitFor(() => clients.run.getRun({ runId: cancelledRun }), result => result.run?.state === RunState.ABORTED, "the cancelled ACP prompt");
    expect((await completedTools()).filter(result => result.id === "cancelled-tool")).toEqual([
      { id: "cancelled-tool", state: ToolCallState.ABORTED, runId: cancelledRun, output: "Interrupted before the tool finished." }
    ]);
    store.appendEvent({ backendId, targetId, sessionId, generation: binding.generation, traceId: "acp-unmarked-history",
      payload: { type: "tool_result", callId: "unmarked-tool", name: "Older plugin tool", output: "retained result", isError: false } });
    const archived = await submit(clients.operation, connectionId, archiveMutation(sessionId, true));
    expect(archived.state, archived.error?.message).toBe(OperationState.SUCCEEDED);
    const restored = await submit(clients.operation, connectionId, archiveMutation(sessionId, false));
    expect(restored.state, restored.error?.message).toBe(OperationState.SUCCEEDED);
    const detachedGeneration = store.getSession(sessionId).descriptor.binding.generation;
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, createManualScheduleMutation({
      backendId, targetId, sessionId, sessionMode: ScheduleSessionMode.BOUND, text: "Run from the same engine"
    })));
    await submit(clients.operation, connectionId, triggerScheduleMutation(scheduleId));
    const history = await waitFor(() => clients.scheduler.listScheduleRunHistory({ scheduleId }),
      result => result.history[0]?.outcome === ScheduleRunOutcome.SUCCEEDED, "completed from the ordinary scheduler on the original engine");
    expect(history.history[0]?.sessionId).toBe(sessionId);
    expect(await readFile(launches, "utf8")).toBe("new\nload\n");
    expect(store.getSession(sessionId).descriptor.binding).toMatchObject({
      nativeSessionId: binding.nativeSessionId, opaqueRef: binding.opaqueRef, generation: detachedGeneration + 1
    });
    await expectToolOutputs();
    expect(await completedTools()).toContainEqual({ id: "unmarked-tool", state: ToolCallState.SUCCEEDED, runId: "", output: "retained result" });

    const second = await submit(clients.operation, connectionId, createSessionMutation({
      backendId, targetId, providerId: backendId, modelId: "default", displayName: "Second session with a separate catalog"
    }));
    expect(second.state, second.error?.message).toBe(OperationState.SUCCEEDED);
    const secondId = sessionIdFrom(second);
    expect(store.getSession(secondId).descriptor.binding.nativeSessionId).toBe("second-acp-session");
    expect(await models(secondId)).toEqual(["gamma", "delta"]);
    expect(await models(sessionId)).toEqual(["alpha", "beta"]);
    await waitFor(async () => (await clients.backend.listModels({ backendId, page: { pageSize: 100 } })).models.map(model => model.key?.modelId),
      ids => ["alpha", "beta", "gamma", "delta"].every(id => ids.includes(id)), "the approved Backend catalog includes both live task catalogs");
    const setRuntimeModel = async (id: string, modelId: string) => {
      const { control } = await clients.session.getSessionRuntimeControl({ sessionId: id });
      return mutate({ case: "setSessionRuntime", value: { sessionId: id, expectedRuntimeGeneration: control!.generation,
        backendId, providerId: backendId, modelId, fastMode: false } });
    };
    const switched = await setRuntimeModel(sessionId, "beta");
    expect(switched.state, switched.error?.message).toBe(OperationState.SUCCEEDED);
    await expect(switchModel(secondId, "beta")).rejects.toMatchObject({ code: Code.FailedPrecondition,
      message: expect.stringContaining("not advertised") });
    const rejectedRuntime = await setRuntimeModel(secondId, "beta");
    expect(rejectedRuntime.state).toBe(OperationState.FAILED);
    expect(rejectedRuntime.error?.message).toContain("same-Backend model");
    const switchedSecond = await setRuntimeModel(secondId, "delta");
    expect(switchedSecond.state, switchedSecond.error?.message).toBe(OperationState.SUCCEEDED);
    expect(await readFile(join(fixture.workspaceDirectory, "acp-models.txt"), "utf8")).toBe("managed-acp-session beta\nmanaged-acp-session alpha\nmanaged-acp-session beta\nsecond-acp-session delta\n");

    const attached = store.getSession(sessionId);
    store.updateSession(sessionId, { binding: { nativeSessionId: "other-native-session", opaqueRef: "acp:other-native-session",
      generation: attached.descriptor.binding.generation + 1 } }, attached.revision);
    expect(await completedTools()).toEqual([]);

    const disabled = await mutate({ case: "setExtensionEnabled", value: { extensionId, enabled: false, expectedRevision: (await extension()).revision } });
    expect(disabled.state, disabled.error?.message).toBe(OperationState.SUCCEEDED);
    const snapshots = join(fixture.rootDirectory, "data", "extension-acp", "snapshots");
    await waitFor(() => readdir(snapshots), files => files.length === 0, "the actual engine process exited and released its package lease");
    await waitFor(engines, items => items[0]?.health === BackendHealth.UNAVAILABLE, "the disabled engine cannot be selected");
  } finally { await fixture.close(); }
});

const ENGINE_SOURCE = `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
let nativeId = "managed-acp-session", model, cwd;
function options() {
  const choice = value => ({ value, name: value });
  const choices = nativeId === "managed-acp-session"
    ? [{ group: "general", name: "General", options: [choice("alpha")] }, { group: "special", name: "Special", options: [choice("beta"), choice("alpha")] }]
    : [choice("gamma"), choice("delta")];
  return [{ id: "model", name: "Model", type: "select", category: "model", currentValue: model, options: choices }];
}
let mode = "new", permissionPrompt, cancelledPrompt;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const respond = (id, result) => send({ id, result });
const update = value => send({ method: "session/update", params: { sessionId: nativeId, update: value } });
function complete(request, text, stopReason = "end_turn") {
  send({ method: "session/update", params: { sessionId: nativeId, update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  respond(request, { stopReason });
}
input.on("line", line => {
  const { id, method, params, result } = JSON.parse(line);
  if (id === "fixture-permission" && permissionPrompt !== undefined) {
    update({ sessionUpdate: "tool_call", toolCallId: "fixture-tool", title: "Review fixture", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "fixture-tool", content: [
      { type: "content", content: { type: "text", text: "Verified result" } },
      { type: "diff", path: "notes.txt", oldText: "old\\n", newText: "new\\n" }
    ] });
    update({ sessionUpdate: "tool_call_update", toolCallId: "fixture-tool", status: "completed" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "fixture-tool", status: "completed" });
    update({ sessionUpdate: "tool_call", toolCallId: "failed-tool", title: "Second fixture" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "failed-tool", status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Permission denied for another file" } }] });
    update({ sessionUpdate: "tool_call", toolCallId: "implicit-tool", title: "Resources", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "implicit-tool", content: [
      { type: "content", content: { type: "resource_link", uri: "file:///project/result.txt", name: "Result" } },
      { type: "content", content: { type: "image", mimeType: "image/png", data: "AQ==" } },
      { type: "content", content: { type: "audio", mimeType: "audio/wav", data: "AQ==" } }
    ] });
    complete(permissionPrompt, mode + ": " + result?.outcome?.optionId);
    permissionPrompt = undefined;
    setTimeout(() => {
      send({ method: "session/update", params: { sessionId: "different-acp-session", update: {
        sessionUpdate: "tool_call", toolCallId: "another-session", status: "completed" } } });
      update({ sessionUpdate: "tool_call", toolCallId: "bg-audit", title: "Background work", status: "in_progress" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "bg-audit", status: "completed", rawOutput: "background result" });
      update({ sessionUpdate: "tool_call_update", toolCallId: "bg-audit", status: "completed" });
    }, 400);
  } else if (method === "initialize") {
    respond(id, { protocolVersion: 1, agentInfo: { name: "fixture", version: "1.0.0" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
  } else if (method === "session/new" || method === "session/load") {
    mode = method === "session/new" ? "new" : "load";
    if (mode === "load" && params.sessionId !== nativeId) throw new Error("Wrong native identity");
    cwd = params.cwd;
    const launches = join(cwd, "acp-launches.txt");
    if (mode === "new" && existsSync(launches)) nativeId = "second-acp-session";
    model = nativeId === "managed-acp-session" ? "alpha" : "gamma";
    appendFileSync(launches, mode + "\\n");
    respond(id, { sessionId: nativeId, configOptions: options() });
  } else if (method === "session/set_config_option") {
    if (params.sessionId !== nativeId || params.configId !== "model") throw new Error("Wrong model owner");
    model = params.value;
    appendFileSync(join(cwd, "acp-models.txt"), nativeId + " " + model + "\\n");
    respond(id, { configOptions: options() });
  } else if (method === "session/prompt") {
    const prompt = params.prompt[0]?.text ?? "";
    if (prompt === "cancel-check") {
      cancelledPrompt = id;
      update({ sessionUpdate: "tool_call", toolCallId: "cancelled-tool", title: "Waiting tool", status: "in_progress" });
      return;
    }
    if (!prompt.includes("permission")) {
      complete(id, mode + ": " + prompt, ["max_tokens", "max_turn_requests", "refusal"].includes(prompt) ? prompt : "end_turn");
      return;
    }
    permissionPrompt = id;
    send({ id: "fixture-permission", method: "session/request_permission", params: {
      sessionId: nativeId, toolCall: { toolCallId: "fixture-tool", title: "Review fixture" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]
    } });
  } else if (method === "session/cancel" && cancelledPrompt !== undefined) {
    respond(cancelledPrompt, { stopReason: "cancelled" });
    cancelledPrompt = undefined;
  }
});
`;
