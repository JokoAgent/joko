import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "./transport.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));

describe("StdioJsonRpcTransport", () => {
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
