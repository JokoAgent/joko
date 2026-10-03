import { fromBinary } from "@bufbuild/protobuf";
import { GetSnapshotResponseSchema, MessageRole, RunState } from "@joko/contracts";
import type { AdapterContext, NativeHistoryEventContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

describe("mounted Timeline Markdown documents", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    try {
      await browser?.close();
    } finally {
      browser = undefined;
      await fixture?.close({ removeRoot: true });
      fixture = undefined;
    }
  });

  mountedIt("retains native selection while streaming repairs and later definitions update the document", { timeout: 120_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new MarkdownAdapter(profile)
    });
    const manager = await fixture.pair("Markdown manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Markdown document" })));
    const adapter = fixture.adapter() as MarkdownAdapter;
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Markdown browser" });
    if (challenge.challenge === undefined) throw new Error("Markdown pairing returned no challenge.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: "no-preference" });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(fixture.baseUrl).origin });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Markdown browser");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`).waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "Close details", exact: true }).click();

    const operation = await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), "Stream a Markdown document"));
    const context = await waitFor(async () => adapter.context, (value) => value !== undefined, "the controlled Markdown Run");
    if (context === undefined) throw new Error("Markdown Run has no active context.");
    const nativeHistory: NativeHistoryEventContext = { identity: { entryId: "markdown-document-answer" } };
    const stableText = "Stable paragraph keeps native selection.";
    let source = `${stableText}\n\n[reference][target]\n\nGrowing tail.`;
    const append = async (delta: string): Promise<void> => {
      source += delta;
      await context.emit({ type: "text_delta", blockId: nativeHistory.identity!.entryId, delta, nativeHistory });
    };
    await context.emit({ type: "text_delta", blockId: nativeHistory.identity!.entryId, delta: source, nativeHistory });
    const body = page.locator(".message-assistant__body");
    await body.getByText(stableText, { exact: true }).waitFor({ state: "visible" });
    expect(await body.locator("a").count()).toBe(0);
    await waitFor(() => body.locator(".stream-word").count(), (value) => value > 0, "mounted streaming words");
    await frames(page);
    const selectionGeometry = await selectParagraphByMouse(page);
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.trim(), JSON.stringify(selectionGeometry)).toBe(stableText);
    const observation = await body.locator("p").first().evaluateHandle((paragraph) => {
      const selection = window.getSelection();
      if (selection === null || selection.anchorNode === null || selection.focusNode === null) throw new Error("Native Markdown selection is absent.");
      const state = {
        paragraph, anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode, focusOffset: selection.focusOffset,
        text: selection.toString(), mutations: 0,
        words: [...paragraph.querySelectorAll(".stream-word")].map((word) => ({ node: word, style: word.getAttribute("style"),
          key: word.getAttribute("data-wf-key"), startedAt: word.getAttribute("data-wf-started-at") })),
        observer: undefined as MutationObserver | undefined
      };
      state.observer = new MutationObserver((records) => { state.mutations += records.length; });
      state.observer.observe(paragraph, { attributes: true, childList: true, characterData: true, subtree: true });
      return state;
    });
    const continuity = async (): Promise<void> => {
      await frames(page);
      const result = await observation.evaluate((state) => {
        const selection = window.getSelection();
        state.mutations += state.observer!.takeRecords().length;
        return { invariants: {
          connected: state.paragraph.isConnected,
          sameBlock: document.querySelector(".message-assistant__body p") === state.paragraph,
          sameAnchor: selection?.anchorNode === state.anchorNode && selection.anchorOffset === state.anchorOffset,
          sameFocus: selection?.focusNode === state.focusNode && selection.focusOffset === state.focusOffset,
          sameText: selection?.toString() === state.text,
          sameWords: state.words.every((word) => word.node.isConnected && word.node.getAttribute("style") === word.style),
          mutations: state.mutations
        }, words: [...state.paragraph.querySelectorAll(".stream-word")].map((node, index) => ({
          sameNode: state.words[index]?.node === node, key: node.getAttribute("data-wf-key"),
          startedAt: node.getAttribute("data-wf-started-at"), style: node.getAttribute("style"),
          previous: { key: state.words[index]?.key, startedAt: state.words[index]?.startedAt, style: state.words[index]?.style }
        })) };
      });
      expect(result.invariants, JSON.stringify(result.words)).toEqual({ connected: true, sameBlock: true, sameAnchor: true, sameFocus: true, sameText: true, sameWords: true, mutations: 0 });
    };

    await append(" More words.\n\n```ts\nconst partial = \"unfinished");
    await waitFor(() => body.locator("pre code").textContent(), (value) => value === "const partial = \"unfinished\n", "the synthetic closing fence to render growing code");
    await continuity();
    const partialHistory = await manager.clients.session.listSessionTimeline({ sessionId, limit: 100 });
    const partialDeltas = partialHistory.events.flatMap((event) => event.payload?.kind.case === "textDelta" ? [event.payload.kind.value.delta] : []).join("");
    expect(partialDeltas).toBe(source);
    expect(partialDeltas.endsWith("\n```")).toBe(false);

    const referenceUrl = "https://example.test/reference?q=%5Ba%5D";
    const explicitUrl = "https://example.test/search?q=%5Ba%5D";
    const bareCorpus = "https://example.test/foo/93（含说明），https://other.test/y。";
    await append(`\";\n\`\`\`\n\n[target]: ${referenceUrl}\n\n${bareCorpus}\n\n[explicit](https://example.test/search?q=[a])`);
    await body.getByRole("link", { name: "reference", exact: true }).waitFor({ state: "visible" });
    expect(await body.getByRole("link", { name: "reference", exact: true }).getAttribute("href")).toBe(referenceUrl);
    expect(await body.locator("pre code").textContent()).toBe("const partial = \"unfinished\";\n");
    await continuity();
    expect(await body.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")))).toEqual([
      referenceUrl, "https://example.test/foo/93", "https://other.test/y", explicitUrl
    ]);
    expect(await body.textContent()).toContain(bareCorpus);
    await observation.evaluate((state) => state.observer!.disconnect());
    await observation.dispose();

    const terminalOwnerRefresh = page.waitForResponse((response) => response.ok()
      && new URL(response.url()).pathname === "/joko.v1.EventService/GetSnapshot", { timeout: 20_000 });
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: source }], nativeHistory });
    await context.emit({ type: "done", outcome: "completed" });
    await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(operation) }),
      (value) => value.run?.state === RunState.SUCCEEDED, "the Markdown Run to complete");
    await waitFor(() => body.locator(".stream-word,.streaming-cursor").count(), (value) => value === 0, "the final Markdown surface");
    expect(await body.locator("pre code").textContent()).toBe("const partial = \"unfinished\";\n");
    expect(await body.locator("a").evaluateAll((links) => links.map((link) => link.getAttribute("href")))).toEqual([
      referenceUrl, "https://example.test/foo/93", "https://other.test/y", explicitUrl
    ]);
    const history = await manager.clients.session.listSessionTimeline({ sessionId, limit: 100 });
    const completed = history.events.find((event) => event.payload?.kind.case === "messageCompleted"
      && event.payload.kind.value.role === MessageRole.ASSISTANT
      && event.payload.kind.value.nativeIdentity?.entryId === nativeHistory.identity!.entryId);
    if (completed?.payload?.kind.case !== "messageCompleted") throw new Error("Generated history has no completed Markdown answer.");
    expect(completed.payload.kind.value.blocks.map((block) => block.content)).toEqual([{ case: "text", value: source }]);

    const terminalWorkspaceDiff = await waitFor(async () => fixture!.application.store.listEvents({ sessionId })
      .find((event) => event.payload.type === "workspace_diff"), (value) => value !== undefined, "the durable terminal workspace projection");
    const refreshedOwner = fromBinary(GetSnapshotResponseSchema, await (await terminalOwnerRefresh).body()).snapshot;
    expect(refreshedOwner).toBeDefined();
    expect(refreshedOwner!.timeline).toEqual([]);
    expect(refreshedOwner!.resumeCursor!.sequence).toBeGreaterThanOrEqual(terminalWorkspaceDiff!.globalCursor);
    await frames(page);
    expect(await body.locator("pre code").textContent()).toBe("const partial = \"unfinished\";\n");

    const explicit = body.getByRole("link", { name: "explicit", exact: true });
    const beforeMenu = await markdownViewport(page);
    const originalLink = await explicit.elementHandle();
    if (originalLink === null) throw new Error("Completed Markdown has no explicit link.");
    await explicit.evaluate((node) => node.focus({ preventScroll: true }));
    try {
      await settledBounds(page, explicit);
    } catch (error) {
      const original = await originalLink.evaluate((node) => ({ connected: node.isConnected,
        visibility: getComputedStyle(node).visibility, display: getComputedStyle(node).display,
        rowConnected: node.closest("[data-timeline-item-id]")?.isConnected }));
      throw new Error(`Completed Markdown link geometry ${JSON.stringify({ beforeMenu, after: await markdownViewport(page), original })}`, { cause: error });
    }
    await originalLink.dispose();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Open link", exact: true });
    await menu.waitFor({ state: "visible" });
    await menu.getByRole("menuitem", { name: "Copy link", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const copyDiagnostics = { clipboardMatches: copied === explicitUrl, menu: await menu.count(), statuses: await menu.getByRole("status").allTextContents(),
      activeElement: await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 200)) };
    await waitFor(() => menu.getByRole("status").allTextContents(), (values) => values.includes("Link copied"), `the link-menu copy feedback ${JSON.stringify(copyDiagnostics)}`);
    expect(copied === explicitUrl).toBe(true);
    const menuFocus = await menu.evaluate((node) => ({ containsFocus: node.contains(node.ownerDocument.activeElement),
      activeElement: node.ownerDocument.activeElement?.outerHTML.slice(0, 200),
      items: [...node.querySelectorAll<HTMLButtonElement>("button")].map((button) => ({ disabled: button.disabled, text: button.textContent })) }));
    expect(menuFocus.containsFocus, JSON.stringify({ copyDiagnostics, menuFocus })).toBe(true);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    expect(await explicit.evaluate((node) => node.ownerDocument.activeElement === node)).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});

