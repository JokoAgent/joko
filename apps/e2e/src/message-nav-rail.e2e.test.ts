import { MessageInputDelivery, MessageRole, RunState } from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const mountedRailIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

describe("mounted message navigation rail", () => {
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

  mountedRailIt("owns browser previews, captured scrubbing, virtual jumps, and page retirement", { timeout: 120_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new MountedRailAdapter(profile)
    });
    const manager = await fixture.pair("Mounted rail manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Message navigation" })));
    for (let index = 0; index < 14; index += 1) {
      const input = `Rail browser ${index}\n\n${"This paragraph creates measured virtual history in the production browser. ".repeat(12)}`;
      const operation = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), input));
      await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(operation) }),
        (value) => value.run?.state === RunState.SUCCEEDED, "the rail history input to settle");
    }
    const history = await manager.clients.session.listSessionTimeline({ sessionId, limit: 500 });
    const messageIds = history.events.flatMap((event) => event.payload?.kind.case === "messageStarted"
      && event.payload.kind.value.role === MessageRole.USER
      && event.payload.kind.value.inputDelivery === MessageInputDelivery.PROMPT
      ? [event.payload.kind.value.messageId] : []);
    expect(messageIds).toHaveLength(14);

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted rail Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted rail pairing returned no challenge.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, reducedMotion: "reduce" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Mounted rail Web");
    await page.locator("form.pair-form button[type=submit]").click();
    const timeline = page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`);
    await timeline.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    const rail = page.locator(".message-nav-rail");
    try {
      await rail.waitFor({ state: "visible", timeout: 20_000 });
    } catch (error) {
      const geometry = await timeline.evaluate((node) => {
        const content = node.querySelector(".timeline__virtual");
        const rootRect = node.getBoundingClientRect();
        const contentRect = content?.getBoundingClientRect();
        return { height: rootRect.height, width: rootRect.width, leftGutter: (contentRect?.left ?? rootRect.left) - rootRect.left,
          rows: node.querySelectorAll("[data-timeline-item-id]").length,
          mountedUsers: node.querySelectorAll(".message-user").length,
          rail: node.ownerDocument.querySelector(".message-nav-rail") !== null,
          bottomInset: node.parentElement?.style.getPropertyValue("--timeline-bottom-inset") };
      });
      throw new Error(`The production rail did not mount: ${JSON.stringify({ geometry, promptTurns: messageIds.length, pageErrors })}`, { cause: error });
    }
    await waitFor(() => page.locator(".message-nav-rail__tick").count(), (value) => value === 14,
      "all durable prompt turns to enter the navigation rail");
    await browserFrames(page);
    const tick = (index: number) => rail.locator(`[data-message-nav-index="${index}"]`);
    expect(await tick(2).getAttribute("type")).toBe("button");
    expect(await tick(2).getAttribute("aria-label")).toContain("Rail browser 2");

    // Observe real browser event and DOM times without replacing product timers.
    await rail.evaluate((node) => {
      node.addEventListener("mouseenter", (event) => {
        const button = event.target;
        if (button instanceof HTMLButtonElement && button.matches("[data-message-nav-index]")) {
          button.dataset.previewEnteredAt = String(performance.now());
        }
      }, true);
      node.addEventListener("pointerdown", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-message-nav-index]");
        if (button !== null) button.dataset.capturedPointerId = String((event as PointerEvent).pointerId);
      }, true);
      const observer = new MutationObserver(() => {
        for (const preview of node.querySelectorAll<HTMLElement>("[role=tooltip]")) {
          if (preview.dataset.openDelay !== undefined) continue;
          const enteredAt = Number(preview.parentElement?.dataset.previewEnteredAt);
          preview.dataset.openDelay = String(performance.now() - enteredAt);
        }
      });
      observer.observe(node, { childList: true, subtree: true });
    });
    await tick(1).hover();
    const firstPreview = tick(1).getByRole("tooltip");
    await firstPreview.waitFor({ state: "visible" });
    expect(Number(await firstPreview.getAttribute("data-open-delay"))).toBeGreaterThanOrEqual(130);
    expect(await firstPreview.locator("strong").textContent()).toBe("Rail browser 1");
    await tick(2).hover();
    const sharedPreview = tick(2).getByRole("tooltip");
    await sharedPreview.waitFor({ state: "visible" });
    expect(Number(await sharedPreview.getAttribute("data-open-delay"))).toBeLessThan(130);
    expect(await firstPreview.count()).toBe(0);
    await page.mouse.move(1450, 100);
    await page.waitForTimeout(750);
    await tick(3).hover();
    const expiredPreview = tick(3).getByRole("tooltip");
    await expiredPreview.waitFor({ state: "visible" });
    expect(Number(await expiredPreview.getAttribute("data-open-delay"))).toBeGreaterThanOrEqual(130);
    await page.mouse.move(1450, 100);

    const virtualTarget = messageIds[2]!;
    expect(await messageOffset(page, virtualTarget)).toBeNull();
    await tick(2).focus();
    await page.keyboard.press("Enter");
    await alignedMessage(page, virtualTarget);
    expect(await tick(2).evaluate((node) => node.ownerDocument.activeElement === node)).toBe(true);
    await tick(2).evaluate((node) => (node as HTMLElement).blur());

    const start = await tickCenter(page, 2);
    const destination = await tickCenter(page, 7);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 1);
    expect(await hasCapturedPointer(page, 2)).toBe(true);
    // Capture must retain the original button even outside the narrow rail.
    await page.mouse.move(destination.x + 55, destination.y, { steps: 5 });
    await alignedMessage(page, messageIds[7]!);
    await page.mouse.up();
    await browserFrames(page);
    expect(await hasCapturedPointer(page, 2)).toBe(false);
    await alignedMessage(page, messageIds[7]!);
    await tick(4).click();
    await alignedMessage(page, messageIds[4]!);

    const cancelledStart = await tickCenter(page, 4);
    const cancelledDestination = await tickCenter(page, 9);
    await page.mouse.move(cancelledStart.x, cancelledStart.y);
    await page.mouse.down();
    await page.mouse.move(cancelledDestination.x + 55, cancelledDestination.y, { steps: 5 });
    expect(await hasCapturedPointer(page, 4)).toBe(true);
    await alignedMessage(page, messageIds[9]!);
    // Releasing actual capture emits the browser's lostpointercapture cancellation.
    await tick(4).evaluate((node) => {
      const button = node as HTMLButtonElement;
      button.releasePointerCapture(Number(button.dataset.capturedPointerId));
    });
    await page.mouse.move(cancelledDestination.x + 56, cancelledDestination.y);
    expect(await hasCapturedPointer(page, 4)).toBe(false);
    await page.mouse.up();
    await tick(6).click();
    await alignedMessage(page, messageIds[6]!);

    await tick(6).hover();
    await tick(6).getByRole("tooltip").waitFor({ state: "visible" });
    await page.mouse.down();
    await page.mouse.move((await tickCenter(page, 6)).x, (await tickCenter(page, 6)).y + 1);
    expect(await hasCapturedPointer(page, 6)).toBe(true);
    // Retire while a captured pointer, preview, and newly requested jump coexist.
    await tick(0).evaluate((node) => {
      (node as HTMLButtonElement).click();
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    });
    await browserFrames(page);
    expect(await hasCapturedPointer(page, 6)).toBe(false);
    expect(await rail.getByRole("tooltip").count()).toBe(0);
    expect(await rail.locator(".is-active,.is-interaction-target").count()).toBe(0);
    await page.mouse.up();
    await tick(5).hover();
    await page.waitForTimeout(180);
    expect(await rail.getByRole("tooltip").count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await browserFrames(page);
    await page.mouse.move(1450, 100);
    await tick(3).click();
    await alignedMessage(page, messageIds[3]!);
    await tick(3).getByRole("tooltip").waitFor({ state: "visible" });
    expect(pageErrors).toEqual([]);
  });
});

class MountedRailAdapter extends InstrumentedFakeAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] });
    await super.send(input, context);
  }
}

async function browserFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function messageOffset(page: Page, messageId: string): Promise<number | null> {
  return page.locator(".timeline").evaluate((node, id) => {
    const anchor = [...node.querySelectorAll<HTMLElement>("[data-message-client-id]")]
      .find((element) => element.dataset.messageClientId === id);
    return anchor === undefined ? null : anchor.getBoundingClientRect().top - node.getBoundingClientRect().top;
  }, messageId);
}

async function alignedMessage(page: Page, messageId: string): Promise<void> {
  try {
    await waitFor(() => messageOffset(page, messageId), (value) => value !== null && Math.abs(value - 12) <= 2,
      "the selected virtual message to align at the 12 px navigation inset");
  } catch (error) {
    const geometry = await page.locator(".timeline").evaluate((node, id) => {
      const anchor = [...node.querySelectorAll<HTMLElement>("[data-message-client-id]")]
        .find((element) => element.dataset.messageClientId === id);
      const row = anchor?.closest<HTMLElement>("[data-timeline-item-id]");
      const top = node.getBoundingClientRect().top;
      return { messageId: id, scrollTop: node.scrollTop, anchorOffset: anchor === undefined ? null : anchor.getBoundingClientRect().top - top,
        rowOffset: row === null || row === undefined ? null : row.getBoundingClientRect().top - top,
        rowPadding: row === null || row === undefined ? null : getComputedStyle(row).paddingTop,
        activeIndex: node.ownerDocument.querySelector(".message-nav-rail__tick.is-active")?.getAttribute("data-message-nav-index") };
    }, messageId);
    throw new Error(`The production message jump did not align: ${JSON.stringify(geometry)}`, { cause: error });
  }
}

async function tickCenter(page: Page, index: number): Promise<{ readonly x: number; readonly y: number }> {
  return page.locator(`.message-nav-rail [data-message-nav-index="${index}"]`).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

async function hasCapturedPointer(page: Page, index: number): Promise<boolean> {
  return page.locator(`.message-nav-rail [data-message-nav-index="${index}"]`).evaluate((node) => {
    const button = node as HTMLButtonElement;
    return button.dataset.capturedPointerId !== undefined && button.hasPointerCapture(Number(button.dataset.capturedPointerId));
  });
}
