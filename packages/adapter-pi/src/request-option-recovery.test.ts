import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { provisionManagedRequestOptionRecovery } from "./request-option-recovery.js";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { provisionManagedSilentEncryptedRetry, writeSilentEncryptedRetryControl } from "./silent-encrypted-retry.js";

const nativeFetch = globalThis.fetch;
const installed = Symbol.for("joko.request-option-recovery.fetch.v1");
afterEach(() => {
  globalThis.fetch = nativeFetch;
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[installed];
  delete process.env.JOKO_PI_REQUEST_OPTION_RECOVERY;
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("joko.silent-encrypted-retry.fetch.v1")];
  delete process.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE;
  delete process.env.JOKO_PI_GENERATION;
});

it("loads through the published native resource loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-cache-loader-"));
  const path = await provisionManagedRequestOptionRecovery(root);
  process.env.JOKO_PI_REQUEST_OPTION_RECOVERY = "1";
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, noExtensions: true,
    additionalExtensionPaths: [path], noSkills: true, noPromptTemplates: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect([...loaded.extensions[0]!.handlers.keys()]).toContain("before_provider_headers");
});

it("loads the provisioned native hook and removes only the two cache fields on one replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-cache-hook-"));
  const path = await provisionManagedRequestOptionRecovery(root);
  const bodies: unknown[] = [], actions: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.has("x-joko-cache-compatibility-request")).toBe(false);
    bodies.push(await request.json());
    return bodies.length === 1 ? new Response('400: Unsupported parameter(s): `prompt_cache_key`', { status: 400 }) : new Response("done");
  };
  process.env.JOKO_PI_REQUEST_OPTION_RECOVERY = "1";
  const silentPath = await provisionManagedSilentEncryptedRetry(root);
  const controlPath = join(root, "silent-control.json");
  await writeSilentEncryptedRetryControl(controlPath, 1, true);
  process.env.JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE = controlPath;
  process.env.JOKO_PI_GENERATION = "1";
  const silentModule = await import(/* @vite-ignore */ pathToFileURL(silentPath).href);
  silentModule.default({ on: () => {} });
  const module = await import(/* @vite-ignore */ pathToFileURL(path).href) as { default(pi: { on(event: string, handler: (...args: any[]) => unknown): void }): void };
  const handlers = new Map<string, (...args: any[]) => unknown>();
  module.default({ on: (event, handler) => { handlers.set(event, handler); } });
  handlers.clear();
  module.default({ on: (event, handler) => { handlers.set(event, handler); } });
  const context = { hasUI: true, model: { api: "openai-completions", provider: "local", id: "model", baseUrl: "https://local.test/v1" },
    ui: { input: async (title: string) => {
      const request = JSON.parse(Buffer.from(title.slice("joko:cache-compatibility/v1/".length), "base64url").toString("utf8"));
      actions.push(request.action);
      return JSON.stringify(request.action === "prepare" ? { current: true, applied: false, lease: "one-lease" } : { applied: true, replay: true });
    } } };
  const event = { headers: {} };
  handlers.get("before_provider_headers")!(event, context);
  const response = await fetch("https://local.test/v1/chat/completions", { method: "POST",
    headers: { ...event.headers, "content-type": "application/json" },
    body: JSON.stringify({ model: "model", messages: [{ role: "user", content: "same input" }], prompt_cache_key: "key", prompt_cache_retention: "24h" }) });
  expect(response.status).toBe(200);
  expect(actions).toEqual(["prepare", "learn"]);
  expect(bodies).toEqual([{ model: "model", messages: [{ role: "user", content: "same input" }], prompt_cache_key: "key", prompt_cache_retention: "24h" },
    { model: "model", messages: [{ role: "user", content: "same input" }] }]);
});
