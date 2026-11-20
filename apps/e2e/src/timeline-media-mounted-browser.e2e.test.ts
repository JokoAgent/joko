import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RunState } from "@joko/contracts";
import { chromium, type Browser, type Locator } from "playwright-core";
import { afterEach, expect, it } from "vitest";

import { OrchestratorE2eFixture, routeFixtureDiscovery, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

let fixture: OrchestratorE2eFixture | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  try { await browser?.close(); }
  finally {
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  }
});

mountedIt("recovers the same mounted video after URL, cover and player failures through keyboard and availability events", { timeout: 120_000 }, async () => {
  fixture = await OrchestratorE2eFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
  const manager = await fixture.pair("Video recovery manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Video recovery" })));
  const { store, artifacts } = fixture.application;
  const session = store.getSession(sessionId).descriptor;
  const incoming = await artifacts.ingestBytes(VIDEO, { fileName: "recovery.webm", mimeType: "video/webm", expiresAt: Date.now() + 60_000 });
  const blob = store.getArtifact(incoming.id).blob;
  store.transaction(() => store.adoptSessionArtifact({ blob, sessionId }));
  const identity = { backendId: session.backendId, targetId: session.targetId, sessionId, generation: session.binding.generation };
  store.appendEvent({ ...identity, traceId: "video-recovery-attachment", payload: { type: "message_complete", role: "user",
    blocks: [{ kind: "text", text: "Keep this video in the original task." }, { kind: "artifact", blob, label: "Recovery video" }] } });
  store.appendEvent({ ...identity, traceId: "video-recovery-artifact", payload: { type: "artifact", artifact: blob, purpose: "backend_artifact" } });
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Video recovery browser" });
  if (challenge.challenge === undefined) throw new Error("Video recovery pairing returned no challenge.");
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, locale: "en-US", hasTouch: true });
  await routeFixtureDiscovery(page.context(), fixture.baseUrl);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let tickets = 0;
  await page.route("**/joko.v1.ArtifactService/GetBlobDownloadTicket", async route => {
    tickets += 1;
    if (tickets === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "Temporary video failure." }) });
    else await route.continue();
  });
  const evidence = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "joko-web-evidence", "timeline-media") : undefined;
  const capture = async (name: string) => {
    if (!evidence) return;
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, name + ".png"), fullPage: false, animations: "disabled", timeout: 5_000 });
  };
  try {
    await page.goto(fixture.baseUrl + "/#/tasks/" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Video recovery browser");
    await page.locator("form.pair-form button[type=submit]").click();
    const timeline = page.locator('.timeline[data-timeline-session-id="' + sessionId + '"]');
    await timeline.waitFor({ state: "visible", timeout: 20_000 });
    const message = timeline.locator(".message-attachment--media .timeline-artifact-media--video");
    const artifact = timeline.locator(".artifact-block .timeline-artifact-media--video");
    await message.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" });
    await artifact.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" });
    expect(tickets).toBe(1);
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await capture("wide-url-error");
    const retry = message.getByRole("button", { name: "Retry", exact: true });
    await retry.focus();
    await page.keyboard.press("Enter");
    await readyVideo(message.locator("video"));
    expect(tickets).toBe(2);
    const inlinePlayer = message.locator("video");
    expect(await inlinePlayer.evaluate(element => {
      const video = element as HTMLVideoElement;
      return { controls: video.controls, loop: video.loop, autoplay: video.autoplay };
    })).toEqual({ controls: true, loop: false, autoplay: false });
    await inlinePlayer.evaluate(element => (element as HTMLVideoElement).play());
    await waitFor(() => inlinePlayer.evaluate(element => (element as HTMLVideoElement).ended),
      ended => ended, "the original video finish in the conversation", 10_000);
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await readyVideo(artifact.locator("video"));
    expect(tickets).toBe(2);

    const originalCover = await message.locator("video").elementHandle();
    await failVideo(message.locator("video"));
    await message.getByRole("button", { name: "Retry", exact: true }).click();
    await readyVideo(message.locator("video"));
    expect(await originalCover?.evaluate(video => ({ connected: video.isConnected, src: video.hasAttribute("src") })))
      .toEqual({ connected: false, src: false });

    await message.locator(".video-preview__open").click();
    const player = page.getByRole("dialog").locator("video");
    await readyVideo(player);
    expect(await player.evaluate(video => (video as HTMLVideoElement).controls)).toBe(true);
    expect(await player.evaluate(video => (video as HTMLVideoElement).loop)).toBe(false);
    await failVideo(player);
    await message.getByRole("button", { name: "Retry", exact: true }).waitFor({ state: "visible" });
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await page.locator("body").evaluate(body => body.classList.contains("modal-open"))).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await readyVideo(message.locator("video"));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const closeNavigation = page.getByLabel("Task navigation").getByRole("button", { name: "Close navigation", exact: true });
    if (await closeNavigation.isVisible()) await closeNavigation.tap();
    await page.locator(".panel-scrim--navigation").waitFor({ state: "hidden" });
    const closeDetails = page.locator(".inspector-dock-group[data-edge]").getByRole("button", { name: "Close details", exact: true });
    if (await closeDetails.isVisible()) await closeDetails.tap();
    await failVideo(artifact.locator("video"));
    const narrowRetry = artifact.getByRole("button", { name: "Retry", exact: true });
    await narrowRetry.scrollIntoViewIfNeeded();
    const bounds = await narrowRetry.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await capture("narrow-dark-error");
    await narrowRetry.tap();
    await readyVideo(artifact.locator("video"));
    expect(tickets).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await capture("narrow-dark-recovered");
    expect(store.getSession(sessionId).descriptor.binding).toEqual(session.binding);
    expect(store.listSessions({ includeArchived: true })).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    await capture("failure").catch(() => undefined);
    throw error;
  }
});