class MarkdownAdapter extends InstrumentedFakeAdapter {
  context: AdapterContext | undefined;

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] });
    this.context = context;
  }
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function selectParagraphByMouse(page: Page) {
  const paragraph = page.locator(".message-assistant__body p").first();
  const beforeSelection = await paragraph.boundingBox();
  if (beforeSelection === null) throw new Error("Stable Markdown paragraph is not mounted.");
  await page.mouse.click(Math.floor(beforeSelection.x) - 12, Math.round(beforeSelection.y + beforeSelection.height / 2));
  await settledBounds(page, paragraph);
  const geometry = await paragraph.evaluate((node) => {
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const first = walker.nextNode();
    let last = first;
    while (walker.nextNode() !== null) last = walker.currentNode;
    if (first === null || last === null) throw new Error("Stable Markdown paragraph has no text geometry.");
    const range = node.ownerDocument.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.textContent?.length ?? 0);
    const rectangles = [...range.getClientRects()];
    const start = rectangles[0];
    const end = rectangles.at(-1);
    if (start === undefined || end === undefined) throw new Error("Stable Markdown text has no visible rectangle.");
    // Native mouse coordinates are integral; keep both endpoints inside glyphs.
    const startX = Math.ceil(start.left) + 1;
    const startY = Math.round(start.top + start.height / 2);
    const endX = Math.ceil(end.right) - 1;
    const endY = Math.round(end.top + end.height / 2);
    return { startX, startY, endX, endY,
      startHit: node.ownerDocument.elementFromPoint(startX, startY)?.getAttribute("class"),
      endHit: node.ownerDocument.elementFromPoint(endX, endY)?.getAttribute("class"),
      userSelect: getComputedStyle(node).userSelect };
  });
  await page.mouse.move(geometry.startX, geometry.startY);
  await page.mouse.down();
  await frames(page);
  await page.mouse.move(geometry.endX, geometry.endY, { steps: 20 });
  await frames(page);
  await page.mouse.up();
  return geometry;
}

