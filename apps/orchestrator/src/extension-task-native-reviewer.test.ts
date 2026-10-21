import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendAdapter } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { createExtensionTaskNativeReviewer, nativeToolReviewEvidence } from "./extension-task-native-reviewer.js";
import type { ExtensionTaskReviewScope } from "./extension-tasks.js";
import { requestPluginTextInference } from "./personalization-inference.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), "joko-task-review-")), store = new OperationalStore(join(root, "store.db"));
  const model = { providerId: "account", modelId: "exact", displayName: "Exact model", api: "openai-completions", contextWindow: 32_000, maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  store.upsertBackend({ id: "native", displayName: "Native", version: "test", adapterKind: "fixture", instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated", health: "healthy", capabilities: new Map(), models: [model], tools: [], diagnostics: [] });
  const route = { backendId: "native", providerId: "account", modelId: "exact", fastMode: false };
  const credential = { ...route, generationId: "one", api: "openai-completions" as const, baseUrl: "https://model.example.test/v1", headers: {}, supportsImages: false };
  const infer = vi.fn<typeof requestPluginTextInference>(async () => '{"verdict":"allow","reason":"Necessary for the approved task"}');
  const nativeInfer = vi.fn<NonNullable<BackendAdapter["inferNativeText"]>>(async input => { input.assertCurrent(); input.assertModelAllowed("account", "exact"); return '{"verdict":"allow","reason":"Necessary"}'; });
  const adapter = { id: "native", inferNativeText: nativeInfer } as unknown as BackendAdapter;
  const review = createExtensionTaskNativeReviewer({ store, routes: { list: () => [], resolve: () => native ? undefined : credential }, adapters: () => [adapter], redact: value => value, infer });
  const scope: ExtensionTaskReviewScope = { extensionId: "plugin", role: "coordinator", task: "Read the approved draft", workingDirectory: root,
    route, userInstructions: ["Do not publish"], authorizationRevision: "one", approvedRoots: [{ path: root, access: "read_write" }] };
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, review, scope, infer, nativeInfer };
}
it("independently reviews reads, pins the billing identity, and fences cached decisions", async () => {
  const f = await fixture(); let current = true;
  const assertCurrent = () => { if (!current) throw new Error("Revoked"); };
  const action = { toolName: "Read", input: { file_path: join(f.root, "draft.md") }, signal: new AbortController().signal };
  await expect(f.review(f.scope, action, assertCurrent)).resolves.toMatchObject({ verdict: "allow" });
  expect(f.infer).toHaveBeenCalledTimes(1); expect(f.infer.mock.calls[0]![0].route).toMatchObject(f.scope.route);
  expect(f.infer.mock.calls[0]![0].user).toContain("Do not publish");
  await expect(f.review(f.scope, action, assertCurrent)).resolves.toMatchObject({ verdict: "allow" }); expect(f.infer).toHaveBeenCalledTimes(1);
  current = false; await expect(f.review(f.scope, action, assertCurrent)).rejects.toThrow("Revoked");
});
it("does not use a response after authorization changed while its model call was pending", async () => {
  const f = await fixture(); let current = true;
  f.infer.mockImplementation(async () => { current = false; return '{"verdict":"allow","reason":"late"}'; });
  await expect(f.review(f.scope, { toolName: "Bash", input: { command: "publish draft" }, signal: new AbortController().signal }, () => { if (!current) throw new Error("Revoked"); })).rejects.toThrow("Revoked");
});
it("uses only the selected native account model and asks explicitly when that reviewer is unavailable", async () => {
  const f = await fixture(true), action = { toolName: "Read", input: { path: "draft.md" }, signal: new AbortController().signal };
  await expect(f.review(f.scope, action, () => {})).resolves.toMatchObject({ verdict: "allow" }); expect(f.infer).not.toHaveBeenCalled();
  expect(f.nativeInfer).toHaveBeenCalledWith(expect.objectContaining({ providerId: "account", modelId: "exact", backendInstanceGeneration: 1 }));
  f.nativeInfer.mockRejectedValue(new Error("Unavailable"));
  await expect(f.review({ ...f.scope, authorizationRevision: "two" }, action, () => {})).resolves.toMatchObject({ verdict: "ask", unavailable: true });
});
it("keeps file contents out of reviewer evidence while refusing incomplete or oversized concrete actions", () => {
  expect(nativeToolReviewEvidence("Write", { file_path: "/approved/draft.md", content: "untrusted data" })).toEqual({ path: "/approved/draft.md" });
  expect(nativeToolReviewEvidence("Bash", { command: "x".repeat(8193) })).toBeUndefined();
  expect(nativeToolReviewEvidence("file_change", { grantRoot: "/approved", evidenceUnavailable: true })).toBeUndefined();
});
