import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AdapterContext, BlobRef, EventPayload, InteractionPayload, TargetDescriptor } from "@joko/core";
import { describe, expect, it } from "vitest";
import { createPiAdapter } from "./adapter.js";
import { mkdtemp } from "./test-paths.js";

type ReviewCase = "allow" | "block" | "ask" | "failure" | "bypass";

describe("real latest Pi auto-review smoke", () => {
  it("routes gray calls through the current fake provider for allow/block/ask/failure", { timeout: 60_000 }, async () => {
    const traffic: Array<{ kind: "main" | "review"; scenario: ReviewCase; body: Record<string, unknown> }> = [];
    const server = await startReviewProvider(traffic);
    const address = server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-auto-review-home-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-auto-review-sessions-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-auto-review-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot,
      providers: [{
        id: "review-smoke",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{ id: "review-model", name: "Review Model", contextWindow: 16_384, maxTokens: 1_024 }],
      }],
    });
    const target: TargetDescriptor = {
      id: "auto-review-target",
      backendId: "pi",
      displayName: "Auto Review",
      workspaceRoot: workspace,
      managed: true,
      trusted: false,
    };

    try {
      for (const scenario of ["allow", "block", "ask", "failure"] as const) {
        const sink = new SmokeSink();
        const interactions: InteractionPayload[] = [];
        const base = smokeContext(target, `auto-review-${scenario}`, sink, interactions);
        const binding = await adapter.createSession({
          target,
          providerId: "review-smoke",
          modelId: "review-model",
          effort: "off",
          fastMode: false,
          permissionMode: "auto",
        }, base);
        const context = { ...base, binding };
        await adapter.send({
          text: `gray-${scenario}: inspect the current Node version`,
          images: [],
          files: [],
          mentions: [],
          disposition: "prompt",
        }, context);
        await sink.waitForDone();
        expect(sink.text).toContain(`done-${scenario}`);

        const reviews = traffic.filter((request) => request.kind === "review" && request.scenario === scenario);
        expect(reviews).toHaveLength(1);
        const reviewBody = JSON.stringify(reviews[0]?.body);
        const reviewMessages = reviews[0]?.body.messages as Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
        const reviewUser = reviewMessages.find((message) => message.role === "user");
        const reviewText = Array.isArray(reviewUser?.content)
          ? reviewUser.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("")
          : reviewUser?.content ?? "";
        const reviewPayload = JSON.parse(reviewText) as { workspace?: string };
        expect(reviewBody).toContain("permission reviewer");
        expect(reviewBody).toContain("node --version");
        expect(reviewPayload.workspace).toBe(workspace);
        expect(reviewBody).not.toContain("tool_result");

        if (scenario === "allow" || scenario === "block") expect(interactions).toHaveLength(0);
        else {
          expect(interactions).toHaveLength(1);
          expect(interactions[0]).toMatchObject({ kind: "permission", toolName: "bash" });
        }
        if (scenario === "block") {
          const continuation = traffic.find((request) => request.kind === "main" && request.scenario === scenario && JSON.stringify(request.body).includes("Use node -p process.version instead."));
          expect(continuation).toBeDefined();
        }
        await adapter.closeSession(binding, context);
      }
    } finally {
      await adapter.dispose().catch(() => undefined);
      await closeServer(server);
    }
  });

  it("runs an ordinary dangerous-classified tool without an interaction in Full Access", { timeout: 60_000 }, async () => {
    const traffic: Array<{ kind: "main" | "review"; scenario: ReviewCase; body: Record<string, unknown> }> = [];
    const server = await startReviewProvider(traffic);
    const address = server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-full-access-home-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-full-access-sessions-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-full-access-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot,
      providers: [{
        id: "review-smoke",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{ id: "review-model", name: "Review Model", contextWindow: 16_384, maxTokens: 1_024 }],
      }],
    });
    const target: TargetDescriptor = {
      id: "full-access-target",
      backendId: "pi",
      displayName: "Full Access",
      workspaceRoot: workspace,
      managed: true,
      trusted: false,
    };
    const sink = new SmokeSink();
    const interactions: InteractionPayload[] = [];
    const base = smokeContext(target, "full-access-bypass", sink, interactions);

    try {
      const binding = await adapter.createSession({
        target,
        providerId: "review-smoke",
        modelId: "review-model",
        effort: "off",
        fastMode: false,
        permissionMode: "bypassPermissions",
      }, base);
      const context = { ...base, binding };
      await adapter.send({
        text: "gray-bypass: run the harmless command requested by this fixture",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt",
      }, context);
      await sink.waitForDone();

      expect(sink.text).toContain("done-bypass");
      expect(interactions).toHaveLength(0);
      expect(traffic.filter((request) => request.kind === "review")).toHaveLength(0);
      expect(traffic.some((request) => request.kind === "main" && JSON.stringify(request.body).includes("shutdown"))).toBe(true);
      await adapter.closeSession(binding, context);
    } finally {
      await adapter.dispose().catch(() => undefined);
      await closeServer(server);
    }
  });
});