async function settledBounds(page: Page, element: Locator): Promise<void> {
  let previous: { left: number; top: number; width: number; height: number; scrollTop: number } | undefined;
  let stableFrames = 0;
  for (let frame = 0; frame < 90; frame += 1) {
    await frames(page);
    if (await element.count() === 0) throw new Error("Markdown pointer target disappeared.");
    const current = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, scrollTop: node.closest(".timeline")?.scrollTop ?? 0 };
    });
    stableFrames = previous !== undefined && Math.abs(current.left - previous.left) < 0.1
      && Math.abs(current.top - previous.top) < 0.1 && Math.abs(current.width - previous.width) < 0.1
      && Math.abs(current.height - previous.height) < 0.1 && Math.abs(current.scrollTop - previous.scrollTop) < 0.1 ? stableFrames + 1 : 0;
    previous = current;
    if (stableFrames >= 8) return;
  }
  throw new Error("Markdown pointer geometry did not settle.");
}

async function markdownViewport(page: Page) {
  return page.evaluate(() => {
    const timeline = document.querySelector<HTMLElement>(".timeline");
    const bodies = [...document.querySelectorAll(".message-assistant__body")];
    const spacer = timeline?.querySelector<HTMLElement>(".timeline__virtual");
    return { timeline: timeline === null ? null : { scrollTop: timeline.scrollTop, clientHeight: timeline.clientHeight,
      scrollHeight: timeline.scrollHeight, rows: timeline.querySelectorAll("[data-timeline-item-id]").length,
      className: timeline.className, connected: timeline.isConnected, offsetHeight: timeline.offsetHeight,
      rectHeight: timeline.getBoundingClientRect().height, spacerHeight: spacer?.style.height,
      welcome: timeline.querySelectorAll(".timeline-welcome").length },
      bodies: bodies.length, links: bodies.flatMap((body) => [...body.querySelectorAll("a")].map((link) => ({
        explicit: link.textContent === "explicit", connected: link.isConnected,
        ariaHidden: link.closest('[aria-hidden="true"]')?.className,
        inert: link.closest("[inert]")?.className,
        top: link.getBoundingClientRect().top, height: link.getBoundingClientRect().height,
        visibility: getComputedStyle(link).visibility, display: getComputedStyle(link).display
      }))) };
  });
}
