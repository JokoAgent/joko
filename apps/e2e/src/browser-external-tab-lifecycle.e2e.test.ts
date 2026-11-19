import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { BrowserAutomationTarget, BrowserTakeoverActionMutationSchema, BrowserTakeoverMouseButton, OperationMutationSchema,
  BrowserTransferState, OperationState, TransferDirection } from "@joko/contracts";
import { OperationalBrowserState } from "@joko/orchestrator";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const executable = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const browserIt = executable ? it : it.skip;

browserIt("removes a closed native external tab from Owner recovery and preserves the surviving tab across a Provider stop", { timeout: 75_000 }, async () => {
  const fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: executable! });
  try {
    const provider = fixture.application.browser;
    if (provider === undefined) throw new Error("The external Browser Provider was not configured.");
    const owner = await fixture.pair("External Browser owner");
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "External Browser task", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const open = (url: string, recoveryPageId = "") => {
      const takeover = provider.currentHumanTakeover();
      return submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload: {
        case: "openBrowserPage", value: {
          browserProviderId: provider.id, sessionId, expectedGeneration: BigInt(provider.generation), url, recoveryPageId,
          presentationTarget: BrowserAutomationTarget.EXTERNAL, currentPageId: takeover?.pageId ?? "", takeoverId: takeover?.takeoverId ?? ""
        }
      } }));
    };
    expect((await open("about:blank")).state).toBe(OperationState.SUCCEEDED);
    const surviving = provider.currentHumanTakeover();
    if (surviving === undefined) throw new Error("No surviving Browser takeover was returned.");
    const survivor = await provider.runHumanTakeoverOperation(surviving, async page => page);
    const url = "https://external-tab.example.test/closed";
    const attachmentUrl = "https://external-tab.example.test/report.txt";
    const attachmentText = "The original report from the closed Browser page.\n";
    await survivor.context().route(url, route => route.fulfill({ contentType: "text/html",
      body: '<!doctype html><title>Tab to close</title><a href="/report.txt">Get original report</a>' }));
    await survivor.context().route(attachmentUrl, route => route.fulfill({ contentType: "text/plain",
      headers: { "content-disposition": 'attachment; filename="report.txt"' }, body: attachmentText }));
    expect((await open(url)).state).toBe(OperationState.SUCCEEDED);
    const closing = provider.currentHumanTakeover();
    if (closing === undefined) throw new Error("No closing Browser takeover was returned.");
    const page = await provider.runHumanTakeoverOperation(closing, async original => original);
    const list = async () => (await owner.clients.browser.listBrowserProviders({})).providers.find(value => value.browserProviderId === provider.id);
    expect((await list())?.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: surviving.pageId, sessionId, recoverable: false }),
      expect.objectContaining({ pageId: closing.pageId, sessionId, url, recoverable: false })
    ]));
    const completedDownloads = (pageId = "") => owner.clients.browser.listBrowserTransfers({
      browserProviderId: provider.id, pageId, direction: TransferDirection.DOWNLOAD, state: BrowserTransferState.COMPLETED
    });
    await page.getByRole("link", { name: "Get original report" }).click();
    const received = await waitFor(() => completedDownloads(closing.pageId),
      result => result.transfers.some(transfer => transfer.blob?.fileName === "report.txt"), "the original Browser download receipt");
    const original = received.transfers.find(transfer => transfer.blob?.fileName === "report.txt");
    if (!original?.blob) throw new Error("The original Browser transfer has no stored file.");

    await page.close();
    expect(survivor.isClosed()).toBe(false);
    expect(provider.generation).toBe(closing.generation);
    expect((await list())?.pages).toEqual([expect.objectContaining({ pageId: surviving.pageId, sessionId, recoverable: false })]);
    expect(provider.currentHumanTakeover()).toBeUndefined();
    await expect(open(url, closing.pageId)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const persisted = new OperationalBrowserState(fixture.application.store);
    expect(persisted.findRecoverablePage(provider.id, closing.pageId)).toBeUndefined();
    expect(persisted.findRecoverablePage(provider.id, surviving.pageId)).toBeDefined();
    expect((await completedDownloads()).transfers).toEqual([original]);
    const { ticket } = await owner.clients.artifact.getBlobDownloadTicket({ blobId: original.blob.blobId });
    if (!ticket) throw new Error("The completed Browser download has no ticket after its source page closed.");
    const loaded = await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), { headers: { authorization: `Bearer ${owner.authKey}` } });
    expect(loaded.ok).toBe(true);
    expect(await loaded.text()).toBe(attachmentText);

    await provider.stop();
    expect((await list())?.pages).toEqual([expect.objectContaining({ pageId: surviving.pageId, sessionId, recoverable: true })]);
  } finally {
    await fixture.close({ removeRoot: true });
  }
});

