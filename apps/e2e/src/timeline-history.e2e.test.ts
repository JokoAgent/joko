import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { GetSnapshotRequestSchema, ListSessionTimelineRequestSchema, MessageInputDelivery, MessageRole, RunState, type Event } from "@joko/contracts";
import type { AdapterContext, EventPayload, NativeHistoryProjectedEvent, NativeHistoryProjection, PromptInput } from "@joko/core";
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

  mountedIt("preserves native work activity through exact timestamps, history pages and browser reload", { timeout: 120_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new WorkHistoryAdapter(profile)
    });
    const manager = await fixture.pair("Work history manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Work activity" })));
    const adapter = fixture.adapter() as WorkHistoryAdapter;
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Work history browser" });
    if (!challenge.challenge) throw new Error("Work history pairing returned no challenge.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: "reduce", locale: "en-US" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    let smallWindow = false;
    let olderRequests = 0;
    await page.route("**/joko.v1.EventService/GetSnapshot", async (route) => {
      const bytes = route.request().postDataBuffer();
      if (smallWindow && bytes) {
        const request = fromBinary(GetSnapshotRequestSchema, bytes);
        if (request.scope?.kind.case === "session") {
          request.scope.kind.value.recentTimelineItems = 3;
          await route.continue({ postData: Buffer.from(toBinary(GetSnapshotRequestSchema, request)) }); return;
        }
      }
      await route.continue();
    });
    await page.route("**/joko.v1.SessionService/ListSessionTimeline", async (route) => {
      const bytes = route.request().postDataBuffer();
      if (!bytes) throw new Error("Work history request has no protobuf body.");
      const request = fromBinary(ListSessionTimelineRequestSchema, bytes);
      if (request.beforeCursor) olderRequests += 1;
      if (smallWindow) {
        request.limit = 3;
        await route.continue({ postData: Buffer.from(toBinary(ListSessionTimelineRequestSchema, request)) }); return;
      }
      await route.continue();
    });
    await page.goto(fixture.baseUrl + "/#/tasks/" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    try { await page.locator(".pair-form").waitFor({ state: "visible", timeout: 5_000 }); }
    catch (cause) {
      const state = await page.evaluate(() => ({ language: navigator.language,
        tabs: [...document.querySelectorAll(".connection-tabs > button")].map((node) => ({ text: node.textContent, pressed: node.getAttribute("aria-pressed") })),
        labels: [...document.querySelectorAll("label > span:first-child")].map((node) => node.textContent) }));
      throw new Error("Work history pairing did not open: " + JSON.stringify({ state, pageErrors }), { cause });
    }
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Work history browser");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(".timeline").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    const operation = await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), "Observe native work activity"));
    const context = await waitFor(async () => adapter.context, (value) => value !== undefined, "the work history Run");
    if (!context) throw new Error("The work history Run has no context.");
    await context.emit({ type: "done", outcome: "completed" });
    await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(operation) }),
      (value) => value.run?.state === RunState.SUCCEEDED, "native work history to settle");

    const events: Event[] = [];
    let beforeCursor;
    for (let round = 0; round < 24; round += 1) {
      const response = await manager.clients.session.listSessionTimeline({ sessionId, limit: 3, ...(beforeCursor ? { beforeCursor } : {}) });
      events.unshift(...response.events);
      beforeCursor = response.nextBeforeCursor;
      if (!beforeCursor) break;
    }
    expect(beforeCursor).toBeUndefined();
    expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
    const completed = events.flatMap((event) => event.payload?.kind.case === "toolCallCompleted"
      && event.payload.kind.value.toolCall ? [event.payload.kind.value.toolCall] : []);
    const historyState = { reads: adapter.historyReads, types: events.map((event) => event.payload?.kind.case),
      diagnostics: fixture.application.store.listDiagnostics({ limit: 20 }).map(({ code, component, message }) => ({ code, component, message })) };
    expect(completed.map((call) => call.toolCallId), JSON.stringify(historyState)).toContain("activity-long");
    const long = completed.find((call) => call.toolCallId === "activity-long")!;
    expect(long.endedAt!.seconds * 1_000n + BigInt(long.endedAt!.nanos / 1_000_000)).toBe(BigInt(adapter.startedAt + 40 * MINUTE + 125));
    const thinking = events.filter((event) => event.payload?.kind.case === "thinkingDelta");
    expect(thinking.map((event) => Number(event.occurredAt!.seconds * 1_000n) + event.occurredAt!.nanos / 1_000_000))
      .toEqual([adapter.startedAt + 42 * MINUTE, adapter.startedAt + 82 * MINUTE, adapter.startedAt + 81 * MINUTE]);
    const around = await manager.clients.session.listSessionTimeline({ sessionId, aroundEventId: thinking[0]!.eventId, limit: 7 });
    expect(around.events.some((event) => event.eventId === thinking[0]!.eventId)).toBe(true);
    const nativeIds = events.filter((event) => event.eventId.startsWith("native-event-")).map((event) => event.eventId);
    expect(nativeIds).toHaveLength(adapter.history.events.length);
    await assertWorkHistory(page);

    smallWindow = true;
    const oldPages = olderRequests;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".timeline,.connection-screen").waitFor({ state: "visible", timeout: 20_000 });
    if (await page.locator(".connection-screen").isVisible()) {
      await page.locator(".profile-card").filter({ hasText: fixture.baseUrl }).getByRole("button", { name: "Connect", exact: true }).click();
    }
    await page.locator(".timeline").waitFor({ state: "visible", timeout: 20_000 });
    for (let round = 0; round < 12; round += 1) {
      await goToHistoryStart(page);
      const load = page.getByRole("button", { name: "Load earlier activity", exact: true });
      await waitFor(() => page.locator(".timeline-history [role=status]").count(), (value) => value === 0, "the small native history window");
      if (await load.isVisible()) await load.click();
      if (await page.locator('[data-timeline-item-ids="activity-user"]').count()) break;
      await frames(page);
    }
    await page.locator('[data-timeline-item-ids="activity-user"]').waitFor({ state: "attached", timeout: 10_000 });
    expect(olderRequests).toBeGreaterThan(oldPages);
    await assertWorkHistory(page);
    const nextSessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Independent activity" })));
    await page.goto(fixture.baseUrl + "/#/tasks/" + encodeURIComponent(nextSessionId), { waitUntil: "domcontentloaded" });
    await page.locator('.timeline[data-timeline-session-id="' + nextSessionId + '"]').waitFor({ state: "visible", timeout: 20_000 });
    expect(await page.locator('[data-timeline-item-ids*="activity-long"],.work-group,.timeline-history-gap').count()).toBe(0);
    expect(adapter.sendCalls).toHaveLength(1);
    expect(pageErrors).toEqual([]);
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

