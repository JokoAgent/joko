import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { PiProcessHandle } from "./transport.js";
import { PiRpcTransport } from "./transport.js";

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Record<string, unknown>[] = [];
  readonly stdin: Writable;
  readonly pid = 42;
  readonly serviceRecovery: { readonly required: true } | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  #pending = Buffer.alloc(0);

  constructor(serviceRecovery = false) {
    super();
    this.serviceRecovery = serviceRecovery ? { required: true } : undefined;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#pending = Buffer.concat([this.#pending, chunk]);
        let index: number;
        while ((index = this.#pending.indexOf(0x0a)) >= 0) {
          const line = this.#pending.subarray(0, index).toString("utf8");
          this.#pending = this.#pending.subarray(index + 1);
          this.writes.push(JSON.parse(line) as Record<string, unknown>);
        }
        callback();
      }
    });
  }

  send(value: unknown, chunks = 1): void {
    const wire = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const width = Math.max(1, Math.ceil(wire.length / chunks));
    for (let index = 0; index < wire.length; index += width) this.stdout.write(wire.subarray(index, index + width));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signalCode = typeof signal === "string" ? signal : null;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("exit", 0, this.signalCode));
    return true;
  }
}

describe("PiRpcTransport", () => {
  it("retains bounded extension startup events until the runtime owner attaches", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 3 });
    process.send({ type: "extension_ui_request", id: "startup", method: "setStatus", statusKey: "ready", statusText: "yes" });
    await new Promise((resolve) => setImmediate(resolve));

    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));
    expect(events).toEqual(["extension_ui_request"]);
    await transport.terminate(50);
  });

  it("correlates responses and forwards asynchronous events", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 3, requestTimeoutMs: 1_000 });
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));

    const pending = transport.request({ type: "get_state" });
    await new Promise((resolve) => setImmediate(resolve));
    const request = process.writes[0];
    expect(request?.type).toBe("get_state");
    process.send({ type: "agent_start" }, 5);
    process.send({ type: "response", id: request?.id, command: "get_state", success: true, data: { sessionId: "s" } }, 7);

    await expect(pending).resolves.toMatchObject({ success: true, command: "get_state" });
    expect(events).toEqual(["agent_start"]);
    await transport.terminate(50);
  });

  it("drains old-generation responses and events before an idle recovery barrier, then restores strict correlation", async () => {
    const process = new FakeProcess(true);
    const transport = new PiRpcTransport({
      process: process as unknown as PiProcessHandle,
      generation: 8,
      requestTimeoutMs: 1_000
    });
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));

    const recovery = transport.recoverService();
    await vi.waitFor(() => expect(process.writes).toHaveLength(1));
    expect(process.writes[0]?.type).toBe("clear_queue");
    process.send({ type: "response", id: "7-old-request", command: "prompt", success: true });
    process.send({ type: "agent_start" });
    process.send({ type: "message_update", message: { role: "assistant", content: [] } });
    process.send({ type: "agent_settled" });
    process.send({
      type: "response",
      id: process.writes[0]?.id,
      command: "clear_queue",
      success: true,
      data: { steering: ["old steer"], followUp: ["old follow-up"] }
    });
    await vi.waitFor(() => expect(process.writes).toHaveLength(2));
    expect(process.writes[1]?.type).toBe("abort");
    process.send({
      type: "response",
      id: process.writes[1]?.id,
      command: "abort",
      success: true
    });
    await vi.waitFor(() => expect(process.writes).toHaveLength(3));
    expect(process.writes[2]?.type).toBe("get_state");
    process.send({
      type: "response",
      id: process.writes[2]?.id,
      command: "get_state",
      success: true,
      data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
    });
    await expect(recovery).resolves.toBeUndefined();
    expect(events).toEqual([]);
    expect(transport.closed).toBe(false);

    process.send({ type: "response", id: "7-late-after-barrier", command: "prompt", success: true });
    await vi.waitFor(() => expect(transport.closed).toBe(true));
    expect(process.signalCode).toBe("SIGTERM");
    await expect(transport.waitForExit()).resolves.toMatchObject({
      error: { publicError: { code: "PI_PROTOCOL_UNKNOWN_RESPONSE" } }
    });
  });

  it("fails service recovery closed when the old generation retained queued input", async () => {
    const process = new FakeProcess(true);
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 8 });
    const recovery = transport.recoverService();
    await vi.waitFor(() => expect(process.writes).toHaveLength(1));
    process.send({
      type: "response",
      id: process.writes[0]?.id,
      command: "clear_queue",
      success: true,
      data: { steering: ["old steer"], followUp: [] }
    });
    await vi.waitFor(() => expect(process.writes).toHaveLength(2));
    process.send({ type: "response", id: process.writes[1]?.id, command: "abort", success: true });
    await vi.waitFor(() => expect(process.writes).toHaveLength(3));
    process.send({
      type: "response",
      id: process.writes[2]?.id,
      command: "get_state",
      success: true,
      data: { isStreaming: false, isCompacting: false, pendingMessageCount: 1 }
    });
    await expect(recovery).rejects.toMatchObject({
      publicError: { code: "PI_SERVICE_RECOVERY_QUEUE_UNSAFE", stateMayHaveChanged: true }
    });
    expect(process.signalCode).toBe("SIGTERM");
  });

  it("fails service recovery closed on a malformed queue-clear acknowledgement", async () => {
    const process = new FakeProcess(true);
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 8 });
    const recovery = transport.recoverService();
    await vi.waitFor(() => expect(process.writes).toHaveLength(1));
    process.send({
      type: "response",
      id: process.writes[0]?.id,
      command: "clear_queue",
      success: true,
      data: { steering: [], followUp: [7] }
    });
    await expect(recovery).rejects.toMatchObject({
      publicError: { code: "PI_SERVICE_RECOVERY_QUEUE_RESPONSE_INVALID", stateMayHaveChanged: true }
    });
    expect(process.writes).toHaveLength(1);
    expect(process.signalCode).toBe("SIGTERM");
  });

  it.each([
    ["record count", () => Buffer.from(
      Array.from({ length: 4_097 }, (_, index) => `${JSON.stringify({ type: "old_event", index })}\n`).join(""),
      "utf8"
    )],
    ["byte count", () => Buffer.from(`${JSON.stringify({ type: "old_event", value: "x".repeat(8 * 1024 * 1024) })}\n`, "utf8")]
  ])("bounds service recovery by %s", async (_label, oldOutput) => {
    const process = new FakeProcess(true);
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 8 });
    const recovery = transport.recoverService();
    await vi.waitFor(() => expect(process.writes).toHaveLength(1));
    process.stdout.write(oldOutput());
    await expect(recovery).rejects.toMatchObject({
      publicError: { code: "PI_SERVICE_RECOVERY_OVERFLOW", stateMayHaveChanged: true }
    });
    expect(process.signalCode).toBe("SIGTERM");
  });

  it("times out service recovery instead of leaving the runtime half-owned", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeProcess(true);
      const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 8 });
      const recovery = transport.recoverService();
      const rejection = expect(recovery).rejects.toMatchObject({
        publicError: { stateMayHaveChanged: true }
      });
      await vi.advanceTimersByTimeAsync(15_001);
      await rejection;
      expect(process.signalCode).toBe("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts Pi's real user-message echo for an image whose base64 record exceeds 16 MiB", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({
      process: process as unknown as PiProcessHandle,
      generation: 3,
      requestTimeoutMs: 1_000
    });
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.type));
    const imageData = Buffer.alloc(12 * 1024 * 1024 + 1).toString("base64");
    const image = { type: "image" as const, data: imageData, mimeType: "image/png" };

    const pending = transport.request({
      type: "prompt",
      message: "inspect the image",
      images: [image]
    }, { stateMayHaveChanged: true });
    const request = process.writes[0];
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeGreaterThan(16 * 1024 * 1024);

    process.send({ type: "agent_start" });
    process.send({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "inspect the image" }, image],
        timestamp: Date.now()
      }
    }, 257);
    process.send({ type: "response", id: request?.id, command: "prompt", success: true });

    await expect(pending).resolves.toMatchObject({ success: true, command: "prompt" });
    expect(events).toEqual(["agent_start", "message_start"]);
    expect(transport.closed).toBe(false);
    expect(process.signalCode).toBeNull();
    await transport.terminate(50);
  });

  it("rejects an echo reservation above an explicit parser ceiling before writing to Pi", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({
      process: process as unknown as PiProcessHandle,
      generation: 3,
      maxRecordBytes: 256
    });

    await expect(transport.request({
      type: "prompt",
      message: "bounded",
      images: [{ type: "image", data: "A".repeat(256), mimeType: "image/png" }]
    }, { stateMayHaveChanged: true })).rejects.toMatchObject({
      publicError: {
        code: "PI_PROTOCOL_RECORD_BUDGET_EXCEEDED",
        stateMayHaveChanged: false
      }
    });
    expect(process.writes).toEqual([]);
    await transport.terminate(50);
  });

  it("marks a timed out side-effecting dispatch as state-ambiguous", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 1, requestTimeoutMs: 10 });
    const pending = transport.request({ type: "prompt", message: "write" }, { stateMayHaveChanged: true });
    await expect(pending).rejects.toMatchObject({ publicError: { code: "PI_RPC_TIMEOUT", stateMayHaveChanged: true } });
    await transport.terminate(50);
  });

  it("discards a matching late acknowledgement after a local timeout without killing the runtime", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 1, requestTimeoutMs: 5 });
    const timedOut = transport.request({ type: "prompt", message: "slow extension command" }, { stateMayHaveChanged: true });
    await expect(timedOut).rejects.toMatchObject({ publicError: { code: "PI_RPC_TIMEOUT" } });
    const retiredRequest = process.writes[0];

    process.send({ type: "response", id: retiredRequest?.id, command: "prompt", success: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.closed).toBe(false);
    expect(process.signalCode).toBeNull();

    const next = transport.request({ type: "get_state" });
    await new Promise((resolve) => setImmediate(resolve));
    const nextRequest = process.writes[1];
    process.send({ type: "response", id: nextRequest?.id, command: "get_state", success: true, data: { sessionId: "still-alive" } });
    await expect(next).resolves.toMatchObject({ success: true, command: "get_state" });
    await transport.terminate(50);
  });

  it("discards a matching late acknowledgement after caller cancellation", async () => {
    const process = new FakeProcess();
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 1, requestTimeoutMs: 1_000 });
    const cancellation = new AbortController();
    const cancelled = transport.request({ type: "compact" }, { signal: cancellation.signal, stateMayHaveChanged: true });
    await new Promise((resolve) => setImmediate(resolve));
    const retiredRequest = process.writes[0];
    cancellation.abort();
    await expect(cancelled).rejects.toMatchObject({ publicError: { code: "PI_REQUEST_ABORTED" } });

    process.send({ type: "response", id: retiredRequest?.id, command: "compact", success: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.closed).toBe(false);
    expect(process.signalCode).toBeNull();
    await transport.terminate(50);
  });

  it("keeps a progressing request correlated while every silent interval remains bounded", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeProcess();
      const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 1, requestTimeoutMs: 10 });
      const pending = transport.request(
        { type: "bash", command: "delayed", excludeFromContext: false },
        {
          timeoutMs: 10,
          stateMayHaveChanged: true,
          refreshTimeoutOnEvent: (event) => event.type === "bash_execution_update"
        }
      );
      const request = process.writes[0];
      for (let index = 0; index < 3; index += 1) {
        await vi.advanceTimersByTimeAsync(9);
        process.send({ type: "bash_execution_update", id: "bash-1", delta: String(index) });
      }
      process.send({
        type: "response",
        id: request?.id,
        command: "bash",
        success: true,
        data: { output: "done", exitCode: 0, cancelled: false, truncated: false }
      });

      await expect(pending).resolves.toMatchObject({ success: true, command: "bash" });
      await transport.terminate(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a request after progress stops instead of allowing an infinite wait", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeProcess();
      const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 1 });
      const pending = transport.request(
        { type: "prompt", message: "preflight" },
        { timeoutMs: 10, stateMayHaveChanged: true, refreshTimeoutOnEvent: () => true }
      );
      const rejection = expect(pending).rejects.toMatchObject({ publicError: { code: "PI_RPC_TIMEOUT" } });
      await vi.advanceTimersByTimeAsync(9);
      process.send({ type: "compaction_start", reason: "threshold" });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      await transport.terminate(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a spawn error into a terminal typed exit instead of hanging", async () => {
    const credentialedProxy = "http://proxy-user:proxy-passphrase@127.0.0.1:8080";
    const process = new FakeProcess();
    const transport = new PiRpcTransport({
      process: process as unknown as PiProcessHandle,
      generation: 2,
      redactValues: [credentialedProxy, "proxy-passphrase"]
    });
    process.emit("error", new Error(`spawn through ${credentialedProxy} with proxy-passphrase failed`));

    const exit = await transport.waitForExit();
    expect(exit).toMatchObject({
      expected: false,
      error: { publicError: { code: "PI_PROCESS_SPAWN_FAILED", phase: "spawn" } }
    });
    expect(exit.error?.publicError.message).toContain("[REDACTED]");
    expect(exit.error?.publicError.message).not.toContain(credentialedProxy);
    expect(exit.error?.publicError.message).not.toContain("proxy-passphrase");
    expect(exit.error?.cause).toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  it("keeps an unconfirmed forced kill fenced without pretending the process exited", async () => {
    const process = new FakeProcess();
    process.kill = (signal: NodeJS.Signals | number = "SIGTERM") => {
      process.signalCode = typeof signal === "string" ? signal : null;
      return true;
    };
    const transport = new PiRpcTransport({ process: process as unknown as PiProcessHandle, generation: 4 });

    await expect(transport.terminate(1)).rejects.toMatchObject({ publicError: { code: "PI_PROCESS_KILL_UNCONFIRMED" } });
    expect(transport.closed).toBe(true);
    let exitObserved = false;
    void transport.waitForExit().then(() => { exitObserved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitObserved).toBe(false);
    process.exitCode = 137;
    process.emit("exit", 137, "SIGKILL");
    await expect(transport.waitForExit()).resolves.toMatchObject({ expected: true, error: { publicError: { code: "PI_PROCESS_KILL_UNCONFIRMED" } } });
  });
});
