import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { RemoteProcessHandle } from "@joko/remote-ssh";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { describe, expect, it } from "vitest";
import { HostedAgentCodexExecServerRelay, type HostedAgentCodexAuthorization } from "./hosted-agent-codex-relay.js";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";

const current = () => undefined;
const allowed: HostedAgentCodexAuthorization = { assertCurrent: current, authorize: async () => current };
const workspace = () => new ExecutorWorkspace({ workingDir: "/project", remote: { pathStyle: "posix", home: "/home/test", temporary: "/tmp" } });
const request = (relay: HostedAgentCodexExecServerRelay, kind: "open" | "message" | "poll", data?: unknown, owner = allowed) =>
  relay.execute({ format: 1, callId: "native", requestId: randomUUID(), operation: "codex.exec_server",
    payload: { kind, connectionId: "native", ...(data === undefined ? {} : { data: JSON.stringify(data) }) } }, new AbortController().signal, owner);

describe("native relay process and bidirectional request ownership", () => {
  it("joins a delayed process opening and confirms its retirement before close returns", async () => {
    const child = new RemoteChild();
    let release!: () => void, opened = false, signal: AbortSignal | undefined;
    const relay = new HostedAgentCodexExecServerRelay({ ...allowed, identityPaths: true, pathStyle: "posix", workspace: workspace(),
      codexExecutable: "unused", cwd: "/project", sessionId: "task", openProcess: async active => {
        opened = true; signal = active;
        await new Promise<void>(resolve => { release = resolve; }); return child;
      } });
    const opening = request(relay, "open").catch(error => error);
    await expect.poll(() => opened).toBe(true);
    let closed = false;
    const closing = relay.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(signal?.aborted).toBe(true); expect(closed).toBe(false);
    release();
    expect(await opening).toBeInstanceOf(Error);
    await closing;
    expect(child.kills).toBe(1); expect(child.signalCode).toBe("SIGTERM");
  });

  it("does not mistake a PID-less remote channel error for the process exit or release its command slot", async () => {
    const child = new RemoteChild();
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1, maximumWaitMs: 1000 });
    const relay = new HostedAgentCodexExecServerRelay({ ...allowed, identityPaths: true, pathStyle: "posix", workspace: workspace(),
      codexExecutable: "unused", cwd: "/project", sessionId: "task", commandConcurrencyGate: gate, openProcess: async () => child });
    try {
      await request(relay, "open");
      await request(relay, "message", { id: 1, method: "process/start", params: { processId: "shell", argv: ["sh"], cwd: "file:///project" } });
      expect(gate.snapshot().running).toBe(1);
      child.autoExit = false;
      child.emit("error", new Error("Remote channel error without an exit receipt."));
      let closed = false;
      const closing = relay.close().then(() => { closed = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(closed).toBe(false); expect(gate.snapshot().running).toBe(1);
      child.finish(); await closing;
      expect(gate.snapshot().running).toBe(0);
    } finally { child.autoExit = true; await relay.close(); gate.close(); }
  });

  it("keeps reverse network request IDs separate and denies its real network effect before forwarding an allow response", async () => {
    const child = new RemoteChild();
    const networkDenied: HostedAgentCodexAuthorization = { assertCurrent: current, authorize: async actions => {
      if (actions.some(action => action.kind === "network")) throw new Error("Network denied."); return current;
    } };
    const relay = new HostedAgentCodexExecServerRelay({ ...networkDenied, identityPaths: true, pathStyle: "posix", workspace: workspace(),
      codexExecutable: "unused", cwd: "/project", sessionId: "task", openProcess: async () => child });
    try {
      await request(relay, "open", undefined, networkDenied);
      await request(relay, "message", { id: 1, method: "process/start", params: { processId: "shell", argv: ["sh"], cwd: "file:///project" } }, networkDenied);
      child.output({ id: 1, method: "network/policyRequest", params: { processId: "shell", request: { protocol: "https_connect", host: "example.test", port: 443 } } });
      const reverse = await request(relay, "poll");
      expect((reverse.messages as string[]).map(text => JSON.parse(text))).toEqual([expect.objectContaining({ id: 1, method: "network/policyRequest" })]);
      await request(relay, "message", { id: 1, result: { decision: { type: "allow" } } }, networkDenied);
      expect(child.received.at(-1)).toEqual({ id: 1, result: { decision: { type: "deny", reason: "Not allowed in this workspace." } } });
      child.output({ id: 1, result: {} });
      expect((await request(relay, "poll")).messages).toEqual([JSON.stringify({ id: 1, result: {} })]);
      await expect(request(relay, "message", { id: 1, result: { decision: { type: "allow" } } })).rejects.toThrow();
    } finally { await relay.close(); }
  });

  it("cannot feed an earlier turn's live shell with a replacement turn's authority", async () => {
    const child = new RemoteChild(); let original = true;
    const assertOriginal = () => { if (!original) throw new Error("The original turn ended."); };
    const owner = { assertCurrent: assertOriginal, authorize: async () => assertOriginal };
    const relay = new HostedAgentCodexExecServerRelay({ ...allowed, identityPaths: true, pathStyle: "posix", workspace: workspace(),
      codexExecutable: "unused", cwd: "/project", sessionId: "task", openProcess: async () => child });
    try {
      await request(relay, "open");
      await request(relay, "message", { id: 1, method: "process/start", params: { processId: "shell", argv: ["sh"], cwd: "file:///project" } }, owner);
      original = false;
      await expect(request(relay, "message", { id: 2, method: "process/write", params: { processId: "shell", input: "ZXhlY3V0ZQ=" } })).rejects.toThrow();
      expect(child.received).toHaveLength(1);
    } finally { await relay.close(); }
  });

  it("advertises the catalog boundary rather than ambient configuration and environment-secret capabilities", async () => {
    const child = new RemoteChild();
    const relay = new HostedAgentCodexExecServerRelay({ ...allowed, identityPaths: true, pathStyle: "posix", workspace: workspace(),
      codexExecutable: "unused", cwd: "/project", sessionId: "task", openProcess: async () => child });
    try {
      await request(relay, "open");
      await request(relay, "message", { id: 1, method: "initialize", params: { clientName: "test" } });
      child.output({ id: 1, result: { environmentInfo: { capabilities: { environmentConfigRead: true, httpHeaderEnvVars: true, capabilityDiscoverySandbox: true } } } });
      const reply = JSON.parse(((await request(relay, "poll")).messages as string[])[0]!) as Record<string, unknown>;
      expect(reply).toMatchObject({ result: { environmentInfo: { capabilities: { environmentConfigRead: false, httpHeaderEnvVars: false, capabilityDiscoverySandbox: true } } } });
    } finally { await relay.close(); }
  });
});

class RemoteChild extends EventEmitter implements RemoteProcessHandle {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly received: Record<string, unknown>[] = [];
  readonly stdin = new Writable({ write: (data, _encoding, callback) => { this.received.push(JSON.parse(Buffer.from(data).toString()) as Record<string, unknown>); callback(); } });
  readonly pid = undefined;
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  autoExit = true; kills = 0;
  output(value: unknown): void { this.stdout.write(JSON.stringify(value) + "\n"); }
  kill(): boolean { this.kills++; if (this.autoExit) this.finish(); return true; }
  finish(): void { if (this.signalCode !== null) return; this.signalCode = "SIGTERM"; this.stdout.end(); this.stderr.end(); this.emit("exit", null, "SIGTERM"); }
}
