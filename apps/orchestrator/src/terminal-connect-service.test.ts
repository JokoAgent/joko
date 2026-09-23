import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { TerminalError, TerminalProvider, type TerminalPty, type TerminalProviderOptions } from "@joko/tool-terminal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalConnectService } from "./terminal-connect-service.js";

const palette = { ansiRgb: [0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec], foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("TerminalService authority and volatile transport", () => {
  it("rechecks task policy after remote preparation and before launching the interactive shell", async () => {
    let ready!: (path: string) => void;
    const directory = vi.fn(async (root: string) => root).mockImplementationOnce(async () => new Promise<string>((resolve) => { ready = resolve; }));
    const spawn = vi.fn(async () => new FakePty());
    const f = await fixture({ resolveRemoteRuntime: async () => ({
      discoverShells: async () => [{ id: "/bin/sh", label: "sh", executable: "/bin/sh", args: ["-i"], isDefault: true }], canonicalDirectory: directory, spawn
    }) });
    const remoteWorkspace = { hostTargetId: "remote-target", hostId: "host-one", workspaceRoot: "/work/project" };
    f.store.upsertTarget({ ...f.store.getTarget("target").descriptor, id: "remote-target", remoteWorkspace });
    f.store.createSession({ ...f.store.getSession("task").descriptor, id: "remote-task", targetId: "remote-target", remoteWorkspace,
      binding: { opaqueRef: "remote-native", generation: 0 } });
    const request = create(contract.CreateTerminalRequestSchema, { sessionId: "remote-task", requestId: "late-policy", initialPalette: palette });
    const pending = f.service.createTerminal(request, f.context);
    await vi.waitFor(() => expect(directory).toHaveBeenCalledOnce());
    const policy = vi.spyOn(f.store, "findSessionRuntimePolicy").mockReturnValue({ sessionId: "remote-task", reviewRunId: "review",
      policy: "review_read_only", sourceLeaseFencingToken: 1n, revision: 1n, createdAt: 1, updatedAt: 1 });
    ready(remoteWorkspace.workspaceRoot);
    await expect(pending).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(spawn).not.toHaveBeenCalled();
    policy.mockRestore();
    expect((await f.service.createTerminal(request, f.context)).terminal?.status).toBe(contract.TerminalStatus.RUNNING);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("uses the remote scope and keeps an unconfirmed failed terminal observable while creation is unavailable", async () => {
    const pty = new FakePty();
    const replacement = new FakePty();
    const spawn = vi.fn().mockResolvedValueOnce(pty).mockResolvedValueOnce(replacement);
    let unavailable = false;
    const resolveRemoteRuntime = vi.fn<NonNullable<TerminalProviderOptions["resolveRemoteRuntime"]>>(async () => {
      if (unavailable) throw new TerminalError("RUNTIME_UNAVAILABLE", "Remote host is disconnected.");
      return { discoverShells: async () => [{ id: "/bin/sh", label: "sh", executable: "/bin/sh", args: ["-i"], isDefault: true }],
        canonicalDirectory: async (root) => root, spawn };
    });
    const f = await fixture({ resolveRemoteRuntime });
    const remoteWorkspace = { hostTargetId: "remote-target", hostId: "host-one", workspaceRoot: "/work/project" };
    f.store.upsertTarget({ ...f.store.getTarget("target").descriptor, id: "remote-target", remoteWorkspace });
    f.store.createSession({ ...f.store.getSession("task").descriptor, id: "remote-task", targetId: "remote-target", remoteWorkspace,
      binding: { opaqueRef: "remote-native", generation: 0 } });
    const capabilities = await f.service.getTerminalCapabilities(create(contract.GetTerminalCapabilitiesRequestSchema, { sessionId: "remote-task" }), f.context);
    expect(capabilities).toMatchObject({ support: contract.CapabilitySupport.SUPPORTED, defaultShellId: "/bin/sh" });
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { sessionId: "remote-task", requestId: "remote-start", initialPalette: palette }), f.context);
    expect(created.terminal).toMatchObject({ cwd: "/work/project", exitConfirmed: false, status: contract.TerminalStatus.RUNNING });
    expect(resolveRemoteRuntime.mock.calls[0]?.[0]).toEqual({ sessionId: "remote-task", targetId: "remote-target", remoteHostTargetId: "remote-target", remoteHostId: "host-one", workspaceRoot: "/work/project" });
    expect(f.spawn).not.toHaveBeenCalled();
    const reference = { sessionId: "remote-task", terminalId: created.terminal!.id, generation: created.terminal!.generation };
    pty.output("Remote process screen");
    await f.service.getTerminal(create(contract.GetTerminalRequestSchema, reference), f.context);
    pty.exit({ exitCode: -1, failureCode: "TERMINAL_UNKNOWN", processExitConfirmed: false });
    unavailable = true;
    expect(await f.service.getTerminalCapabilities(create(contract.GetTerminalCapabilitiesRequestSchema, { sessionId: "remote-task" }), f.context)).toMatchObject({
      support: contract.CapabilitySupport.PLATFORM_LIMITED, maximumInputBytes: 65536, maximumColumns: 500 });
    expect(await f.service.getTerminal(create(contract.GetTerminalRequestSchema, reference), f.context)).toMatchObject({
      serialized: expect.stringContaining("Remote process screen"), terminal: { status: contract.TerminalStatus.FAILED, exitConfirmed: false, failureCode: "TERMINAL_UNKNOWN" } });
    expect((await f.service.listTerminals(create(contract.ListTerminalsRequestSchema, { sessionId: "remote-task" }), f.context)).terminals).toHaveLength(1);
    const restart = create(contract.RestartTerminalRequestSchema, { ...reference, requestId: "remote-restart" });
    await expect(f.service.restartTerminal(restart, f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(spawn).toHaveBeenCalledOnce();
    unavailable = false;
    pty.exit({ exitCode: 0, processExitConfirmed: true });
    expect((await f.service.getTerminal(create(contract.GetTerminalRequestSchema, reference), f.context)).terminal?.exitConfirmed).toBe(true);
    const restarted = await f.service.restartTerminal(create(contract.RestartTerminalRequestSchema, { ...reference, requestId: "confirmed-restart" }), f.context);
    expect(restarted.terminal).toMatchObject({ status: contract.TerminalStatus.RUNNING, exitConfirmed: false });
    expect(restarted.terminal?.generation).not.toBe(reference.generation);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("binds appearance claims to the live authenticated Watch and never persists theme or focus", async () => {
    const f = await fixture();
    const before = f.store.health();
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { sessionId: "task", requestId: "missing-palette" }), f.context)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(f.spawn).not.toHaveBeenCalled();
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { sessionId: "task", requestId: "appearance", initialPalette: palette }), f.context);
    const reference = { sessionId: "task", terminalId: created.terminal!.id, generation: created.terminal!.generation };
    const view = { viewId: "live-view", viewRevision: 1n, palette };
    const controller = new AbortController();
    const context = { signal: controller.signal } as HandlerContext;
    const stream = f.service.watchTerminal(create(contract.WatchTerminalRequestSchema, { ...reference, appearance: view }), context)[Symbol.asyncIterator]();
    const first = (await stream.next()).value!;
    expect(first).toMatchObject({ activeColorOverrides: "", kind: contract.TerminalUpdateKind.RESET });
    const request = create(contract.UpdateTerminalAppearanceRequestSchema, { ...reference, appearance: { ...view, viewRevision: 2n, palette: { ...palette, foregroundRgb: 0x123456 } }, claimFocus: true, expectedAppearanceRevision: first.appearanceRevision });
    await expect(f.service.updateTerminalAppearance(request, { signal: new AbortController().signal, connectionId: "other" } as unknown as HandlerContext)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const result = await f.service.updateTerminalAppearance(request, f.context);
    expect(result).toMatchObject({ accepted: true, acceptedViewRevision: 2n, ownsDefaults: true });
    expect(await f.service.updateTerminalAppearance(request, f.context)).toEqual(result);
    controller.abort();
    await expect(f.service.updateTerminalAppearance(request, f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await stream.return?.();
    expect(f.ptys[0]!.kill).not.toHaveBeenCalled();
    expect(f.store.health().revision).toBe(before.revision);
    expect(f.store.health().globalCursor).toBe(before.globalCursor);
  });

  it("allows many observers but only the current control view can write or resize", async () => {
    const f = await fixture();
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, {
      sessionId: "task",
      requestId: "unique-control-view",
      initialPalette: palette
    }), f.context);
    const terminal = created.terminal!;
    const reference = { sessionId: "task", terminalId: terminal.id, generation: terminal.generation };
    const first = await claimControlView(f, terminal, "first-view");
    const second = await claimControlView(f, terminal, "second-view");

    await expect(f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, {
      ...reference, writerId: first.viewId, inputSequence: 1n, data: "stale controller"
    }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(f.service.resizeTerminal(create(contract.ResizeTerminalRequestSchema, {
      ...reference, viewId: first.viewId, columns: 90, rows: 30
    }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, {
      ...reference, writerId: second.viewId, inputSequence: 1n, data: "current controller"
    }), f.context);
    await f.service.resizeTerminal(create(contract.ResizeTerminalRequestSchema, {
      ...reference, viewId: second.viewId, columns: 91, rows: 31
    }), f.context);
    expect(f.ptys[0]!.write).toHaveBeenCalledExactlyOnceWith("current controller");
    expect(f.ptys[0]!.resize).toHaveBeenCalledExactlyOnceWith(91, 31);

    await second.close();
    await expect(f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, {
      ...reference, writerId: first.viewId, inputSequence: 1n, data: "no implicit takeover"
    }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const current = await f.service.getTerminal(create(contract.GetTerminalRequestSchema, reference), f.context);
    const reclaimed = await f.service.updateTerminalAppearance(create(contract.UpdateTerminalAppearanceRequestSchema, {
      ...reference,
      appearance: { viewId: first.viewId, viewRevision: 3n, palette },
      claimFocus: true,
      expectedAppearanceRevision: current.appearanceRevision
    }), f.context);
    expect(reclaimed).toMatchObject({ accepted: true, ownsDefaults: true });
    await f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, {
      ...reference, writerId: first.viewId, inputSequence: 1n, data: "explicit takeover"
    }), f.context);
    expect(f.ptys[0]!.write).toHaveBeenLastCalledWith("explicit takeover");
  });

  it("blocks terminal mutations while a portable task replacement is quiescing but still permits observation and close", async () => {
    let replacementPending = false;
    const f = await fixture({ isSessionMutationBlocked: () => replacementPending });
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, {
      sessionId: "task",
      requestId: "portable-replacement-fence",
      initialPalette: palette
    }), f.context);
    const terminal = created.terminal!;
    const reference = { sessionId: "task", terminalId: terminal.id, generation: terminal.generation };
    const control = await claimControlView(f, terminal, "replacement-view");
    replacementPending = true;

    expect(await f.service.getTerminalCapabilities(create(contract.GetTerminalCapabilitiesRequestSchema, {
      sessionId: "task"
    }), f.context)).toMatchObject({ support: contract.CapabilitySupport.DISABLED_BY_POLICY });
    await expect(f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, {
      ...reference,
      writerId: control.viewId,
      inputSequence: 1n,
      data: "must not reach the process"
    }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(f.service.resizeTerminal(create(contract.ResizeTerminalRequestSchema, {
      ...reference,
      viewId: control.viewId,
      columns: 90,
      rows: 30
    }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect((await f.service.getTerminal(create(contract.GetTerminalRequestSchema, reference), f.context)).terminal)
      .toMatchObject({ id: terminal.id, status: contract.TerminalStatus.RUNNING });
    await f.service.closeTerminal(create(contract.CloseTerminalRequestSchema, reference), f.context);
    expect(f.ptys[0]!.write).not.toHaveBeenCalled();
    expect(f.ptys[0]!.resize).not.toHaveBeenCalled();
    expect(f.ptys[0]!.kill).toHaveBeenCalledOnce();
  });

  it("allows a confirmed cancelled start to retry the same request identity", async () => {
    const f = await fixture();
    const request = create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "cancelled-start" });
    await expect(f.service.createTerminal(request, { signal: AbortSignal.abort() } as HandlerContext)).rejects.toMatchObject({ code: Code.Canceled });
    expect(f.spawn).not.toHaveBeenCalled();
    expect((await f.service.createTerminal(request, f.context)).terminal?.status).toBe(contract.TerminalStatus.RUNNING);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("starts one process through concurrent retries and fences input generations and sequence without durable content", async () => {
    const f = await fixture();
    const before = f.store.health();
    const request = create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "create-one" });
    const [first, duplicate] = await Promise.all([f.service.createTerminal(request, f.context), f.service.createTerminal(request, f.context)]);
    expect(first.terminal?.id).toBe(duplicate.terminal?.id);
    expect(f.spawn).toHaveBeenCalledOnce();
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { ...request, columns: 90 }), f.context)).rejects.toMatchObject({ code: Code.AlreadyExists });
    const terminal = first.terminal!;
    const control = await claimControlView(f, terminal, "view");
    await f.service.resizeTerminal(create(contract.ResizeTerminalRequestSchema, { sessionId: "task", terminalId: terminal.id,
      generation: terminal.generation, viewId: control.viewId, columns: 92, rows: 28 }), f.context);
    expect((await f.service.createTerminal(request, f.context)).terminal).toMatchObject({ columns: 92, rows: 28 });
    const input = create(contract.WriteTerminalRequestSchema, { sessionId: "task", terminalId: terminal.id, generation: terminal.generation,
      writerId: "view", inputSequence: 1n, data: "private pasted command\r" });
    const acknowledgements = await Promise.all([f.service.writeTerminal(input, f.context), f.service.writeTerminal(input, f.context)]);
    expect(acknowledgements).toMatchObject([{ nextInputSequence: 2n }, { nextInputSequence: 2n }]);
    expect(f.ptys[0]!.write).toHaveBeenCalledTimes(1);
    await expect(f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, { ...input, data: "different private input" }), f.context))
      .rejects.toMatchObject({ code: Code.AlreadyExists });
    expect(f.ptys[0]!.write).toHaveBeenCalledTimes(1);
    await expect(f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, { ...input, inputSequence: 3n }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await f.provider.kill({ ...f.scope, id: terminal.id!, generation: Number(terminal.generation) });
    const restarted = await f.service.restartTerminal(create(contract.RestartTerminalRequestSchema, {
      sessionId: "task", terminalId: terminal.id, generation: terminal.generation, requestId: "restart-one"
    }), f.context);
    expect(restarted.terminal!.generation).not.toBe(terminal.generation);
    await expect(f.service.createTerminal(request, f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(f.service.writeTerminal(input, f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(f.store.health().revision).toBe(before.revision);
    expect(f.store.health().globalCursor).toBe(before.globalCursor);
  });

  it("fences queued input after revocation while retaining the acknowledged outcome of earlier input", async () => {
    const f = await fixture();
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "queued" }), f.context);
    let acknowledge!: () => void;
    f.ptys[0]!.write.mockImplementationOnce(async () => { await new Promise<void>((done) => { acknowledge = done; }); });
    const control = await claimControlView(f, created.terminal!, "queued-view");
    const base = { sessionId: "task", terminalId: created.terminal!.id, generation: created.terminal!.generation, writerId: control.viewId };
    const first = f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, { ...base, inputSequence: 1n, data: "first" }), f.context);
    const second = f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, { ...base, inputSequence: 2n, data: "second" }), f.context);
    const outcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(f.ptys[0]!.write).toHaveBeenCalledOnce());
    f.revoke();
    acknowledge();
    expect(await outcomes).toMatchObject([
      { status: "rejected", reason: { code: Code.Unauthenticated } },
      { status: "rejected", reason: { code: Code.Unauthenticated } }
    ]);
    await control.close();
    expect(f.ptys[0]!.write).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
  });

  it("restores parsed screen after disconnect and wakes an idle subscriber on authorization revocation without killing the process", async () => {
    const f = await fixture();
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "stream" }), f.context);
    const request = create(contract.WatchTerminalRequestSchema, { appearance: { viewId: "view-one", viewRevision: 1n, palette }, sessionId: "task", terminalId: created.terminal!.id, generation: created.terminal!.generation });
    const stream = f.service.watchTerminal(request, f.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: contract.TerminalUpdateKind.RESET });
    f.ptys[0]!.output("\x1b[31mprivate screen\x1b[0m");
    const output = await stream.next();
    expect(output.value).toMatchObject({ kind: contract.TerminalUpdateKind.OUTPUT, data: "\x1b[31mprivate screen\x1b[0m" });
    await stream.return?.();
    expect(f.ptys[0]!.kill).not.toHaveBeenCalled();
    const restored = await f.service.getTerminal(create(contract.GetTerminalRequestSchema, { sessionId: "task", terminalId: created.terminal!.id }), f.context);
    expect(restored.serialized).toContain("private screen");
    const reconnected = f.service.watchTerminal(create(contract.WatchTerminalRequestSchema, { ...request, appearance: create(contract.TerminalViewAppearanceSchema, { viewId: "view-two", viewRevision: 1n, palette }) }), f.context)[Symbol.asyncIterator]();
    expect((await reconnected.next()).value).toMatchObject({ kind: contract.TerminalUpdateKind.RESET, activeColorOverrides: "" });
    const pending = reconnected.next();
    f.revoke();
    await expect(pending).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(f.listeners.size).toBe(0);
    expect(f.ptys[0]!.kill).not.toHaveBeenCalled();
  });

  it("fences queued resizing after a policy change while retaining observation and close", async () => {
    const f = await fixture();
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "queued-resize" }), f.context);
    const reference = { sessionId: "task", terminalId: created.terminal!.id, generation: created.terminal!.generation };
    const control = await claimControlView(f, created.terminal!, "resize-view");
    const request = create(contract.ResizeTerminalRequestSchema, { ...reference, viewId: control.viewId, columns: 92, rows: 28 });
    let finishResize!: () => void;
    f.ptys[0]!.resize.mockImplementationOnce(() => new Promise<void>((resolve) => { finishResize = resolve; }));
    const first = f.service.resizeTerminal(request, f.context);
    await vi.waitFor(() => expect(f.ptys[0]!.resize).toHaveBeenCalledOnce());
    const second = f.service.resizeTerminal(create(contract.ResizeTerminalRequestSchema, { ...request, columns: 100 }), f.context);
    const outcomes = Promise.allSettled([first, second]);
    vi.spyOn(f.store, "findSessionRuntimePolicy").mockReturnValue({ sessionId: "task", reviewRunId: "review",
      policy: "review_read_only", sourceLeaseFencingToken: 1n, revision: 1n, createdAt: 1, updatedAt: 1 });
    finishResize();
    expect(await outcomes).toMatchObject([
      { status: "rejected", reason: { code: Code.PermissionDenied } },
      { status: "rejected", reason: { code: Code.PermissionDenied } }
    ]);
    expect(f.ptys[0]!.resize).toHaveBeenCalledTimes(1);
    expect((await f.service.getTerminal(create(contract.GetTerminalRequestSchema, reference), f.context)).terminal).toMatchObject({ columns: 92, rows: 28 });
    const appearance = { viewId: "read-only-view", viewRevision: 1n, palette };
    const stream = f.service.watchTerminal(create(contract.WatchTerminalRequestSchema, { ...reference, appearance }), f.context)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: contract.TerminalUpdateKind.RESET, terminal: { columns: 92, rows: 28 } });
    const observedOutput = stream.next();
    f.ptys[0]!.output("screen remains observable");
    expect((await observedOutput).value).toMatchObject({ kind: contract.TerminalUpdateKind.OUTPUT, data: "screen remains observable" });
    await expect(f.service.updateTerminalAppearance(create(contract.UpdateTerminalAppearanceRequestSchema, { ...reference, appearance }), f.context)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(f.service.writeTerminal(create(contract.WriteTerminalRequestSchema, { ...reference, writerId: "read-only", inputSequence: 1n, data: "do not execute" }), f.context)).rejects.toMatchObject({ code: Code.PermissionDenied });
    await stream.return?.();
    await f.service.closeTerminal(create(contract.CloseTerminalRequestSchema, reference), f.context);
    expect(f.ptys[0]!.kill).toHaveBeenCalledOnce();
  });

  it("resolves the isolated task directory and rejects unconfigured remote, archived and closing tasks before spawn", async () => {
    const f = await fixture();
    const isolated = join(f.root, "isolated");
    await mkdir(isolated);
    f.setEffectiveRoot(isolated);
    await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "isolated" }), f.context);
    expect(f.spawn.mock.calls[0]![2]).toMatchObject({ cwd: isolated });
    f.store.updateSession("task", { archived: true });
    expect(await f.service.getTerminalCapabilities(create(contract.GetTerminalCapabilitiesRequestSchema, { sessionId: "task" }), f.context)).toMatchObject({ support: contract.CapabilitySupport.DISABLED_BY_POLICY });
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "archived" }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    f.store.updateSession("task", { archived: false });
    const existing = f.store.getSession("task").descriptor;
    const remoteWorkspace = { hostTargetId: "remote-target", hostId: "remote-host", workspaceRoot: "/remote/workspace" };
    f.store.upsertTarget({ ...f.store.getTarget("target").descriptor, id: "remote-target", remoteWorkspace });
    f.store.createSession({ ...existing, id: "remote-task", targetId: "remote-target", remoteWorkspace, binding: { opaqueRef: "remote-native", generation: 0 } });
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "remote-task", requestId: "remote" }), f.context)).rejects.toMatchObject({ code: Code.Unimplemented });
    const policy = vi.spyOn(f.store, "findSessionRuntimePolicy").mockReturnValue({ sessionId: "task", reviewRunId: "review",
      policy: "review_read_only", sourceLeaseFencingToken: 1n, revision: 1n, createdAt: 1, updatedAt: 1 });
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "read-only" }), f.context)).rejects.toMatchObject({ code: Code.PermissionDenied });
    policy.mockRestore();
    const scheduleDeletion = vi.spyOn(f.store, "findPendingScheduleDeletionCleanupForSession")
      .mockReturnValue({} as never);
    expect(await f.service.getTerminalCapabilities(create(contract.GetTerminalCapabilitiesRequestSchema, {
      sessionId: "task"
    }), f.context)).toMatchObject({ support: contract.CapabilitySupport.DISABLED_BY_POLICY });
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, {
      initialPalette: palette,
      sessionId: "task",
      requestId: "schedule-closing"
    }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    scheduleDeletion.mockRestore();
    f.store.prepareSessionLifecycleCleanup({ sessionId: "task", operationId: "closing", disposition: "archive" });
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "closing" }), f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it("does not retry uncertain input and closes a process whose workspace authority changes while creating", async () => {
    const f = await fixture();
    const created = await f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "uncertain" }), f.context);
    const control = await claimControlView(f, created.terminal!, "uncertain-view");
    f.ptys[0]!.write.mockImplementation(() => { throw new Error("native error with private contents"); });
    const input = create(contract.WriteTerminalRequestSchema, { sessionId: "task", terminalId: created.terminal!.id,
      generation: created.terminal!.generation, writerId: control.viewId, inputSequence: 1n, data: "private" });
    await expect(f.service.writeTerminal(input, f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(f.service.writeTerminal(input, f.context)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(f.ptys[0]!.write).toHaveBeenCalledTimes(1);
    const other = join(f.root, "other");
    await mkdir(other);
    f.spawn.mockImplementationOnce(() => { f.setEffectiveRoot(other); const pty = new FakePty(); f.ptys.push(pty); return pty; });
    await expect(f.service.createTerminal(create(contract.CreateTerminalRequestSchema, { initialPalette: palette, sessionId: "task", requestId: "changed-root" }), f.context)).rejects.toMatchObject({ code: Code.Aborted });
    expect(f.ptys[1]!.kill).toHaveBeenCalledOnce();
  });
});