const sidebarExecutable = executable ?? chromium.executablePath();
it.skipIf(!existsSync(sidebarExecutable))("cancels exactly the Owner's in-flight native download before artifact ingest", { timeout: 75_000 }, async () => {
  let disconnected = false;
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end('<a href="/report">Download report</a>');
      return;
    }
    if (request.url !== "/report") {
      response.writeHead(404).end();
      return;
    }
    response.once("close", () => { disconnected = !response.writableEnded; });
    response.writeHead(200, { "Content-Disposition": 'attachment; filename="slow-report.txt"',
      "Content-Type": "application/octet-stream", "Content-Length": 128 * 1024 });
    response.write(Buffer.alloc(32 * 1024, 0x4a));
  });
  let fixture: RealPiSystemFixture | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The download server has no address.");
    fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: sidebarExecutable });
    const provider = fixture.application.browser;
    if (provider === undefined) throw new Error("The sidebar Browser Provider was not configured.");
    const owner = await fixture.pair("Download Owner");
    const other = await fixture.pair("Other Browser Device");
    const mutate = (payload: NonNullable<MessageInitShape<typeof OperationMutationSchema>["payload"]>) =>
      submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload }));
    expect((await mutate({ case: "updateBrowserSettings", value: { patch: {
      browserProviderId: provider.id, automationTarget: BrowserAutomationTarget.SIDEBAR
    } } })).state).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Download task", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    expect((await mutate({ case: "openBrowserPage", value: {
      browserProviderId: provider.id, sessionId, expectedGeneration: BigInt(provider.generation),
      url: `http://127.0.0.1:${address.port}/`, presentationTarget: BrowserAutomationTarget.SIDEBAR
    } })).state).toBe(OperationState.SUCCEEDED);
    const source = provider.currentHumanTakeover();
    if (source === undefined) throw new Error("The original Browser page has no active takeover.");
    const page = await provider.runHumanTakeoverOperation(source, async original => original);
    const link = page.getByRole("link", { name: "Download report" });
    const [box, viewport] = [await link.boundingBox(), page.viewportSize()];
    if (box === null || viewport === null) throw new Error("The original download link is not available.");
    const fence = { browserProviderId: provider.id, pageId: source.pageId, takeoverId: source.takeoverId, generation: BigInt(source.generation) };
    const artifactsBefore = fixture.application.store.listArtifacts({ limit: 100 });
    expect((await mutate({ case: "browserTakeoverAction", value: { ...fence, action: { case: "mouseClick", value: {
      normalizedX: (box.x + box.width / 2) / (viewport.width - 1),
      normalizedY: (box.y + box.height / 2) / (viewport.height - 1), button: BrowserTakeoverMouseButton.PRIMARY
    } } } })).state).toBe(OperationState.SUCCEEDED);
    const read = async () => (await owner.clients.browser.listBrowserTransfers({ browserProviderId: provider.id,
      pageId: source.pageId, direction: TransferDirection.DOWNLOAD })).transfers;
    const running = (await waitFor(read, records => records.some(record => record.cancellable && record.fileName === "slow-report.txt"),
      "the live Browser transfer before the HTTP response completes"))[0]!;
    expect(running).toMatchObject({ fileName: "slow-report.txt", state: BrowserTransferState.RUNNING, cancellable: true });
    expect(running.blob).toBeUndefined();
    const cancel = create(OperationMutationSchema, { payload: { case: "cancelBrowserDownload",
      value: { ...fence, browserTransferId: running.browserTransferId } } });
    await expect(submit(other.clients.operation, other.connectionId, cancel)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(disconnected).toBe(false);
    expect(await read()).toEqual([running]);
    const operationId = "cancel-original-browser-download";
    const submitted = await submit(owner.clients.operation, owner.connectionId, cancel, operationId);
    expect(submitted.state).toBe(OperationState.SUCCEEDED);
    expect(await submit(owner.clients.operation, owner.connectionId, cancel, operationId))
      .toMatchObject({ operationId, state: OperationState.SUCCEEDED, result: submitted.result });
    await waitFor(async () => disconnected, value => value, "the original native HTTP connection to be cancelled");
    const [cancelled] = await read();
    expect(cancelled).toMatchObject({ browserTransferId: running.browserTransferId, fileName: running.fileName,
      state: BrowserTransferState.CANCELLED, cancellable: false });
    expect(cancelled?.blob).toBeUndefined();
    expect(cancelled?.artifact).toBeUndefined();
    expect(new OperationalBrowserState(fixture.application.store).list(provider.id)).toMatchObject([
      { id: running.browserTransferId, fileName: running.fileName, state: BrowserTransferState.CANCELLED }
    ]);
    expect(fixture.application.store.listArtifacts({ limit: 100 })).toEqual(artifactsBefore);
  } finally {
    server.closeAllConnections();
    await Promise.all([fixture?.close({ removeRoot: true }), new Promise<void>(resolve => server.close(() => resolve()))]);
  }
});

