import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { BrowserAutomationTarget, BrowserTakeoverActionMutationSchema, BrowserTakeoverMouseButton, OperationMutationSchema,
  BrowserTransferState, OperationState, PermissionMode, RunState, SubmitOperationRequestSchema, SubmitOperationResponseSchema,
  TransferDirection } from "@joko/contracts";
import { OperationalBrowserState } from "@joko/orchestrator";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
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
const mountedWebDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();

it.skipIf(!existsSync(sidebarExecutable) || !mountedWebDirectory)(
  "uploads from the mounted Browser canvas to the chosen second native file input",
  { timeout: 120_000 }, async () => {
    const fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: sidebarExecutable, webDirectory: mountedWebDirectory! });
    let client: Browser | undefined;
    try {
      const provider = fixture.application.browser;
      if (provider === undefined) throw new Error("The sidebar Browser Provider was not configured.");
      const owner = await fixture.pair("Browser upload setup");
      const targetId = "workspace-real-pi";
      const mutate = (payload: NonNullable<MessageInitShape<typeof OperationMutationSchema>["payload"]>) =>
        submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload }));
      expect((await mutate({ case: "setWorkspaceTrust", value: { workspaceId: targetId, trusted: true } })).state)
        .toBe(OperationState.SUCCEEDED);
      expect((await mutate({ case: "updateBrowserSettings", value: { patch: {
        browserProviderId: provider.id, automationTarget: BrowserAutomationTarget.SIDEBAR, targetId, enabled: true, allowUploads: true
      } } })).state).toBe(OperationState.SUCCEEDED);
      const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
        backendId: "pi", targetId, displayName: "Browser upload task", providerId: REAL_PI_PROVIDER_ID,
        modelId: REAL_PI_MODEL_ID, effortId: "off"
      })));
      expect((await mutate({ case: "openBrowserPage", value: {
        browserProviderId: provider.id, sessionId, expectedGeneration: BigInt(provider.generation),
        url: "about:blank", presentationTarget: BrowserAutomationTarget.SIDEBAR
      } })).state).toBe(OperationState.SUCCEEDED);
      const initial = provider.currentHumanTakeover();
      if (initial === undefined) throw new Error("The original Browser page has no setup takeover.");
      const native = await provider.runHumanTakeoverOperation(initial, async page => page);
      const url = "https://browser-upload.example.test/";
      await native.route(url, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <title>Browser upload fixture</title>
        <style>label { display: block; margin: 22px } input { display: block; width: 300px }</style>
        <label>First document<input id="first" type="file"></label>
        <label>Second document<input id="second" type="file"></label>
        <script>
          document.addEventListener("click", event => {
            document.body.dataset.lastClickTarget = event.target.id || event.target.tagName;
            document.body.dataset.lastClickTrusted = String(event.isTrusted);
            document.body.dataset.lastClickActive = String(navigator.userActivation.isActive);
          }, true);
        </script>` }));
      await native.goto(url);
      expect((await mutate({ case: "endBrowserTakeover", value: { takeoverId: initial.takeoverId } })).state)
        .toBe(OperationState.SUCCEEDED);

      const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Browser upload client" })).challenge!;
      client = await chromium.launch({ executablePath: sidebarExecutable, headless: true });
      const page = await client.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
      await page.goto(`${fixture.baseUrl}/#/tools`, { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator("details.device-authorization__manual > summary").click();
      await page.getByLabel("Joko node address").fill(fixture.baseUrl);
      await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
      await page.getByLabel("Device name").fill("Browser upload client");
      await page.locator("form.pair-form button[type=submit]").click();
      await page.getByRole("button", { name: "Take over", exact: true }).click();
      await page.getByText("Remote control active", { exact: true }).waitFor({ state: "visible" });
      const capture = page.waitForResponse(response => {
        if (!response.url().endsWith("/joko.v1.OperationService/SubmitOperation")) return false;
        const body = response.request().postDataBuffer();
        return body !== null && fromBinary(SubmitOperationRequestSchema, body).mutation?.payload.case === "captureBrowserScreenshot";
      });
      await page.getByRole("button", { name: "Capture", exact: true }).click();
      const captured = fromBinary(SubmitOperationResponseSchema, await (await capture).body()).operation;
      expect(captured?.state, captured?.error?.message).toBe(OperationState.SUCCEEDED);

      const canvas = page.getByRole("img", { name: /^Interactive remote browser screenshot:/u });
      const viewport = native.viewportSize();
      if (viewport === null) throw new Error("The native Browser viewport is unavailable.");
      await waitFor(() => canvas.evaluate(element => (element as HTMLCanvasElement).width),
        width => width === viewport.width, "the loaded Browser canvas");
      const selectSecond = async () => {
        const field = await native.locator("#second").boundingBox();
        const surface = await canvas.boundingBox();
        if (field === null || surface === null) throw new Error("The second Browser file field is unavailable.");
        const clicked = page.waitForResponse(response => {
          if (!response.url().endsWith("/joko.v1.OperationService/SubmitOperation")) return false;
          const body = response.request().postDataBuffer();
          const payload = body === null ? undefined : fromBinary(SubmitOperationRequestSchema, body).mutation?.payload;
          return payload?.case === "browserTakeoverAction" && payload.value.action.case === "mouseClick";
        });
        const clickStartedAt = performance.now();
        await canvas.click({ position: {
          x: (field.x + 24) / (viewport.width - 1) * surface.width,
          y: (field.y + field.height / 2) / (viewport.height - 1) * surface.height
        } });
        const result = await clicked;
        expect(result.ok()).toBe(true);
        expect(fromBinary(SubmitOperationResponseSchema, await result.body()).operation?.state).toBe(OperationState.SUCCEEDED);
        await page.locator(".remote-browser.is-enabled[aria-busy=false]").waitFor({ state: "visible" });
        return Math.round(performance.now() - clickStartedAt);
      };
      const bytes = Buffer.from("Original file contents for the second field.\n");
      const upload = async (name: string) => {
        const picker = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Upload file", exact: true }).click();
        const submitted = page.waitForResponse(response => {
          if (!response.url().endsWith("/joko.v1.OperationService/SubmitOperation")) return false;
          const body = response.request().postDataBuffer();
          const payload = body === null ? undefined : fromBinary(SubmitOperationRequestSchema, body).mutation?.payload;
          return payload?.case === "uploadBrowserFile" && payload.value.blob?.fileName === name;
        });
        await (await picker).setFiles({ name, mimeType: "text/plain", buffer: bytes });
        const response = await submitted;
        if (!response.ok()) throw new Error(`Browser upload ${response.status()} ${await response.text()}`);
        const operation = fromBinary(SubmitOperationResponseSchema, await response.body()).operation;
        expect(operation?.state, operation?.error?.message).toBe(OperationState.SUCCEEDED);
        const receipt = operation?.result?.payload;
        if (receipt?.case !== "browserTransfer") throw new Error("The Browser upload did not return a transfer receipt.");
        const { transfers } = await owner.clients.browser.listBrowserTransfers({
          browserProviderId: provider.id, pageId: initial.pageId, direction: TransferDirection.UPLOAD
        });
        expect(transfers.find(transfer => transfer.browserTransferId === receipt.value.browserTransferId)).toEqual(receipt.value);
        return receipt.value;
      };
      const inputFiles = () => native.locator("input[type=file]").evaluateAll(async elements => Promise.all(
        elements.map(async element => Promise.all(Array.from((element as HTMLInputElement).files ?? [], async file =>
          ({ name: file.name, text: await file.text() }))))
      ));

      const selectionDurationMs = await selectSecond();
      const uploaded = await upload("second.txt");
      const uploadFailure = uploaded.state === BrowserTransferState.COMPLETED ? undefined : JSON.stringify({
        error: uploaded.error,
        selectionDurationMs,
        click: await native.locator("body").evaluate(element => ({
          target: element.dataset.lastClickTarget,
          trusted: element.dataset.lastClickTrusted,
          userActive: element.dataset.lastClickActive
        })).catch(() => undefined)
      });
      expect(uploaded, uploadFailure).toMatchObject({ state: BrowserTransferState.COMPLETED,
        blob: { fileName: "second.txt", sha256Hex: createHash("sha256").update(bytes).digest("hex") } });
      expect(await inputFiles()).toEqual([[], [{ name: "second.txt", text: bytes.toString() }]]);

      await selectSecond();
      await native.locator("#second").evaluate(element => {
        const replacement = document.createElement("input");
        replacement.id = "second";
        replacement.type = "file";
        element.replaceWith(replacement);
      });
      expect(await upload("stale.txt")).toMatchObject({ state: BrowserTransferState.FAILED });
      expect(await inputFiles()).toEqual([[], []]);
    } finally {
      await client?.close().catch(() => undefined);
      await fixture.close({ removeRoot: true });
    }
  });