mountedIt("opens the original successful Pi generation in the default timeline without expanding work", { timeout: 120_000 }, async () => {
  const pi = await RealPiSystemFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
  try {
    const manager = await pi.pair("Image generation timeline manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Generated image", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const { store, artifacts } = pi.application;
    const session = store.getSession(sessionId).descriptor;
    const runId = queueRunIdFrom(await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, BigInt(session.binding.generation), "Review the sample PNG.")));
    await waitFor(() => manager.clients.run.getRun({ runId }), result => result.run?.state === RunState.SUCCEEDED,
      "the original Pi fixture run to settle");
    const attempt = store.listAttempts(runId)[0]?.descriptor;
    if (attempt === undefined) throw new Error("The Pi fixture did not produce an Attempt.");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const stored = await artifacts.ingestBytes(bytes, { fileName: "generated.png", mimeType: "image/png", expiresAt: Date.now() + 60_000 });
    const blob = store.getArtifact(stored.id).blob;
    store.transaction(() => store.adoptSessionArtifact({ blob, sessionId }));
    const identity = { backendId: session.backendId, targetId: session.targetId, sessionId, runId, attemptId: attempt.id,
      generation: attempt.generation, traceId: "pi-generated-image" };
    // Seed the exact durable receipt so the browser check uses the owned image without calling an image provider.
    store.appendEvent({ ...identity, payload: { type: "tool_start", callId: "generation-call", name: "image_generate", input: "sample" } });
    const completion = store.appendEvent({ ...identity, payload: { type: "tool_result", callId: "generation-call", name: "image_generate", isError: false,
      output: "Image generated", parts: [{ kind: "image", blob, alt: "Generated sample" }] } });
    expect((await manager.clients.artifact.listArtifacts({ sessionId })).artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: blob.id, sessionId, blob: expect.objectContaining({ blobId: blob.id }) })
    ]));
    const timelineResponse = await manager.clients.session.listSessionTimeline({ sessionId });
    const event = timelineResponse.events.find(value => value.eventId === completion.id);
    expect(event).toMatchObject({ identity: { backendId: "pi", sessionId, runId, attemptId: attempt.id, generation: BigInt(attempt.generation) },
      payload: { kind: { case: "toolCallCompleted", value: { toolCall: { toolCallId: "generation-call", toolId: "image_generate",
        result: { parts: [{ content: { case: "image", value: { blob: { blobId: blob.id, byteSize: BigInt(bytes.length) } } } }] } } } } }
    });
    expect(event?.cursor?.generation).not.toBe(event?.identity?.generation);

    const device = "Image generation timeline browser";
    const challenge = (await pi.anonymous.connection.beginPairing({ deviceDisplayName: device })).challenge;
    if (challenge === undefined) throw new Error("The browser fixture could not begin pairing.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, locale: "en-US" });
    await routeFixtureDiscovery(page.context(), pi.baseUrl);
    await page.goto(`${pi.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(pi.baseUrl);
    await page.getByLabel("Pairing code").fill(pi.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill(device);
    await page.locator("form.pair-form button[type=submit]").click();
    const timeline = page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`);
    const image = timeline.locator(".artifact-block").getByRole("button", { name: "Open Generated sample in the image viewer", exact: true });
    await image.waitFor();
    expect(await image.count()).toBe(1);
    expect(await image.evaluate(element => element.closest(".work-group"))).toBeNull();
    expect(await timeline.locator(".work-group__header").last().getAttribute("aria-expanded")).toBe("false");
    await image.click();
    const gallery = page.getByRole("dialog", { name: "generated.png", exact: true });
    const original = gallery.locator("img");
    await waitFor(() => original.evaluate(element => (element as HTMLImageElement).naturalWidth),
      width => width === 1, "the original authenticated PNG in the gallery");
    expect(await original.evaluate(async (element: HTMLImageElement) => {
      const response = await fetch(element.currentSrc);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    })).toEqual(Array.from(bytes));
  } finally {
    await browser?.close();
    browser = undefined;
    await pi.close({ removeRoot: true });
  }
});

async function readyVideo(video: Locator): Promise<void> {
  await video.waitFor({ state: "attached" });
  await waitFor(() => video.evaluate(element => ({ ready: (element as HTMLVideoElement).readyState, width: (element as HTMLVideoElement).videoWidth })),
    value => value.ready >= 1 && value.width > 0, "the recovered native video metadata", 20_000);
}

async function failVideo(video: Locator): Promise<void> {
  await video.evaluate(element => {
    const media = element as HTMLVideoElement;
    media.src = "data:video/webm;base64,bm90LXZpZGVv";
    media.load();
  });
}

// The existing synthetic VP9 sample used by the Web visual harness.
const VIDEO = Buffer.from("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", "base64");