it.skipIf(!existsSync(sidebarExecutable))("adopts a native same-origin sidebar popup for the exact task and lets its Owner focus it", { timeout: 75_000 }, async () => {
  const fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: sidebarExecutable });
  try {
    const provider = fixture.application.browser;
    if (provider === undefined) throw new Error("The sidebar Browser Provider was not configured.");
    const owner = await fixture.pair("Sidebar popup owner");
    const mutate = (payload: NonNullable<MessageInitShape<typeof OperationMutationSchema>["payload"]>) =>
      submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload }));
    expect((await mutate({ case: "updateBrowserSettings", value: {
      patch: { browserProviderId: provider.id, automationTarget: BrowserAutomationTarget.SIDEBAR }
    } })).state).toBe(OperationState.SUCCEEDED);
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Sidebar popup task", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    expect((await mutate({ case: "openBrowserPage", value: {
      browserProviderId: provider.id, sessionId, expectedGeneration: BigInt(provider.generation), url: "about:blank",
      presentationTarget: BrowserAutomationTarget.SIDEBAR
    } })).state).toBe(OperationState.SUCCEEDED);
    const source = provider.currentHumanTakeover();
    if (source === undefined) throw new Error("The original Browser page has no active takeover.");
    const opener = await provider.runHumanTakeoverOperation(source, async (page) => page);
    const origin = "https://task-popup.example.test";
    const foreign = "https://other-popup.example.test/help";
    await opener.context().route(`${origin}/start`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
      <title>Original task page</title>
      <button onclick="window.open('/help','task-help','popup')">Open help</button>
      <button onclick="window.open('${foreign}','other-help','popup')">Open other</button>` }));
    await opener.context().route(`${origin}/help`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Task help</title><p>Help in the same task.</p>" }));
    await opener.context().route(foreign, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Different origin</title>" }));
    const act = (action: MessageInitShape<typeof BrowserTakeoverActionMutationSchema>["action"]) => mutate({ case: "browserTakeoverAction", value: {
      browserProviderId: provider.id, takeoverId: source.takeoverId, pageId: source.pageId, generation: BigInt(source.generation), action
    } });
    expect((await act({ case: "navigate", value: { url: `${origin}/start` } })).state).toBe(OperationState.SUCCEEDED);
    const click = async (name: string) => {
      const button = await opener.getByRole("button", { name, exact: true }).boundingBox();
      const viewport = opener.viewportSize();
      if (button === null || viewport === null) throw new Error("The requested Browser button is unavailable.");
      expect((await act({ case: "mouseClick", value: {
        normalizedX: (button.x + button.width / 2) / (viewport.width - 1),
        normalizedY: (button.y + button.height / 2) / (viewport.height - 1),
        button: BrowserTakeoverMouseButton.PRIMARY
      } })).state).toBe(OperationState.SUCCEEDED);
    };
    const pages = async () => (await owner.clients.browser.listBrowserProviders({})).providers.find((value) => value.browserProviderId === provider.id)?.pages ?? [];
    await click("Open help");
    const url = `${origin}/help`;
    const opened = await waitFor(pages, (current) => current.some((page) => page.url === url), "the adopted native help tab");
    const popup = opened.find((page) => page.url === url)!;
    expect(popup).toMatchObject({ sessionId, recoverable: false });
    expect(popup.pageId).not.toBe(source.pageId);
    expect(opened).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: source.pageId, sessionId })]));
    const otherNativePage = opener.waitForEvent("popup", { timeout: 10_000 });
    await click("Open other");
    expect((await otherNativePage).url()).toBe(foreign);
    expect((await pages()).some((page) => page.url === foreign)).toBe(false);

    expect((await mutate({ case: "focusBrowserPage", value: {
      browserProviderId: provider.id, pageId: popup.pageId, currentPageId: source.pageId,
      takeoverId: source.takeoverId, generation: BigInt(source.generation)
    } })).state).toBe(OperationState.SUCCEEDED);
    const focused = provider.currentHumanTakeover();
    if (focused?.pageId !== popup.pageId) throw new Error("The actual popup did not receive the original task's takeover.");
    const nativeHelp = await provider.runHumanTakeoverOperation(focused, async (page) => page);
    expect(await nativeHelp.opener()).toBe(opener);
    expect(await nativeHelp.locator("p").textContent()).toBe("Help in the same task.");
    const saved = new OperationalBrowserState(fixture.application.store).findRecoverablePage(provider.id, popup.pageId);
    expect(saved).toMatchObject({ sessionId, targetId: "workspace-real-pi", generation: source.generation, url });
  } finally { await fixture.close({ removeRoot: true }); }
});
