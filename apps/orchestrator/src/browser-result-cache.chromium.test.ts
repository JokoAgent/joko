import { mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { BrowserProvider } from "@joko/tool-browser";
import { BrowserTransferState, TransferDirection } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { BrowserTransferCoordinator } from "./browser-transfers.js";
import { OperationalBrowserState } from "./operational-browser-state.js";

it.skipIf(!process.env.JOKO_BROWSER_EXECUTABLE)("reads a real page's complete large extract in segments without re-extracting or dispatching an action", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-results-"));
  const native = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true }), context = await native.newContext();
  const titles = Array.from({ length: 320 }, (_, index) => `Record ${index} 中文🙂 ${"descriptive text ".repeat(8)}`.trim());
  await context.route("https://results.example.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: titles.map(title => `<article><h2>${title}</h2></article>`).join("") }));
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

it.skipIf(!process.env.JOKO_BROWSER_EXECUTABLE)("gives native Browser uploads their registered names and preserves lazy file reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-upload-files-"));
  const native = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const context = await native.newContext();
  const url = "https://upload.example.test/";
  const cache = join(root, "sidebar", "joko-upload-cache");
  await mkdir(join(cache, "selection-Orphan"), { recursive: true });
  await mkdir(join(cache, "unowned-directory"));
  await context.route(url, route => route.fulfill({ contentType: "text/html",
    body: '<input id="files" type="file" multiple><input id="single" type="file">' }));
  const provider = new BrowserProvider({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!,
    profileDirectories: { sidebar: join(root, "sidebar"), external: join(root, "external") },
    targetMode: "sidebar", downloadDirectory: join(root, "downloads"), uploadRoots: [root], launchPersistentContext: async () => context });
  const store = new OperationalStore(join(root, "orchestrator.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  const repository = new OperationalBrowserState(store);
  const transfers = new BrowserTransferCoordinator({ artifacts, provider, repository });
  const bridge = new BrowserToolBridgeProvider({ browser: provider, transfers, artifacts });
  try {
    await artifacts.initialize();
    await provider.start();
    const lease = provider.acquireAgentLease("prepare-file-inputs");
    const page = await provider.createPage(lease, url);
    await provider.releaseAgentLease(lease);
    const original = context.pages().find(candidate => candidate.url() === url)!;
    await original.locator("#files").evaluate((element: HTMLElement) => {
      element.addEventListener("change", () => {
        element.dataset.changeCount = String(Number(element.dataset.changeCount ?? "0") + 1);
      });
    });
    const first = await artifacts.ingestBytes(Buffer.from("Invoice body"), { fileName: "invoice.txt", mimeType: "text/plain" });
    const second = await artifacts.ingestBytes(Buffer.from("Second file body"), { fileName: "details.txt", mimeType: "text/plain" });
    const call = async (selector: string) => bridge.callTool("browser", {
      action: "upload", targetId: page.id, selector, paths: [first.id, second.id]
    });
    const result = await call("#files");
    expect(result.isError).toBe(false);
    const actual = await original.locator("#files").evaluate(async (input: HTMLInputElement) => ({
      changes: input.dataset.changeCount,
      contents: await Promise.all(Array.from(input.files ?? [], async file => ({ name: file.name, text: await file.text() })))
    }));
    expect(actual).toEqual({ changes: "1", contents: [
      { name: "invoice.txt", text: "Invoice body" }, { name: "details.txt", text: "Second file body" }
    ] });
    const completed = transfers.list({ pageId: page.id, direction: TransferDirection.UPLOAD, state: BrowserTransferState.COMPLETED });
    expect(completed.map(item => item.blob?.blobId).sort()).toEqual([first.id, second.id].sort());
    expect(completed[0]?.completedAt).toEqual(completed[1]?.completedAt);
    await call("#single");
    expect(await original.locator("#single").evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
    expect(repository.list("browser").filter(item => item.state === BrowserTransferState.FAILED)).toHaveLength(2);
    expect(await readdir(cache)).not.toContain("selection-Orphan");

    const largeBytes = Buffer.alloc(51 * 1024 * 1024, 0x53);
    largeBytes[largeBytes.length - 1] = 0x74;
    const large = await artifacts.ingestBytes(largeBytes, { fileName: "large report.bin", mimeType: "application/octet-stream" });
    const owner = "upload-owner";
    const takeover = await provider.beginHumanTakeover({ providerId: provider.id, pageId: page.id, generation: provider.generation, owner });
    const documentId = provider.uploadDocumentId(page.id);
    if (documentId === undefined) throw new Error("The upload document is missing.");
    const uploaded = await transfers.upload({ ...large, fileName: "ignored-request-name.bin" }, page.id, "#single", {
      id: owner, documentId, assertCurrent: () => undefined, humanTakeover: takeover
    });
    expect(uploaded).toMatchObject({ state: BrowserTransferState.COMPLETED, blob: { blobId: large.id, fileName: "large report.bin" } });
    await unlink(large.storagePath);
    const delayed = await original.locator("#single").evaluate(async (input: HTMLInputElement) => {
      const file = input.files?.[0];
      if (file === undefined) throw new Error("The native FileList has no registered upload.");
      return { name: file.name, size: file.size, first: new Uint8Array(await file.slice(0, 1).arrayBuffer())[0],
        last: new Uint8Array(await file.slice(-1).arrayBuffer())[0] };
    });
    expect(delayed).toEqual({ name: "large report.bin", size: largeBytes.length, first: 0x53, last: 0x74 });
    await original.close();
    await expect.poll(() => readdir(cache)).toEqual(["unowned-directory"]);
    const replacementLease = provider.acquireAgentLease("prepare-replacement-input");
    const replacement = await provider.createPage(replacementLease, url);
    await provider.releaseAgentLease(replacementLease);
    const remaining = await bridge.callTool("browser", { action: "upload", targetId: replacement.id,
      selector: "#single", paths: [first.id] });
    expect(remaining.isError).toBe(false);
    expect(await readdir(cache)).toHaveLength(2);
    await provider.stop();
    expect(await readdir(cache)).toEqual(["unowned-directory"]);
  } finally {
    await provider.stop().catch(() => undefined);
    await native.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
