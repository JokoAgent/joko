import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Code } from "@connectrpc/connect";
import { CapabilitySupport, TerminalStatus } from "@joko/contracts";
import { createOrchestratorApplication, createPublicServer, type OrchestratorConfig } from "@joko/orchestrator";
import type { TerminalPty } from "@joko/tool-terminal";
import { expect, it, vi } from "vitest";
import { createE2eClients } from "./connect-clients.js";
import { waitFor } from "./fixture.js";

type RemoteConnector = NonNullable<NonNullable<Parameters<typeof createOrchestratorApplication>[1]>["remoteSshConnector"]>;
const palette = { ansiRgb: Array.from({ length: 16 }, (_, index) => index * 0x111111), foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff };

it("composes remote terminals over authenticated HTTP and completes service shutdown even when remote exit remains unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-remote-terminal-e2e-"));
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  await mkdir(workspace);
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4317, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4317",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"), allowInsecureLoopback: true, allowInsecureLan: false,
    lanDiscoveryEnabled: false, codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "workspace", root: workspace, displayName: "Terminal fixture", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web"), corsOrigins: []
  };
  const channels: MemoryTerminal[] = [];
  const closeConnection = vi.fn(async () => {});
  const capabilities = { commandExecution: false, processStreaming: true, fileTransfer: true, tcpForwarding: false, interactiveTerminal: true };
  const openTerminal = vi.fn(async (_request: { executable: string; cwd: string; cols: number; rows: number }) => { const terminal = new MemoryTerminal(); channels.push(terminal); return terminal; });
  const connector: RemoteConnector = {
    capabilities,
    async connect(request) {
      request.onAuthenticating();
      await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Buffer.from("terminal-e2e-host-key") });
      return { capabilities, close: closeConnection, terminals: { open: openTerminal },
        processes: { open: async () => new ShellProbe() },
        files: { realpath: async (path) => path, stat: async () => ({ kind: "directory", size: 0, modifiedAt: 0, mode: 0o755 }),
          list: async () => [], read: async () => new Uint8Array(), write: async () => {}, mkdir: async () => {}, rename: async () => {}, remove: async () => {} }
      };
    }
  };
  const application = await createOrchestratorApplication(config, { remoteSshConnector: connector });
  let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
  try {
    const remoteWorkspace = { hostId: "host-one", workspaceRoot: "/srv/project" };
    application.store.upsertTarget({ id: "remote-target", backendId: "pi", displayName: "Remote project", workspaceRoot: workspace,
      managed: false, trusted: true, remoteWorkspace });
    application.remoteHosts!.create({ id: "host-one", targetId: "remote-target", hostname: "terminal.invalid", user: "fixture", source: "manual" });
    application.store.createSession({ id: "remote-task", backendId: "pi", targetId: "remote-target", title: "Remote task", remoteWorkspace,
      binding: { opaqueRef: "remote-task-native", generation: 0 }, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    const challenge = application.connections.issuePairing("Remote terminal test");
    const paired = application.connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Terminal client" });
    server = await createPublicServer(application);
    server.log.level = "silent";
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const clients = createE2eClients(baseUrl, paired.authKey);
    const sessionId = "remote-task";
    expect(await clients.terminal.getTerminalCapabilities({ sessionId })).toMatchObject({ support: CapabilitySupport.SUPPORTED, defaultShellId: "/bin/sh" });
    const created = await clients.terminal.createTerminal({ sessionId, requestId: "remote-create", initialPalette: palette, columns: 90, rows: 30 });
    expect(created.terminal).toMatchObject({ cwd: "/srv/project", status: TerminalStatus.RUNNING, exitConfirmed: false });
    expect(openTerminal).toHaveBeenCalledWith(expect.objectContaining({ executable: "/bin/sh", cwd: "/srv/project", cols: 90, rows: 30 }));
    expect(openTerminal.mock.calls[0]?.[0]).not.toHaveProperty("env");
    const reference = { sessionId, terminalId: created.terminal!.id, generation: created.terminal!.generation };
    const view = { viewId: "remote-view", viewRevision: 1n, palette };
    const watchAbort = new AbortController();
    const watch = clients.terminal.watchTerminal({ ...reference, appearance: view }, { signal: watchAbort.signal })[Symbol.asyncIterator]();
    const registered = (await watch.next()).value!;
    const focused = await clients.terminal.updateTerminalAppearance({
      ...reference,
      appearance: { ...view, viewRevision: 2n },
      claimFocus: true,
      expectedAppearanceRevision: registered.appearanceRevision
    });
    expect(focused).toMatchObject({ accepted: true, ownsDefaults: true, acceptedViewRevision: 2n });
    await clients.terminal.writeTerminal({ ...reference, writerId: view.viewId, inputSequence: 1n, data: "remote typed text" });
    await waitFor(async () => (await clients.terminal.getTerminal(reference)).serialized, (screen) => screen.includes("remote typed text"), "remote terminal screen");
    watchAbort.abort();
    await watch.return?.();
    channels[0]!.finish();
    await waitFor(async () => (await clients.terminal.getTerminal(reference)).terminal, (terminal) => terminal?.exitConfirmed === true, "remote exit confirmation");
    const restarted = await clients.terminal.restartTerminal({ ...reference, requestId: "restart" });
    expect(restarted.terminal?.generation).not.toBe(reference.generation);
    expect((await clients.terminal.getTerminal({ ...reference, generation: restarted.terminal!.generation })).serialized).toContain("remote typed text");
    expect(channels[1]!.write).not.toHaveBeenCalled();
    channels[1]!.lose();
    const activeReference = { ...reference, generation: restarted.terminal!.generation };
    await waitFor(async () => (await clients.terminal.getTerminal(activeReference)).terminal, (terminal) => terminal?.status === TerminalStatus.FAILED, "remote transport failure");
    expect((await clients.terminal.listTerminals({ sessionId })).terminals[0]).toMatchObject({ status: TerminalStatus.FAILED, exitConfirmed: false, failureCode: "TERMINAL_UNKNOWN" });
    await expect(clients.terminal.restartTerminal({ ...activeReference, requestId: "unknown-restart" })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(openTerminal).toHaveBeenCalledTimes(2);
    await server.close();
    server = undefined;
    const shutdownFailure = await application.close().catch((error: unknown) => error);
    expect(shutdownFailure).toBeInstanceOf(Error);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(() => application.store.health()).toThrow();
    expect(await application.close().catch((error: unknown) => error)).toBe(shutdownFailure);
  } finally {
    await server?.close();
    await application.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

class ShellProbe extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdin.once("finish", () => { this.stdout.end("/bin/sh\n"); this.stderr.end(); this.exitCode = 0; this.emit("exit", 0, null); });
  }
  kill() { return true; }
}

class MemoryTerminal implements TerminalPty {
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<Parameters<TerminalPty["onExit"]>[0]>();
  #unknown = false;
  readonly write = vi.fn(async (data: string) => { for (const listener of this.#data) listener(data); });
  onData(listener: (data: string) => void) { this.#data.add(listener); return { dispose: () => { this.#data.delete(listener); } }; }
  onExit(listener: Parameters<TerminalPty["onExit"]>[0]) { this.#exit.add(listener); return { dispose: () => { this.#exit.delete(listener); } }; }
  async resize() {}
  pause() {}
  resume() {}
  async kill() { if (this.#unknown) throw new Error("Remote stop is unconfirmed."); this.finish(); }
  finish() { for (const listener of this.#exit) listener({ exitCode: 0, processExitConfirmed: true }); }
  lose() { this.#unknown = true; for (const listener of this.#exit) listener({ exitCode: -1, failureCode: "TERMINAL_UNKNOWN", processExitConfirmed: false }); }
}