class SmokeSink {
  readonly events: EventPayload[] = [];
  #done = false;
  #waiters: Array<() => void> = [];

  get text(): string {
    return this.events
      .filter((event): event is Extract<EventPayload, { type: "text_delta" }> => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
  }

  async emit(event: EventPayload): Promise<void> {
    this.events.push(event);
    if (event.type !== "done") return;
    this.#done = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async waitForDone(): Promise<void> {
    if (this.#done) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for Pi auto-review smoke")), 20_000);
      this.#waiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

function smokeContext(
  target: TargetDescriptor,
  sessionId: string,
  sink: SmokeSink,
  interactions: InteractionPayload[],
): AdapterContext {
  return {
    sessionId,
    generation: 1,
    target,
    signal: new AbortController().signal,
    emit: (event) => sink.emit(event),
    requestInteraction: async (interaction) => {
      interactions.push(interaction);
      return { kind: "confirmed", confirmed: true };
    },
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async (sourcePath, options) => blob(Buffer.from(sourcePath), options?.mimeType, options?.fileName),
  };
}

function blob(bytes: Uint8Array, mimeType = "application/octet-stream", fileName?: string): BlobRef {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { id: `auto-review-${digest.slice(0, 12)}`, sha256: digest, byteLength: bytes.byteLength, mimeType, fileName };
}

async function startReviewProvider(
  traffic: Array<{ kind: "main" | "review"; scenario: ReviewCase; body: Record<string, unknown> }>,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const serialized = JSON.stringify(body);
      const scenario = (["allow", "block", "ask", "failure", "bypass"] as const).find((candidate) => serialized.includes(`gray-${candidate}`));
      if (!scenario) {
        response.writeHead(400).end("missing review scenario");
        return;
      }
      const isReview = serialized.includes("You are a permission reviewer for one tool call");
      traffic.push({ kind: isReview ? "review" : "main", scenario, body });
      if (isReview) {
        const decision = scenario === "allow"
          ? { verdict: "allow", reason: "The read-only version check is required and scoped." }
          : scenario === "block"
            ? { verdict: "block", reason: "Use a narrower expression.", safeAlternative: "Use node -p process.version instead." }
            : scenario === "ask"
              ? { verdict: "ask", reason: "Confirm this executable invocation." }
              : undefined;
        writeTextCompletion(response, decision ? JSON.stringify(decision) : "not structured JSON", `review-${scenario}`);
        return;
      }
      const hasToolResult = serialized.includes("tool_call_id") || serialized.includes('"role":"tool"');
      if (hasToolResult) writeTextCompletion(response, `done-${scenario}`, `done-${scenario}`);
      else writeToolCall(response, scenario);
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

function writeHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function writeTextCompletion(response: ServerResponse, text: string, id: string): void {
  writeHeaders(response);
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "review-model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "review-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function writeToolCall(response: ServerResponse, scenario: ReviewCase): void {
  const id = `tool-${scenario}`;
  writeHeaders(response);
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "review-model",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: `call-${scenario}`,
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: scenario === "bypass" ? "echo shutdown" : "node --version" }),
          },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "review-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
