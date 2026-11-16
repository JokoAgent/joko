import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";

import { OrchestratorE2eFixture, routeFixtureDiscovery, waitFor } from "./fixture.js";
import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";

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

mountedIt("pans the mounted task image with trackpad, Space and middle button while preserving annotation and toolbar focus", { timeout: 120_000 }, async () => {
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", hasTouch: true });
  const imageBytes = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 900;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#407a92";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f3d8a2";
    context.fillRect(300, 225, 600, 450);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  fixture = await OrchestratorE2eFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
  const manager = await fixture.pair("Image gesture manager");
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Image gestures",
      providerId: "vision", modelId: "multimodal", effortId: "low" })));
  const { store, artifacts } = fixture.application;
  const session = store.getSession(sessionId).descriptor;
  const incoming = await artifacts.ingestBytes(imageBytes, { fileName: "gestures.png", mimeType: "image/png", expiresAt: Date.now() + 60_000 });
  const blob = store.getArtifact(incoming.id).blob;
  store.transaction(() => store.adoptSessionArtifact({ blob, sessionId }));
  store.appendEvent({ backendId: session.backendId, targetId: session.targetId, sessionId, generation: session.binding.generation,
    traceId: "image-gestures", payload: { type: "message_complete", role: "user",
      blocks: [{ kind: "text", text: "Inspect this image without changing the task." }, { kind: "image", blob, alt: "Gesture image" }] } });
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Image gesture browser" });
  if (challenge.challenge === undefined) throw new Error("Image gesture pairing returned no challenge.");
  await routeFixtureDiscovery(page.context(), fixture.baseUrl);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const evidence = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "joko-web-evidence", "image-lightbox") : undefined;
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
    await page.getByLabel("Device name").fill("Image gesture browser");
    await page.locator("form.pair-form button[type=submit]").click();
    const timeline = page.locator('.timeline[data-timeline-session-id="' + sessionId + '"]');
    await timeline.waitFor({ state: "visible", timeout: 20_000 });
    const trigger = timeline.locator(".message-attachment__preview");
    await trigger.click();
    const overlay = page.getByRole("dialog", { name: "gestures.png", exact: true });
    const wrap = overlay.locator(".workspace-image-lightbox__image-wrap");
    await waitFor(() => wrap.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth),
      width => width === 1200, "the authenticated image in the mounted task gallery");
    const viewport = () => wrap.evaluate(element => {
      const transform = new DOMMatrixReadOnly((element as HTMLElement).style.transform);
      return { x: transform.e, y: transform.f, scale: transform.a };
    });
    const wheel = (sample: { x?: number; y?: number; ctrl?: boolean; time: number }) => overlay.evaluate((element, sample) => {
      const rect = element.getBoundingClientRect();
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaMode: 0,
        deltaX: sample.x ?? 0, deltaY: sample.y ?? 0, ctrlKey: sample.ctrl ?? false,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
      Object.defineProperty(event, "timeStamp", { value: sample.time });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, sample);
    expect(await wheel({ x: 20, time: 1 })).toBe(true);
    expect(await viewport()).toEqual({ x: 0, y: 0, scale: 1 });
    for (let index = 0; index < 4; index++) await overlay.getByRole("button", { name: "Zoom in", exact: true }).click();
    const zoomed = await waitFor(viewport, value => value.scale > 2, "the gallery image zoom");
    await wheel({ x: 20, time: 10 });
    await wheel({ y: 15, time: 20 });
    const panned = await waitFor(viewport, value => value.x === -20 && value.y === -15, "horizontal scrolling and its vertical momentum tail");
    expect(panned.scale).toBeCloseTo(zoomed.scale);
    await wheel({ y: -10, ctrl: true, time: 30 });
    await waitFor(viewport, value => value.scale > zoomed.scale, "pinch zoom at the pointer");
    await wheel({ y: 10, time: 500 });
    const mouseZoom = await waitFor(viewport, value => Math.abs(value.scale - zoomed.scale) < 0.0001, "a new mouse wheel stream after idle");
    expect(mouseZoom.scale).toBeCloseTo(zoomed.scale);
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await capture("wide-light-trackpad");

    await overlay.getByRole("button", { name: "Annotate", exact: true }).click();
    await overlay.focus();
    const drag = async (button: "left" | "middle", dx: number, dy: number) => {
      const size = page.viewportSize()!;
      await page.mouse.move(size.width / 2, size.height / 2);
      await page.mouse.down({ button });
      await page.mouse.move(size.width / 2 + dx, size.height / 2 + dy, { steps: 4 });
      await page.mouse.up({ button });
    };
    const beforeSpace = await viewport();
    await page.keyboard.down("Space");
    await drag("left", 60, 40);
    await page.keyboard.up("Space");
    const afterSpace = await viewport();
    expect(afterSpace.x).toBeCloseTo(beforeSpace.x + 60);
    expect(afterSpace.y).toBeCloseTo(beforeSpace.y + 40);
    expect(await wrap.locator("path").count()).toBe(0);
    await drag("middle", 30, 20);
    const afterMiddle = await viewport();
    expect(afterMiddle.x).toBeCloseTo(afterSpace.x + 30);
    expect(afterMiddle.y).toBeCloseTo(afterSpace.y + 20);
    expect(await wrap.locator("path").count()).toBe(0);
    await wheel({ x: 20, time: 510 });
    await waitFor(viewport, value => Math.abs(value.x - (afterMiddle.x - 20)) < 0.0001, "trackpad pan while annotating");
    expect(await wrap.locator("path").count()).toBe(0);

    await overlay.focus();
    await page.keyboard.down("Space");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(await wrap.evaluate(element => element.classList.contains("is-space-panning"))).toBe(false);
    await page.keyboard.up("Space");
    await drag("left", 25, 15);
    expect(await wrap.locator("g").count()).toBe(1);
    const undo = overlay.getByRole("button", { name: "Undo last stroke", exact: true });
    await undo.focus();
    await page.keyboard.press("Space");
    await waitFor(() => wrap.locator("g").count(), count => count === 0, "native Space activation of the focused Undo button");
    expect(await wrap.evaluate(element => element.classList.contains("is-space-panning"))).toBe(false);
    await capture("wide-light-annotation-pan");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await overlay.getByRole("button", { name: "Discard annotation", exact: true }).tap();
    await overlay.getByRole("button", { name: "Fit", exact: true }).tap();
    for (let index = 0; index < 4; index++) await overlay.getByRole("button", { name: "Zoom in", exact: true }).tap();
    await overlay.getByRole("button", { name: "Annotate", exact: true }).tap();
    await overlay.focus();
    await page.keyboard.down("Space");
    const beforeNarrow = await viewport();
    await drag("left", 20, 0);
    await page.keyboard.up("Space");
    expect((await viewport()).x).toBeCloseTo(beforeNarrow.x + 20);
    expect(await wrap.locator("path").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await capture("narrow-dark-reduced-motion");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });
    expect(await trigger.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true);
    expect(store.getSession(sessionId).descriptor.binding).toEqual(session.binding);
    expect(store.listSessions({ includeArchived: true })).toHaveLength(1);
    expect(store.listQueueItems({ sessionId })).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    await capture("failure").catch(() => undefined);
    throw error;
  }
});
