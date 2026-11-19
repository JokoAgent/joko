import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { HostedAgentService } from "@joko/contracts";
import type { AdapterContext, BackendAdapter } from "@joko/core";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentHost, type HostedAgentOpen } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentSettings } from "./hosted-agent-settings.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-provider-idle-")), database = new OperationalStore(":memory:");
  const settings = new HostedAgentSettings(database), slots = new HostedAgentSessionSlots(() => settings.limits());
  let nativeNow = 0, hostNow = 0, readable = true, authorized = true, context!: AdapterContext;
  const binding = { opaqueRef: "retained-native-history", nativeSessionId: "retained-native", generation: 1 };
  let state = { binding, streaming: false, compacting: false, pendingMessages: 0, fastMode: false, permissionMode: "ask" as const };
  const adapter = { id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    createSession: async (_input: unknown, value: AdapterContext) => { context = value; return binding; },
    inspectSession: vi.fn(async () => state), getNativeHistoryProjection: async () => ({ events: [] }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}) } satisfies Partial<BackendAdapter>;
  const principal = { id: "controller", deviceId: "source-device", trust: "owner" as const,
    assertCurrent: () => { if (!authorized) throw new Error("Controller revoked."); } };
  const host = new HostedAgentHost({ now: () => hostNow,
    providerIdleMinutes: () => { if (!readable) throw new Error("Settings unavailable."); return settings.providerIdleMinutes(); },
    authorize: () => ({ root, store: new HostedAgentStore(database), slots, artifactCapacityBytes: 1024, modelIds: ["model"],
      now: () => nativeNow, assertCurrent: principal.assertCurrent, assertModelAllowed: () => {}, createAdapter: () => adapter as unknown as BackendAdapter }) });
  const input: HostedAgentOpen = { runId: "original-run", nativeSessionId: binding.nativeSessionId, start: "create", sessionId: "task", targetId: "workspace",
    generation: 1, backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
    workspace: { platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false } };
  const run = await host.open(principal, input);
  const client = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => {
    router.service(HostedAgentService, createHostedAgentConnectService({ host, authenticate: () => principal }));
  })), principal.assertCurrent);
  const poll = (after = 0) => host.poll(principal, [{ runId: input.runId, after }], new AbortController().signal, 0);
  return { host, run, runId: input.runId, client, poll, slots, settings, adapter, context,
    setNativeNow: (value: number) => { nativeNow = value; }, setHostNow: (value: number) => { hostNow = value; },
    setState: (value: Partial<typeof state>) => { state = { ...state, ...value }; },
    setReadable: (value: boolean) => { readable = value; }, revoke: () => { authorized = false; },
    close: async () => {
      await host.dispose(); database.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup.");
      await rm(root, { recursive: true, force: true });
    } };
}

