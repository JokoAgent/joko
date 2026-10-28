import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import type { AdapterContext, InteractionDecision, InteractionPayload } from "@joko/core";
import { afterEach, expect, it } from "vitest";
import { HostedAgentExecutor, type HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(sideChat = false) {
  const root = await mkdtemp(join(tmpdir(), "joko-task-executor-")), task = join(root, "task"), agent = join(root, "agent");
  await mkdir(task); await mkdir(agent);
  let current = true;
  let policy: HostedAgentExecutorPolicy = { revision: "first", permissionMode: "auto", planMode: false, approvedRoots: [], confirmCredentials: false };
  const questions: InteractionPayload[] = [];
  let answer: (question: InteractionPayload) => Promise<InteractionDecision> = async () => ({ kind: "confirmed", confirmed: true });
  const context: AdapterContext = { sessionId: "original-session", generation: 2,
    target: { id: "original-target", backendId: "pi", displayName: "Task", workspaceRoot: task, managed: true, trusted: true },
    signal: new AbortController().signal, emit: async () => {},
    ...(sideChat ? { runtimePolicy: "review_read_only" as const, persistentReadOnly: "side_chat" as const } : {}),
    requestInteraction: async question => { questions.push(question); return answer(question); },
    artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No Artifact expected."); } };
  const gate = createCommandConcurrencyGate({ readMaximum: () => 1 });
  const executor = new HostedAgentExecutor({ context, virtualRoot: agent, readPolicy: () => policy,
    assertCurrent: () => { if (!current) throw new Error("Turn ended."); }, commandConcurrencyGate: gate });
  let sequence = 0, policyRevision = 0;
  cleanups.push(async () => { executor.dispose(); gate.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); });
  return { root, task, agent, context, questions, executor, gate,
    call: async (operation: string, payload: Record<string, unknown>, signal?: AbortSignal) => {
      const callId = `native-call-${++sequence}`;
      const name = operation === "exec.run" ? "bash" : operation === "fs.write" ? "write" : operation === "fs.readdir" || operation === "fs.stat" ? "ls" : "read";
      const input = operation === "exec.run" ? payload : { path: payload.path };
      const request = (index: number, operation: string, payload: Record<string, unknown>) => executor.execute({ format: 1, callId, requestId: `${callId}:${index}`, operation, payload }, signal);
      await request(1, "tool.begin", { name, input });
      try { return await request(2, operation, payload); }
      finally { await request(3, "tool.end", {}).catch(() => {}); }
    },
    setPolicy: (value: Partial<HostedAgentExecutorPolicy>) => { policy = { ...policy, ...value, revision: String(++policyRevision) }; },
    setAnswer: (callback: typeof answer) => { answer = callback; }, revoke: () => { current = false; } };
}

it("executes native file operations on the task computer and round-trips projected text without changing binary bytes", async () => {
  const f = await fixture(), path = join(f.agent, "source.json"), real = join(f.task, "source.json");
  const original = JSON.stringify({ path: join(f.task, "data.txt"), text: "untouched" }, null, 2) + "\n";
  await writeFile(real, original);
  const result = await f.call("fs.read", { path });
  const view = Buffer.from(String(result.data), "base64").toString("utf8");
  expect(view).toContain(JSON.stringify(join(f.agent, "data.txt")).slice(1, -1));
  expect(view).not.toContain(JSON.stringify(f.task).slice(1, -1));
  await f.call("fs.write", { path, data: Buffer.from(view.replace("untouched", "changed")).toString("base64") });
  expect(await readFile(real, "utf8")).toBe(original.replace("untouched", "changed"));
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  const binary = Buffer.from([0, 255, 254, 1, 2, 3]);
  await f.call("fs.write", { path: join(f.agent, "data.bin"), data: binary.toString("base64") });
  expect(Buffer.from(String((await f.call("fs.read", { path: join(f.agent, "data.bin") })).data), "base64")).toEqual(binary);
  expect(await f.call("fs.readdir", { path: f.agent })).toEqual({ entries: ["data.bin", "source.json"] });
  expect(f.questions).toEqual([]);
});

it("reads a side chat's original Source workspace through a bounded immutable native facade", async () => {
  const f = await fixture(true);
  await writeFile(join(f.task, "answer.txt"), "Source workspace answer");
  await writeFile(join(f.agent, "answer.txt"), "Provider shadow must not be read");
  await writeFile(join(f.task, ".env"), "PRIVATE_CREDENTIAL=never-send");
  let sequence = 0;
  const request = (callId: string, operation: string, payload: Record<string, unknown>) => f.executor.execute({
    format: 1, callId, requestId: `${callId}:${++sequence}`, operation, payload });
  await request("answer", "tool.begin", { name: "read", input: { path: join(f.agent, "answer.txt") } });
  const result = await request("answer", "review.call", { tool: "joko_read", arguments: { path: "answer.txt" } });
  expect(String(result.text)).toContain("Source workspace answer");
  expect(String(result.text)).not.toContain("Provider shadow");
  await expect(request("answer", "review.call", { tool: "bash", arguments: { command: "echo no" } })).rejects.toThrow();
  await expect(request("answer", "review.call", { tool: "joko_read", arguments: { path: ".env" } })).rejects.toThrow();
  await expect(f.call("fs.write", { path: join(f.agent, "answer.txt"), data: Buffer.from("overwrite").toString("base64") })).rejects.toThrow();
  expect(await readFile(join(f.task, "answer.txt"), "utf8")).toBe("Source workspace answer");
  f.revoke();
  await expect(request("answer", "review.call", { tool: "joko_read", arguments: { path: "answer.txt" } })).rejects.toThrow();
  const ordinary = await fixture();
  await expect(ordinary.call("review.call", { tool: "joko_ls", arguments: { path: "." } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

it("obtains credential consent on the task computer even under Full Access and does not publish file contents", async () => {
  const f = await fixture(); await writeFile(join(f.task, ".env"), "PRIVATE_TASK_KEY=kept-on-task-node");
  f.setPolicy({ permissionMode: "bypassPermissions", confirmCredentials: true });
  f.setAnswer(async question => { expect(question).toMatchObject({ kind: "permission", title: "Allow credential access", choices: ["allow_once", "deny_once"] });
    expect(JSON.stringify(question)).not.toContain("PRIVATE_TASK_KEY"); return { kind: "confirmed", confirmed: false }; });
  await expect(f.call("fs.read", { path: join(f.agent, ".env") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.questions).toHaveLength(1);
  f.setAnswer(async () => ({ kind: "selected", value: "allow_once" }));
  const allowed = await f.call("fs.read", { path: join(f.agent, ".env") });
  expect(Buffer.from(String(allowed.data), "base64").toString()).toContain("kept-on-task-node");
  f.setPolicy({ confirmCredentials: true });
  f.setAnswer(async () => ({ kind: "confirmed", confirmed: false }));
  await expect(f.call("fs.read", { path: join(f.agent, ".env") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.questions).toHaveLength(3);
});

it("streams native text ranges beyond the ordinary byte limit under the same Source lease and keeps native read options private", async () => {
  const f = await fixture(), path = join(f.agent, "large.txt"), sourcePath = join(f.task, "large.txt");
  const bytes = Buffer.concat([Buffer.alloc(17 * 1024 * 1024, "a"), Buffer.from(`\r\n${join(f.task, "proof.txt")}\r\nlast\n`)]);
  await writeFile(sourcePath, bytes);
  let sequence = 0;
  const request = (operation: string, payload: Record<string, unknown>, effects?: Parameters<HostedAgentExecutor["execute"]>[2]) => f.executor.execute({
    format: 1, callId: "native-range", requestId: `native-range:${++sequence}`, operation, payload
  }, undefined, effects);
  await request("tool.begin", { name: "read", input: { path } });
  await expect(request("fs.read", { path })).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
  await expect(request("fs.read", { path, readMaximumBytes: 32 * 1024 * 1024 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  const expected = createHash("sha256").update(bytes).digest("hex");
  const full = await request("fs.read", { path }, { readMaximumBytes: 32 * 1024 * 1024 });
  expect(full.sha256).toBe(expected);
  const range = await request("fs.read", { path }, { readLines: { offset: 2, limit: 3, maxLineChars: 2000 } });
  expect(range).toEqual({ lines: [join(f.agent, "proof.txt"), "last", ""], totalLines: 4, sha256: expected });
  expect(await request("fs.read", { path }, { readLines: { offset: 1, limit: 1, maxLineChars: 32 } }))
    .toEqual({ lines: ["a".repeat(32)], totalLines: 4, sha256: expected });
  await expect(request("fs.read", { path }, { readMaximumBytes: 33 * 1024 * 1024 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  f.setPolicy({ planMode: true });
  await expect(request("fs.read", { path }, { readLines: { offset: 2, limit: 1, maxLineChars: 2000 } })).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
});

it.each(["policy", "owner"] as const)("rejects an approval after its original %s changes, before creating a file", async kind => {
  const f = await fixture(); f.setPolicy({ permissionMode: "ask" });
  f.setAnswer(async () => { if (kind === "policy") f.setPolicy({ permissionMode: "bypassPermissions" }); else f.revoke();
    return { kind: "confirmed", confirmed: true }; });
  await expect(f.call("fs.write", { path: join(f.agent, "must-not-exist"), data: Buffer.from("write").toString("base64") })).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
  await expect(stat(join(f.task, "must-not-exist"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reserves each request before asynchronous execution and refuses uncertain write replays", async () => {
  const f = await fixture(), request = { format: 1, callId: "write", requestId: "write:2", operation: "fs.write",
    payload: { path: join(f.agent, "once.txt"), data: Buffer.from("first").toString("base64") } };
  await f.executor.execute({ ...request, requestId: "write:1", operation: "tool.begin", payload: { name: "write", input: { path: request.payload.path } } });
  await f.executor.execute(request); await writeFile(join(f.task, "once.txt"), "newer owner content");
  await expect(f.executor.execute(request)).rejects.toMatchObject({ code: "REQUEST_REPLAYED" });
  expect(await readFile(join(f.task, "once.txt"), "utf8")).toBe("newer owner content");
  await expect(f.call("fs.read", { path: join(f.agent, "missing") })).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(f.call("fs.read", { path: join(f.agent, "once.txt"), arbitrary: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});

it("binds a native approval to its exact operation and path instead of granting arbitrary reverse filesystem access", async () => {
  const f = await fixture(); await writeFile(join(f.task, "allowed.txt"), "read scope"); await writeFile(join(f.task, "other.txt"), "outside the approved tool");
  const request = (sequence: number, operation: string, payload: Record<string, unknown>) => f.executor.execute({ format: 1,
    callId: "read-scope", requestId: `read-scope:${sequence}`, operation, payload });
  await expect(request(1, "fs.read", { path: join(f.agent, "allowed.txt") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await request(2, "tool.begin", { name: "read", input: { path: join(f.agent, "allowed.txt") } });
  await expect(request(3, "fs.read", { path: join(f.agent, "allowed.txt") })).resolves.toHaveProperty("data");
  await expect(request(4, "fs.read", { path: join(f.agent, "other.txt") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(request(5, "fs.write", { path: join(f.agent, "allowed.txt"), data: Buffer.from("unauthorized write").toString("base64") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await request(6, "tool.end", {});
  await expect(request(7, "fs.read", { path: join(f.agent, "allowed.txt") })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(await readFile(join(f.task, "allowed.txt"), "utf8")).toBe("read scope");
});

it("keeps credential-bearing shell reads under task-origin consent in Full Access", async () => {
  const f = await fixture(); f.setPolicy({ permissionMode: "bypassPermissions", confirmCredentials: true });
  f.setAnswer(async question => { expect(question.title).toBe("Allow credential access"); return { kind: "confirmed", confirmed: false }; });
  for (const command of ["cat .env", "cat < .env", "bash -c 'cat .env'", "git credential fill"]) {
    await expect(f.call("exec.run", { command, cwd: f.agent })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  }
  expect(f.questions).toHaveLength(4); expect(f.gate.snapshot()).toEqual({ running: 0, queued: 0 });
});

it("allows Plan reads but blocks writes and runs shell with the original cwd and command gate", async () => {
  const f = await fixture(); await writeFile(join(f.task, "cwd.mjs"), "process.stdout.write(process.cwd());\n");
  f.setPolicy({ planMode: true });
  await expect(f.call("fs.read", { path: join(f.agent, "cwd.mjs") })).resolves.toHaveProperty("data");
  await expect(f.call("fs.write", { path: join(f.agent, "blocked"), data: "" })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  f.setPolicy({ planMode: false });
  const command = `"${process.execPath.replace(/\\/gu, "/")}" cwd.mjs`;
  const output = await f.call("exec.run", { command, cwd: f.agent, timeout: 10 });
  expect(output.exitCode).toBe(0);
  expect(Buffer.from(String(output.output), "base64").toString()).toBe(f.agent);
  expect(f.gate.snapshot()).toEqual({ running: 0, queued: 0 });
  expect(f.questions).toHaveLength(1);
});

it("denies git diff output and execution options in Plan before opening command capacity", async () => {
  const f = await fixture();
  f.setPolicy({ planMode: true });
  const outside = join(f.root, "outside.patch");
  await writeFile(outside, "owner content");
  for (const command of [
    `git diff --output=${outside.replace(/\\/gu, "/")}`,
    "git diff --out=inside.patch", "git diff -oinside.patch", "git diff --ext-diff", "git diff --textconv",
    "git diff", "git diff --stat"
  ]) {
    await expect(f.call("exec.run", { command, cwd: f.agent })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  }
  expect(await readFile(outside, "utf8")).toBe("owner content");
  await expect(stat(join(f.task, "inside.patch"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.questions).toEqual([]);
  expect(f.gate.snapshot()).toEqual({ running: 0, queued: 0 });
});

it("maps a Windows Agent path by complete segments onto the actual task filesystem", async () => {
  const f = await fixture();
  const executor = new HostedAgentExecutor({ context: f.context, virtualRoot: "Q:\\private-agent\\workspace",
    readPolicy: () => ({ revision: "first", permissionMode: "auto", planMode: false, approvedRoots: [], confirmCredentials: false }), assertCurrent: () => {} });
  try {
    expect(executor.workspace.resolve("Q:\\private-agent\\workspace\\nested\\file.txt")).toBe(join(f.task, "nested", "file.txt"));
    expect(executor.workspace.resolve("q:/PRIVATE-agent/workspace/nested/file.txt")).toBe(join(f.task, "nested", "file.txt"));
    expect(executor.workspace.localPathFromAgent("Q:\\private-agent\\workspace-copy\\file.txt")).toBeNull();
    expect(executor.workspace.mapCommand("cat 'Q:/private-agent/workspace/nested/file.txt'" )).toContain(f.task.replace(/\\/gu, "/"));
  } finally { executor.dispose(); }
});

it("keeps native exec-server primitive approval tied to Source policy and credential consent", async () => {
  const f = await fixture(); f.setPolicy({ permissionMode: "bypassPermissions", confirmCredentials: true });
  f.setAnswer(async () => ({ kind: "confirmed", confirmed: false }));
  await expect(f.executor.authorizeNativeActions([{ kind: "read", path: join(f.agent, ".env") }], f.context.signal)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  expect(f.questions).toHaveLength(1);
  const assert = await f.executor.authorizeNativeActions([{ kind: "write", path: join(f.agent, "approved.txt") }], f.context.signal);
  assert(); f.setPolicy({ planMode: true }); expect(assert).toThrow(expect.objectContaining({ code: "STALE_AUTHORITY" }));
  await expect(f.executor.authorizeNativeActions([{ kind: "write", path: join(f.agent, "not-approved.txt") }], f.context.signal)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

it("captures native shell cwd privately, streams projected output, and releases Source command capacity after exit", async () => {
  const f = await fixture(); await mkdir(join(f.task, "nested")); f.setPolicy({ permissionMode: "bypassPermissions" });
  const command = "cd nested\nprintf 'streamed-output\\n'", callId = "native-cwd";
  await f.executor.execute({ format: 1, callId, requestId: "native-cwd:1", operation: "tool.begin", payload: { name: "bash", input: { command, cwd: f.agent, timeout: 10 } } });
  const streamed: Buffer[] = [];
  const result = await f.executor.execute({ format: 1, callId, requestId: "native-cwd:2", operation: "exec.run", payload: { command, cwd: f.agent, timeout: 10 } },
    f.context.signal, { captureCwd: true, onOutput: chunk => streamed.push(chunk) });
  expect(result).toMatchObject({ cwd: join(f.agent, "nested"), exitCode: 0 });
  expect(Buffer.from(String(result.output), "base64").toString()).toBe("streamed-output\n");
  expect(Buffer.concat(streamed).toString()).toBe("streamed-output\n");
  expect(JSON.stringify(result)).not.toContain("JOKO_CWD_"); expect(f.gate.snapshot()).toEqual({ running: 0, queued: 0 });
});
