import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  BackendHealth, ExtensionPackageAction, OperationMutationSchema, OperationState, RunState, ScheduleRunOutcome, ScheduleSessionMode
} from "@joko/contracts";
import { expect, it } from "vitest";
import { waitFor } from "./fixture.js";
import {
  archiveMutation, createManualScheduleMutation, createSessionMutation, queueRunIdFrom,
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
    expect(store.listEvents({ sessionId, limit: 200 }).map(event => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "new: allow-once" }] })
    ]));
    const archived = await submit(clients.operation, connectionId, archiveMutation(sessionId, true));
    expect(archived.state, archived.error?.message).toBe(OperationState.SUCCEEDED);
    const restored = await submit(clients.operation, connectionId, archiveMutation(sessionId, false));
    expect(restored.state, restored.error?.message).toBe(OperationState.SUCCEEDED);
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, createManualScheduleMutation({
      backendId, targetId, sessionId, sessionMode: ScheduleSessionMode.BOUND, text: "Run from the same engine"
    })));
    await submit(clients.operation, connectionId, triggerScheduleMutation(scheduleId));
    const history = await waitFor(() => clients.scheduler.listScheduleRunHistory({ scheduleId }),
      result => result.history[0]?.outcome === ScheduleRunOutcome.SUCCEEDED, "completed from the ordinary scheduler on the original engine");
    expect(history.history[0]?.sessionId).toBe(sessionId);
    expect(await readFile(launches, "utf8")).toBe("new\nload\n");
    expect(store.getSession(sessionId).descriptor.binding.nativeSessionId).toBe(binding.nativeSessionId);

    const disabled = await mutate({ case: "setExtensionEnabled", value: { extensionId, enabled: false, expectedRevision: (await extension()).revision } });
    expect(disabled.state, disabled.error?.message).toBe(OperationState.SUCCEEDED);
    const snapshots = join(fixture.rootDirectory, "data", "extension-acp", "snapshots");
    await waitFor(() => readdir(snapshots), files => files.length === 0, "the actual engine process exited and released its package lease");
    await waitFor(engines, items => items[0]?.health === BackendHealth.UNAVAILABLE, "the disabled engine cannot be selected");
  } finally { await fixture.close(); }
});

const ENGINE_SOURCE = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
const nativeId = "managed-acp-session";
let mode = "new", permissionPrompt;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
const respond = (id, result) => send({ id, result });
function complete(request, text) {
  send({ method: "session/update", params: { sessionId: nativeId, update: {
    sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  respond(request, { stopReason: "end_turn" });
}
input.on("line", line => {
  const { id, method, params, result } = JSON.parse(line);
  if (id === "fixture-permission" && permissionPrompt !== undefined) {
    complete(permissionPrompt, mode + ": " + result?.outcome?.optionId);
    permissionPrompt = undefined;
  } else if (method === "initialize") {
    respond(id, { protocolVersion: 1, agentInfo: { name: "fixture", version: "1.0.0" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
  } else if (method === "session/new" || method === "session/load") {
    mode = method === "session/new" ? "new" : "load";
    if (mode === "load" && params.sessionId !== nativeId) throw new Error("Wrong native identity");
    appendFileSync(join(params.cwd, "acp-launches.txt"), mode + "\\n");
    respond(id, { sessionId: nativeId });
  } else if (method === "session/prompt") {
    const prompt = params.prompt[0]?.text ?? "";
    if (!prompt.includes("permission")) { complete(id, mode + ": " + prompt); return; }
    permissionPrompt = id;
    send({ id: "fixture-permission", method: "session/request_permission", params: {
      sessionId: nativeId, toolCall: { toolCallId: "fixture-tool", title: "Review fixture" },
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }]
    } });
  }
});
`;
