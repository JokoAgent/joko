import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { BackendAdapter, NativeSessionBinding } from "@joko/core";
import { expect, it, vi, afterEach } from "vitest";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";
import { HostedAgentHost, type HostedAgentOpen, type HostedAgentPrincipal } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import type { HostedAgentRun } from "./hosted-agent-run.js";
import { decodeHostedAgentCall, decodeHostedAgentOpen, encodeHostedAgentValue } from "./hosted-agent-wire.js";
import { HostedAgentRun as NativeRun } from "./hosted-agent-run.js";
const databases: OperationalStore[] = [];
afterEach(() => { for (const store of databases.splice(0)) store.close(); });

function fixture(options: { readonly beforeAuthorize?: () => Promise<void>; readonly beforeClose?: () => Promise<void> } = {}) {
  let now = 1, enabled = true, connected = true;
  const slots = new HostedAgentSessionSlots(), exchanges = new Map<string, HostedAgentExchange>();
  const database = new OperationalStore(":memory:"); databases.push(database);
  const principal: HostedAgentPrincipal = { id: "connection:source", deviceId: "source-device", trust: "guest",
    assertCurrent: () => { if (!connected) throw new Error("private-auth-grant"); } };
  const createRun = vi.fn(async input => {
    input.assertCurrent(); const slot = input.slots.reserve(input.source.deviceId);
    const exchange = new HostedAgentExchange({ assertCurrent: input.assertCurrent, onOverflow: () => {} }); exchanges.set(input.runId, exchange);
    let closing: Promise<void> | undefined;
    return { id: input.runId, ready: true, checkAuthority: input.assertCurrent, workspaceRoot: join(tmpdir(), "joko-hosted-test", input.runId), exchange,
      close: () => closing ??= (async () => { exchange.finish(); await options.beforeClose?.(); slot.release(); })(),
      disposeExchange: () => exchange.close() } as unknown as HostedAgentRun;
  });
  const authorize = vi.fn(async () => {
    await options.beforeAuthorize?.();
    return { root: tmpdir(), store: new HostedAgentStore(database), artifactCapacityBytes: 1024, slots, modelIds: ["model"],
      assertCurrent: () => { if (!enabled) throw new Error("private-provider-policy"); }, assertModelAllowed: () => {},
      createAdapter: () => { throw new Error("Native creation is controlled by this service-owner fixture."); } };
  });
  const host = new HostedAgentHost({ now: () => now, authorize, createRun });
  const input: HostedAgentOpen = { runId: "first", nativeSessionId: "native-first", start: "create", sessionId: "task", targetId: "workspace", generation: 1, backendId: "native",
    providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
    workspace: { platform: "win32", shell: "bash", isGitRepository: false } };
  return { host, slots, input, principal, createRun, authorize, exchanges, setNow: (value: number) => { now = value; },
    disable: () => { enabled = false; }, disconnect: () => { connected = false; } };
}

it("reserves one open across async authorization and rejects conflicting identities without starting another native process", async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ beforeAuthorize: () => wait });
  try {
    const first = f.host.open(f.principal, f.input); expect(f.host.open(f.principal, f.input)).toBe(first);
    expect(() => f.host.open(f.principal, { ...f.input, modelId: "other" })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => f.host.open({ ...f.principal, trust: "owner" }, f.input)).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
    release(); await first; expect(f.authorize).toHaveBeenCalledTimes(1); expect(f.createRun).toHaveBeenCalledTimes(1);
    await expect(f.host.poll({ ...f.principal, deviceId: "other-device" }, [{ runId: "first", after: 0 }], new AbortController().signal, 0))
      .rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(f.slots.usage("source-device").device).toBe(1);
  } finally { release(); await f.host.dispose(); }
});