it("reclaims a low-occupancy continuously polled native owner and retains its authenticated terminal across reconnect", async () => {
  const f = await fixture();
  try {
    expect(f.settings.providerIdleMinutes()).toBe(30); expect(f.settings.idleReleaseMinutes()).toBe(0);
    f.settings.update({ kind: "provider_idle", minutes: 0 }, 0n);
    f.setNativeNow(31 * 60_000); await f.poll(); await f.host.sweep();
    expect(f.slots.summary().total).toBe(1); expect(f.adapter.dispose).not.toHaveBeenCalled();
    f.settings.update({ kind: "provider_idle", minutes: 30 }, f.settings.snapshot().revision);
    await f.context.emit({ type: "status", key: "original", text: "Retained task history" });
    await f.host.sweep(); expect(f.slots.summary().total).toBe(0);
    const terminal = (await f.client.poll([{ runId: f.runId, after: 0 }], new AbortController().signal))[0]!;
    expect(terminal).toMatchObject({ runId: f.runId, finished: true, idleReclaimed: true, cursor: 1,
      frames: [{ payload: { kind: "event", event: { text: "Retained task history" } } }] });
    f.setHostNow(61_000);
    expect((await f.poll(terminal.cursor))[0]).toMatchObject({ finished: true, idleReclaimed: true });
    f.setHostNow(180_001); await f.host.sweep(); await expect(f.poll(terminal.cursor)).rejects.toThrow();
    expect(f.adapter.dispose).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it.each(["streaming", "compacting", "pendingMessages"] as const)("starts a full idle interval only after native %s ends", async busy => {
  const f = await fixture();
  try {
    f.settings.update({ kind: "provider_idle", minutes: 1 }, 0n);
    f.setState(busy === "pendingMessages" ? { pendingMessages: 1 } : { [busy]: true });
    f.setNativeNow(120_000); await f.host.sweep(); expect(f.slots.summary().total).toBe(1);
    f.setState({ streaming: false, compacting: false, pendingMessages: 0 });
    f.setNativeNow(179_999); await f.host.sweep(); expect(f.adapter.dispose).not.toHaveBeenCalled();
    f.setNativeNow(180_000); await f.host.sweep(); expect(f.slots.summary().total).toBe(0);
  } finally { await f.close(); }
});

it("preserves background work and pending Source replies before starting the idle interval", async () => {
  const f = await fixture();
  try {
    f.settings.update({ kind: "provider_idle", minutes: 1 }, 0n);
    await f.context.emit({ type: "background_task", taskId: "background", title: "Original work", state: "running" });
    f.setNativeNow(120_000); await f.host.sweep(); expect(f.adapter.dispose).not.toHaveBeenCalled();
    await f.context.emit({ type: "background_task", taskId: "background", title: "Original work", state: "completed" });
    const reply = f.run.exchange.tool({ operation: "source.read" }, new AbortController().signal);
    void reply.catch(() => {});
    f.setNativeNow(240_000); await f.host.sweep(); expect(f.adapter.dispose).not.toHaveBeenCalled();
    const request = (await f.poll())[0]!.frames.find(frame => frame.payload.kind === "request")!;
    if (request.payload.kind !== "request") throw new Error("Missing original reverse request.");
    f.run.exchange.reply(request.payload.id, { ok: true, value: {} }); await reply;
    f.setNativeNow(299_999); await f.host.sweep(); expect(f.slots.summary().total).toBe(1);
    f.setNativeNow(300_000); await f.host.sweep(); expect(f.slots.summary().total).toBe(0);
  } finally { await f.close(); }
});

it("keeps authenticated Source execution held and starts the full idle interval when that Source releases it", async () => {
  const f = await fixture();
  try {
    f.settings.update({ kind: "provider_idle", minutes: 1 }, 0n);
    let cursor = 0;
    const pollHold = async (holdsNative: boolean) => {
      await f.context.emit({ type: "status", key: "hold", text: "Source execution state" });
      const batch = (await f.client.poll([{ runId: f.runId, after: cursor, holdsNative }], new AbortController().signal))[0]!;
      cursor = batch.cursor; expect(batch.finished).toBe(false);
    };
    f.setNativeNow(120_000); await pollHold(true); await f.host.sweep();
    f.setNativeNow(240_000); await pollHold(true); await f.host.sweep();
    expect(f.adapter.dispose).not.toHaveBeenCalled();
    f.setNativeNow(240_001); await pollHold(false); await f.host.sweep();
    f.setNativeNow(300_000); await f.host.sweep(); expect(f.slots.summary().total).toBe(1);
    f.setNativeNow(300_001); await f.host.sweep(); expect(f.slots.summary().total).toBe(0);
  } finally { await f.close(); }
});

it("does not attest or return a slot until exact native cleanup succeeds, even if settings become unreadable", async () => {
  const f = await fixture();
  try {
    f.setNativeNow(31 * 60_000); f.setReadable(false); await f.host.sweep();
    expect(f.adapter.dispose).not.toHaveBeenCalled(); f.setReadable(true);
    f.adapter.dispose.mockRejectedValueOnce(new Error("Native exit is unconfirmed."));
    await f.host.sweep(); expect(f.slots.summary().total).toBe(1);
    expect((await f.poll())[0]).toMatchObject({ finished: false }); expect(f.run.idleReclaimed).toBe(false);
    expect(() => f.run.call("new-input", { kind: "abort" })).toThrow("not active");
    f.setReadable(false); await f.host.sweep();
    expect(f.adapter.dispose).toHaveBeenCalledTimes(2); expect(f.slots.summary().total).toBe(0);
    expect((await f.poll())[0]).toMatchObject({ finished: true, idleReclaimed: true });
  } finally { await f.close(); }
});

it("rechecks fresh task activity after a delayed native idle inspection before choosing cleanup", async () => {
  const f = await fixture(); let release = () => {};
  try {
    f.settings.update({ kind: "provider_idle", minutes: 1 }, 0n); f.setNativeNow(120_000);
    const inspect = f.adapter.inspectSession.getMockImplementation()!;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.adapter.inspectSession.mockImplementationOnce(async () => { await gate; return inspect(); });
    const sweeping = f.host.sweep();
    await vi.waitFor(() => expect(f.adapter.inspectSession).toHaveBeenCalledOnce());
    f.setNativeNow(120_001); await f.run.call("current-task-control", { kind: "abort" });
    release(); await sweeping; expect(f.adapter.dispose).not.toHaveBeenCalled();
    f.setNativeNow(180_000); await f.host.sweep(); expect(f.slots.summary().total).toBe(1);
    f.setNativeNow(180_001); await f.host.sweep(); expect(f.slots.summary().total).toBe(0);
  } finally { release(); await f.close(); }
});

it("keeps revoked closure separate from Provider idle reclamation", async () => {
  const f = await fixture();
  try {
    f.setNativeNow(31 * 60_000); f.revoke(); await f.host.sweep();
    expect(f.slots.summary().total).toBe(0); expect(f.run.idleReclaimed).toBe(false);
    await expect(f.poll()).rejects.toThrow();
  } finally { await f.close(); }
});
