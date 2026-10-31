import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { BrowserProvider } from "@joko/tool-browser";
import { expect, it } from "vitest";
import { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { BrowserTransferCoordinator } from "./browser-transfers.js";

it.skipIf(!process.env.JOKO_BROWSER_EXECUTABLE)("reads a real page's complete large extract in segments without re-extracting or dispatching an action", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-results-"));
  const native = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true }), context = await native.newContext();
  const titles = Array.from({ length: 320 }, (_, index) => `Record ${index} 中文🙂 ${"descriptive text ".repeat(8)}`);
  await context.route("https://results.example.test/**", route => route.fulfill({ contentType: "text/html", body: titles.map(title => `<article><h2>${title}</h2></article>`).join("") }));
  const provider = new BrowserProvider({ providerId: "result-test", executablePath: process.env.JOKO_BROWSER_EXECUTABLE!,
    profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") }, targetMode: "sidebar", downloadDirectory: join(root, "downloads"), uploadRoots: [root], launchPersistentContext: async () => context });
  const bridge = new BrowserToolBridgeProvider({ browser: provider, transfers: {} as BrowserTransferCoordinator, artifacts: {} as ArtifactStore });
  try {
    await provider.start(); const lease = provider.acquireAgentLease("prepare-results", 60_000), page = await provider.createPage(lease, "https://results.example.test/"); await provider.releaseAgentLease(lease);
    const result = await bridge.callTool("browser", { action: "extract", targetId: page.id, extract: { from: "article", multiple: true, fields: { title: "h2" }, limit: 320 } });
    const full = (result.structuredContent as any).data.fullResult; expect(full.chars).toBeGreaterThan(16_384);
    let offset: number | null = 0, output = "";
    while (offset !== null) { const value = (await bridge.callTool("browser", { ...full.read, offset, maxChars: 11_111 })).structuredContent as any;
      expect(value.ok).toBe(true); output += value.data.text; offset = value.data.nextOffset; }
    expect(JSON.parse(output).data.records.map((row: { title: string }) => row.title)).toEqual(titles);
    expect(context.pages().filter(page => page.url() === "https://results.example.test/")).toHaveLength(1);
  } finally { await provider.stop().catch(() => undefined); await native.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