class FakePty implements TerminalPty {
  readonly pid = 123;
  readonly write = vi.fn<(data: string) => void>();
  readonly resize = vi.fn();
  readonly kill = vi.fn(() => { for (const listener of this.exitListeners) listener({ exitCode: 0 }); });
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<Parameters<TerminalPty["onExit"]>[0]>();
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } }; }
  onExit(listener: Parameters<TerminalPty["onExit"]>[0]) { this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } }; }
  output(data: string) { for (const listener of this.dataListeners) listener(data); }
  exit(event: Parameters<Parameters<TerminalPty["onExit"]>[0]>[0]) { for (const listener of this.exitListeners) listener(event); }
}

async function claimControlView(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  terminal: { readonly id?: string; readonly generation?: bigint },
  viewId: string
) {
  if (terminal.id === undefined || terminal.id === "" || terminal.generation === undefined) {
    throw new Error("Terminal control view requires a current terminal identity.");
  }
  const controller = new AbortController();
  const context = { signal: controller.signal } as HandlerContext;
  const reference = { sessionId: "task", terminalId: terminal.id, generation: terminal.generation };
  const initialAppearance = { viewId, viewRevision: 1n, palette };
  const stream = fixtureValue.service.watchTerminal(create(contract.WatchTerminalRequestSchema, {
    ...reference,
    appearance: initialAppearance
  }), context)[Symbol.asyncIterator]();
  const first = await stream.next();
  if (first.done || first.value === undefined) throw new Error("Terminal control view did not receive its initial checkpoint.");
  const claim = await fixtureValue.service.updateTerminalAppearance(create(contract.UpdateTerminalAppearanceRequestSchema, {
    ...reference,
    appearance: { ...initialAppearance, viewRevision: 2n },
    claimFocus: true,
    expectedAppearanceRevision: first.value.appearanceRevision
  }), fixtureValue.context);
  if (!claim.accepted || !claim.ownsDefaults) throw new Error("Terminal control view was not admitted.");
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    controller.abort();
    await stream.return?.();
  };
  cleanups.push(close);
  return { viewId, stream, close };
}

