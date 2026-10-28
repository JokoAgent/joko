import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext, BackendAdapter, NativeSessionBinding } from "@joko/core";
import { managedSubagentRunRoot, managedSubagentSessionKey, type PiHostedBackgroundScope } from "@joko/adapter-pi";
import { expect, it, vi, afterEach } from "vitest";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { HostedAgentExchange } from "./hosted-agent-exchange.js";
import { HostedAgentHost, type HostedAgentOpen, type HostedAgentPrincipal } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import type { HostedAgentRun } from "./hosted-agent-run.js";
import { decodeHostedAgentCall, decodeHostedAgentOpen, encodeHostedAgentValue } from "./hosted-agent-wire.js";
import { HostedAgentRun as NativeRun } from "./hosted-agent-run.js";
import { createClient, createRouterTransport, Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
const databases: OperationalStore[] = [];
afterEach(() => { for (const store of databases.splice(0)) store.close(); });

it("protects background work from idle release and retries only the approved native close when its outcome is uncertain", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-idle-")), database = new OperationalStore(":memory:"), store = new HostedAgentStore(database);
  let now = 0, context!: AdapterContext, disposals = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const slots = new HostedAgentSessionSlots(), binding = { opaqueRef: "native-history", nativeSessionId: "history", generation: 1 };
  const adapter = { id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    createSession: async (_input, input) => { context = input; return binding; },
    inspectSession: async () => ({ binding, streaming: false, compacting: false, pendingMessages: 0, fastMode: false, permissionMode: "ask" }),
    getNativeHistoryProjection: async () => ({ events: [] }),
    dispose: async () => { if (++disposals === 1) throw new Error("Native closure is uncertain."); }
  } satisfies Partial<BackendAdapter>;
  let run: NativeRun | undefined;
  try {
    run = await NativeRun.create({ root, runId: "idle-run", nativeSessionId: "retained", start: "create", store, slots,
      source: { authorityId: "owner", deviceId: "source", sessionId: "task", targetId: "workspace", generation: 1 },
      trust: "owner", backendId: "native", providerId: "provider", modelId: "model", modelIds: ["model"], permissionMode: "ask", fastMode: false,
      workspace: { platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }, artifactCapacityBytes: 1024,
      assertCurrent: () => {}, assertModelAllowed: () => {}, createAdapter: () => adapter as unknown as BackendAdapter });
    await context.emit({ type: "background_task", taskId: "background", title: "Active background work", state: "running" });
    now = 120_000; expect(await run.call("busy-idle", { kind: "idle_release", idleMinutes: 1 })).toBe(false); expect(disposals).toBe(0);
    await context.emit({ type: "background_task", taskId: "background", title: "Finished background work", state: "completed" });
    expect(await run.call("recent-idle", { kind: "idle_release", idleMinutes: 1 })).toBe(false);
    now = 240_000; await expect(run.call("release-idle", { kind: "idle_release", idleMinutes: 1 })).rejects.toThrow("uncertain");
    expect(slots.summary().total).toBe(1);
    expect(await run.call("recover-idle", { kind: "idle_release_status", releaseCallId: "release-idle" })).toBe("released");
    expect(disposals).toBe(2); expect(slots.summary().total).toBe(0); expect(store.find(run.id)?.state).toBe("closed");
    expect(() => run!.call("new-input", { kind: "abort" })).toThrow();
  } finally {
    await run?.close(); run?.disposeExchange(); database.close(); clock.mockRestore();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});

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

it("carries native admission rejection through the generated service while keeping payload failures outside that retry authority", async () => {
  const f = fixture(), occupied = Array.from({ length: 16 }, () => f.slots.reserve(f.principal.deviceId));
  const generated = createClient(contract.HostedAgentService, createRouterTransport(router => router.service(contract.HostedAgentService,
    createHostedAgentConnectService({ host: f.host, authenticate: () => f.principal }))));
  const client = new HostedAgentConnectClient(generated, f.principal.assertCurrent);
  try {
    const response = await generated.openHostedAgent({ format: 1, openJson: encodeHostedAgentValue(f.input) });
    expect(response.capacityRejection).toBe(contract.HostedAgentCapacityRejection.DEVICE_LIMIT); expect(response.virtualRoot).toBe("");
    await expect(client.open({ ...f.input, runId: "another-rejected-open" }, new AbortController().signal)).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect(f.slots.summary().total).toBe(16); expect(f.exchanges.size).toBe(0);
  } finally { occupied.forEach(slot => slot.release()); await f.host.dispose(); }
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

it("reserves one original child registration before its tool owner arrives and grants no effects to either reserved runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-child-registration-")), database = new OperationalStore(":memory:"), store = new HostedAgentStore(database);
  let context!: AdapterContext;
  const binding = { opaqueRef: "controlled-native", nativeSessionId: "controlled-native", generation: 1 };
  const adapter = { id: "pi", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    createSession: async (_input, current) => { context = current; return binding; },
    send: async (_input, current) => { context = current; }, dispose: async () => {} } satisfies Partial<BackendAdapter>;
  let run: NativeRun | undefined;
  try {
    run = await NativeRun.create({ root, runId: "registered-source", nativeSessionId: "stable-source", start: "create", store, slots: new HostedAgentSessionSlots(),
      source: { authorityId: "controller", deviceId: "source", sessionId: "task", targetId: "workspace", generation: 1 },
      trust: "owner", backendId: "pi", providerId: "provider", modelId: "model", modelIds: ["model"], permissionMode: "ask", fastMode: false,
      workspace: { platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false, subagentsEnabled: true },
      artifactCapacityBytes: 1024, assertCurrent: () => {}, assertModelAllowed: () => {}, createAdapter: () => adapter as unknown as BackendAdapter });
    await run.call("original-parent", { kind: "send", durableFence: false, input: { text: "Register the exact child", images: [], files: [], mentions: [], disposition: "prompt" } });
    const original = context, taskId = "native-parent-tool:step-1";
    const reserved = async (): Promise<PiHostedBackgroundScope> => {
      const scope = { taskId, runId: randomUUID(), launchToken: randomUUID(), runnerInstanceId: randomUUID(), nativeSessionId: randomUUID() };
      const directory = join(managedSubagentRunRoot(join(root, run!.id, "native")), managedSubagentSessionKey(context.sessionId), scope.runId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const runnerScript = join(directory, "joko-managed-subagent-runner.cjs"), transcriptPath = join(directory, "transcript.jsonl"), script = "// controlled runner\n";
      const identity = { format: 1, runId: scope.runId, launchToken: scope.launchToken, runnerInstanceId: scope.runnerInstanceId,
        productSessionId: context.sessionId, taskId, runnerScript, runnerScriptSha256: createHash("sha256").update(script).digest("hex") };
      await Promise.all([writeFile(runnerScript, script), writeFile(transcriptPath, ""),
        writeFile(join(directory, "config.json"), JSON.stringify({ ...identity, productGeneration: 1, nativeSessionId: scope.nativeSessionId,
          parentTaskId: "native-parent-tool", title: "Controlled child", background: true, transcriptPath })),
        writeFile(join(directory, "owner.json"), JSON.stringify({ ...identity, state: "reserved", runnerPid: 0 })),
        writeFile(join(directory, "status.json"), JSON.stringify({ ...identity, state: "queued", runnerPid: 0, nativeSessionId: scope.nativeSessionId,
          transcriptPath, createdAt: Date.now(), heartbeatAt: Date.now() }))]);
      return scope;
    };
    const scopes = await Promise.all([reserved(), reserved()]);
    const post = async (scope: PiHostedBackgroundScope, register: boolean, occurrence?: string, scoped = true) => {
      const callId = occurrence ?? (register ? "background-" + scope.runId : "tool-" + randomUUID());
      const channel = context.hostedExecution!.channel;
      const response = await fetch(channel.endpoint + "/execute", { method: "POST", signal: AbortSignal.timeout(10_000),
        headers: { authorization: "Bearer " + channel.bearer, "content-type": "application/json" },
        body: JSON.stringify({ format: 1, callId, requestId: callId + ":1", origin: "agent", operation: register ? "background.register" : "tool.begin",
          payload: register ? scope : { name: "read", input: { path: "proof.txt" } }, ...(register || !scoped ? {} : { backgroundScope: scope }) }) });
      return await response.json() as { ok: boolean; error?: { code: string } };
    };
    const registering = scopes.map(scope => post(scope, true));
    for (const pending of registering) void pending.catch(() => {});
    const blocked = await Promise.race(registering);
    expect(blocked).toMatchObject({ ok: false, error: { code: "EXECUTOR_FAILED" } });
    // Only the first registration is waiting for this exact native tool event.
    await original.emit({ type: "tool_start", callId: "native-parent-tool", name: "subagent", input: "{}" });
    await run.call("later-input", { kind: "send", durableFence: false, input: { text: "Another foreground input", images: [], files: [], mentions: [], disposition: "prompt" } });
    let registration: Extract<import("./hosted-agent-exchange.js").HostedAgentFrame["payload"], { kind: "request" }> | undefined;
    await vi.waitFor(async () => {
      const frames = (await run!.exchange.poll(0, new AbortController().signal, 0)).frames.filter(frame => frame.payload.kind === "request");
      expect(frames).toHaveLength(1);
      const payload = frames[0]!.payload;
      if (payload.kind === "request") registration = payload;
    });
    expect(registration!.operationId).toBe("original-parent");
    run.exchange.reply(registration!.id, { ok: true, value: { registered: true } });
    expect((await Promise.all(registering)).map(reply => reply.ok).sort()).toEqual([false, true]);
    for (const scope of scopes) expect((await post(scope, false)).ok).toBe(false);
    const registeredScopeId = registration!.request.kind === "tool" ? (registration!.request.input as { scopeId: string }).scopeId : undefined;
    const scope = scopes.find(candidate => candidate.runId === registeredScopeId)!;
    const directory = join(managedSubagentRunRoot(join(root, run.id, "native")), managedSubagentSessionKey(context.sessionId), scope.runId);
    const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
    const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
    await Promise.all([writeFile(join(directory, "owner.json"), JSON.stringify({ ...owner, state: "running", runnerPid: process.pid })),
      writeFile(join(directory, "status.json"), JSON.stringify({ ...status, state: "running", runnerPid: process.pid })),
      writeFile(join(directory, "runner.claim.json"), JSON.stringify({ format: 1, runId: scope.runId, launchToken: scope.launchToken,
        runnerPid: process.pid, runnerInstanceId: scope.runnerInstanceId, runnerScriptSha256: owner.runnerScriptSha256 }))]);
    let replied = 1;
    const confirmTool = async (expectedOperationId: string) => {
      let request: typeof registration;
      await vi.waitFor(async () => {
        const requests = (await run!.exchange.poll(0, new AbortController().signal, 0)).frames.filter(frame => frame.payload.kind === "request");
        expect(requests).toHaveLength(replied + 1);
        const payload = requests.at(-1)!.payload; if (payload.kind === "request") request = payload;
      });
      expect(request!.operationId).toBe(expectedOperationId);
      run!.exchange.reply(request!.id, { ok: true, value: {} }); replied++;
    };
    const heldCallId = "tool-" + randomUUID(), childBegin = post(scope, false, heldCallId);
    await confirmTool("original-parent"); expect((await childBegin).ok).toBe(true);
    await writeFile(join(directory, "status.json"), JSON.stringify({ ...status, state: "aborted", runnerPid: process.pid, endedAt: Date.now() }));
    await original.emit({ type: "subagent_run", run: { id: taskId, sessionId: original.sessionId, logicalAgentId: taskId,
      identityAliases: [scope.nativeSessionId], providerRunIds: [scope.runId], state: "stopped", title: "Cancelled child",
      startedAt: 1, updatedAt: Date.now(), endedAt: Date.now(), activity: [], capabilities: { viewActivity: true, viewReturnedResult: true,
        viewFullTranscript: true, stop: false, steer: false, followUp: false, resume: true, parentContext: "none" } } });
    expect((await post(scope, false)).ok).toBe(false);
    // Cancellation retired the child occurrence. Its ID is available to an
    // independently owned foreground call, without reviving the old scope.
    const foregroundBegin = post(scope, false, heldCallId, false);
    await confirmTool("later-input"); expect((await foregroundBegin).ok).toBe(true);
  } finally {
    await run?.close(); run?.disposeExchange(); database.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});

it.each(["complete", "reserved", "source-retired"] as const)("retains exact native rewind ownership across %s replacement and restart without replaying navigation", async failure => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-native-rewind-")), database = new OperationalStore(":memory:"), store = new HostedAgentStore(database);
  const first = { opaqueRef: "native-first", nativeSessionId: "first", generation: 1 }, next = { opaqueRef: "native-next", nativeSessionId: "next", generation: 2 };
  const resumed: NativeSessionBinding[] = [], removed: NativeSessionBinding[] = [];
  let navigations = 0, resumeFailed = false;
  const state = (binding: NativeSessionBinding) => ({ binding, streaming: false, compacting: false, pendingMessages: 0,
    providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" as const });
  const adapter = (): BackendAdapter => ({ id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
    createSession: async () => first, inspectSession: async binding => state(binding),
    resumeSession: async binding => { resumed.push(binding); if (failure === "source-retired" && !resumeFailed) { resumeFailed = true; throw new Error("Native restore confirmation lost."); } return state(binding); },
    navigateTree: async (_target, _summarize, _context, _instructions, navigation) => {
      navigations++; navigation.recordBinding(next); if (failure === "reserved") throw new Error("Native rewind confirmation lost.");
      return { kind: "replacement", binding: next, nativeHistory: { events: [], activeLineage: [] } };
    }, closeSession: async () => {}, deleteSession: async binding => { removed.push(binding); },
    getNativeHistoryProjection: async () => ({ events: [], activeLineage: [] }), dispose: async () => {}
  } satisfies Partial<BackendAdapter>) as unknown as BackendAdapter;
  const options = { root, runId: "first-run", nativeSessionId: "stable-actor", start: "create" as const, store, slots: new HostedAgentSessionSlots(),
    source: { authorityId: "controller", deviceId: "source", sessionId: "task", targetId: "workspace", generation: 1 },
    trust: "owner" as const, backendId: "native", providerId: "provider", modelId: "model", modelIds: ["model"], permissionMode: "ask" as const, fastMode: false,
    workspace: { platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }, artifactCapacityBytes: 1024,
    assertCurrent: () => {}, assertModelAllowed: () => {}, createAdapter: adapter };
  let run: NativeRun | undefined, restored: NativeRun | undefined;
  try {
    run = await NativeRun.create(options);
    const command = { kind: "navigate" as const, target: { kind: "session_start" as const }, summarize: false };
    if (failure === "complete") {
      await expect(run.call("native-rewind", command)).resolves.toBeNull();
      await expect(run.call("native-rewind", command)).resolves.toBeNull();
      expect(store.find(run.id)?.binding).toEqual(next);
    } else await expect(run.call("native-rewind", command)).rejects.toThrow("confirmation lost");
    await run.close();
    restored = await NativeRun.create({ ...options, runId: "restored-run", start: "resume" });
    const expected = failure === "reserved" ? first : next;
    expect((await restored.call("restored-state", { kind: "state" }) as { binding: unknown }).binding).toEqual(expected);
    expect(resumed.at(-1)).toEqual(expected); expect(navigations).toBe(1);
    expect(removed).toEqual(failure === "reserved" ? [next] : []);
    expect(database.listSettingsByKeyPrefix("service", "native-hosted-navigation.v1", "")).toEqual([]);
  } finally {
    await restored?.close(); restored?.disposeExchange(); await run?.close(); run?.disposeExchange(); database.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
