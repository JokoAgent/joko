import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "./transport.js";
import { AppServerHost } from "./host.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

describe("StdioJsonRpcTransport", () => {
  it.each(["cancel", "timeout", "stale"] as const)("does not write a queued mutation after %s while the prior write is blocked", async (boundary) => {
    const transport = new StdioJsonRpcTransport({ command: process.execPath, args: [fixture], requestTimeoutMs: 2_000 });
    const cancellation = new AbortController();
    let current = true;
    try {
      await transport.start({ onNotification: () => undefined, onRequest: () => undefined, onExit: () => undefined });
      await transport.request("pause-input", {});
      const padding = transport.notify("backpressure-padding", { value: "x".repeat(8 * 1024 * 1024) });
      let paddingWritten = false;
      void padding.then(() => { paddingWritten = true; });
      const pending = transport.request(boundary === "stale" ? "thread/fork" : "turn/steer", {}, {
        mutation: true,
        signal: cancellation.signal,
        timeoutMs: boundary === "timeout" ? 20 : 2_000,
        beforeDispatch: () => {
          if (!current) throw new Error("The captured history changed.");
        }
      }).catch((error: unknown) => error);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(paddingWritten).toBe(false);
      if (boundary === "cancel") cancellation.abort();
      if (boundary === "stale") current = false;
      const failure = await pending;
      if (boundary === "stale") expect(failure).toMatchObject({ message: "The captured history changed." });
      else expect(failure).toMatchObject({ code: boundary === "cancel" ? "closed" : "request_timeout", stateMayHaveChanged: false });
      await padding;
      const received = await transport.request("received-methods", {});
      expect(received).not.toContain("thread/fork");
      expect(received).not.toContain("turn/steer");
    } finally {
      await transport.close();
    }
  });

  it("observes the exact thread history revision before a response while notification delivery is blocked", async () => {
    const host = new AppServerHost({ transport: { command: process.execPath, args: [fixture], requestTimeoutMs: 1_500 } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const delivered: string[] = [];
    const handlers = {
      onNotification: async (method: string) => {
        if (method === "fixture/held") await held;
        delivered.push(method);
      },
      onRequest: async () => undefined,
      onDisconnect: () => undefined
    };
    try {
      const generation = await host.ensureStarted();
      const subscription = await host.subscribe("history-thread", generation, handlers);
      const initial = host.historyRevision("history-thread", generation);
      expect(initial).toBeTypeOf("bigint");
      expect(host.hasPendingThreadNotifications("history-thread", generation)).toBe(false);
      await host.request("notifications-before-response", { notifications: [
        { method: "fixture/held", params: { threadId: "history-thread" } },
        { method: "thread/tokenUsage/updated", params: { threadId: "history-thread" } },
        { method: "thread/reverted", params: { threadId: "foreign-thread" } }
      ] });
      expect(delivered).toEqual([]);
      expect(host.hasPendingThreadNotifications("history-thread", generation)).toBe(true);
      expect(host.historyRevision("history-thread", generation)).toBe(initial);
      expect(host.historyRevision("foreign-thread", generation)).toBeUndefined();
      expect(host.historyRevision("history-thread", generation + 1)).toBeUndefined();
      for (const method of ["thread/reverted", "turn/completed", "item/agentMessage/delta"]) {
        const before = host.historyRevision("history-thread", generation);
        await host.request("notifications-before-response", { notifications: [{ method, params: { threadId: "history-thread" } }] });
        expect(host.historyRevision("history-thread", generation)).not.toBe(before);
        expect(delivered).toEqual([]);
      }
      const cancellation = new AbortController();
      const cancelledWait = host.waitForThreadNotifications("history-thread", generation, cancellation.signal).catch((error: unknown) => error);
      cancellation.abort();
      expect(await cancelledWait).toMatchObject({ code: "closed" });
      const retiredWait = host.waitForThreadNotifications("history-thread", generation, new AbortController().signal).catch((error: unknown) => error);
      await subscription.release({ unsubscribe: false });
      expect(await retiredWait).toMatchObject({ code: "process_exited" });
      expect(host.historyRevision("history-thread", generation)).toBeUndefined();
      await host.subscribe("history-thread", generation, handlers);
      expect(host.historyRevision("history-thread", generation)).not.toBe(initial);
      release();
    } finally {
      release();
      await host.shutdown();
    }
  });

  it("keeps descendant arrival pending through ownership registration and asynchronous delivery", async () => {
    const host = new AppServerHost({ transport: { command: process.execPath, args: [fixture], requestTimeoutMs: 1_500 } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      const generation = await host.ensureStarted();
      await host.subscribe("pending-root", generation, {
        onNotification: () => undefined, onRequest: async () => undefined, onDisconnect: () => undefined,
        onDescendantThreadStarted: () => undefined,
        onDescendantNotification: async () => held
      });
      await host.request("notifications-before-response", { notifications: [{ method: "thread/started", params: { thread: { id: "pending-child", parentThreadId: "pending-root" } } }] });
      expect(host.hasPendingThreadNotifications("pending-root", generation)).toBe(true);
      await host.registerDescendantThread("pending-child", "pending-root", generation);
      expect(host.hasPendingThreadNotifications("pending-root", generation)).toBe(false);
      await host.request("notifications-before-response", { notifications: [{ method: "turn/started", params: { threadId: "pending-child", turn: { id: "child-turn" } } }] });
      expect(host.hasPendingThreadNotifications("pending-root", generation)).toBe(true);
      let settled = false;
      const pendingDrain = host.waitForThreadNotifications("pending-root", generation, new AbortController().signal).then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await pendingDrain;
      expect(host.hasPendingThreadNotifications("pending-root", generation)).toBe(false);
    } finally {
      release(); await host.shutdown();
    }
  });

  it("limits the default child environment and preserves an explicitly supplied environment", async () => {
    const unrelatedName = "JOKO_CODEX_UNRELATED_TEST_VALUE";
    const originalUnrelated = process.env[unrelatedName];
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env[unrelatedName] = "ambient-value-must-not-cross";
    process.env.OPENAI_API_KEY = "allowed-api-value";
    const handlers = {
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: () => undefined
    };
    const bounded = new StdioJsonRpcTransport({ command: process.execPath, args: [fixture] });
    const explicit = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      env: { JOKO_EXPLICIT_CHILD_VALUE: "explicit-value" }
    });

    try {
      await bounded.start(handlers);
      await expect(bounded.request("read-environment", {
        names: [unrelatedName, "OPENAI_API_KEY"]
      })).resolves.toEqual({
        [unrelatedName]: null,
        OPENAI_API_KEY: "allowed-api-value"
      });

      await explicit.start(handlers);
      await expect(explicit.request("read-environment", {
        names: [unrelatedName, "OPENAI_API_KEY", "JOKO_EXPLICIT_CHILD_VALUE"]
      })).resolves.toEqual({
        [unrelatedName]: null,
        OPENAI_API_KEY: null,
        JOKO_EXPLICIT_CHILD_VALUE: "explicit-value"
      });
    } finally {
      await bounded.close().catch(() => undefined);
      await explicit.close().catch(() => undefined);
      restoreEnvironment(unrelatedName, originalUnrelated);
      restoreEnvironment("OPENAI_API_KEY", originalApiKey);
    }
  });

  it("uses bounded JSONL and ignores a late response through its timeout tombstone", async () => {
    const exits: string[] = [];
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_000,
      maxLineBytes: 8_192,
      maxBufferedBytes: 16_384
    });
    await transport.start({
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: (fault) => { exits.push(fault.code); }
    });

    await expect(transport.request("echo", { value: 1 })).resolves.toEqual({
      method: "echo",
      params: { value: 1 }
    });
    await expect(transport.request("late", {}, { timeoutMs: 10, mutation: true })).rejects.toMatchObject({
      code: "request_timeout",
      stateMayHaveChanged: true
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(transport.request("after-late", {})).resolves.toMatchObject({ method: "after-late" });
    expect(exits).toEqual([]);
    await transport.close();
  });

  it("fails closed when one JSONL record exceeds the configured line bound", async () => {
    const exits: string[] = [];
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_500,
      maxLineBytes: 1_024,
      maxBufferedBytes: 2_048
    });
    await transport.start({
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: (fault) => { exits.push(fault.code); }
    });
    await expect(transport.request("oversize", {})).rejects.toMatchObject({ code: "buffer_overflow" });
    expect(exits).toEqual(["buffer_overflow"]);
    await transport.close();
  });

  it("serializes asynchronous notification handlers in wire order", async () => {
    const delivered: number[] = [];
    let release: (() => void) | undefined;
    const complete = new Promise<void>((resolve) => { release = resolve; });
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_500
    });
    await transport.start({
      onNotification: async (notification) => {
        const sequence = (notification.params as { sequence?: number }).sequence;
        if (sequence === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        if (sequence !== undefined) delivered.push(sequence);
        if (delivered.length === 2) release?.();
      },
      onRequest: () => undefined,
      onExit: () => undefined
    });
    await transport.request("ordered-notifications", {});
    await complete;
    expect(delivered).toEqual([1, 2]);
    await transport.close();
  });

  it("fails closed when parsed inbound handler work exceeds its bound", async () => {
    const exits: string[] = [];
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_500,
      maxInboundHandlerEntries: 1
    });
    await transport.start({
      onNotification: async () => new Promise((resolve) => setTimeout(resolve, 50)),
      onRequest: () => undefined,
      onExit: (fault) => { exits.push(fault.code); }
    });
    await expect(transport.request("ordered-notifications", {})).rejects.toMatchObject({ code: "buffer_overflow" });
    expect(exits).toEqual(["buffer_overflow"]);
    await transport.close();
  });

  it("rejects oversized outbound records without losing the buffer taxonomy", async () => {
    const exits: string[] = [];
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_000,
      maxOutboundBytes: 256
    });
    await transport.start({
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: (fault) => { exits.push(fault.code); }
    });
    await expect(transport.request("echo", { value: "x".repeat(1_000) }, { mutation: true }))
      .rejects.toMatchObject({ code: "buffer_overflow", stateMayHaveChanged: false });
    await expect(transport.request("echo", { value: 1 })).resolves.toMatchObject({ method: "echo" });
    expect(exits).toEqual([]);
    await transport.close();
  });

  it("marks a malformed mutation response as an unknown native outcome", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_000
    });
    await transport.start({
      onNotification: () => undefined,
      onRequest: () => undefined,
      onExit: () => undefined
    });
    await expect(transport.request("malformed-response", {}, { mutation: true })).rejects.toMatchObject({
      code: "protocol_violation",
      stateMayHaveChanged: true
    });
    await expect(transport.request("echo", { value: 1 })).resolves.toMatchObject({ method: "echo" });
    await transport.close();
  });

  it.skipIf(process.platform === "win32")("escalates a graceful close to SIGKILL and confirms the child is gone", async () => {
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 20
    });
    let pid: number | undefined;
    try {
      await transport.start({
        onNotification: () => undefined,
        onRequest: () => undefined,
        onExit: () => undefined
      });
      const result = await transport.request("hang-on-close", {}) as { readonly pid: number };
      pid = result.pid;

      await expect(transport.close()).resolves.toBeUndefined();
      expect(processExists(pid)).toBe(false);
    } finally {
      if (pid !== undefined && processExists(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* The fixture already exited. */ }
      }
    }
  });

  it("retires a stale exact process owner before spawning and removes the current owner after exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-codex-owner-"));
    const staleDirectory = join(root, "3");
    const staleOwnerToken = "11111111-1111-4111-8111-111111111111";
    await mkdir(staleDirectory);
    await writeFile(join(staleDirectory, `owner-${staleOwnerToken}.json`), JSON.stringify({
      format: 1,
      instanceId: "codex-instance",
      generation: 3,
      ownerToken: staleOwnerToken,
      pid: 4242,
      processIdentity: "stale-process-identity"
    }));
    const terminate = vi.fn(async () => "terminated" as const);
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      processOwner: {
        rootDirectory: root,
        instanceId: "codex-instance",
        generation: 4,
        recoverStale: true,
        supervisor: {
          capture: async (pid) => `current-${pid}`,
          captureSync: (pid) => `current-${pid}`,
          terminate
        }
      }
    });
    try {
      await transport.start({
        onNotification: () => undefined,
        onRequest: () => undefined,
        onExit: () => undefined
      });
      expect(terminate).toHaveBeenCalledExactlyOnceWith(4242, "stale-process-identity", 2_000);
      expect(await readdir(root)).toEqual(["4"]);
      await transport.close();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await transport.forceClose().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an unconfirmed stale owner fenced and refuses to spawn a second app-server", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-codex-owner-unconfirmed-"));
    const staleDirectory = join(root, "7");
    const staleOwnerToken = "22222222-2222-4222-8222-222222222222";
    await mkdir(staleDirectory);
    await writeFile(join(staleDirectory, `owner-${staleOwnerToken}.json`), JSON.stringify({
      format: 1,
      instanceId: "codex-instance",
      generation: 7,
      ownerToken: staleOwnerToken,
      pid: 4343,
      processIdentity: "unconfirmed-process-identity"
    }));
    const transport = new StdioJsonRpcTransport({
      command: process.execPath,
      args: [fixture],
      shutdownTimeoutMs: 5,
      processOwner: {
        rootDirectory: root,
        instanceId: "codex-instance",
        generation: 8,
        recoverStale: true,
        supervisor: {
          capture: async () => undefined,
          captureSync: () => undefined,
          terminate: async () => "unconfirmed"
        }
      }
    });
    try {
      await expect(transport.start({
        onNotification: () => undefined,
        onRequest: () => undefined,
        onExit: () => undefined
      })).rejects.toThrow("could not be retired");
      expect(await readdir(root)).toEqual(["7"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid transport bounds before spawning a process", () => {
    expect(() => new StdioJsonRpcTransport({ tombstoneTtlMs: 0 })).toThrow(TypeError);
    expect(() => new StdioJsonRpcTransport({ shutdownTimeoutMs: Number.NaN })).toThrow(TypeError);
    expect(() => new StdioJsonRpcTransport({ maxInboundHandlerEntries: 1.5 })).toThrow(TypeError);
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