async function fixture(options: Pick<TerminalProviderOptions, "resolveRemoteRuntime"> & {
  readonly isSessionMutationBlocked?: (sessionId: string) => boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-terminal-service-"));
  const store = new OperationalStore(join(root, "store.db"));
  store.upsertBackend({ id: "test-backend", displayName: "Test backend", version: "test", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "test-backend", displayName: "Project", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: "task", backendId: "test-backend", targetId: "target", title: "Task", binding: { opaqueRef: "native-task", generation: 0 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const ptys: FakePty[] = [];
  const spawn = vi.fn<NonNullable<ConstructorParameters<typeof TerminalProvider>[0]>["spawn"] & {}>(() => { const pty = new FakePty(); ptys.push(pty); return pty; });
  const { isSessionMutationBlocked, ...providerOptions } = options;
  const provider = new TerminalProvider({ ...providerOptions, spawn, shells: async () => [{ id: "test-shell", label: "Test shell", executable: process.execPath, args: [], isDefault: true }] });
  const listeners = new Set<() => void>();
  let authorized = true;
  let effectiveRoot = root;
  const service = createTerminalConnectService({ terminals: provider, store, effectiveTarget: () => ({ workspaceRoot: effectiveRoot }),
    authenticate: (context) => { if (!authorized) throw new ConnectError("Connection revoked.", Code.Unauthenticated); return { id: (context as HandlerContext & { connectionId?: string }).connectionId ?? "connection" }; },
    onRevoked: (_id, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ...(isSessionMutationBlocked === undefined ? {} : { isSessionMutationBlocked }) });
  cleanups.push(async () => { await provider.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, ptys, spawn, provider, service, listeners, scope: { sessionId: "task", targetId: "target", workspaceRoot: root },
    context: { signal: new AbortController().signal } as HandlerContext,
    setEffectiveRoot: (value: string) => { effectiveRoot = value; },
    revoke: () => { authorized = false; for (const listener of listeners) listener(); } };
}
