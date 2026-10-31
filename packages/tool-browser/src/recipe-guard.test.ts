import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { BrowserPageGuardError, BrowserProvider } from "./provider.js";

it.skipIf(process.env.JOKO_BROWSER_EXECUTABLE === undefined)("guards the real document before extraction and requires one visible exact match", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-recipe-guard-"));
  const browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const context = await browser.newContext();
  const url = "https://recipe.example.test/results?q=one";
  await context.route("https://recipe.example.test/**", route => route.fulfill({ contentType: "text/html", body:
    '<h1> Results </h1><h1 hidden>Hidden</h1><article><span>First</span></article>' }));
  const provider = new BrowserProvider({ providerId: "guard-test", executablePath: process.env.JOKO_BROWSER_EXECUTABLE!,
    profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") }, targetMode: "sidebar",
    downloadDirectory: join(root, "downloads"), uploadRoots: [root], launchPersistentContext: async () => context });
  try {
    await provider.start();
    const lease = provider.acquireAgentLease("guard-owner", 60_000);
    const page = await provider.createPage(lease, url);
    const guard = { url, selector: "h1", text: "Results" };
    const spec = { from: "article", multiple: true, fields: { title: "span" } };
    expect(await provider.checkPageGuard(page.id, lease, guard)).toBe(true);
    expect(await provider.extract(page.id, lease, spec, 5_000, undefined, guard))
      .toEqual({ ok: true, count: 1, records: [{ title: "First" }] });
    for (const invalid of [{ ...guard, url: url.replace("one", "two") }, { ...guard, text: "Other" }, { ...guard, selector: ".missing" }]) {
      expect(await provider.checkPageGuard(page.id, lease, invalid)).toBe(false);
      await expect(provider.extract(page.id, lease, spec, 5_000, undefined, invalid)).rejects.toBeInstanceOf(BrowserPageGuardError);
    }
    const native = context.pages().find(candidate => candidate.url() === url)!;
    await native.locator("h1[hidden]").evaluate(element => { element.removeAttribute("hidden"); });
    expect(await provider.checkPageGuard(page.id, lease, guard)).toBe(false);
    await expect(provider.extract(page.id, lease, spec, 5_000, undefined, guard)).rejects.toBeInstanceOf(BrowserPageGuardError);
  } finally {
    await provider.stop().catch(() => undefined);
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
