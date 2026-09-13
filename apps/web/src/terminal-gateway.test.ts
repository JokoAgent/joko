import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { CapabilitySupport, TerminalSchema, TerminalStatus, TerminalUpdateKind, WatchTerminalResponseSchema } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createTerminalGateway } from "./terminal-gateway.js";

const palette = { ansiRgb: [0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec], foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff };
const appearance = { viewId: "view", viewRevision: 1n, palette };

it("maps terminal ownership and optional checkpoints, rejects broken streams and never retries uncertain input", async () => {
  const terminal = create(TerminalSchema, { id: "pty", sessionId: "task", targetId: "target", generation: 2n, status: TerminalStatus.RUNNING, shellId: "shell", shellLabel: "Shell", cwd: "/workspace", columns: 80, rows: 24 });
  let frames = [
    create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.RESET, terminal, sequence: 8n, data: "screen" }),
    create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.OUTPUT, sequence: 9n, data: "output" }),
    create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.STATE, terminal: { ...terminal, status: TerminalStatus.EXITED, exitConfirmed: true, exitCode: 0, exitSignal: 15 }, sequence: 10n })
  ];
  const requests: { name: string; input: any; signal: AbortSignal }[] = [];
  let failWrite = false;
  let wrongOwner = false;
  const response = (method: any, message: unknown, stream = false) => ({ service: method.parent, method, stream, header: new Headers(), trailer: new Headers(), message });
  const transport = {
    unary: vi.fn(async (method: any, signal: AbortSignal, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ name: method.localName, input, signal });
      if (method.localName === "getTerminalCapabilities") return response(method, { support: CapabilitySupport.SUPPORTED, reason: "", shells: [{ id: "shell", label: "Shell" }], defaultShellId: "shell", maximumTerminals: 16, maximumInputBytes: 65536, maximumColumns: 500, maximumRows: 200 });
      if (method.localName === "writeTerminal") { if (failWrite) throw new Error("acknowledgement lost"); return response(method, { nextInputSequence: input.inputSequence + 1n }); }
      if (method.localName === "closeTerminal") return response(method, {});
      return response(method, { terminal: wrongOwner ? { ...terminal, sessionId: "other-task" } : terminal });
    }),
    stream: vi.fn(async (method: any, signal: AbortSignal, _timeout: unknown, _headers: unknown, inputs: AsyncIterable<any>) => {
      for await (const input of inputs) requests.push({ name: method.localName, input, signal });
      return response(method, (async function* () { yield* frames; })(), true);
    })
  } as unknown as Transport;
  const owner = new AbortController();
  const local = new AbortController();
  const gateway = createTerminalGateway(transport, owner.signal);
  expect(await gateway.getTerminalCapabilities()).toMatchObject({ support: "supported", defaultShellId: "shell" });
  expect(requests.at(-1)?.input.sessionId).toBe("");
  await gateway.createTerminal("task", "create-request", "auto", 80, 24, palette, local.signal);
  expect(requests.at(-1)?.input).toMatchObject({ requestId: "create-request", shellId: "" });
  let finishCheckpoint!: () => void;
  const updates = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finishCheckpoint = resolve; }));
  const watch = gateway.watchTerminal("task", "pty", 2n, appearance, updates);
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  expect(updates).toHaveBeenCalledTimes(1);
  finishCheckpoint();
  await watch;
  expect(requests.at(-1)?.input.afterSequence).toBeUndefined();
  expect(updates.mock.calls.map(([value]) => [value.kind, value.sequence, value.terminal?.status])).toEqual([["reset", 8n, "running"], ["output", 9n, undefined], ["state", 10n, "exited"]]);
  expect(updates.mock.calls.at(-1)?.[0].terminal.exitSignal).toBe(15);
  expect(updates.mock.calls.at(-1)?.[0].terminal.exitConfirmed).toBe(true);
  frames = [create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.RESET,
    terminal: { ...terminal, status: TerminalStatus.FAILED, exitConfirmed: false, failureCode: "TERMINAL_UNKNOWN" }, sequence: 11n })];
  await gateway.watchTerminal("task", "pty", 2n, appearance, updates, 10n);
  expect(updates.mock.calls.at(-1)?.[0].terminal).toMatchObject({ status: "failed", exitConfirmed: false, failureCode: "TERMINAL_UNKNOWN" });
  frames = [create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.RESET, terminal, sequence: 25n, data: "new checkpoint" })];
  await gateway.watchTerminal("task", "pty", 2n, appearance, updates, 10n);
  expect(requests.at(-1)?.input.afterSequence).toBe(10n);
  frames = [create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.OUTPUT, sequence: 30n, data: "gap" })];
  await expect(gateway.watchTerminal("task", "pty", 2n, appearance, updates, 25n)).rejects.toThrow("sequence");
  await expect(gateway.watchTerminal("task", "pty", 2n, appearance, updates)).rejects.toThrow("sequence");
  frames = [create(WatchTerminalResponseSchema, { appearanceRevision: 1n, activeColorOverrides: "", kind: TerminalUpdateKind.RESET, terminal: { ...terminal, generation: 3n }, sequence: 30n })];
  await expect(gateway.watchTerminal("task", "pty", 2n, appearance, updates)).rejects.toThrow("generation");
  wrongOwner = true;
  await expect(gateway.getTerminal("task", "pty")).rejects.toThrow("owner");
  wrongOwner = false;
  await gateway.resizeTerminal("task", "pty", 2n, "view", 90, 30);
  expect(requests.at(-1)?.input).toMatchObject({ viewId: "view", columns: 90, rows: 30 });
  failWrite = true;
  await expect(gateway.writeTerminal("task", "pty", 2n, "writer", 1n, "input")).rejects.toThrow("acknowledgement lost");
  expect(requests.filter((request) => request.name === "writeTerminal")).toHaveLength(1);
  owner.abort();
  expect(requests.every((request) => request.signal.aborted)).toBe(true);
  expect(requests.some((request) => request.name === "closeTerminal")).toBe(false);
});
