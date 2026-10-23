import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import { DevicePeerCommandSchema, DevicePeerCapabilityKind, DevicePeerEffectKind, DevicePeerFailureCode, DevicePeerResponsePhase, HostedAgentPeerMethod } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { NodeDevicePeerAgentExecutor, type NodeDevicePeerAgentEmission } from "./node-agent-executor.js";

const command = (method: HostedAgentPeerMethod, effect: DevicePeerEffectKind) => create(DevicePeerCommandSchema, {
  capability: DevicePeerCapabilityKind.NATIVE_AGENTS, effect, controllerDeviceId: "authenticated-controller",
  action: { case: "invokeHostedAgent", value: { method, requestBytes: new Uint8Array() } }
});
it("does not advertise native Agent hosting or admit its commands on a generic file/process node", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-native-peer-absent-"));
  const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json") }), emit = vi.fn();
  try {
    expect(executor.capabilities).not.toContain(DevicePeerCapabilityKind.NATIVE_AGENTS);
    await expect(executor.execute(command(HostedAgentPeerMethod.GET_SETTINGS, DevicePeerEffectKind.READ_ONLY), new AbortController().signal, emit))
      .rejects.toMatchObject({ code: DevicePeerFailureCode.CAPABILITY_UNAVAILABLE });
    expect(emit).not.toHaveBeenCalled();
  } finally { await executor.retire(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); }
});
it("fences native effects before acceptance, forwards only the closed native method, and retires its owned service", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-native-peer-command-")), invoke = vi.fn(async () => Uint8Array.of(1, 2, 3)), retire = vi.fn(async () => {});
  const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: { invoke, retire } });
  const emit = vi.fn(), frames: NodeDevicePeerAgentEmission[] = [], signal = new AbortController().signal;
  try {
    expect(executor.capabilities).toContain(DevicePeerCapabilityKind.NATIVE_AGENTS);
    await expect(executor.execute(command(HostedAgentPeerMethod.CALL, DevicePeerEffectKind.READ_ONLY), signal, emit)).rejects.toMatchObject({ code: DevicePeerFailureCode.INVALID_REQUEST });
    await expect(executor.execute(command(999 as HostedAgentPeerMethod, DevicePeerEffectKind.SIDE_EFFECT), signal, emit)).rejects.toMatchObject({ code: DevicePeerFailureCode.INVALID_REQUEST });
    const missingOwner = command(HostedAgentPeerMethod.GET_CATALOG, DevicePeerEffectKind.READ_ONLY); missingOwner.controllerDeviceId = "";
    await expect(executor.execute(missingOwner, signal, emit)).rejects.toMatchObject({ code: DevicePeerFailureCode.INVALID_REQUEST });
    expect(invoke).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
    await executor.execute(command(HostedAgentPeerMethod.GET_SETTINGS, DevicePeerEffectKind.READ_ONLY), signal, async frame => { frames.push(frame); });
    expect(invoke).toHaveBeenCalledWith(HostedAgentPeerMethod.GET_SETTINGS, new Uint8Array(), signal, { controllerDeviceId: "authenticated-controller" });
    expect(frames.map(frame => frame.phase)).toEqual([DevicePeerResponsePhase.ACCEPTED, DevicePeerResponsePhase.COMPLETED]);
    expect(frames[1]?.payload).toMatchObject({ case: "hostedAgent", value: { responseBytes: Uint8Array.of(1, 2, 3) } });
    await executor.execute(command(HostedAgentPeerMethod.GET_CATALOG, DevicePeerEffectKind.READ_ONLY), signal, emit);
    expect(invoke).toHaveBeenLastCalledWith(HostedAgentPeerMethod.GET_CATALOG, new Uint8Array(), signal, { controllerDeviceId: "authenticated-controller" });
  } finally { await executor.retire(); expect(retire).toHaveBeenCalledTimes(1);
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); }
});