it.skipIf(!existsSync(sidebarExecutable) || !mountedWebDirectory)(
  "returns a one-time native Browser POST download to the original Pi tool and Run after switching tasks",
  { timeout: 120_000 }, async () => {
    const fileName = "pi-browser-original.csv";
    const bytes = Buffer.from("name,count\noriginal Browser download,42\n");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const exportMethods: string[] = [];
    let exportResponse: ServerResponse | undefined;
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<form method="POST" action="/export"><button>Export original report</button></form>');
        return;
      }
      if (request.url !== "/export") {
        response.writeHead(404).end();
        return;
      }
      exportMethods.push(request.method ?? "");
      if (request.method !== "POST" || exportMethods.length !== 1) {
        response.writeHead(410).end();
        return;
      }
      request.resume();
      response.writeHead(200, { "content-type": "text/csv", "content-length": bytes.byteLength,
        "content-disposition": `attachment; filename="${fileName}"` });
      response.write(bytes.subarray(0, 8));
      exportResponse = response;
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The original export fixture did not expose a TCP port.");

    let fixture: RealPiSystemFixture | undefined;
    let clientBrowser: Browser | undefined;
    const toolName = "mcp__joko_browser__call_tool";
    const callId = "original-post-export";
    try {
      fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: sidebarExecutable, webDirectory: mountedWebDirectory!,
        enableInternalServer: true,
        providerResponder: ({ requestNumber }) => {
          if (requestNumber === 1) return { kind: "tool", name: toolName, callId: "original-browser-page",
            arguments: { name: "browser", args: { action: "open", url: `http://127.0.0.1:${address.port}/` } } };
          if (requestNumber === 2) return { kind: "tool", name: toolName, callId,
            arguments: { name: "browser", args: { action: "act", request: {
              kind: "click", query: { role: "button", name: "Export original report" }
            } } } };
          return { kind: "text", text: "The original Browser export finished." };
        } });
      const provider = fixture.application.browser;
      if (provider === undefined) throw new Error("The sidebar Browser Provider was not configured.");
      const store = fixture.application.store;
      const owner = await fixture.pair("Browser export Owner");
      const targetId = "workspace-real-pi";
      const mutate = (payload: NonNullable<MessageInitShape<typeof OperationMutationSchema>["payload"]>) =>
        submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload }));
      expect((await mutate({ case: "setWorkspaceTrust", value: { workspaceId: targetId, trusted: true } })).state)
        .toBe(OperationState.SUCCEEDED);
      expect((await mutate({ case: "updateBrowserSettings", value: { patch: {
        browserProviderId: provider.id, automationTarget: BrowserAutomationTarget.SIDEBAR,
        targetId, enabled: true, allowDownloads: true
      } } })).state).toBe(OperationState.SUCCEEDED);
      const makeTask = async (displayName: string) => sessionIdFrom(await submit(owner.clients.operation, owner.connectionId,
        createSessionMutation({ backendId: "pi", targetId, displayName, providerId: REAL_PI_PROVIDER_ID,
          modelId: REAL_PI_MODEL_ID, effortId: "off", permissionMode: PermissionMode.BYPASS_PERMISSIONS })));
      const sessionId = await makeTask("Original Browser export task");
      const otherSessionId = await makeTask("Separate foreground task");

      const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Browser export client" })).challenge!;
      clientBrowser = await chromium.launch({ executablePath: sidebarExecutable, headless: true });
      const page = await clientBrowser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
      const taskUrl = (id: string) => `${fixture!.baseUrl}/#/tasks/${encodeURIComponent(id)}`;
      const pane = (id: string) => page.locator(`.session-pane[data-input-session-id='${id}']`);
      await page.goto(taskUrl(sessionId), { waitUntil: "domcontentloaded" });
      await page.locator(".connection-tabs > button").nth(2).click();
      await page.locator("details.device-authorization__manual > summary").click();
      await page.getByLabel("Joko node address").fill(fixture.baseUrl);
      await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
      await page.getByLabel("Device name").fill("Browser export client");
      await page.locator("form.pair-form button[type=submit]").click();
      await pane(sessionId).waitFor({ state: "visible", timeout: 30_000 });
      const runId = queueRunIdFrom(await submit(owner.clients.operation, owner.connectionId,
        sendInputMutation(sessionId, BigInt(store.getSession(sessionId).descriptor.binding.generation), "Export the original report.")));

      const originalPage = await waitFor(async () => {
        const found = (await provider.listPages().catch(() => [])).find(value => value.url === `http://127.0.0.1:${address.port}/`);
        if (found !== undefined) return found;
        const run = store.getRun(runId).descriptor;
        if (run.state === "completed" || run.state === "failed") {
          const results = store.listEvents({ sessionId }).flatMap(({ payload, runId: origin }) =>
            origin === runId && payload.type === "tool_result" ? [{ name: payload.name, output: payload.output.slice(0, 512) }] : []);
          throw new Error(`The original native Browser page was absent after the Run settled: ${JSON.stringify({ state: run.state, error: run.error?.code, results })}`);
        }
        return undefined;
      }, value => value !== undefined, "the original native Browser page", 25_000);
      if (originalPage === undefined) throw new Error("The original Pi Browser open returned no native page.");
      const transfers = async () => (await owner.clients.browser.listBrowserTransfers({ browserProviderId: provider.id,
        pageId: originalPage.id, direction: TransferDirection.DOWNLOAD })).transfers;
      const running = await waitFor(async () => (await transfers()).find(value => value.state === BrowserTransferState.RUNNING),
        value => value !== undefined && exportResponse !== undefined, "the in-flight native Browser export");
      expect(running).toMatchObject({ fileName, state: BrowserTransferState.RUNNING });
      await page.goto(taskUrl(otherSessionId));
      await pane(otherSessionId).waitFor({ state: "visible", timeout: 10_000 });
      expect(await pane(sessionId).count()).toBe(0);
      exportResponse!.end(bytes.subarray(8));

      const tool = await waitFor(async () => store.listEvents({ sessionId }).find(event =>
        event.runId === runId && event.payload.type === "tool_result" && event.payload.callId === callId),
      value => value !== undefined, "the original published Pi tool result", 25_000);
      if (tool?.payload.type !== "tool_result") throw new Error("The Browser download has no original Pi ToolCall.");
      expect(tool.payload.isError).toBe(false);
      expect(tool.payload.output).toContain(fileName);
      const outputs = tool.payload.parts?.filter(part => part.kind === "artifact");
      expect(outputs).toHaveLength(1);
      const blob = outputs?.[0]?.blob;
      expect(blob).toMatchObject({ fileName, sha256: digest, byteLength: bytes.byteLength });
      const result = await waitFor(() => owner.clients.run.getRun({ runId }),
        value => value.run?.state === RunState.SUCCEEDED || value.run?.state === RunState.FAILED,
        "the original Pi Run to finish");
      expect(result.run?.state).toBe(RunState.SUCCEEDED);

      const { artifacts } = await owner.clients.artifact.listArtifacts({ sessionId, runId });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ artifactId: blob!.id, blob: { blobId: blob!.id, fileName, sha256Hex: digest } });
      expect((await owner.clients.artifact.listArtifacts({ sessionId: otherSessionId })).artifacts).toHaveLength(0);
      const [originalTransfer] = await transfers();
      expect(originalTransfer).toMatchObject({ browserTransferId: running?.browserTransferId, fileName,
        state: BrowserTransferState.COMPLETED, blob: { fileName, sha256Hex: digest } });
      expect(originalTransfer?.blob?.blobId).not.toBe(blob!.id);
      const { ticket } = await owner.clients.artifact.getBlobDownloadTicket({ blobId: blob!.id });
      if (ticket === undefined) throw new Error("The original Run artifact has no authorized download ticket.");
      const downloaded = await fetch(`${fixture.baseUrl}${ticket.relativeEndpoint}`, { headers: { authorization: `Bearer ${owner.authKey}` } });
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      expect(exportMethods).toEqual(["POST"]);
    } finally {
      server.closeAllConnections();
      await Promise.all([clientBrowser?.close(), fixture?.close({ removeRoot: true }),
        new Promise<void>(resolve => server.close(() => resolve()))]);
    }
  }
);

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
