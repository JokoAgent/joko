import { RunState, taskMessageReferenceHref } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt("inserts distinct whole-message references at the caret and delivers only their durable bodies to real Pi", { timeout: 90_000 }, async () => {
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await RealPiSystemFixture.start({ webDirectory });
    const manager = await fixture.pair("Message reference manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Whole-message references", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const store = fixture.application.store;
    const session = store.getSession(sessionId).descriptor;
    const firstBody = "First exact source: hazel orbit eighty";
    const secondBody = "Second exact source: bronze window seventy";
    const plainBody = "Plain link source: marble ceiling sixty";
    const seedVisibleTurn = (id: string, text: string) => {
      // Preserve each historical turn's user boundary in the product timeline, outside Pi's current context.
      store.appendEvent({ id: `${id}-prompt`, sessionId, backendId: session.backendId, targetId: session.targetId,
        generation: session.binding.generation, traceId: id,
        payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text: `Earlier prompt for ${id}` }] } });
      store.appendEvent({ id, sessionId, backendId: session.backendId, targetId: session.targetId,
        generation: session.binding.generation, traceId: id,
        payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] } });
      const origin = store.findVisibleSessionMessageOrigin({ sessionId, eventId: id });
      if (origin === undefined) throw new Error("The fixture has no visible durable message.");
      const anchor = { sourceSessionId: sessionId, ...origin };
      return { anchor, href: taskMessageReferenceHref(anchor) };
    };
    const first = seedVisibleTurn("whole-reference-first", firstBody);
    const second = seedVisibleTurn("whole-reference-second", secondBody);
    const plain = seedVisibleTurn("ordinary-message-link", plainBody);
    expect(fixture.providerRequests).toEqual([]);

    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Message reference browser" })).challenge!;
    browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 } });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill("Message reference browser");
    await page.locator("form.pair-form button[type=submit]").click();

    const pane = page.locator(".session-pane");
    const draft = pane.locator(".composer-rich-editor__content");
    const tail = `after ${plain.href}`;
    await draft.fill(`Before ${tail}`);
    await draft.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    for (let index = 0; index < "Before ".length; index += 1) await draft.press("ArrowRight");
    const addMessage = async (body: string) => {
      const row = pane.locator("article.message-assistant").filter({ hasText: body });
      await row.hover();
      await row.locator(".message-action-menu summary").click();
      await row.getByRole("menuitem", { name: "Add to chat", exact: true }).click();
    };
    await addMessage(firstBody);
    await addMessage(secondBody);
    const draftPieces = await draft.locator("p").evaluate(paragraph => Array.from(paragraph.childNodes, node =>
      node instanceof HTMLElement && node.dataset.composerMention === "true" ? node.dataset.display : node.textContent));
    expect(draftPieces).toEqual(["Before ", firstBody, " ", secondBody, ` ${tail}`]);

    await pane.locator(".send-button").click();
    const queued = await waitFor(async () => store.listQueueItems({ sessionId }).at(0), value => value !== undefined, "the accepted message references");
    if (queued === undefined) throw new Error("The original message reference input was not queued.");
    expect(queued.body.text).toBe(`Before ${first.href} ${second.href} ${tail}`);
    expect(queued.body.messageReferences?.map(({ start, end, ...anchor }) => ({ ...anchor, text: queued.body.text.slice(start, end) })))
      .toEqual([{ ...first.anchor, text: first.href }, { ...second.anchor, text: second.href }]);
    await waitFor(() => manager.clients.run.getRun({ runId: queued.runId }), value => value.run?.state === RunState.SUCCEEDED, "the original Pi turn");
    expect(fixture.providerRequests).toHaveLength(1);
    const providerBody = JSON.stringify(fixture.providerRequests[0]?.body);
    expect(providerBody).toContain(firstBody);
    expect(providerBody).toContain(secondBody);
    expect(providerBody).toContain(plain.href);
    expect(providerBody).not.toContain(plainBody);
  } finally {
    await browser?.close();
    await fixture?.close();
  }
});

mountedIt("quotes the selected part of a completed tool result and sends it only with the next prompt", { timeout: 90_000 }, async () => {
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await RealPiSystemFixture.start({ webDirectory });
    const manager = await fixture.pair("Tool result Owner");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Tool result selection", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const store = fixture.application.store;
    const session = store.getSession(sessionId).descriptor;
    const append = { sessionId, backendId: session.backendId, targetId: session.targetId, generation: session.binding.generation,
      traceId: "tool-result-selection" };
    const callId = "ordinary-command-result";
    const privateInput = "unselected tool input";
    const excerpt = "Only this chosen output";
    const unselectedOutput = "unselected neighboring output";
    store.appendEvent({ ...append, payload: { type: "tool_start", callId, name: "bash", input: privateInput } });
    store.appendEvent({ ...append, payload: { type: "tool_result", callId, name: "bash", isError: false, output: `${excerpt}\n${unselectedOutput}` } });

    const device = "Tool result browser";
    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: device })).challenge!;
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill(device);
    await page.locator("form.pair-form button[type=submit]").click();

    const timeline = page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`);
    await timeline.locator(".work-group__header").click();
    const tool = timeline.locator(`[data-work-child-id="${callId}"] .tool-block`);
    await tool.locator("summary").click();
    const select = async (text: string) => {
      const pre = tool.locator("pre").filter({ hasText: text });
      await pre.scrollIntoViewIfNeeded();
      await pre.evaluate(async (element, selected) => {
        const node = element.firstChild!;
        const start = node.textContent!.indexOf(selected);
        if (start < 0) throw new Error("The fixture text is absent from the rendered tool result.");
        const selection = window.getSelection()!;
        selection.setBaseAndExtent(node, start, node, start + selected.length);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, text);
    };
    const add = page.locator(".selection-quote-actions").getByRole("button", { name: "Add to chat", exact: true });
    await select(privateInput);
    expect(await add.count()).toBe(0);
    await select(excerpt);
    await add.click();
    await page.locator(".composer-rich-editor__content [data-selection-quote-chip]").getByText(excerpt, { exact: true }).waitFor();
    expect(store.listQueueItems({ sessionId })).toEqual([]);
    expect(fixture.providerRequests).toEqual([]);
    await page.locator(".session-pane .send-button").click();
    const item = await waitFor(async () => store.listQueueItems({ sessionId })[0], value => value !== undefined, "the accepted tool selection");
    expect(item?.body).toMatchObject({ text: `> <!-- joko-selection-quote -->\n> ${excerpt}`, quotesEncoded: true });
    await waitFor(() => manager.clients.run.getRun({ runId: item!.runId }), response => response.run?.state === RunState.SUCCEEDED,
      "the explicit Pi prompt with the tool selection");
    expect(fixture.providerRequests).toHaveLength(1);
    const wire = JSON.stringify(fixture.providerRequests[0]?.body);
    expect(wire).toContain(excerpt);
    expect(wire).not.toContain(unselectedOutput);
    expect(wire).not.toContain(privateInput);
  } finally {
    await browser?.close();
    await fixture?.close();
  }
});
