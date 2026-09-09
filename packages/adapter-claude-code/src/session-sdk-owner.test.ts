import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { describe, expect, test, vi } from "vitest";
import { SessionSdkOwner } from "./session-sdk-owner.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const derivedId = "22222222-2222-4222-8222-222222222222";
const request = { kind: "forkSession" as const, sessionId: sourceId, options: { dir: process.cwd() } };

class FakeWorker extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  readonly unref = vi.fn();
  readonly terminate = vi.fn(async () => 1);
  result(value: unknown) { this.emit("message", { type: "result", json: JSON.stringify({ value }) }); }
}

function setup(timeoutMs = 1_000, cleanupTimeoutMs = 20) {
  const worker = new FakeWorker();
  const factory = vi.fn((_url: URL, _options: WorkerOptions) => worker as unknown as Worker);
  const owner = new SessionSdkOwner({
    environment: { CLAUDE_CONFIG_DIR: join(tmpdir(), "isolated-sdk-profile"), ANTHROPIC_API_KEY: "must-never-enter-worker", HTTPS_PROXY: "https://user:credential@proxy.invalid" },
    timeoutMs, cleanupTimeoutMs, workerFactory: factory
  });
  return { owner, worker, factory };
}

describe("SessionSdkOwner", () => {
  test("registers the exact new identity before exit and admits only the transcript profile environment", async () => {
    const { owner, worker, factory } = setup();
    const record = vi.fn();
    let settled = false;
    const pending = owner.run(request, { recordSessionId: record }).finally(() => { settled = true; });
    worker.result({ sessionId: derivedId });
    expect(record).toHaveBeenCalledExactlyOnceWith(derivedId);
    expect(owner.ownsSession(sourceId)).toBe(true);
    expect(owner.ownsSession(derivedId)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factory.mock.calls[0]![1].env).toEqual({ CLAUDE_CONFIG_DIR: join(tmpdir(), "isolated-sdk-profile") });
    worker.emit("exit", 0);
    await expect(pending).resolves.toEqual({ sessionId: derivedId });
    expect(owner.ownsSession(derivedId)).toBe(false);
  });

  test("does not spawn before cancellation and registers an already-returned identity while cancellation is draining", async () => {
    const { owner, worker, factory } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(owner.run(request, { signal: abort.signal, recordSessionId: vi.fn() })).rejects.toMatchObject({ code: "CANCELLED", stateMayHaveChanged: false });
    await expect(owner.run({ ...request, options: { ...request.options, upToMessageId: "invalid-boundary" } }, { recordSessionId: vi.fn() })).rejects.toMatchObject({ code: "UNAVAILABLE", stateMayHaveChanged: false });
    expect(factory).not.toHaveBeenCalled();
    const active = new AbortController();
    const record = vi.fn();
    const pending = owner.run(request, { signal: active.signal, recordSessionId: record });
    active.abort();
    worker.result({ sessionId: derivedId });
    expect(record).toHaveBeenCalledExactlyOnceWith(derivedId);
    worker.emit("exit", 1);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", stateMayHaveChanged: true });
    worker.result({ sessionId: randomUUID() });
    expect(record).toHaveBeenCalledTimes(1);
    await owner.retire();
  });

  test("keeps unknown Worker identities fenced and drops all registration callbacks after the bounded outcome", async () => {
    const { owner, worker } = setup(10, 10);
    const record = vi.fn();
    const pending = owner.run(request, { recordSessionId: record });
    worker.result({ sessionId: derivedId });
    await expect(pending).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
    expect(owner.ownsSession(sourceId)).toBe(true);
    expect(owner.ownsSession(derivedId)).toBe(true);
    await expect(owner.retire()).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
    worker.result({ sessionId: randomUUID() });
    expect(record).toHaveBeenCalledTimes(1);
    worker.emit("exit", 1);
    expect(owner.ownsSession(derivedId)).toBe(false);
    await owner.retire();
  });

  test("closes Worker admission synchronously even when an earlier SDK operation cannot confirm retirement", async () => {
    const { owner, worker, factory } = setup(1_000, 10);
    const pending = owner.run(request, { recordSessionId: vi.fn() }).catch((error: unknown) => error);
    const closing = owner.close();
    await expect(owner.run({ kind: "deleteSession", sessionId: sourceId, options: request.options })).rejects.toMatchObject({ code: "UNAVAILABLE", stateMayHaveChanged: false });
    await expect(closing).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
    expect(await pending).toMatchObject({ code: "CLEANUP_UNKNOWN" });
    worker.emit("exit", 1);
    await owner.close();
    await expect(owner.run(request, { recordSessionId: vi.fn() })).rejects.toMatchObject({ code: "UNAVAILABLE", stateMayHaveChanged: false });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test.each(["invalid-id", "source-id", "sdk-error", "receipt-conflict"] as const)("contains %s without exposing SDK text or deleting unknown ownership", async (boundary) => {
    const { owner, worker } = setup();
    const record = vi.fn(() => { if (boundary === "receipt-conflict") throw new Error("credential must not escape"); });
    const pending = owner.run(request, { recordSessionId: record }).catch((error: unknown) => error);
    if (boundary === "sdk-error") worker.emit("error", new Error("credential must not escape"));
    else worker.result({ sessionId: boundary === "invalid-id" ? "bad" : boundary === "source-id" ? sourceId : derivedId });
    worker.emit("exit", 1);
    const error = await pending;
    expect(error).toMatchObject({ code: boundary === "receipt-conflict" ? "REGISTRATION_FAILED" : "FAILED", stateMayHaveChanged: true });
    expect(String(error)).not.toContain("credential");
    expect(record).toHaveBeenCalledTimes(boundary === "receipt-conflict" ? 1 : 0);
  });

  test.each(["full", "user", "assistant"] as const)("uses the published SDK for an isolated %s copy with inclusive boundaries and fresh message identities", { timeout: 30_000 }, async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), "joko-session-sdk-owner-"));
    const profile = join(root, "profile");
    const otherProfile = join(root, "other-profile");
    const workspace = join(root, "workspace");
    const storageName = "isolated-project";
    const project = join(profile, "projects", storageName);
    const otherProject = join(otherProfile, "projects", storageName);
    await Promise.all([mkdir(project, { recursive: true }), mkdir(otherProject, { recursive: true }), mkdir(workspace)]);
    const messageIds: string[] = [randomUUID(), randomUUID(), randomUUID()];
    const transcript = messageIds.map((uuid, index) => JSON.stringify({
      type: index === 1 ? "assistant" : "user", uuid, parentUuid: index === 0 ? null : messageIds[index - 1],
      sessionId: sourceId, cwd: workspace, timestamp: new Date(index).toISOString(),
      message: index === 1 ? { role: "assistant", content: [{ type: "text", text: "local answer" }] } : { role: "user", content: index === 0 ? "isolated local fixture" : "later question" }
    })).join("\n") + "\n";
    const sourcePath = join(project, `${sourceId}.jsonl`);
    const otherPath = join(otherProject, `${sourceId}.jsonl`);
    await Promise.all([writeFile(sourcePath, transcript), writeFile(otherPath, transcript)]);
    const owner = new SessionSdkOwner({
      environment: { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_PROJECT_DIR_NAME: storageName }, timeoutMs: 10_000, cleanupTimeoutMs: 2_000,
      workerFactory: (_url, options) => new Worker(new URL("./session-sdk-worker.mts", import.meta.url), options)
    });
    try {
      const info = await owner.run({ kind: "getSessionInfo", sessionId: sourceId, options: { dir: workspace } });
      expect(info).toMatchObject({ sessionId: sourceId, cwd: workspace });
      const record = vi.fn();
      const upToMessageId = boundary === "full" ? undefined : messageIds[boundary === "user" ? 0 : 1];
      const result = await owner.run({ kind: "forkSession", sessionId: sourceId, options: { dir: workspace, ...(upToMessageId === undefined ? {} : { upToMessageId }) } }, { recordSessionId: record }) as { sessionId: string };
      expect(record).toHaveBeenCalledExactlyOnceWith(result.sessionId);
      expect(result.sessionId).not.toBe(sourceId);
      const messages = await owner.run({ kind: "getSessionMessages", sessionId: result.sessionId, options: { dir: workspace, limit: 10, offset: 0, includeSystemMessages: true } }) as { uuid: string; session_id: string; message: unknown }[];
      expect(messages).toHaveLength(boundary === "full" ? 3 : boundary === "user" ? 1 : 2);
      expect(messages.every((message) => !messageIds.includes(message.uuid) && message.session_id === result.sessionId)).toBe(true);
      expect(messages.map((message) => message.message)).toEqual(transcript.trim().split("\n").slice(0, messages.length).map((line) => (JSON.parse(line) as { message: unknown }).message));
      await owner.run({ kind: "deleteSession", sessionId: result.sessionId, options: { dir: workspace } });
      expect(await owner.run({ kind: "getSessionInfo", sessionId: result.sessionId, options: { dir: workspace } })).toBeUndefined();
      expect(await readFile(sourcePath, "utf8")).toBe(transcript);
      expect(await readFile(otherPath, "utf8")).toBe(transcript);
    } finally {
      await owner.retire();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