it("multiplexes two task cursors over one pending poll and cancels only the departing task", async () => {
  const f = fixture(), signal = new AbortController().signal;
  await f.host.open(f.principal, f.input); await f.host.open(f.principal, { ...f.input, runId: "second", nativeSessionId: "native-second" });
  let active = 0, maximum = 0;
  const poller = new HostedAgentPoller({ poll: async (cursors, pollSignal) => {
    maximum = Math.max(maximum, ++active); try { return await f.host.poll(f.principal, cursors, pollSignal); } finally { active--; }
  }, reply: async () => {}, readArtifact: async () => ({ data: "" }) });
  const first = poller.attach("first"), second = poller.attach("second"), leaving = new AbortController();
  try {
    const a = first.poll(0, leaving.signal); void a.catch(() => {}); const b = second.poll(0, signal);
    await vi.waitFor(() => expect(active).toBe(1)); leaving.abort(); await expect(a).rejects.toThrow("cancelled");
    f.exchanges.get("second")!.emit({ type: "status", key: "native", text: "second task output" });
    expect((await b).frames[0]?.payload).toMatchObject({ kind: "event", event: { text: "second task output" } });
    expect(maximum).toBe(1);
    expect((await f.host.poll(f.principal, [{ runId: "second", after: 0 }], signal, 0))[0]?.frames).toHaveLength(1);
    const acknowledged = second.poll(1, signal); void acknowledged.catch(() => {});
    await vi.waitFor(async () => { await expect(f.exchanges.get("second")!.poll(0, signal, 0)).rejects.toMatchObject({ code: "INVALID_CURSOR" }); });
    second.detach(); await expect(acknowledged).rejects.toThrow("detached");
  } finally { first.detach(); second.detach(); await poller.close(); await f.host.dispose(); }
});

it("expires a disconnected controller, retains closing output, and holds its quota until native cleanup confirms closure", async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ beforeClose: () => wait }); await f.host.open(f.principal, f.input);
  try {
    f.setNow(180_001); const sweeping = f.host.sweep();
    await vi.waitFor(() => expect(f.exchanges.get("first")!.poll(0, new AbortController().signal, 0)).resolves.toMatchObject({ finished: true }));
    expect(f.slots.usage("source-device").device).toBe(1); release(); await sweeping;
    expect(f.slots.usage("source-device").device).toBe(0);
    f.setNow(240_001); await f.host.sweep();
    expect(() => f.host.open(f.principal, f.input)).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
    expect(f.createRun).toHaveBeenCalledTimes(1);
  } finally { release(); await f.host.dispose(); }
});

it("closes native ownership when Provider permission is revoked even with an otherwise current device connection", async () => {
  const f = fixture(); await f.host.open(f.principal, f.input);
  try { f.disable(); await f.host.sweep(); expect(f.slots.usage("source-device").device).toBe(0); }
  finally { await f.host.dispose(); }
});

it("keeps an uncertain startup's native owner and quota until its exact process cleanup succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-cleanup-owner-")), database = new OperationalStore(":memory:");
  const slots = new HostedAgentSessionSlots(); let disposalAttempts = 0;
  const adapter = { id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    createSession: async () => { throw new Error("native startup failed"); },
    dispose: async () => { if (++disposalAttempts === 1) throw new Error("native process closure is uncertain"); } } as unknown as BackendAdapter;
  const principal: HostedAgentPrincipal = { id: "cleanup-owner", deviceId: "cleanup-device", trust: "guest", assertCurrent: () => {} };
  const input: HostedAgentOpen = { runId: "opening", nativeSessionId: "retained", start: "create", sessionId: "task", targetId: "workspace", generation: 1,
    backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
    workspace: { platform: "win32", shell: "bash", isGitRepository: false } };
  const host = new HostedAgentHost({ authorize: () => ({ root, store: new HostedAgentStore(database), slots, modelIds: ["model"], artifactCapacityBytes: 1024,
    assertCurrent: () => {}, assertModelAllowed: () => {}, createAdapter: () => adapter }) });
  try {
    await expect(host.open(principal, input)).rejects.toThrow("cleanup could not be confirmed");
    expect(slots.usage(principal.deviceId).device).toBe(1);
    expect(() => host.open(principal, { ...input, runId: "overlapping" })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    await host.sweep(); expect(disposalAttempts).toBe(2); expect(slots.usage(principal.deviceId).device).toBe(0);
    await expect(host.open(principal, { ...input, runId: "uncertain-native-resume", start: "resume" })).rejects.toThrow("cannot");
    expect(disposalAttempts).toBe(2);
  } finally {
    await host.dispose(); database.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});

