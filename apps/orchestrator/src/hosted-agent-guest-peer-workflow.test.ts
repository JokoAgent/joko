import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { BackgroundTaskOutputResult, BackgroundWorkflowReadInput } from "@joko/core";
import { createInProcessDevicePeerHarness, NodeDevicePeerAgentExecutor } from "@joko/device-peer";
import * as contract from "@joko/contracts";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import type { ConnectionManager } from "./connection-manager.js";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { createHostedAgentPeerPort } from "./hosted-agent-peer-port.js";
import { createHostedAgentGuestPeerCapture } from "./hosted-agent-guest-peer-capture.js";
import { decodeHostedWorkflowProgress } from "./hosted-agent-workflow-wire.js";

it("reads only the original closed guest workflow over a real Device relay without granting any model operation", async () => {
  const temporary = await realpath(tmpdir()), root = await mkdtemp(join(temporary, "joko-guest-workflow-"));
  const source = new OperationalStore(":memory:"), modelStore = new OperationalStore(":memory:");
  const controller = source.createConnection({ id: "controller", deviceId: "group-computer", name: "Group", authKeyDigest: "group-digest",
    device: { defaultName: "Group", kind: "service", platform: process.platform } });
  const target = source.createConnection({ id: "native", deviceId: "native-computer", name: "Native", authKeyDigest: "native-digest",
    device: { defaultName: "Native", kind: "service", platform: process.platform } });
  source.setDeviceRemoteControlEnabled(target.deviceId, true);
  modelStore.upsertBackend({ id: "native", adapterKind: "claude-agent-sdk-stdio", instanceGeneration: 3, displayName: "Native", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  const recipient = { shareId: "group-share", memberId: "original-person", generation: 1, name: "Person", avatarUrl: null };
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const relayId = hash([recipient.shareId, recipient.memberId]), ownerId = `owner-guest-relay:${hash(["group-home", controller.deviceId, relayId, "native", "provider"])}`;
  const journal = new HostedAgentStore(modelStore), record = journal.claim({ authorityId: ownerId, deviceId: controller.deviceId, trust: "guest",
    backendId: "native", sessionId: "original-task", targetId: "original-target", nativeSessionId: "group-owned-alias" }, "previous-process", "create");
  const binding = { opaqueRef: "original-private-binding", nativeSessionId: "original-private-sdk", generation: 1 };
  journal.bind(record.key, record.leaseId, binding); journal.close(record.key, record.leaseId);
  await mkdir(join(root, record.key, "native"), { recursive: true }); await mkdir(join(root, record.key, "workspace"));
  const create = vi.fn(() => { throw new Error("A cold guest read must not create an Adapter"); });
  const read = vi.fn(async (_home: string, input: BackgroundWorkflowReadInput): Promise<BackgroundTaskOutputResult> => {
    input.assertCurrent(); return { status: "available", text: "", totalBytes: 200, capturedAtMs: Date.now(), truncated: false,
      workflow: { runId: "original-workflow", status: "done", totalTokens: 0, phases: [], agents: [], logs: ["Original durable observation"] } };
  });
  const runtime = new HostedAgentRuntime({ store: modelStore, root, artifactCapacityBytes: 1024, connections: {} as ConnectionManager,
    factories: [{ backendId: "native", providerIds: () => ["provider"], models: () => [], isolatedGuests: () => true, create, readWorkflowProgress: read }] });
  let settings = runtime.settings.update({ kind: "remote_control", enabled: true }, 0n);
  settings = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, settings.revision);
  runtime.settings.update({ kind: "model_access", backendId: "native", providerId: "provider", modelIds: [] }, settings.revision);
  const peer = createHostedAgentPeerPort(runtime, "group-home"), owner = new DevicePeerOwner({ store: source });
  const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: peer });
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["native_agents"], agent: { handle: async (frame, signal) => {
    let value: contract.DevicePeerAgentResult["payload"] | undefined;
    await executor.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) value = result.payload; });
    return { outcome: "completed", value };
  }, retire: () => executor.retire() } });
  owner.registerRoute(target, harness.transport);
  const authority = owner.captureBinding(controller.deviceId, target.deviceId, ["native_agents"]);
  const capture = createHostedAgentGuestPeerCapture({ owner, authority, recipient, backendId: "native", providerId: "provider", modelIds: [], assertCurrent() {} });
  const active = new AbortController().signal;
  const command = { kind: "workflow_progress" as const, backendId: "native", providerId: "provider", sessionId: "original-task", targetId: "original-target",
    nativeSessionId: "group-owned-alias", taskId: `claude-task-${"a".repeat(32)}`, maximumBytes: 16_384 };
  try {
    const result = decodeHostedWorkflowProgress(await capture.client.call("cold-read", "original-read", command, active));
    expect(result.output.workflow).toMatchObject({ status: "done", totalTokens: 0, logs: ["Original durable observation"] });
    expect(read.mock.calls[0]).toEqual([join(root, record.key, "native"), expect.objectContaining({ bindings: [binding], taskId: command.taskId })]);
    expect(result.virtualRoot).toBe(join(root, record.key, "workspace"));
    await expect(capture.client.catalog(active)).rejects.toBeDefined();
    await expect(capture.client.call("cold-read", "state", { kind: "state" }, active)).rejects.toBeDefined();
    await expect(capture.client.open({ runId: "forbidden", start: "create", nativeSessionId: "new-alias", sessionId: "new-task", targetId: "new-target", generation: 1,
      backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
      workspace: { platform: process.platform as "win32" | "linux" | "darwin", shell: "native", isGitRepository: false } }, active)).rejects.toBeDefined();
    await expect(capture.client.infer({ requestId: "forbidden", backendId: "native", backendInstanceGeneration: 3, providerId: "provider", modelId: "model",
      system: "Reply briefly", user: "Hello", timeoutMs: 10_000 }, active)).rejects.toBeDefined();
    await expect(capture.client.call("cold-read", "foreign-provider", { ...command, providerId: "foreign" }, active)).rejects.toBeDefined();
    expect(decodeHostedWorkflowProgress(await capture.client.call("cold-read", "foreign-task", { ...command, sessionId: "foreign-task" }, active)).output.status).toBe("unavailable");
    expect(read).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled(); expect(runtime.slots.summary().total).toBe(0); expect(modelStore.listSessions()).toEqual([]);
    let release!: () => void; read.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return result.output; });
    const pending = capture.client.call("cold-read", "retired-read", command, active);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, runtime.settings.snapshot().revision);
    release(); await expect(pending).rejects.toBeDefined(); expect(create).not.toHaveBeenCalled();
  } finally {
    owner.shutdown(); await executor.retire(); await runtime.close(); source.close(); modelStore.close();
    if (!root.startsWith(temporary + sep)) throw new Error("Unsafe guest workflow fixture cleanup."); await rm(root, { recursive: true, force: true });
  }
});
