import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createInProcessDevicePeerHarness, DEVICE_PEER_RUNTIME_EXECUTABLES, NodeDevicePeerAgentExecutor, type DevicePeerAgentOutcome, type InProcessDevicePeerHarness } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { ConnectionManager, digestAuthKey } from "./connection-manager.js";
import { registerConnectServices } from "./connect-services.js";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";
import { HostedAgentSources } from "./hosted-agent-sources.js";
import { decodeHostedAgentOpen, decodeHostedAgentInvocation, decodeHostedAgentReply, encodeHostedAgentValue } from "./hosted-agent-wire.js";
import { toProtoBackend, toProtoCapability } from "./proto-mapper.js";
import { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { SessionHost } from "./session-host.js";
import { WorkspaceService } from "./workspace-service.js";

it("registers an untrusted Device project for a paired Source and runs only from the approved Device root", { timeout: 30_000 }, async () => {
  const temporaryRoot = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryRoot, "joko-source-device-project-")));
  const projectPath = join(root, "device-project");
  await mkdir(projectPath);
  const deviceRoot = await realpath(projectPath);
  await writeFile(join(deviceRoot, "AGENTS.md"), "Use the approved Device project.");
  await writeFile(join(deviceRoot, "proof.txt"), "Original Device file");
  const store = new OperationalStore(join(root, "source.sqlite"));
  const peers = new DevicePeerOwner({ store });
  const remoteExecution = new RemoteExecutionRouter({ peers, hosts: {
    captureProcessAuthority: async () => { throw new Error("Unexpected SSH process route."); },
    captureTransportAuthority: async () => { throw new Error("Unexpected SSH files route."); }
  } });
  const workspaces = new WorkspaceService({ remoteDelegate: new RemoteWorkspaceService(remoteExecution) });
  const artifactRepository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: artifactRepository, ingestRoots: [root] });
  const captureBeforeRun = vi.fn(async () => {}), captureAfterRun = vi.fn(async () => {});
  const host = new SessionHost(store, artifacts, [], { workspaceCapture: { captureBeforeRun, captureAfterRun } });
  const sources = new HostedAgentSources({ store, peers, host, remoteExecution, registry: new BackendInstanceRegistry(store),
    temporaryRoot: join(root, "incoming"), readPolicy: () => ({ revision: "device-project", permissionMode: "ask", planMode: false,
      approvedRoots: [], confirmCredentials: true }), readBlob: async () => { throw new Error("Unexpected Blob read."); } });
  const authKey = "source-device-project-fixture";
  const controller = store.createConnection({ id: "source-controller", deviceId: "source-device", name: "Source", authKeyDigest: digestAuthKey(authKey),
    device: { defaultName: "Source", kind: "web", platform: "web" } });
  const provider = store.createConnection({ id: "provider-agent", deviceId: "provider-device", name: "Provider", authKeyDigest: "provider-digest",
    device: { defaultName: "Provider", kind: "service", platform: process.platform } });
  const target = store.createConnection({ id: "project-agent", deviceId: "project-device", name: "Project", authKeyDigest: "project-digest",
    device: { defaultName: "Project", kind: "service", platform: process.platform } });
  store.setDeviceRemoteControlEnabled(provider.deviceId, true);
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const opens: ReturnType<typeof decodeHostedAgentOpen>[] = [];
  const exchanges = new Map<string, HostedAgentExchange>();
  const virtualRoot = process.platform === "win32" ? "V:\\provider-private\\project" : "/provider-private/project";
  const native = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: {
    invoke: async (method, bytes, signal) => {
      switch (method) {
        case contract.HostedAgentPeerMethod.GET_CATALOG:
          return toBinary(contract.GetHostedAgentCatalogResponseSchema, create(contract.GetHostedAgentCatalogResponseSchema, {
            format: 1, remoteControlEnabled: true, backends: [{ backendId: "device-pi", nativeAdapterKind: "pi", instanceGeneration: 1n,
              displayName: "Device Pi", version: "1", capabilities: ["input.text", "model.switch", "session.resume", "session.detach", "workspace.files"]
                .map(name => ({ name, support: contract.CapabilitySupport.SUPPORTED })),
              providers: [{ providerId: "provider", displayName: "Provider", connected: true, remoteInvocationEnabled: true,
                models: [{ backendId: "device-pi", key: { providerId: "provider", modelId: "model" }, displayName: "Model",
                  api: "openai-completions", contextWindowTokens: 32_768n, maximumOutputTokens: 1_024n, inputModalities: [contract.ModelInputModality.TEXT] }] }] }]
          }));
        case contract.HostedAgentPeerMethod.OPEN: {
          const request = fromBinary(contract.OpenHostedAgentRequestSchema, bytes);
          const opened = decodeHostedAgentOpen(request.openJson);
          opens.push(opened);
          exchanges.set(opened.runId, new HostedAgentExchange({ assertCurrent: () => {}, onOverflow: () => { throw new Error("Unexpected Provider output limit."); } }));
          return toBinary(contract.OpenHostedAgentResponseSchema, create(contract.OpenHostedAgentResponseSchema,
            { format: 1, runId: opened.runId, virtualRoot }));
        }
        case contract.HostedAgentPeerMethod.CALL: {
          const request = fromBinary(contract.CallHostedAgentRequestSchema, bytes);
          const command = decodeHostedAgentInvocation(request.commandJson);
          const opened = opens.find(value => value.runId === request.runId);
          const exchange = exchanges.get(request.runId);
          if (!opened || !exchange) throw new Error("The Provider call did not belong to an opened task.");
          const state = { binding: { opaqueRef: "provider-binding", nativeSessionId: opened.nativeSessionId, generation: opened.generation },
            providerId: "provider", modelId: "model", streaming: false, compacting: false, pendingMessages: 0, permissionMode: "ask", fastMode: false };
          const history = { events: [], activeLineage: [] };
          let result: unknown;
          if (command.kind === "send") {
            expect(command.durableFence).toBe(true);
            await exchange.nativeDispatch(request.callId, { inputFingerprint: createHash("sha256").update(command.input.text).digest("hex"), nativeHistory: history }, signal);
            const callId = "read-device-proof";
            await exchange.tool({ format: 1, callId, requestId: `${callId}:1`, operation: "tool.begin",
              payload: { name: "read", input: { path: "proof.txt" } } }, signal, request.callId);
            const file = await exchange.tool({ format: 1, callId, requestId: `${callId}:2`, operation: "fs.read",
              payload: { path: "proof.txt" } }, signal, request.callId);
            if (typeof file.data !== "string") throw new Error("The Device file read did not return bytes.");
            exchange.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: Buffer.from(file.data, "base64").toString("utf8") }] }, undefined, request.callId);
            exchange.emit({ type: "done", outcome: "completed" }, undefined, request.callId);
            result = null;
          } else if (command.kind === "state" || command.kind === "set_model" || command.kind === "history") {
            result = command.kind === "history" ? history : state;
          } else {
            throw new Error(`Unexpected Provider command ${command.kind}.`);
          }
          return toBinary(contract.CallHostedAgentResponseSchema, create(contract.CallHostedAgentResponseSchema,
            { format: 1, resultJson: encodeHostedAgentValue(result) }));
        }
        case contract.HostedAgentPeerMethod.POLL: {
          const request = fromBinary(contract.PollHostedAgentsRequestSchema, bytes);
          const runs = await Promise.all(request.cursors.map(async ({ runId, after }) => {
            const exchange = exchanges.get(runId);
            if (!exchange) throw new Error("The Provider poll did not belong to an opened task.");
            const batch = await exchange.poll(Number(after), signal, 1_000);
            return { runId, cursor: BigInt(batch.cursor), finished: batch.finished, framesJson: encodeHostedAgentValue(batch.frames) };
          }));
          return toBinary(contract.PollHostedAgentsResponseSchema, create(contract.PollHostedAgentsResponseSchema, { format: 1, runs }));
        }
        case contract.HostedAgentPeerMethod.REPLY: {
          const request = fromBinary(contract.ReplyHostedAgentRequestSchema, bytes);
          const exchange = exchanges.get(request.runId);
          if (!exchange) throw new Error("The Provider reply did not belong to an opened task.");
          exchange.reply(request.requestId, decodeHostedAgentReply(request.resultJson));
          return toBinary(contract.ReplyHostedAgentResponseSchema, create(contract.ReplyHostedAgentResponseSchema, { format: 1 }));
        }
        case contract.HostedAgentPeerMethod.CLOSE: {
          const request = fromBinary(contract.CloseHostedAgentRequestSchema, bytes);
          exchanges.get(request.runId)?.close();
          exchanges.delete(request.runId);
          return toBinary(contract.CloseHostedAgentResponseSchema, create(contract.CloseHostedAgentResponseSchema, { format: 1 }));
        }
        default: throw new Error(`Unexpected Provider method ${method}.`);
      }
    }, retire: async () => {}
  } });
  const files = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "project-recent.json") });
  const execute = async (executor: NodeDevicePeerAgentExecutor, command: contract.DevicePeerCommand, signal: AbortSignal): Promise<DevicePeerAgentOutcome> => {
    const results: contract.DevicePeerAgentResult[] = [];
    await executor.execute(command, signal, async result => { results.push(result); });
    const completed = results.find(result => result.phase === contract.DevicePeerResponsePhase.COMPLETED);
    if (completed) return { outcome: "completed", value: completed.payload };
    if (results.some(result => result.phase === contract.DevicePeerResponsePhase.ABORTED)) return { outcome: "aborted" };
    const failure = results.find(result => result.payload.case === "failure")?.payload;
    if (failure?.case === "failure") return { outcome: "failed",
      errorCode: failure.value.code === contract.DevicePeerFailureCode.NOT_FOUND ? "not_found" : "native_rejected", failure: failure.value };
    throw new Error("The Device request did not produce a terminal result.");
  };
  const modelHarness = createInProcessDevicePeerHarness({ targetDeviceId: provider.deviceId, capabilities: ["native_agents"], agent: {
    handle: (frame, signal) => execute(native, frame.payload as contract.DevicePeerCommand, signal), retire: () => native.retire()
  } });
  const processStarts: string[] = [];
  let routeActive = true;
  const harness: InProcessDevicePeerHarness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["files", "process"], agent: {
    handle: async (frame, signal) => {
      const command = frame.payload as contract.DevicePeerCommand;
      if (command.action.case === "startProcess") {
        const { executable, workingDirectory } = command.action.value;
        expect(workingDirectory).toBe(deviceRoot);
        expect([DEVICE_PEER_RUNTIME_EXECUTABLES.node, "git"]).toContain(executable);
        processStarts.push(workingDirectory);
        const identity = { protocolVersion: 1, kind: "stream_event", requestId: frame.requestId, targetDeviceId: frame.targetDeviceId,
          routeGeneration: frame.routeGeneration, streamId: `project-process-${processStarts.length}` } as const;
        setImmediate(() => {
          if (!routeActive) return;
          const data = executable === "git" ? "false" : JSON.stringify({ home: root, temporary: root, platform: process.platform });
          harness.emit({ ...identity, sequence: 1, channel: "process_stdout", data: Buffer.from(data) });
          harness.emit({ ...identity, sequence: 2, channel: "process_exit", exitCode: 0, signal: null });
        });
        return { outcome: "completed", value: { case: "processStarted", value: create(contract.DevicePeerProcessStartedResultSchema, { processId: identity.streamId }) } };
      }
      return execute(files, command, signal);
    }, retire: () => { routeActive = false; return files.retire(); }
  } });
  peers.registerRoute(provider, modelHarness.transport);
  peers.registerRoute(target, harness.transport);
  try {
    await artifacts.initialize(); await sources.initialize(); await host.initialize(); await sources.refresh(controller);
    const backend = store.listBackends()[0]!.descriptor;
    const application = { config: { publicOrigin: "http://127.0.0.1", dataDirectory: root }, store, devicePeers: peers,
      sessionHost: host, workspaces, artifacts, artifactRepository, adapters: [host.currentAdapter(backend.id)!],
      connections: new ConnectionManager(store), hostedAgentSources: sources } as unknown as OrchestratorApplication;
    const operations = createClient(contract.OperationService, createRouterTransport(router => registerConnectServices(router, application)));
    const submit = (operationId: string, payload: contract.OperationMutation["payload"], preconditions: contract.OperationMutation["preconditions"] = []) => operations.submitOperation({
      operationId, connectionId: controller.id, mutation: { payload, preconditions }
    }, { headers: { authorization: `Bearer ${authKey}` } });
    const peer = peers.list(controller)[0]!;
    const createProject = await submit("device-project-create", { case: "createDevicePeerTarget", value: create(contract.CreateDevicePeerTargetMutationSchema, {
      backendId: backend.id, displayName: "Device project", workspacePath: deviceRoot, peer: {
        targetDeviceId: peer.targetDeviceId, targetDeviceRevision: { value: peer.targetDeviceRevision }, relationId: peer.relationId,
        relationRevision: { value: peer.relationRevision }, routeGeneration: BigInt(peer.routeGeneration)
      }
    }) });
    const createdTarget = createProject.operation?.result?.payload;
    if (createdTarget?.case !== "target") throw new Error("Device project registration did not return its target.");
    const targetId = createdTarget.value.targetId, workspaceId = createdTarget.value.workspaceId;
    const registered = store.getTarget(targetId).descriptor;
    expect(registered).toMatchObject({ trusted: false, remoteWorkspace: { workspaceRoot: deviceRoot, targetDeviceId: target.deviceId } });
    expect(registered.workspaceRoot).not.toBe(deviceRoot);
    expect(await readdir(registered.workspaceRoot)).toEqual([]);
    const registration = () => workspaces.listRegistrations().find(value => value.id === workspaceId);
    expect(registration()).toMatchObject({ root: deviceRoot, trusted: false });
    expect(processStarts).toEqual([]);

    const task = create(contract.CreateSessionMutationSchema, { targetId, backendId: backend.id, displayName: "Device task",
      model: { model: { providerId: "provider", modelId: "model" } }, permissionMode: contract.PermissionMode.ASK });
    const rejected = await submit("device-project-untrusted", { case: "createSession", value: task });
    expect(rejected.operation).toMatchObject({ state: contract.OperationState.FAILED, error: { message: "The original Source task authority changed." } });
    expect(opens).toEqual([]);
    expect(store.listSessions()).toEqual([]);
    expect(processStarts).toEqual([]);
    await submit("device-project-trust", { case: "setWorkspaceTrust", value: create(contract.SetWorkspaceTrustMutationSchema, { workspaceId, trusted: true }) });
    expect(registration()).toMatchObject({ root: deviceRoot, trusted: true });

    const created = await submit("device-project-task", { case: "createSession", value: task });
    const taskResult = created.operation?.result?.payload;
    if (taskResult?.case !== "session") throw new Error("Device task creation did not return its session.");
    const sessionId = taskResult.value.sessionId;
    const before = store.getSession(sessionId).descriptor;
    expect(before.remoteWorkspace).toEqual(registered.remoteWorkspace);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ start: "create", sessionId, targetId, workspace: { contextFiles: [
      { path: "AGENTS.md", content: "Use the approved Device project." }
    ] } });
    const sent = await submit("device-project-send", { case: "sendInput", value: create(contract.SendInputMutationSchema, {
      sessionId, deliveryMode: contract.QueueDeliveryMode.PROMPT, input: { parts: [{ content: { case: "text", value: "Read proof.txt" } }] }
    }) }, [create(contract.OperationPreconditionSchema, {
      entity: { kind: contract.EntityKind.SESSION, id: sessionId }, expectedGeneration: BigInt(before.binding.generation)
    })]);
    const queued = sent.operation?.result?.payload;
    if (queued?.case !== "queueItem") throw new Error("Device input did not return its queue item.");
    await vi.waitFor(() => expect(store.getRun(queued.value.runId).descriptor.state).toBe("completed"), { timeout: 10_000 });
    expect(store.listEvents({ sessionId }).filter(event => event.runId === queued.value.runId).map(event => event.payload)).toContainEqual(expect.objectContaining({
      type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Original Device file" }]
    }));
    expect(captureBeforeRun).not.toHaveBeenCalled();
    expect(captureAfterRun).not.toHaveBeenCalled();
    await host.detach(sessionId);
    await host.resume(sessionId);
    const restored = store.getSession(sessionId).descriptor;
    expect(restored.binding.opaqueRef).toBe(before.binding.opaqueRef);
    expect(restored.binding.generation).toBe(before.binding.generation + 1);
    expect(opens).toHaveLength(2);
    expect(opens[1]).toMatchObject({ start: "resume", nativeSessionId: before.binding.nativeSessionId, sessionId, targetId });
    expect(processStarts).toEqual(Array<string>(4).fill(deviceRoot));
    expect(await readdir(registered.workspaceRoot)).toEqual([]);
    await host.detach(sessionId);
    store.setDeviceRemoteControlEnabled(target.deviceId, false);
    expect(peers.listForCapabilities(controller, ["native_agents"]).map(device => device.targetDeviceId)).toEqual([provider.deviceId]);
    await expect(host.resume(sessionId)).rejects.toThrow();
    expect(opens).toHaveLength(2);
    expect(processStarts).toEqual(Array<string>(4).fill(deviceRoot));
  } finally {
    await host.dispose(); await sources.close(); await peers.shutdown(); await workspaces.close(); store.close();
    if (!root.startsWith(temporaryRoot + sep)) throw new Error("Unsafe test cleanup.");
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

it("reads a completed retained workflow through the actual paired Source without opening a native run and drops a revoked relation's late result", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-paired-workflow-"))), store = new OperationalStore(join(root, "source.sqlite"));
  const peers = new DevicePeerOwner({ store }), registry = new BackendInstanceRegistry(store);
  const host = new SessionHost(store, new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }), []);
  const sources = new HostedAgentSources({ store, peers, registry, host, temporaryRoot: join(root, "incoming"),
    readPolicy: () => ({ revision: "source-policy", permissionMode: "ask", planMode: false, approvedRoots: [], confirmCredentials: true }),
    readBlob: async () => { throw new Error("A workflow read has no image authority."); } });
  const controller = store.createConnection({ id: "source-connection", deviceId: "original-device", device: { defaultName: "Original", kind: "web", platform: "web" }, name: "Original", authKeyDigest: "original-digest" });
  const target = store.createConnection({ id: "native-connection", deviceId: "native-device", device: { defaultName: "Native", kind: "service", platform: process.platform }, name: "Native", authKeyDigest: "native-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true); await writeFile(join(root, "evidence.txt"), "Owned Source evidence");
  const taskId = `claude-task-${"a".repeat(32)}`, virtualRoot = "/provider-private/workspace", calls: string[] = [];
  let block = false, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; }), delayed = new Promise<void>(resolve => { release = resolve; });
  const native = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: {
    invoke: async (method, bytes) => {
      if (method === contract.HostedAgentPeerMethod.GET_CATALOG) return toBinary(contract.GetHostedAgentCatalogResponseSchema, create(contract.GetHostedAgentCatalogResponseSchema,
        { format: 1, remoteControlEnabled: true, backends: [{ backendId: "native-claude", nativeAdapterKind: "claude-agent-sdk-stdio", instanceGeneration: 1n,
          displayName: "Native Claude", version: "1", capabilities: [{ name: contract.capabilityNames.backgroundTasks, support: contract.CapabilitySupport.SUPPORTED }],
          providers: [{ providerId: "provider", displayName: "Provider", connected: true, remoteInvocationEnabled: true, models: [{ backendId: "native-claude", key: { providerId: "provider", modelId: "model" },
            displayName: "Model", api: "anthropic-messages", contextWindowTokens: 32768n, maximumOutputTokens: 1024n, inputModalities: [contract.ModelInputModality.TEXT] }] }] }] }));
      expect(method).toBe(contract.HostedAgentPeerMethod.CALL);
      const request = fromBinary(contract.CallHostedAgentRequestSchema, bytes), command = decodeHostedAgentInvocation(request.commandJson); calls.push(command.kind);
      expect(command).toMatchObject({ kind: "workflow_progress", sessionId: "retained-task", targetId: "source-target", nativeSessionId: "retained-native-alias", taskId, backendId: "native-claude" });
      if (block) { entered(); await delayed; }
      return toBinary(contract.CallHostedAgentResponseSchema, create(contract.CallHostedAgentResponseSchema, { format: 1, resultJson: encodeHostedAgentValue({ virtualRoot,
        output: { status: "available", text: "", totalBytes: 500, truncated: false, capturedAtMs: Date.now(), workflow: { runId: "workflow", status: "done", totalTokens: 0,
          phases: [{ index: 1, title: "Review" }], agents: [{ label: "Reviewer", state: "done", phaseIndex: 1, attempt: 2, resultPreview: `${virtualRoot}/evidence.txt` }],
          logs: [block ? "Late retired relation" : `${virtualRoot}/evidence.txt`] } } }) }));
    }, retire: async () => {}
  } });
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["native_agents"], agent: {
    handle: async (frame, signal) => {
      let value: contract.DevicePeerAgentResult["payload"] | undefined;
      await native.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) value = result.payload; });
      return { outcome: "completed", value };
    }, retire: () => native.retire()
  } }); peers.registerRoute(target, harness.transport);
  try {
    await sources.initialize(); await host.initialize(); await sources.refresh(controller);
    const backend = store.listBackends()[0]!.descriptor, source = sources.source(backend.id)!;
    await host.registerTarget({ id: "source-target", backendId: backend.id, displayName: "Source", workspaceRoot: root, trusted: true, managed: false });
    const binding = { generation: 1, nativeSessionId: "retained-native-alias", opaqueRef: JSON.stringify({ format: 1, backendId: backend.id, source,
      sessionId: "retained-task", targetId: "source-target", nativeSessionId: "retained-native-alias", providerId: "provider" }) };
    store.createSession({ id: "retained-task", backendId: backend.id, targetId: "source-target", title: "Workflow", binding,
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    store.appendEvent({ backendId: backend.id, targetId: "source-target", sessionId: "retained-task", generation: 1, traceId: "retained-workflow",
      payload: { type: "background_task", taskId, title: "Workflow", state: "completed" } });
    const value = await host.getBackgroundTaskOutput("retained-task", taskId);
    // Workflow previews and logs retain the Provider's separator style in text.
    const displayPath = join(root, "evidence.txt").replaceAll(sep, "/");
    expect(value.workflow).toMatchObject({ status: "done", totalTokens: 0, agents: [{ attempt: 2, resultPreview: displayPath }], logs: [displayPath] });
    expect(JSON.stringify(value)).not.toContain(virtualRoot); expect(calls).toEqual(["workflow_progress"]);
    block = true; const pending = host.getBackgroundTaskOutput("retained-task", taskId);
    await Promise.race([reached, pending.then(() => { throw new Error("The workflow read did not enter the original paired route."); })]);
    store.setDeviceRemoteControlEnabled(target.deviceId, false); release();
    const retired = await pending; expect(retired.status).toBe("unavailable"); expect(JSON.stringify(retired)).not.toContain("Late retired relation");
    expect(calls).toEqual(["workflow_progress", "workflow_progress"]);
  } finally {
    release(); await host.dispose(); await sources.close(); await peers.shutdown(); store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});

it("publishes actual paired native sources, retains paused and offline choices, and restores the same identity from the Source database", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-native-source-catalog-"));
  let store = new OperationalStore(join(root, "source.sqlite")), peers = new DevicePeerOwner({ store });
  let registry = new BackendInstanceRegistry(store);
  let host = new SessionHost(store, new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }), []);
  const readPolicy = () => ({ revision: "source-policy", permissionMode: "ask" as const, planMode: false, approvedRoots: [], confirmCredentials: true });
  const readBlob = async () => { throw new Error("No image dispatch in this catalog fixture."); };
  const reviewTool = async () => ({ verdict: "ask" as const });
  const resolveTextResources = async () => [];
  const resolveFile = async () => { throw new Error("No file dispatch in this catalog fixture."); };
  const resolveArtifactMention = async () => { throw new Error("No Artifact mention dispatch in this catalog fixture."); };
  let sources = new HostedAgentSources({ store, peers, registry, host, temporaryRoot: join(root, "incoming"), readPolicy, readBlob, reviewTool,
    resolveTextResources, resolveFile, resolveArtifactMention });
  const controller = store.createConnection({ id: "source-connection", deviceId: "original-device", device: { defaultName: "Original", kind: "web", platform: "web" }, name: "Original", authKeyDigest: "original-digest" });
  const target = store.createConnection({ id: "node-connection", deviceId: "model-node", device: { defaultName: "Native computer", kind: "service", platform: process.platform }, name: "Native computer", authKeyDigest: "node-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  let remoteEnabled = true, malformed = false, inferred = 0;
  const native = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: {
    invoke: async (method, bytes, _signal, authority) => {
      expect(authority.controllerDeviceId).toBe(controller.deviceId);
      if (method === contract.HostedAgentPeerMethod.CALL) {
        const request = fromBinary(contract.CallHostedAgentRequestSchema, bytes), command = decodeHostedAgentInvocation(request.commandJson);
        expect(command).toMatchObject({ kind: "infer", request: { backendId: "native-sdk", backendInstanceGeneration: 1, providerId: "provider", modelId: "native-model", system: "Private reply", user: "Hello", maxTokens: 256 } });
        inferred++;
        return toBinary(contract.CallHostedAgentResponseSchema, create(contract.CallHostedAgentResponseSchema, { format: 1, resultJson: encodeHostedAgentValue("Source isolated reply") }));
      }
      expect(method).toBe(contract.HostedAgentPeerMethod.GET_CATALOG);
      const backend = { backendId: "native-sdk", instanceGeneration: 1n, displayName: "Native Agent", version: "1", capabilities: [
        { name: "input.text", support: contract.CapabilitySupport.SUPPORTED }, { name: "model.switch", support: contract.CapabilitySupport.SUPPORTED },
        { name: "workspace.files", support: contract.CapabilitySupport.SUPPORTED },
        toProtoCapability({ key: "input.image", supported: true, options: ["image/png"] }),
        ...["runtime.commands", "subagents.list", "subagents.detail", "subagents.transcript", "subagents.resume", "session.rewind", "session.rewind_to_start", "session.fork", "session.clone"]
          .map(name => ({ name, support: contract.CapabilitySupport.SUPPORTED })),
        toProtoCapability({ key: "permission.modes", supported: true, options: ["ask", "acceptEdits", "auto", "bypassPermissions"] })
      ], providers: [{ providerId: "provider", displayName: "Provider", connected: true, remoteInvocationEnabled: remoteEnabled,
        models: [{ backendId: "native-sdk", key: { providerId: "provider", modelId: "native-model" }, displayName: "Model", logicalId: "stable-model", api: "openai-responses",
          contextWindowTokens: 32768n, contextWindowMaxTokens: 262144n, maximumOutputTokens: 1024n, inputModalities: [contract.ModelInputModality.TEXT], description: "Native model description",
          displayThinkingLevels: ["low", "high"], defaultVisible: false, declaredSupportsFastMode: false, referenceApi: "openai-responses",
          inputCostMicrosPerMillion: 2500000n, currencyCode: "USD", priceSource: contract.ModelPriceSource.UPSTREAM }] }] };
      return toBinary(contract.GetHostedAgentCatalogResponseSchema, create(contract.GetHostedAgentCatalogResponseSchema, {
        format: 1, remoteControlEnabled: true, backends: malformed ? [backend, { ...backend, backendId: "invalid", providers: backend.providers }] : [backend]
      }));
    }, retire: async () => {}
  } });
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["native_agents"], agent: {
    handle: async (frame, signal) => {
      let value: contract.DevicePeerAgentResult["payload"] | undefined;
      await native.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) value = result.payload; });
      return { outcome: "completed", value };
    }, retire: () => native.retire()
  } });
  peers.registerRoute(target, harness.transport);
  try {
    await sources.initialize(); await host.initialize(); await sources.refresh(controller);
    const descriptor = store.listBackends()[0]!.descriptor, id = descriptor.id;
    expect(sources.source(id)).toEqual({ controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId, backendId: "native-sdk" });
    expect(descriptor).toMatchObject({ adapterKind: "hosted", health: "healthy", displayName: "Native Agent · Native computer", instanceGeneration: 1 });
    expect(descriptor.capabilities.get("input.text")?.supported).toBe(true);
    for (const key of ["runtime.commands", "subagents.list", "subagents.detail", "subagents.transcript", "subagents.resume", "session.rewind", "session.rewind_to_start"]) {
      expect(descriptor.capabilities.get(key)?.supported).toBe(true);
    }
    for (const key of ["session.fork", "session.clone"]) expect(descriptor.capabilities.get(key)).toMatchObject({ supported: true });
    expect(descriptor.capabilities.get("permission.modes")?.options).toEqual(["ask", "acceptEdits", "auto", "bypassPermissions"]);
    expect(descriptor.capabilities.get("runtime.resources")).toMatchObject({ supported: true, options: ["skill", "prompt"] });
    expect(descriptor.capabilities.get("input.mention")).toMatchObject({ supported: true,
      options: ["resource", "workspace_file", "workspace_directory", "workspace_line_range", "artifact"] });
    const projected = () => toProtoBackend(store.getBackend(id)).capabilities!.capabilities;
    expect(projected().find(capability => capability.name === "input.file")).toMatchObject({
      support: contract.CapabilitySupport.SUPPORTED, options: { kind: { case: "input", value: { mediaTypes: [], maximumBytes: 0n, maximumItems: 0 } } }
    });
    expect(projected().find(capability => capability.name === "input.image")).toMatchObject({
      support: contract.CapabilitySupport.SUPPORTED, options: { kind: { case: "input", value: { mediaTypes: ["image/png"] } } }
    });
    expect(descriptor.providers?.[0]?.displayName).toBe("Provider · Native Agent · Native computer");
    expect(descriptor.models[0]).toMatchObject({ logicalId: "stable-model", displayThinkingLevels: ["low", "high"], defaultVisible: false,
      contextWindow: 32768, contextWindowMax: 262144, declaredSupportsFastMode: false, cost: { input: 2.5 }, pricing: { source: "upstream", currencyCode: "USD" } });
    expect(host.currentAdapter(id)?.id).toBe(id); expect(sources.modelAvailable(id, "provider", "native-model")).toBe(true);
    expect(await host.currentAdapter(id)!.inferNativeText!({ backendInstanceGeneration: descriptor.instanceGeneration, providerId: "provider", modelId: "native-model",
      system: "Private reply", user: "Hello", maxTokens: 256, timeoutMs: 10_000, signal: new AbortController().signal,
      assertCurrent() {}, assertModelAllowed(providerId, modelId) { expect([providerId, modelId]).toEqual(["provider", "native-model"]); } })).toBe("Source isolated reply");
    expect(inferred).toBe(1); expect(store.listSessions()).toEqual([]);
    remoteEnabled = false; await sources.refresh(controller);
    expect(sources.modelAvailable(id, "provider", "native-model")).toBe(false); expect(store.getBackend(id).descriptor.models).toHaveLength(1);
    remoteEnabled = true; malformed = true; await sources.refresh(controller);
    expect(store.listBackends()).toHaveLength(1); expect(sources.modelAvailable(id, "provider", "native-model")).toBe(false);
    malformed = false; await sources.refresh(controller); expect(sources.modelAvailable(id, "provider", "native-model")).toBe(true);
    const staleTarget = { id: "stale-target", backendId: id, displayName: "Original", workspaceRoot: root, managed: false, trusted: true };
    await host.registerTarget(staleTarget);
    store.createSession({ id: "stale-task", backendId: id, targetId: staleTarget.id, title: "Retired occurrence", binding: { opaqueRef: "retained", generation: 2 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    await expect(host.currentAdapter(id)!.createSession({ target: staleTarget, providerId: "provider", modelId: "native-model", permissionMode: "ask", fastMode: false }, {
      sessionId: "stale-task", generation: 1, backendInstanceGeneration: descriptor.instanceGeneration, target: staleTarget, operationId: "retired-create",
      signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
      storeArtifact: async () => { throw new Error("No stale artifacts."); }
    })).rejects.toThrow(/Source task authority changed/u);
    await host.dispose(); await sources.close(); await peers.shutdown(); await native.retire(); store.close();
    store = new OperationalStore(join(root, "source.sqlite")); peers = new DevicePeerOwner({ store }); registry = new BackendInstanceRegistry(store);
    host = new SessionHost(store, new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }), []);
    sources = new HostedAgentSources({ store, peers, registry, host, temporaryRoot: join(root, "incoming"), readPolicy, readBlob });
    await sources.initialize(); await host.initialize();
    expect(store.getBackend(id).descriptor).toMatchObject({ id, health: "unavailable", instanceGeneration: 2 });
    expect(sources.modelAvailable(id, "provider", "native-model")).toBe(false); expect(host.currentAdapter(id)?.id).toBe(id);
    expect(store.getBackend(id).descriptor.models[0]?.modelId).toBe("native-model");
    expect(projected().find(capability => capability.name === "input.file")).toMatchObject({
      support: contract.CapabilitySupport.NOT_IMPLEMENTED, options: undefined
    });
  } finally {
    await host.dispose(); await sources.close(); await peers.shutdown(); store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
