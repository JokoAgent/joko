import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserProvider } from "@joko/tool-browser";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import type { ArtifactStore } from "./artifact-store.js";
import { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import type { BrowserTransferCoordinator } from "./browser-transfers.js";

const executablePath = process.env.JOKO_BROWSER_EXECUTABLE ?? chromium.executablePath();

it.skipIf(!existsSync(executablePath))("returns a browser confirmation before the tool click completes and settles that click by dialog ID", { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-dialog-"));
  const native = await chromium.launch({ executablePath, headless: true }), context = await native.newContext();
  const provider = new BrowserProvider({ executablePath, targetMode: "sidebar", uploadRoots: [root],
    profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") },
    downloadDirectory: join(root, "downloads"), launchPersistentContext: async () => context });
  const bridge = new BrowserToolBridgeProvider({ browser: provider,
    artifacts: {} as ArtifactStore, transfers: {} as BrowserTransferCoordinator });
  const url = "https://confirmation.example.test/";
  try {
    await context.route(url, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <button id="commit" onclick="document.querySelector('output').textContent = window.confirm('Keep this change?') ? 'accepted' : 'dismissed'">Save</button>
      <output>waiting</output>` }));
    await provider.start();
    const setup = provider.acquireAgentLease("dialog fixture");
    const page = await provider.createPage(setup, url);
    await provider.releaseAgentLease(setup);
    const nativePage = context.pages().find((candidate) => candidate.url() === url);
    if (nativePage === undefined) throw new Error("The confirmation fixture page did not open.");
    const click = (signal?: AbortSignal) => bridge.callTool("browser", {
      action: "act", targetId: page.id, request: { kind: "click", selector: "#commit" }
    }, signal);
    const resolve = (input: { readonly accept?: boolean; readonly dialogId?: string } = {}) =>
      bridge.callTool("browser", { action: "dialog", targetId: page.id, ...input });

    const clickReceipt = await click();
    expect(clickReceipt.structuredContent).toMatchObject({ ok: true, action: "act", data: {
      page: { id: page.id }, barrier: { kind: "page-dialog", dialogId: expect.any(String), dialog: {
        pageId: page.id, type: "confirm", message: "Keep this change?"
      } }
    } });
    const data = clickReceipt.structuredContent?.["data"] as { barrier: { dialogId: string } };
    const dialogId = data.barrier.dialogId;
    expect(provider.currentAgentLease()).toBeUndefined();
    expect((await resolve()).structuredContent).toMatchObject({ ok: true, data: { dialogs: [{ id: dialogId, pageId: page.id }] } });
    await expect(resolve({ accept: true, dialogId: "another-dialog" })).rejects.toThrow(/no longer pending/);
    expect((await resolve({ accept: true, dialogId })).structuredContent).toMatchObject({ ok: true, data: { handled: true } });
    expect(await nativePage.locator("output").textContent()).toBe("accepted");
    expect((await resolve()).structuredContent).toMatchObject({ ok: true, data: { dialogs: [] } });

    const abandoned = new AbortController();
    const second = await click(abandoned.signal);
    expect(second.structuredContent).toMatchObject({ ok: true, data: { barrier: { kind: "page-dialog", dialogId: expect.any(String) } } });
    abandoned.abort();
    await expect.poll(() => nativePage.locator("output").textContent({ timeout: 5_000 })).toBe("dismissed");
    expect((await resolve()).structuredContent).toMatchObject({ ok: true, data: { dialogs: [] } });
  } finally {
    await provider.stop().catch(() => undefined);
    await native.close();
    await rm(root, { recursive: true, force: true });
  }
});
