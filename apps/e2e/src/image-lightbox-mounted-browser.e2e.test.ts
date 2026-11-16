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
      blocks: [{ kind: "text", text: "Inspect this image without changing the task." }, { kind: "artifact", blob, label: "Gesture image" }] } });
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
    await overlay.focus();
    await drag("left", 20, 10);
    await overlay.getByRole("button", { name: "Discard annotation", exact: true }).click();
    const discard = page.getByRole("alertdialog", { name: "Discard unsaved annotations?", exact: true });
    await discard.waitFor({ state: "visible" });
    await capture("wide-light-unsaved-annotation");
    await page.keyboard.press("Escape");
    await discard.waitFor({ state: "detached" });
    expect(await wrap.locator("g").count()).toBe(1);
    await undo.click();

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
    await drag("left", 12, 5);
    await overlay.getByRole("button", { name: "Discard annotation", exact: true }).tap();
    await discard.waitFor({ state: "visible" });
    await capture("narrow-dark-unsaved-annotation");
    await discard.getByRole("button", { name: "Cancel", exact: true }).tap();
    expect(await wrap.locator("g").count()).toBe(1);
    await overlay.getByRole("button", { name: "Discard annotation", exact: true }).tap();
    await discard.getByRole("button", { name: "Discard annotation", exact: true }).tap();
    expect(await wrap.locator("path").count()).toBe(0);
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

