import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { BrowserProvider } from "@joko/tool-browser";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import { BrowserUserKnowledgeStore } from "./browser-user-knowledge-store.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BrowserTransferCoordinator } from "./browser-transfers.js";

it.skipIf(!process.env.JOKO_BROWSER_EXECUTABLE)("learns a real navigation flow and explicitly activates and suspends a durable recipe", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-learning-"));
  const native = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const context = await native.newContext();
  await context.route("https://learning.example.test/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Example</h1><input id='query'><p>Public fixture</p>" }));
  const provider = new BrowserProvider({ providerId: "learning-test", executablePath: process.env.JOKO_BROWSER_EXECUTABLE!,
    profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") }, targetMode: "sidebar", downloadDirectory: join(root, "downloads"), uploadRoots: [root], launchPersistentContext: async () => context });
  let store = new OperationalStore(join(root, "operational.sqlite"));
  let knowledge = new BrowserUserKnowledgeStore(store);
  const makeBridge = () => new BrowserToolBridgeProvider({ browser: provider, transfers: {} as BrowserTransferCoordinator, artifacts: {} as ArtifactStore, userKnowledge: knowledge });
  let bridge = makeBridge();
  const recipeDraft = { id: "learning-read", match: ["learning.example.test"], access: "read", steps: [{
    action: "extract", guard: { url: "https://learning.example.test/" }, extract: { fields: { title: "h1" } },
    expect: { equals: { title: "Example" } }, as: "rows"
  }], output: "{{rows}}" };
  try {
    await provider.start(); const lease = provider.acquireAgentLease("prepare-learning", 60_000);
    const page = await provider.createPage(lease, "https://learning.example.test/"); await provider.releaseAgentLease(lease);
    for (let repeat = 0; repeat < 2; repeat++) {
      await bridge.callTool("browser", { action: "navigate", targetId: page.id, url: "https://learning.example.test/?query=private-value" });
      await bridge.callTool("browser", { action: "act", targetId: page.id, request: { kind: "type", selector: "#query", text: "private-record" } });
      const result = await bridge.callTool("browser", { action: "extract", targetId: page.id, extract: { fields: { title: "h1" } } });
      expect(result.structuredContent).toMatchObject({ ok: true, data: { records: [{ title: "Example" }] } });
      if (repeat === 1) expect(result.structuredContent).toMatchObject({ data: { learningOpportunity: { observations: 2 } } });
    }
    const observations = await knowledge.listExperiences("learning.example.test");
    expect(observations).toEqual([{ site: "learning.example.test", actions: ["navigate", "type", "extract"], observations: 2, updatedAt: expect.any(Number) }]);
    expect(JSON.stringify(observations)).not.toMatch(/private-value|private-record|#query/u);
    await bridge.callTool("browser", { action: "saveRecipe", site: "learning.example.test", recipeDraft, deferValidation: true });
    await bridge.callTool("browser", { action: "navigate", targetId: page.id, url: "https://learning.example.test/" });
    expect((await bridge.callTool("browser", { action: "recipe", recipeId: recipeDraft.id, targetId: page.id })).structuredContent)
      .toMatchObject({ ok: true, data: { verified: true, output: { records: [{ title: "Example" }] } } });
    expect(knowledge.recipes[0]).toMatchObject({ validation: { state: "candidate" } });
    await bridge.callTool("browser", { action: "saveRecipe", site: "learning.example.test", recipeDraft });
    store.close(); store = new OperationalStore(join(root, "operational.sqlite")); knowledge = new BrowserUserKnowledgeStore(store); bridge = makeBridge();
    expect(knowledge.recipes[0]).toMatchObject({ validation: { state: "active", profile: "sidebar" } });
    expect(await knowledge.listExperiences("learning.example.test")).toEqual(observations);
    const transition = provider.acquireAgentLease("change-fixture", 60_000);
    await provider.act(page.id, transition, { type: "navigate", url: "https://learning.example.test/changed" }); await provider.releaseAgentLease(transition);
    expect((await bridge.callTool("browser", { action: "recipe", recipeId: recipeDraft.id, targetId: page.id })).structuredContent)
      .toMatchObject({ ok: false, failureKind: "guard" });
    expect(knowledge.recipes[0]).toMatchObject({ validation: { state: "suspended" } });
    expect((await makeBridge().callTool("browser", { action: "recipe", recipeId: recipeDraft.id, targetId: page.id })).structuredContent)
      .toMatchObject({ ok: false, message: expect.stringContaining("suspended") });
  } finally {
    store.close(); await provider.stop().catch(() => undefined); await native.close(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