it("accepts only current native commands and source data without inbound trust, callbacks, private grants or unsupported child controls", () => {
  const f = fixture(); void f.host.dispose();
  expect(decodeHostedAgentOpen(encodeHostedAgentValue(f.input))).toEqual(f.input);
  for (const field of ["trust", "deviceId", "assertCurrent", "createAdapter", "modelIds"]) {
    expect(() => decodeHostedAgentOpen(encodeHostedAgentValue({ ...f.input, [field]: "inbound-authority" }))).toThrow("invalid");
  }
  const command = { kind: "send", durableFence: true, input: { text: "a😀", images: [], files: [], mentions: [], disposition: "prompt",
    pastedTextRanges: [{ start: 1, end: 3, display: "paste" }] } };
  expect(decodeHostedAgentCall(encodeHostedAgentValue(command))).toEqual(command);
  expect(() => decodeHostedAgentCall(encodeHostedAgentValue({ ...command, input: { ...command.input, sessionReferenceSnapshots: [] } }))).toThrow("invalid");
  expect(() => decodeHostedAgentCall(encodeHostedAgentValue({ ...command, input: { ...command.input, pastedTextRanges: [{ start: 1, end: 2, display: "split" }] } }))).toThrow("invalid");
  expect(() => decodeHostedAgentCall(encodeHostedAgentValue({ kind: "control_subagent", input: { runId: "child", action: "remove" } }))).toThrow("invalid");
  expect(() => decodeHostedAgentCall(encodeHostedAgentValue({ kind: "shell", input: { command: "pwd", excludeFromContext: true, env: { TOKEN: "inbound" } } }))).toThrow("invalid");
});

it("persists an SDK binding change before publishing it and resumes that context after closing its native process", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-binding-switch-")), database = new OperationalStore(":memory:"), store = new HostedAgentStore(database);
  const first = { opaqueRef: "native-reference-first", nativeSessionId: "native-first", generation: 1 }, next = { ...first, opaqueRef: "native-reference-next", nativeSessionId: "native-next" };
  let resumed: unknown;
  const state = (binding: NativeSessionBinding) => ({ binding, streaming: false, compacting: false, pendingMessages: 0,
    providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" as const });
  const adapter = () => ({ id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    createSession: async (_input, context) => { await context.emit({ type: "native_session_changed", opaqueRef: first.opaqueRef, nativeSessionId: first.nativeSessionId }); return first; },
    setName: async (_name, context) => { await context.emit({ type: "native_session_changed", opaqueRef: next.opaqueRef, nativeSessionId: next.nativeSessionId }); },
    inspectSession: async binding => state(binding), resumeSession: async binding => { resumed = binding; return state(binding); }, dispose: async () => {}
  }) satisfies Partial<BackendAdapter>;
  const options = { root, runId: "first-run", nativeSessionId: "stable-native", start: "create" as const, store, slots: new HostedAgentSessionSlots(),
    source: { authorityId: "owning-controller", deviceId: "source", sessionId: "task", targetId: "workspace", generation: 1 },
    trust: "owner" as const, backendId: "native", providerId: "provider", modelId: "model", modelIds: ["model"], permissionMode: "ask" as const, fastMode: false,
    workspace: { platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }, artifactCapacityBytes: 1024,
    assertCurrent: () => {}, assertModelAllowed: () => {}, createAdapter: () => adapter() as unknown as BackendAdapter };
  let run: NativeRun | undefined, restored: NativeRun | undefined;
  try {
    run = await NativeRun.create(options);
    let publishedBinding: unknown; const detach = run.exchange.onOutput(() => { publishedBinding = store.find(run!.id)?.binding; });
    await run.call("native-switch", { kind: "set_name", name: "controlled native switch" }); detach();
    expect(publishedBinding).toEqual(next); expect((await run.call("observe-switch", { kind: "state" }) as { binding: unknown }).binding).toEqual(next);
    await run.close();
    restored = await NativeRun.create({ ...options, runId: "resumed-run", start: "resume" });
    expect(resumed).toEqual(next); expect((await restored.call("observe-resumed", { kind: "state" }) as { binding: unknown }).binding).toEqual(next);
  } finally {
    await restored?.close(); restored?.disposeExchange(); await run?.close(); run?.disposeExchange(); database.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
