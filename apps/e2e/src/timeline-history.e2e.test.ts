import { fromBinary } from "@bufbuild/protobuf";
import { ListSessionTimelineRequestSchema, MessageInputDelivery, MessageRole, RunState } from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

describe("mounted Timeline history windows", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;
  let releasePage: (() => void) | undefined;

  afterEach(async () => {
    releasePage?.();
    releasePage = undefined;
    try {
      await browser?.close();
    } finally {
      browser = undefined;
      await fixture?.close({ removeRoot: true });
      fixture = undefined;
    }
  });

  mountedIt("retains the reading anchor through failed older pages and fills history after an offline burst", { timeout: 120_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new HistoryAdapter(profile)
    });
    const manager = await fixture.pair("History manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "History window" })));
    const send = async (index: number) => {
      const operation = await submit(manager.clients.operation, manager.connectionId,
        sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), prompt(index)));
      await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(operation) }),
        (value) => value.run?.state === RunState.SUCCEEDED, "the history turn to settle");
    };
    for (let index = 0; index < 56; index += 1) await send(index);
    const recentHistory = await manager.clients.session.listSessionTimeline({ sessionId, limit: 240 });
    const recentUsers = recentHistory.events.flatMap((event) => event.payload?.kind.case === "messageStarted"
      && event.payload.kind.value.role === MessageRole.USER ? [event.payload.kind.value] : []);
    expect(recentUsers.length).toBeGreaterThanOrEqual(8);
    expect(recentUsers.every((value) => value.inputDelivery === MessageInputDelivery.PROMPT)).toBe(true);

    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: "reduce" });
    const pageErrors: string[] = [];
    let failedEventStreams = 0;
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/joko.v1.EventService/StreamEvents") failedEventStreams += 1;
    });
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "History browser" });
    if (challenge.challenge === undefined) throw new Error("History pairing returned no challenge.");
    let olderRequests = 0;
    let rejectOlder = true;
    let holdOlder: Promise<void> | undefined;
    await page.route("**/joko.v1.SessionService/ListSessionTimeline", async (route) => {
      const bytes = route.request().postDataBuffer();
      if (bytes === null) throw new Error("History request has no protobuf body.");
      const request = fromBinary(ListSessionTimelineRequestSchema, bytes);
      if (request.beforeCursor !== undefined) {
        olderRequests += 1;
        if (rejectOlder) {
          rejectOlder = false;
          await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "History page temporarily unavailable" }) });
          return;
        }
        if (holdOlder !== undefined) {
          const held = holdOlder;
          holdOlder = undefined;
          await held;
        }
      }
      await route.continue();
    });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("History browser");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(".timeline").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await waitFor(() => page.locator(".timeline").evaluate((node) => {
      const content = node.querySelector(".timeline__virtual");
      const rootRect = node.getBoundingClientRect();
      return { ticks: document.querySelectorAll(".message-nav-rail__tick").length,
        leftGutter: (content?.getBoundingClientRect().left ?? 0) - rootRect.left,
        rows: node.querySelectorAll("[data-message-client-id]").length, height: rootRect.height,
        rail: document.querySelector(".message-nav-rail") !== null,
        prompts: node.querySelectorAll(".message--user").length };
    }), (value) => value.ticks >= 8, "the bounded initial history to render");
    const initialIds = await navIds(page);
    expect(initialIds.length).toBeLessThan(56);
    await goToHistoryStart(page);
    await page.locator(".timeline-history--error").waitFor({ state: "visible" });
    expect(olderRequests).toBe(1);
    const failedIds = await navIds(page);
    expect(failedIds).toEqual(initialIds);
    const beforeRetry = await anchor(page);
    holdOlder = new Promise<void>((resolve) => { releasePage = resolve; });
    await page.locator(".timeline-history--error").getByRole("button", { name: "Retry", exact: true }).click();
    await waitFor(async () => olderRequests, (value) => value === 2, "the explicit history retry");
    expect(await navIds(page)).toEqual(initialIds);
    releasePage!();
    releasePage = undefined;
    await waitFor(() => navIds(page), (value) => value.length > initialIds.length, "older history to merge");
    const afterRetry = await settledAnchor(page);
    const retainedOffset = await rowOffset(page, beforeRetry.id!);
    expect(afterRetry.id, JSON.stringify({ beforeRetry, afterRetry, retainedOffset })).toBe(beforeRetry.id);
    expect(Math.abs(afterRetry.offset - beforeRetry.offset)).toBeLessThanOrEqual(3);
    await loadAllEarlier(page, 56);
    const allInitialIds = await navIds(page);
    expect(new Set(allInitialIds).size).toBe(56);
    await send(56);
    await waitFor(() => navIds(page), (value) => value.length === 57, "a live history turn before disconnect");

    // Read a durable middle row while the transport loses more than one page.
    await page.locator(".message-nav-rail__tick").nth(24).click();
    await frames(page);
    const beforeOffline = await anchor(page);
    const failuresBeforeOffline = failedEventStreams;
    await page.context().setOffline(true);
    fixture.dropPublicConnections();
    await waitFor(async () => failedEventStreams, (value) => value > failuresBeforeOffline, "the history Connect stream to fail", 20_000);
    for (let index = 57; index < 113; index += 1) await send(index);
    await page.context().setOffline(false);
    await waitFor(() => page.locator(".offline-banner,.error-banner").count(), (value) => value === 0, "history reconnect", 20_000);
    await frames(page);
    const afterOffline = await anchor(page);
    expect(afterOffline.id, JSON.stringify({ beforeOffline, afterOffline })).toBe(beforeOffline.id);
    expect(Math.abs(afterOffline.offset - beforeOffline.offset)).toBeLessThanOrEqual(3);
    expect((await navIds(page)).filter((id) => allInitialIds.includes(id))).toEqual(allInitialIds);
    if ((await navIds(page)).length < 113) {
      await goToHistoryStart(page);
      await page.getByRole("button", { name: "Load earlier activity", exact: true }).waitFor({ state: "visible" });
    }
    await loadAllEarlier(page, 113);
    const finalIds = await navIds(page);
    expect(new Set(finalIds).size).toBe(113);
    await page.locator(".jump-latest").click();
    await page.getByText(`History answer 112`, { exact: true }).waitFor({ state: "visible" });
    expect(await page.locator(".jump-latest").count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});

