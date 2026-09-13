import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RemoteSshError, type RemoteProcessHandle, type RemoteSshTransportLease, type RemoteTerminalHandle } from "@joko/remote-ssh";
import type { RemoteHostRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";
import { RemoteTerminalRuntimeResolver } from "./remote-terminal-runtime.js";

const scope = { sessionId: "remote-task", targetId: "remote-target", remoteHostId: "host-one", workspaceRoot: "/work/project" };

describe("remote terminal connection and workspace authority", () => {
  it("uses one remote lease for the user's shell catalog, canonical directory and PTY without forwarding local environment", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const runtime = await f.resolver.resolve(scope, signal);
    const shells = await runtime.discoverShells();
    expect(shells).toEqual([
      { id: "/usr/bin/zsh", label: "zsh", executable: "/usr/bin/zsh", args: ["-i"], isDefault: true },
      { id: "/bin/sh", label: "sh", executable: "/bin/sh", args: ["-i"], isDefault: false }
    ]);
    expect(await runtime.canonicalDirectory(scope.workspaceRoot, "src")).toBe("/work/project/src");
    expect(await runtime.spawn(shells[0]!, { cwd: "/work/project/src", cols: 90, rows: 30 }, signal)).toBe(f.pty);
    expect(f.transports).toHaveBeenCalledExactlyOnceWith("remote-target", "host-one", signal);
    expect(f.openTerminal).toHaveBeenCalledExactlyOnceWith({ executable: "/usr/bin/zsh", args: ["-i"], cwd: "/work/project/src", cols: 90, rows: 30, signal });
    expect(f.openProcess.mock.calls[0]![0]).toMatchObject({ executable: "/bin/sh", cwd: "/work/project" });
    expect(f.openProcess.mock.calls[0]![0]).not.toHaveProperty("env");
  });

  it("rejects missing capability, escaped directories and symlinked workspace roots before a PTY can start", async () => {
    const f = fixture();
    f.transports.mockResolvedValueOnce({ host: {} as RemoteHostRecord, lease: { ...f.lease, capabilities: { ...f.lease.capabilities, interactiveTerminal: false } } });
    await expect(f.resolver.resolve(scope)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", stateMayHaveChanged: false });
    const runtime = await f.resolver.resolve(scope);
    for (const cwd of ["../elsewhere", "/outside", "../../work/project-two"]) {
      await expect(runtime.canonicalDirectory(scope.workspaceRoot, cwd)).rejects.toMatchObject({ code: "WORKSPACE_PATH_DENIED" });
    }
    f.realpath.mockResolvedValueOnce("/other/project");
    await expect(runtime.canonicalDirectory(scope.workspaceRoot, ".")).rejects.toMatchObject({ code: "WORKSPACE_PATH_DENIED" });
    expect(f.openTerminal).not.toHaveBeenCalled();
  });

  it("bounds discovery output and preserves uncertain creation outcomes without exposing connector details", async () => {
    const f = fixture();
    f.setOutput("x".repeat(17 * 1024));
    const runtime = await f.resolver.resolve(scope);
    await expect(runtime.discoverShells()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(f.probes[0]?.kill).toHaveBeenCalledOnce();
    f.openTerminal.mockRejectedValueOnce(new RemoteSshError("TERMINAL_UNKNOWN", "private transport text", false, { stateMayHaveChanged: true }));
    const result = runtime.spawn({ id: "/bin/sh", label: "sh", executable: "/bin/sh", args: ["-i"], isDefault: true }, { cwd: scope.workspaceRoot, cols: 80, rows: 24 });
    await expect(result).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
    await expect(result).rejects.not.toThrow("private transport text");
  });

  it("cancels a shell probe and never requests an interactive process", async () => {
    const f = fixture();
    f.setOutput(undefined);
    const controller = new AbortController();
    const runtime = await f.resolver.resolve(scope, controller.signal);
    const discovered = runtime.discoverShells();
    await vi.waitFor(() => expect(f.openProcess).toHaveBeenCalledOnce());
    controller.abort();
    await expect(discovered).rejects.toMatchObject({ code: "ABORTED", stateMayHaveChanged: false });
    expect(f.probes[0]?.kill).toHaveBeenCalledOnce();
    expect(f.openTerminal).not.toHaveBeenCalled();
  });

  it("waits for both output streams after exit and cleans a discovery channel delivered after cancellation", async () => {
    const f = fixture();
    f.setOutput(undefined);
    const runtime = await f.resolver.resolve(scope);
    let settled = false;
    const discovered = runtime.discoverShells().finally(() => { settled = true; });
    await vi.waitFor(() => expect(f.probes).toHaveLength(1));
    f.probes[0]!.exitCode = 0;
    f.probes[0]!.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.probes[0]!.stdout.end("/bin/sh\n");
    f.probes[0]!.stderr.end();
    expect(await discovered).toMatchObject([{ id: "/bin/sh", isDefault: true }]);

    let deliver!: (process: Probe) => void;
    f.openProcess.mockImplementationOnce(async () => new Promise<Probe>((resolve) => { deliver = resolve; }));
    const controller = new AbortController();
    const delayedRuntime = await f.resolver.resolve(scope, controller.signal);
    const pending = delayedRuntime.discoverShells();
    await vi.waitFor(() => expect(f.openProcess).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
    const late = new Probe();
    deliver(late);
    await vi.waitFor(() => expect(late.kill).toHaveBeenCalledOnce());
    expect(f.openTerminal).not.toHaveBeenCalled();
  });
});

class Probe extends EventEmitter implements RemoteProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => { this.signalCode = "SIGTERM"; this.emit("exit", null, "SIGTERM"); return true; });
  complete(output: string): void {
    this.stdout.end(output);
    this.stderr.end();
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function fixture() {
  let output: string | undefined = "/usr/bin/zsh\n/bin/sh\n/bin/sh\n";
  const probes: Probe[] = [];
  const pty: RemoteTerminalHandle = { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), async write() {}, async resize() {}, async kill() {}, pause() {}, resume() {} };
  const openTerminal = vi.fn<NonNullable<RemoteSshTransportLease["terminals"]>["open"]>(async () => pty);
  const openProcess = vi.fn<NonNullable<RemoteSshTransportLease["processes"]>["open"]>(async () => {
    const probe = new Probe();
    probes.push(probe);
    probe.stdin.once("finish", () => { if (output !== undefined) probe.complete(output); });
    return probe;
  });
  const realpath = vi.fn(async (path: string) => path);
  const lease: RemoteSshTransportLease = {
    capabilities: { commandExecution: false, processStreaming: true, fileTransfer: true, tcpForwarding: false, interactiveTerminal: true },
    terminals: { open: openTerminal }, processes: { open: openProcess },
    files: { realpath, stat: async () => ({ kind: "directory", size: 0, modifiedAt: 0, mode: 0o755 }),
      list: async () => [], read: async () => new Uint8Array(), write: async () => {}, mkdir: async () => {}, rename: async () => {}, remove: async () => {} }
  };
  const transports = vi.fn(async (_targetId: string, _hostId: string, _signal?: AbortSignal) => ({ host: {} as RemoteHostRecord, lease }));
  return { resolver: new RemoteTerminalRuntimeResolver({ transports }), transports, lease, openTerminal, openProcess, realpath, pty, probes,
    setOutput(value: string | undefined) { output = value; } };
}
