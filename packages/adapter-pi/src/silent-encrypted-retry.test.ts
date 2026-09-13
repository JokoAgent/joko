import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isInvalidEncryptedContentError,
  MANAGED_SILENT_ENCRYPTED_RETRY_SOURCE,
  provisionManagedSilentEncryptedRetry,
  SILENT_ENCRYPTED_RETRY_CONTROL_ENV,
  stripResponsesReasoningEncryptedContent,
  writeSilentEncryptedRetryControl
} from "./silent-encrypted-retry.js";
import { mkdtemp } from "./test-paths.js";

const installed = Symbol.for("joko.silent-encrypted-retry.fetch.v1");
const nativeFetch = globalThis.fetch;

type ManagedExtensionModule = {
  default: (pi: { on: (event: string, handler: (...args: unknown[]) => void) => void }) => void;
};

type ProviderHeaderHandler = (
  event: { headers: Record<string, string | null> },
  context: { model?: { api?: string } }
) => void;

function installForProvider(module: ManagedExtensionModule): {
  headers: (api?: string) => Record<string, string>;
  selectModel: () => void;
} {
  let modelSelect: (() => void) | undefined;
  let beforeProviderHeaders: ProviderHeaderHandler | undefined;
  module.default({
    on(event, handler) {
      if (event === "model_select") modelSelect = handler as () => void;
      if (event === "before_provider_headers") beforeProviderHeaders = handler as ProviderHeaderHandler;
    }
  });
  return {
    headers(api = "openai-responses") {
      const event: { headers: Record<string, string | null> } = { headers: {} };
      beforeProviderHeaders?.(event, { model: { api } });
      return Object.fromEntries(Object.entries(event.headers).filter((entry): entry is [string, string] => entry[1] !== null));
    },
    selectModel() {
      modelSelect?.();
    }
  };
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[installed];
  delete process.env[SILENT_ENCRYPTED_RETRY_CONTROL_ENV];
  delete process.env.JOKO_PI_GENERATION;
});