const MINUTE = 60_000;

class WorkHistoryAdapter extends InstrumentedFakeAdapter {
  context?: AdapterContext;
  startedAt = 0;
  historyReads = 0;
  history: NativeHistoryProjection = { events: [] };

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    this.historyReads += 1;
    return this.context?.sessionId === context.sessionId ? this.history : { events: [] };
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input); this.context = context;
    this.startedAt = Date.now() - 115 * MINUTE;
    const events: NativeHistoryProjectedEvent[] = [];
    const lineage: NonNullable<NativeHistoryProjection["activeLineage"]>[number][] = [];
    const append = (entry: string, payload: EventPayload, offset: number) => {
      let identity = lineage.find((item) => item.entryId === entry);
      if (!identity) {
        const parent = lineage.at(-1)?.entryId;
        identity = { entryId: entry, ...(parent ? { parentEntryId: parent } : {}) };
        lineage.push(identity);
      }
      events.push({ nativeEntryId: entry, ...(identity.parentEntryId ? { nativeParentEntryId: identity.parentEntryId } : {}),
        projectionKind: payload.type + "-" + events.length, contentIndex: 0, emittedAt: this.startedAt + offset, payload });
    };
    const start = (callId: string, offset: number) => append(callId,
      { type: "tool_start", callId, name: "read", input: JSON.stringify({ path: callId }) }, offset);
    const end = (callId: string, offset: number) => append(callId,
      { type: "tool_result", callId, name: "read", output: "Completed " + callId, isError: false }, offset);
    append("activity-user", { type: "message_complete", role: "user",
      blocks: [{ kind: "text", text: input.text }], inputDelivery: "prompt" }, 0);
    start("activity-long", 0); start("activity-short", MINUTE);
    end("activity-long", 40 * MINUTE + 125); end("activity-short", 2 * MINUTE);
    start("activity-next", 41 * MINUTE); end("activity-next", 41 * MINUTE + 125);
    for (const offset of [42, 82, 81]) append("activity-thinking",
      { type: "thinking_delta", blockId: "activity-thinking", contentIndex: 0, delta: "Observed activity. " }, offset * MINUTE);
    append("activity-thinking", { type: "message_complete", role: "assistant",
      blocks: [{ kind: "thinking", text: "Observed thinking activity.", redacted: false }] }, 82 * MINUTE + 125);
    start("activity-after-thinking", 83 * MINUTE); end("activity-after-thinking", 83 * MINUTE + 125);
    start("activity-gap", 114 * MINUTE + 125); end("activity-gap", 114 * MINUTE + 250);
    append("activity-no-delta", { type: "message_complete", role: "assistant",
      blocks: [{ kind: "thinking", text: "Final thinking without delta.", redacted: false }] }, 115 * MINUTE);
    append("activity-answer", { type: "message_complete", role: "assistant",
      blocks: [{ kind: "text", text: "Native work history complete." }] }, 115 * MINUTE + 125);
    this.history = { events, activeEntryId: "activity-answer", activeLineage: lineage };
  }
}

async function assertWorkHistory(page: Page): Promise<void> {
  await goToHistoryStart(page);
  await waitFor(() => page.locator(".timeline-history-gap").count(), (value) => value === 1, "the actual native history gap");
  await waitFor(() => page.locator(".work-group").count(), (value) => value === 2, "two bounded native work groups");
  const groups = await page.locator("[data-timeline-item-ids]:has(.work-group)").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-timeline-item-ids")?.split(" ")));
  expect(groups).toEqual([
    ["activity-long", "activity-short", "activity-next", "activity-thinking:thinking:0", "activity-after-thinking"],
    ["activity-gap", "activity-no-delta:thinking:0"]
  ]);
  for (const button of await page.locator(".work-group__header").all()) {
    if (await button.getAttribute("aria-expanded") !== "true") await button.click();
  }
  await page.getByText("Observed thinking activity.", { exact: true }).waitFor({ state: "visible" });
  const finalThinking = page.locator('[data-work-child-id="activity-no-delta:thinking:0"]');
  expect(await finalThinking.locator("summary time").count()).toBe(1);
  expect(await finalThinking.locator("summary").textContent()).not.toMatch(/duration|worked|minutes/iu);
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