function prompt(index: number): string {
  return `History prompt ${index}\n\n${"A paragraph preserves the real measured reading position. ".repeat(8)}`;
}

class HistoryAdapter extends InstrumentedFakeAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] });
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: `History answer ${/^History prompt (\d+)/u.exec(input.text)?.[1]}` }] });
    await context.emit({ type: "done", outcome: "completed" });
  }
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function navIds(page: Page): Promise<string[]> {
  return page.locator(".message-nav-rail__tick").evaluateAll((nodes) => nodes.map((node) => /History prompt \d+/u.exec(node.getAttribute("aria-label") ?? "")?.[0] ?? ""));
}

async function anchor(page: Page) {
  return page.locator(".timeline").evaluate((node) => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>("[data-timeline-item-id]")].find((entry) => entry.getBoundingClientRect().bottom > top + 0.5);
    if (row === undefined) throw new Error("History has no visible row.");
    return { id: row.dataset.timelineItemId, offset: row.getBoundingClientRect().top - top };
  });
}

async function settledAnchor(page: Page) {
  let previous: Awaited<ReturnType<typeof anchor>> | undefined;
  let stableFrames = 0;
  for (let frame = 0; frame < 90; frame += 1) {
    await frames(page);
    const current = await anchor(page);
    stableFrames = previous !== undefined && current.id === previous.id && Math.abs(current.offset - previous.offset) < 0.5 ? stableFrames + 1 : 0;
    if (stableFrames >= 8) return current;
    previous = current;
  }
  throw new Error(`History did not settle: ${JSON.stringify(previous)}`);
}

async function rowOffset(page: Page, id: string): Promise<number | null> {
  return page.locator(".timeline").evaluate((node, rowId) => {
    const row = [...node.querySelectorAll<HTMLElement>("[data-timeline-item-id]")].find((entry) => entry.dataset.timelineItemId === rowId);
    return row === undefined ? null : row.getBoundingClientRect().top - node.getBoundingClientRect().top;
  }, id);
}

async function goToHistoryStart(page: Page): Promise<void> {
  await page.locator(".timeline").focus();
  await page.keyboard.press("Home");
  await frames(page);
}

async function loadAllEarlier(page: Page, expectedCount: number): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    if ((await navIds(page)).length === expectedCount) return;
    await goToHistoryStart(page);
    const button = page.getByRole("button", { name: "Load earlier activity", exact: true });
    if (await button.isVisible()) await button.click();
    await frames(page);
    await waitFor(() => page.locator(".timeline-history [role=status]").count(), (value) => value === 0, "history page to settle");
    await frames(page);
  }
  expect((await navIds(page)).length).toBe(expectedCount);
}