describe("silent encrypted-content recovery", () => {
  it("matches only the closed invalid-encrypted-content family", () => {
    expect(isInvalidEncryptedContentError('{"code":"invalid_encrypted_content"}')).toBe(true);
    expect(isInvalidEncryptedContentError("Could not decrypt the provided encrypted_content" )).toBe(true);
    expect(isInvalidEncryptedContentError("invalid-argument: encrypted_content could not be verified")).toBe(true);
    expect(isInvalidEncryptedContentError("invalid request body")).toBe(false);
    expect(isInvalidEncryptedContentError("compaction blob could not be decoded")).toBe(false);
  });

  it("drops only encrypted reasoning replay items and preserves compaction blobs", () => {
    const stripped = stripResponsesReasoningEncryptedContent(JSON.stringify({
      model: "grok-4.5",
      input: [
        { type: "compaction", encrypted_content: "COMP" },
        { type: "context_compaction", encrypted_content: "CONTEXT" },
        { type: "reasoning", encrypted_content: "SECRET", summary: [] },
        { type: "message", content: { encrypted_content: "BUSINESS" } }
      ]
    }));
    expect(stripped).toBeDefined();
    expect(JSON.parse(stripped!)).toEqual({
      model: "grok-4.5",
      input: [
        { type: "compaction", encrypted_content: "COMP" },
        { type: "context_compaction", encrypted_content: "CONTEXT" },
        { type: "message", content: { encrypted_content: "BUSINESS" } }
      ]
    });
    expect(stripResponsesReasoningEncryptedContent(JSON.stringify({
      model: "grok-4.5",
      input: [{ type: "compaction", encrypted_content: "COMP" }]
    }))).toBeUndefined();
  });

  it("provisions the managed extension without logging payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-encrypted-retry-"));
    try {
      const path = await provisionManagedSilentEncryptedRetry(root);
      expect(await readFile(path, "utf8")).toBe(MANAGED_SILENT_ENCRYPTED_RETRY_SOURCE);
      expect(MANAGED_SILENT_ENCRYPTED_RETRY_SOURCE).not.toMatch(/console\.|logger\.|process\.stdout|process\.stderr/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries one matching Responses 400, pre-strips only that route, and preserves abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-encrypted-retry-runtime-"));
    try {
      const extensionPath = await provisionManagedSilentEncryptedRetry(root);
      const controlPath = join(root, "control.json");
      await writeSilentEncryptedRetryControl(controlPath, 7, true);
      process.env[SILENT_ENCRYPTED_RETRY_CONTROL_ENV] = controlPath;
      process.env.JOKO_PI_GENERATION = "7";

      const bodies: string[] = [];
      let firstFailure = true;
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        expect([...request.headers.keys()]).not.toContain("x-joko-silent-encrypted-retry-provider");
        bodies.push(await request.clone().text());
        if (firstFailure) {
          firstFailure = false;
          return new Response('{"error":{"code":"invalid_encrypted_content"}}', {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response("ok", { status: 200 });
      };
      const module = await import(`${pathToFileURL(extensionPath).href}?test=${Date.now()}`) as ManagedExtensionModule;
      const hooks = installForProvider(module);

      const requestBody = JSON.stringify({
        model: "grok-4.5",
        input: [
          { type: "compaction", encrypted_content: "COMP" },
          { type: "reasoning", encrypted_content: "SECRET" }
        ]
      });
      const send = (model = "grok-4.5", signal?: AbortSignal) => globalThis.fetch("https://provider.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...hooks.headers() },
        body: requestBody.replace("grok-4.5", model),
        signal
      });

      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toContain("SECRET");
      expect(bodies[1]).not.toContain("SECRET");
      expect(bodies[1]).toContain("COMP");

      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toContain("SECRET");
      expect(bodies[2]).toContain("COMP");

      await expect(send("other-model")).resolves.toMatchObject({ status: 200 });
      expect(bodies[3]).toContain("SECRET");

      // Switching away clears the marker rather than retaining historical
      // model keys, so switching back starts with one byte-identical request.
      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies[4]).toContain("SECRET");

      // Pi also reports switches to non-Responses models. That event clears
      // the per-runtime marker even though no /responses request observed it.
      firstFailure = true;
      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies[5]).toContain("SECRET");
      expect(bodies[6]).not.toContain("SECRET");
      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies[7]).not.toContain("SECRET");
      hooks.selectModel();
      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies[8]).toContain("SECRET");

      await expect(globalThis.fetch("https://other-provider.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...hooks.headers() },
        body: requestBody
      })).resolves.toMatchObject({ status: 200 });
      expect(bodies[9]).toContain("SECRET");
      await expect(send()).resolves.toMatchObject({ status: 200 });
      expect(bodies[10]).toContain("SECRET");

      const abort = new AbortController();
      abort.abort(new DOMException("cancelled", "AbortError"));
      await expect(send("aborted-model", abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts 422 but never retries unknown, disabled, compact, or a retry response twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-encrypted-retry-closed-"));
    try {
      const extensionPath = await provisionManagedSilentEncryptedRetry(root);
      const controlPath = join(root, "control.json");
      await writeSilentEncryptedRetryControl(controlPath, 11, true);
      process.env[SILENT_ENCRYPTED_RETRY_CONTROL_ENV] = controlPath;
      process.env.JOKO_PI_GENERATION = "11";
      const calls = new Map<string, number>();
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        expect([...request.headers.keys()]).not.toContain("x-joko-silent-encrypted-retry-provider");
        const body = JSON.parse(await request.clone().text()) as { model: string };
        calls.set(body.model, (calls.get(body.model) ?? 0) + 1);
        if (body.model === "unknown") return new Response('{"error":"bad request"}', { status: 400 });
        if (body.model === "success-422" && calls.get(body.model) === 2) return new Response("ok", { status: 200 });
        return new Response('{"error":"Could not decrypt the provided encrypted_content"}', {
          status: body.model === "success-422" ? 422 : 400
        });
      };
      const module = await import(`${pathToFileURL(extensionPath).href}?closed=${Date.now()}`) as ManagedExtensionModule;
      const hooks = installForProvider(module);
      const send = (model: string, path = "/v1/responses", api = "openai-responses") => globalThis.fetch(`https://provider.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hooks.headers(api) },
        body: JSON.stringify({ model, input: [{ type: "reasoning", encrypted_content: "SECRET" }] })
      });

      await expect(send("always-fails")).resolves.toMatchObject({ status: 400 });
      expect(calls.get("always-fails")).toBe(2);
      await expect(send("always-fails")).resolves.toMatchObject({ status: 400 });
      expect(calls.get("always-fails")).toBe(3);
      await expect(send("success-422")).resolves.toMatchObject({ status: 200 });
      expect(calls.get("success-422")).toBe(2);
      const unknown = await send("unknown");
      expect(unknown.status).toBe(400);
      await expect(unknown.text()).resolves.toBe('{"error":"bad request"}');
      expect(calls.get("unknown")).toBe(1);
      await expect(send("compact", "/v1/responses/compact")).resolves.toMatchObject({ status: 400 });
      expect(calls.get("compact")).toBe(1);
      await expect(send("stock-pi", "/v1/responses", "openai-completions")).resolves.toMatchObject({ status: 400 });
      expect(calls.get("stock-pi")).toBe(1);

      await writeSilentEncryptedRetryControl(controlPath, 11, false);
      await expect(send("disabled")).resolves.toMatchObject({ status: 400 });
      expect(calls.get("disabled")).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts while inspecting a matching error body without dispatching a retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-encrypted-retry-abort-"));
    try {
      const extensionPath = await provisionManagedSilentEncryptedRetry(root);
      const controlPath = join(root, "control.json");
      await writeSilentEncryptedRetryControl(controlPath, 13, true);
      process.env[SILENT_ENCRYPTED_RETRY_CONTROL_ENV] = controlPath;
      process.env.JOKO_PI_GENERATION = "13";
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"code":"invalid_encrypted_content"}'));
          }
        }), { status: 400 });
      };
      const module = await import(`${pathToFileURL(extensionPath).href}?abort=${Date.now()}`) as ManagedExtensionModule;
      const hooks = installForProvider(module);
      const abort = new AbortController();
      const pending = globalThis.fetch("https://provider.test/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...hooks.headers() },
        body: JSON.stringify({
          model: "grok-4.5",
          input: [{ type: "reasoning", encrypted_content: "SECRET" }]
        }),
        signal: abort.signal
      });
      await new Promise((resolve) => setImmediate(resolve));
      abort.abort(new DOMException("timed out", "AbortError"));

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
