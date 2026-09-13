import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, BlobRef, EventPayload, TargetDescriptor } from "@joko/core";
import { describe, expect, it } from "vitest";

import { createPiAdapter } from "./adapter.js";
import type { PiSupportedApi } from "./config.js";
import { mkdtemp } from "./test-paths.js";

const providerId = process.env["JOKO_REAL_PI_PROVIDER_ID"]?.trim();
const modelId = process.env["JOKO_REAL_PI_MODEL_ID"]?.trim();
const baseUrl = process.env["JOKO_REAL_PI_BASE_URL"]?.trim();
const api = managedApi(process.env["JOKO_REAL_PI_API"]);
const apiKeyEnvironment = process.env["JOKO_REAL_PI_API_KEY_ENV"]?.trim();
const apiKey = apiKeyEnvironment === undefined ? undefined : process.env[apiKeyEnvironment];
const configured = providerId !== undefined && modelId !== undefined && baseUrl !== undefined && api !== undefined &&
  (apiKeyEnvironment === undefined || (apiKey !== undefined && apiKey.length > 0));

describe.skipIf(!configured)("opt-in real Pi Provider", () => {
  it("completes a real provider/model turn without exposing its credential", { timeout: 120_000 }, async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "joko-real-provider-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-provider-workspace-"));
    const events: EventPayload[] = [];
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: providerId!,
        baseUrl: baseUrl!,
        api: api!,
        keyless: apiKeyEnvironment === undefined,
        ...(apiKeyEnvironment === undefined ? {} : { apiKeyEnv: apiKeyEnvironment }),
        models: [{
          id: modelId!,
          name: modelId!,
          contextWindow: positiveInteger(process.env["JOKO_REAL_PI_CONTEXT_WINDOW"], 128_000),
          maxTokens: positiveInteger(process.env["JOKO_REAL_PI_MAX_OUTPUT"], 4_096)
        }]
      }],
      ...(apiKeyEnvironment === undefined || apiKey === undefined
        ? {}
        : {
            environment: { [apiKeyEnvironment]: apiKey },
            secretEnvironmentNames: [apiKeyEnvironment]
          })
    });
    const target: TargetDescriptor = {
      id: "opt-in-real-provider-target",
      backendId: "pi",
      displayName: "Opt-in real provider",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const context: AdapterContext = {
      sessionId: "opt-in-real-provider-session",
      generation: 1,
      target,
      signal: new AbortController().signal,
      emit: async (event) => { events.push(event); },
      requestInteraction: async () => ({ kind: "confirmed", confirmed: true }),
      artifactCapacityBytes: 256 * 1024 * 1024,
      storeArtifact: async (path, options) => blob(Buffer.from(path), options?.mimeType, options?.fileName)
    };
    try {
      const binding = await adapter.createSession({
        target,
        providerId: providerId!,
        modelId: modelId!,
        effort: process.env["JOKO_REAL_PI_EFFORT"]?.trim() || "off",
        fastMode: false,
        permissionMode: "ask"
      }, context);
      await adapter.send({
        text: process.env["JOKO_REAL_PI_PROMPT"]?.trim() || "Reply with a short acknowledgement and do not call tools.",
        images: [],
        files: [],
        mentions: [],
        disposition: "prompt"
      }, { ...context, binding });
      await waitFor(() => events.some((event) => event.type === "done"), 90_000);
      expect(events.find((event) => event.type === "done")).toMatchObject({ type: "done", outcome: "completed" });
      expect(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "").join("").trim()).not.toBe("");
      if (apiKey !== undefined) expect(JSON.stringify(events)).not.toContain(apiKey);
    } finally {
      await adapter.dispose().catch(() => undefined);
      await Promise.all([
        rm(agentHome, { recursive: true, force: true }),
        rm(workspace, { recursive: true, force: true })
      ]);
    }
  });
});

function managedApi(value: string | undefined): PiSupportedApi | undefined {
  if (
    value === "anthropic-messages" || value === "openai-responses" ||
    value === "openai-completions" || value === "google-generative-ai"
  ) return value;
  return undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for the opt-in real Provider turn to settle.");
}

function blob(bytes: Uint8Array, mimeType = "application/octet-stream", fileName?: string): BlobRef {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { id: `real-provider-${sha256.slice(0, 12)}`, sha256, byteLength: bytes.byteLength, mimeType, fileName };
}
