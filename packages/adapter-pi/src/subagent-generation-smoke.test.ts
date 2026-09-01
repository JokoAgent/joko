import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { AdapterContext, BlobRef, EventPayload, TargetDescriptor } from "@joko/core";
import { describe, expect, it } from "vitest";

import { createPiAdapter } from "./adapter.js";
import { managedSubagentSessionKey } from "./durable-subagent-runs.js";
import { mkdtemp } from "./test-paths.js";

describe("real managed Pi subagent smoke", () => {
  it("runs a durable background child against a local fake provider with stable sessions and no ambient resources or credential disclosure", { timeout: 75_000 }, async () => {
    const credentialCanary = "joko-subagent-secret-canary-value";
    const requests: Record<string, unknown>[] = [];
    const server = await startSubagentProvider(requests, credentialCanary, 1_500);
    const address = server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-subagent-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-pi-subagent-workspace-"));
    const ambientMarker = join(workspace, "ambient-project-extension-loaded");
    const ambientExtensionDirectory = join(workspace, ".pi", "extensions");
    await mkdir(ambientExtensionDirectory, { recursive: true });
    await writeFile(
      join(ambientExtensionDirectory, "untrusted-project-extension.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(ambientMarker)}, "loaded");`,
        "export default function untrustedProjectExtension() {}",
        ""
      ].join("\n"),
      "utf8"
    );
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: "subagent-smoke",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{ id: "subagent-smoke-model", name: "Subagent Smoke", contextWindow: 16_384, maxTokens: 1_024 }]
      }],
      environment: { JOKO_SUBAGENT_SMOKE_KEY: credentialCanary },
      secretEnvironmentNames: ["JOKO_SUBAGENT_SMOKE_KEY"]
    });
    const target: TargetDescriptor = {
      id: "real-pi-subagent-target",
      backendId: "pi",
      displayName: "Real Pi Subagent",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const sink = new SubagentEventSink();
    const context = subagentContext(target, sink);
    let disposed = false;
    try {
      const descriptor = await adapter.describe();
      expect(descriptor.capabilities.get("background.tasks")).toMatchObject({ supported: true });
      for (const capability of [
        "subagents.list", "subagents.detail", "subagents.transcript", "subagents.stop",
        "subagents.steer", "subagents.follow_up", "subagents.resume"
      ]) expect(descriptor.capabilities.get(capability)).toMatchObject({ supported: true });
      const binding = await adapter.createSession({
        target,
        providerId: "subagent-smoke",
        modelId: "subagent-smoke-model",
        effort: "off",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await adapter.send(
        { text: "Use the subagent tool exactly once as a background scout, then report that it started.", images: [], files: [], mentions: [], disposition: "prompt" },
        { ...context, binding }
      );
      await sink.waitFor((event) => event.type === "done", "parent turn completion");
      await adapter.closeSession(binding, context);
      const durableSessionDirectory = join(agentHome, "subagent-runs", managedSubagentSessionKey(context.sessionId));
      const durableRunIds = await waitForRunDirectories(durableSessionDirectory, 1, 15_000);
      const durableRunDirectory = join(durableSessionDirectory, durableRunIds[0]!);
      await waitForDurableState(join(durableRunDirectory, "status.json"), "completed", 30_000);
      await sink.waitFor(
        (event) => event.type === "subagent_run" && event.run.state === "completed",
        "detached canonical Subagent completion"
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      const canonicalEventCountBeforeRestart = sink.events.filter(
        (event) => event.type === "subagent_run" || event.type === "subagent_transcript"
      ).length;
      expect(sink.events.some((event) => event.type === "background_task" && event.state === "completed")).toBe(false);
      const recoveredContext = { ...context, generation: 2, binding };
      await adapter.resumeSession(binding, recoveredContext);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      expect(sink.events.filter(
        (event) => event.type === "subagent_run" || event.type === "subagent_transcript"
      )).toHaveLength(canonicalEventCountBeforeRestart);
      const recoveredDoneCount = sink.events.filter((event) => event.type === "done").length;
      await adapter.send(
        { text: "Use subagent_status with action list exactly once, then report that the recovered task is visible.", images: [], files: [], mentions: [], disposition: "prompt" },
        recoveredContext
      );
      await sink.waitFor(
        (event) => event.type === "done" && sink.events.filter((candidate) => candidate.type === "done").length > recoveredDoneCount,
        "recovered status inspection"
      );

      expect(sink.text).toContain("PARENT_BACKGROUND_STARTED");
      expect(sink.text).toContain("RECOVERED_STATUS_VISIBLE");
      const recoveredCompletion = sink.events.find((event) => event.type === "background_task" && event.state === "completed");
      expect(recoveredCompletion).toMatchObject({ type: "background_task", title: "scout subagent", state: "completed" });
      expect(recoveredCompletion?.type === "background_task" ? recoveredCompletion.detail : "").toContain("[REDACTED]");
      expect(sink.events.filter((event) => event.type === "background_task").map((event) => event.state)).toEqual(
        expect.arrayContaining(["queued", "completed"])
      );
      const canonicalCompletion = await sink.waitFor(
        (event) => event.type === "subagent_run" && event.run.state === "completed",
        "canonical recovered Subagent completion"
      );
      expect(canonicalCompletion).toMatchObject({
        type: "subagent_run",
        run: {
          id: "joko-subagent-smoke-call:step-1",
          sessionId: context.sessionId,
          logicalAgentId: "joko-subagent-smoke-call:step-1",
          state: "completed",
          capabilities: {
            viewActivity: true,
            viewReturnedResult: true,
            viewFullTranscript: true,
            resume: true,
            parentContext: "none"
          }
        }
      });
      const firstCanonicalRun = canonicalCompletion.type === "subagent_run" ? canonicalCompletion.run : undefined;
      expect(firstCanonicalRun?.providerRunIds).toHaveLength(1);
      const firstTranscript = sink.events.filter(
        (event): event is Extract<EventPayload, { type: "subagent_transcript" }> =>
          event.type === "subagent_transcript" && event.subagentRunId === "joko-subagent-smoke-call:step-1"
      );
      expect(firstTranscript.length).toBeGreaterThan(0);
      expect(firstTranscript.map((event) => event.entry.sequence)).toEqual(
        firstTranscript.map((_, index) => index + 1)
      );
      expect(firstTranscript.every((event) => event.entry.childId === undefined
        || event.entry.childId === "joko-subagent-smoke-call:step-1:child")).toBe(true);

      const parentRequests = requests.filter((request) => requestToolNames(request).includes("subagent"));
      const childRequests = requests.filter((request) => !requestToolNames(request).includes("subagent"));
      expect(parentRequests).toHaveLength(4);
      expect(childRequests).toHaveLength(1);
      expect(childRequests[0]?.["model"]).toBe("subagent-smoke-model");
      expect(requestToolNames(childRequests[0]!)).toEqual(["read", "grep", "find", "ls"]);
      expect(JSON.stringify(requests)).not.toContain(credentialCanary);
      expect(JSON.stringify(parentRequests[3])).toContain("joko-subagent-smoke-call:step-1");
      expect(JSON.stringify(parentRequests[3])).toContain("completed");
      expect(JSON.stringify(sink.events)).not.toContain(credentialCanary);
      await expect(access(ambientMarker)).rejects.toMatchObject({ code: "ENOENT" });

      expect(durableRunIds).toHaveLength(1);
      const durableStatus = JSON.parse(await readFile(join(durableRunDirectory, "status.json"), "utf8")) as Record<string, unknown>;
      expect(durableStatus).toMatchObject({ state: "completed", taskId: "joko-subagent-smoke-call:step-1" });
      const nativeSessionRelative = relative(
        resolve(durableRunDirectory, "sessions"),
        resolve(String(durableStatus["nativeSessionPath"]))
      );
      expect(nativeSessionRelative).not.toBe("");
      expect(isAbsolute(nativeSessionRelative)).toBe(false);
      expect(nativeSessionRelative).not.toMatch(/^\.\.(?:[\\/]|$)/u);
      const durableFiles = await Promise.all(["config.json", "status.json", "result.json", "transcript.jsonl"]
        .map((name) => readFile(join(durableRunDirectory, name), "utf8")));
      expect(durableFiles.join("\n")).not.toContain(credentialCanary);
      expect(await readFile(String(durableStatus["nativeSessionPath"]), "utf8")).not.toContain(credentialCanary);
      const resumeDoneCount = sink.events.filter((event) => event.type === "done").length;
      await adapter.send(
        { text: "Resume the recovered subagent_status task with a short follow-up, then report that resume started.", images: [], files: [], mentions: [], disposition: "prompt" },
        recoveredContext
      );
      await sink.waitFor(
        (event) => event.type === "done" && sink.events.filter((candidate) => candidate.type === "done").length > resumeDoneCount,
        "same-session resume launch"
      );
      const resumedRunIds = await waitForRunDirectories(durableSessionDirectory, 2, 15_000);
      const resumedRunDirectory = join(durableSessionDirectory, resumedRunIds.find((id) => id !== durableRunIds[0])!);
      await waitForDurableState(join(resumedRunDirectory, "status.json"), "completed", 30_000);
      const resumedStatus = JSON.parse(await readFile(join(resumedRunDirectory, "status.json"), "utf8")) as Record<string, unknown>;
      expect(resumedStatus).toMatchObject({
        state: "completed",
        taskId: "joko-subagent-smoke-call:step-1",
        nativeSessionId: durableStatus["nativeSessionId"],
        nativeSessionPath: durableStatus["nativeSessionPath"]
      });
      const resumedCanonical = await sink.waitFor(
        (event) => event.type === "subagent_run" && event.run.id === "joko-subagent-smoke-call:step-1"
          && event.run.state === "completed" && event.run.providerRunIds.length === 2,
        "canonical resumed Subagent completion"
      );
      expect(resumedCanonical.type === "subagent_run" ? resumedCanonical.run.activity : []).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "resumed" })])
      );
      const allTranscript = sink.events.filter(
        (event): event is Extract<EventPayload, { type: "subagent_transcript" }> =>
          event.type === "subagent_transcript" && event.subagentRunId === "joko-subagent-smoke-call:step-1"
      );
      expect(allTranscript.map((event) => event.entry.sequence)).toEqual(
        allTranscript.map((_, index) => index + 1)
      );
      expect(new Set(allTranscript.map((event) => event.entry.id)).size).toBe(allTranscript.length);
      expect(allTranscript.some((event) => event.entry.controlAction === "resume")).toBe(true);
      expect(await readFile(String(resumedStatus["nativeSessionPath"]), "utf8")).not.toContain(credentialCanary);
      expect(requests.filter((request) => !requestToolNames(request).includes("subagent"))).toHaveLength(2);
      expect(JSON.stringify(requests)).not.toContain(credentialCanary);
      expect(JSON.stringify(sink.events)).not.toContain(credentialCanary);

      const chainedResumeDoneCount = sink.events.filter((event) => event.type === "done").length;
      await adapter.send(
        { text: "Resume the same recovered subagent_status task one more time, then report that the chained resume started.", images: [], files: [], mentions: [], disposition: "prompt" },
        recoveredContext
      );
      await sink.waitFor(
        (event) => event.type === "done" && sink.events.filter((candidate) => candidate.type === "done").length > chainedResumeDoneCount,
        "second same-session resume launch"
      );
      const chainedRunIds = await waitForRunDirectories(durableSessionDirectory, 3, 15_000);
      const priorRunIds = new Set(resumedRunIds);
      const chainedRunDirectory = join(durableSessionDirectory, chainedRunIds.find((id) => !priorRunIds.has(id))!);
      await waitForDurableState(join(chainedRunDirectory, "status.json"), "completed", 30_000);
      const chainedStatus = JSON.parse(await readFile(join(chainedRunDirectory, "status.json"), "utf8")) as Record<string, unknown>;
      expect(chainedStatus).toMatchObject({
        state: "completed",
        taskId: "joko-subagent-smoke-call:step-1",
        nativeSessionId: durableStatus["nativeSessionId"],
        nativeSessionPath: durableStatus["nativeSessionPath"]
      });
      await sink.waitFor(
        (event) => event.type === "subagent_run" && event.run.id === "joko-subagent-smoke-call:step-1"
          && event.run.state === "completed" && event.run.providerRunIds.length === 3,
        "second canonical resumed Subagent completion"
      );
      expect(sink.text).toContain("CHAINED_RESUME_STARTED");
      expect(requests.filter((request) => !requestToolNames(request).includes("subagent"))).toHaveLength(3);
      expect(await readFile(String(chainedStatus["nativeSessionPath"]), "utf8")).not.toContain(credentialCanary);
      expect(JSON.stringify(requests)).not.toContain(credentialCanary);
      expect(JSON.stringify(sink.events)).not.toContain(credentialCanary);
      const sessionEntries = await readdir(join(agentHome, "sessions"));
      expect(sessionEntries.filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
      await adapter.dispose();
      disposed = true;
      expect(JSON.parse(await readFile(join(durableRunDirectory, "status.json"), "utf8"))).toMatchObject({ state: "completed" });
    } finally {
      if (!disposed) await adapter.dispose().catch(() => undefined);
      await closeServer(server);
    }
  });
});