mountedIt("edits the same original image in task and new-task drafts, restores vectors and burns only the sent input", { timeout: 120_000 }, async () => {
  browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "en-US", hasTouch: true });
  const imageBytes = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext("2d")!; context.fillStyle = "#407a92"; context.fillRect(0, 0, 600, 400);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }), "base64");
  fixture = await OrchestratorE2eFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
  const manager = await fixture.pair("Editable image manager"), { store, artifacts } = fixture.application;
  const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
    createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Editable images", providerId: "vision", modelId: "multimodal", effortId: "low" })));
  const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Editable image browser" });
  if (challenge.challenge === undefined) throw new Error("Image editing pairing returned no challenge.");
  await routeFixtureDiscovery(page.context(), fixture.baseUrl);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const evidence = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "joko-web-evidence", "image-lightbox") : undefined;
  const capture = async (name: string) => { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name + ".png"), animations: "disabled", timeout: 5_000 }); } };
  const closeDrawers = async () => { for (const name of ["Close details", "Close navigation"]) { const button = page.getByRole("button", { name, exact: true }); if (await button.isVisible()) await button.click(); } };
  const composer = page.locator(".composer"), tray = composer.locator(".attachment-list");
  const selectModel = async (name: string) => {
    const trigger = composer.locator(".model-picker-trigger"); await trigger.click();
    await page.locator('.model-picker__row[role="option"]').filter({ hasText: name }).first().click();
    await waitFor(() => trigger.innerText(), text => text.includes(name), "the selected image input policy");
  };
  const attach = async () => {
    await composer.locator(".composer-add-menu__trigger").click(); const picker = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: /Attach image or file/u }).click();
    await (await picker).setFiles({ name: "editable.png", mimeType: "image/png", buffer: imageBytes });
  };
  const persisted = async (newTask: boolean) => waitFor(() => page.evaluate(({ newTask, sessionId }) => new Promise<boolean>((resolve, reject) => {
    const opening = indexedDB.open("joko-ui"); opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result, transaction = database.transaction("drafts", "readonly"), cursor = transaction.objectStore("drafts").openCursor(); let found = false;
      cursor.onsuccess = () => {
        const entry = cursor.result; if (entry === null) return;
        const key = String(entry.key), owned = newTask ? key.startsWith("new-session\u0000") : key.startsWith("[") && (JSON.parse(key) as unknown[])[2] === sessionId;
        if (owned) {
          type Saved = { readonly attachments?: readonly { readonly name: string; readonly annotationStrokes?: readonly unknown[] }[] };
          const record = entry.value as Saved & { readonly draft?: Saved }, image = (record.draft ?? record).attachments?.[0];
          if (image?.name === "editable.png" && image.annotationStrokes?.length === 1) found = true;
        }
        entry.continue();
      };
      transaction.oncomplete = () => { database.close(); resolve(found); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  }), { newTask, sessionId }), value => value, "the original image and vectors in durable draft storage");
  const edit = async (draw: boolean) => {
    await tray.locator("button.attachment-chip__content").click();
    const overlay = page.getByRole("dialog", { name: "editable.png", exact: true }), wrap = overlay.locator(".workspace-image-lightbox__image-wrap");
    await waitFor(() => wrap.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth), width => width === 600, "the original draft image");
    await overlay.getByRole("button", { name: "Annotate", exact: true }).click();
    if (draw) {
      const rect = (await wrap.locator("img").boundingBox())!;
      await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height * 0.5); await page.mouse.down();
      await page.mouse.move(rect.x + rect.width * 0.75, rect.y + rect.height * 0.5, { steps: 4 }); await page.mouse.up();
    } else {
      expect(await wrap.locator("g").count()).toBe(1);
      await overlay.getByRole("button", { name: "Undo last stroke", exact: true }).click();
      expect(await wrap.locator("path").count()).toBe(0);
    }
    await overlay.getByRole("button", { name: "Save", exact: true }).click(); await overlay.waitFor({ state: "detached" });
  };
  const assertSentPixels = async (id: string) => {
    const item = await waitFor(() => store.listQueueItems({ sessionId: id })[0], item => item?.state === "completed", "the annotated image input");
    expect(item!.body.images).toHaveLength(1);
    const image = await artifacts.readBlob(item!.body.images[0]!.blob);
    const pixel = await page.evaluate(async base64 => {
      const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + base64)).blob());
      const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!; context.drawImage(bitmap, 0, 0); bitmap.close();
      return [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data];
    }, Buffer.from(image.data).toString("base64"));
    expect(image.mimeType).toBe("image/png"); expect(pixel[0]).toBeGreaterThan(240); expect(pixel[1]).toBeLessThan(100); expect(pixel[2]).toBeLessThan(100);
  };
  try {
    await page.goto(fixture.baseUrl + "/#/tasks/" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click(); await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl); await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Editable image browser"); await page.locator("form.pair-form button[type=submit]").click();
    await composer.waitFor({ state: "visible", timeout: 20_000 }); await closeDrawers(); await attach(); await edit(true);
    await waitFor(() => tray.locator(".annotated-image path").count(), count => count === 2, "the saved vector thumbnail");
    await capture("wide-light-editable-draft"); await persisted(false); await page.reload({ waitUntil: "domcontentloaded" });
    await tray.waitFor({ state: "visible", timeout: 20_000 }); await closeDrawers(); await edit(false);
    expect(await tray.locator(".annotated-image path").count()).toBe(0);
    const originalBytes = await tray.locator("img").evaluate(async image => [...new Uint8Array(await (await fetch((image as HTMLImageElement).src)).arrayBuffer())]);
    expect(Buffer.from(originalBytes)).toEqual(imageBytes);
    await edit(true); await composer.locator(".send-button").click(); await assertSentPixels(sessionId);
    expect(store.listSessions({ includeArchived: true })).toHaveLength(1);

    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const navigation = page.getByRole("button", { name: "Open navigation", exact: true }); if (await navigation.isVisible()) await navigation.click();
    await page.getByRole("button", { name: /^New task/u }).first().click(); await closeDrawers();
    await selectModel("Test Multimodal");
    await attach(); await edit(true); await capture("narrow-dark-editable-new-task"); await persisted(true);
    await page.reload({ waitUntil: "domcontentloaded" }); await tray.waitFor({ state: "visible", timeout: 20_000 }); await closeDrawers();
    await selectModel("Test Text");
    await tray.locator("button.attachment-chip__content").click();
    const readOnlyOverlay = page.getByRole("dialog", { name: "editable.png", exact: true });
    await readOnlyOverlay.waitFor({ state: "visible" }); expect(await readOnlyOverlay.getByRole("button", { name: "Annotate", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape"); await readOnlyOverlay.waitFor({ state: "detached" });
    await selectModel("Test Multimodal");
    await edit(false); await edit(true); await composer.locator(".send-button").click();
    const created = await waitFor(() => store.listSessions({ includeArchived: true }).find(value => value.descriptor.id !== sessionId), value => value !== undefined, "the new task with its original image draft");
    await assertSentPixels(created!.descriptor.id); expect(store.listQueueItems({ sessionId })).toHaveLength(1); expect(errors).toEqual([]);
  } catch (error) { await capture("editable-draft-failure").catch(() => undefined); throw error; }
});