class SubagentEventSink {
  readonly events: EventPayload[] = [];
  readonly #waiters = new Set<{
    readonly predicate: (event: EventPayload) => boolean;
    readonly resolve: (event: EventPayload) => void;
  }>();

  get text(): string {
    return this.events
      .filter((event): event is Extract<EventPayload, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
  }

  async emit(payload: EventPayload): Promise<void> {
    this.events.push(payload);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(payload)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(payload);
    }
  }

  async waitFor(predicate: (event: EventPayload) => boolean, description: string): Promise<EventPayload> {
    const existing = this.events.find(predicate);
    if (existing !== undefined) return existing;
    return new Promise<EventPayload>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (event: EventPayload) => {
          clearTimeout(timer);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${description}`));
      }, 40_000);
      this.#waiters.add(waiter);
    });
  }
}

function subagentContext(target: TargetDescriptor, sink: SubagentEventSink): AdapterContext {
  return {
    sessionId: "real-pi-subagent-session",
    generation: 1,
    target,
    signal: new AbortController().signal,
    emit: (payload) => sink.emit(payload),
    requestInteraction: async () => ({ kind: "confirmed", confirmed: true }),
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async (sourcePath, options) => blob(Buffer.from(sourcePath), options?.mimeType, options?.fileName)
  };
}

function blob(bytes: Uint8Array, mimeType = "application/octet-stream", fileName?: string): BlobRef {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { id: `subagent-${sha256.slice(0, 12)}`, sha256, byteLength: bytes.byteLength, mimeType, fileName };
}

async function startSubagentProvider(
  requests: Record<string, unknown>[],
  credentialCanary: string,
  childDelayMs = 100
): Promise<Server> {
  let parentRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      if (requestToolNames(body).includes("subagent")) {
        parentRequestCount += 1;
        if (parentRequestCount === 1) {
          writeToolCall(response, {
            agent: "scout",
            task: "Return one short conclusion without invoking tools.",
            background: true,
            timeoutSeconds: 30
          });
        } else if (parentRequestCount === 3) {
          writeToolCall(response, { action: "list" }, "subagent_status");
        } else if (parentRequestCount === 4) {
          writeText(response, "RECOVERED_STATUS_VISIBLE");
        } else if (parentRequestCount === 5) {
          writeToolCall(response, {
            action: "resume",
            taskId: "joko-subagent-smoke-call:step-1",
            message: "Return one more short conclusion."
          }, "subagent_status");
        } else if (parentRequestCount === 6) {
          writeText(response, "RESUME_STARTED");
        } else if (parentRequestCount === 7) {
          writeToolCall(response, {
            action: "resume",
            taskId: "joko-subagent-smoke-call:step-1",
            message: "Return one final short conclusion."
          }, "subagent_status");
        } else if (parentRequestCount === 8) {
          writeText(response, "CHAINED_RESUME_STARTED");
        } else {
          writeText(response, "PARENT_BACKGROUND_STARTED");
        }
        return;
      }
      // Delay the child so the parent demonstrably settles before the typed
      // background terminal message is published.
      setTimeout(() => writeText(response, `CHILD_COMPLETE ${credentialCanary}`), childDelayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function requestToolNames(request: Record<string, unknown>): string[] {
  if (!Array.isArray(request["tools"])) return [];
  return request["tools"].flatMap((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
    const fn = (tool as Record<string, unknown>)["function"];
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return [];
    const name = (fn as Record<string, unknown>)["name"];
    return typeof name === "string" ? [name] : [];
  });
}

function writeToolCall(response: ServerResponse, parameters: Record<string, unknown>, name = "subagent"): void {
  beginSse(response);
  writeChunk(response, {
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "joko-subagent-smoke-call",
          type: "function",
          function: { name, arguments: JSON.stringify(parameters) }
        }]
      },
      finish_reason: null
    }]
  });
  writeChunk(response, {
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
  response.end("data: [DONE]\n\n");
}

function writeText(response: ServerResponse, text: string): void {
  beginSse(response);
  writeChunk(response, {
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]
  });
  writeChunk(response, {
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
  response.end("data: [DONE]\n\n");
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
}

function writeChunk(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({
    id: "joko-subagent-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model: "subagent-smoke-model",
    ...value
  })}\n\n`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function waitForRunDirectories(path: string, count: number, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const runs = entries
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.name))
      .map((entry) => entry.name);
    if (runs.length === count) return runs;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} durable run directories`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function waitForDurableState(path: string, state: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (status["state"] === state) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for durable state ${state}: ${JSON.stringify(status)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}
