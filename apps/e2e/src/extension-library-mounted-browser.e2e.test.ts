import { resolve } from "node:path";

import { create } from "@bufbuild/protobuf";
import { ExtensionLibraryCallSchema, type ExtensionCatalogEntry, type ExtensionLibraryCall } from "@joko/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionLibrarySystemFixture,
  installLibraryExtension
} from "./extension-library-system-fixture.js";
import { waitFor } from "./fixture.js";
import type { PairedClient } from "./connect-clients.js";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Extension Library main-view bridge", () => {
  let fixture: ExtensionLibrarySystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  mountedIt("runs the injected file and SQLite bridge in wide and narrow Chromium viewports", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = resolve(requiredEnvironment("JOKO_MOUNTED_WEB_DIR"));
    fixture = await ExtensionLibrarySystemFixture.start({ webDirectory });
    const manager = await fixture.pair("Mounted Library manager");
    const extension = await installLibraryExtension(fixture, manager);
    await writeLibraryVideo(manager, extension);

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Library Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/extensions/${encodeURIComponent(extension.extensionId)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Library Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const frameElement = page.locator("iframe.extension-main-view-page__frame");
    await frameElement.waitFor({ state: "visible", timeout: 20_000 });
    // The disconnected landing page probes its default local origin before the
    // explicit node pairing completes. From this point onward the mounted
    // product and its Extension surface must remain error-free.
    browserErrors.splice(0);
    const frame = page.frameLocator("iframe.extension-main-view-page__frame");
    const result = frame.locator("#bridge-result");
    const expectedResult = `bridge-ready:mounted-bridge:chromium:${extension.extensionId}`;
    await waitFor(() => result.textContent(), (value) => value === expectedResult, "the mounted Library bridge", 20_000);
    expect(await frame.locator("html").getAttribute("data-bridge-ready")).toBe("true");
    expect(await frame.locator("html").evaluate(() => ({ origin: window.origin, secure: window.isSecureContext })))
      .toEqual({ origin: "null", secure: true });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await result.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await frameElement.waitFor({ state: "visible" });
    const narrowRead = await result.evaluate(async () => {
      const library = (window as unknown as Window & {
        readonly joko: {
          readonly library: (operation: unknown) => Promise<Record<string, unknown>>;
        };
      }).joko.library;
      const response = await library({ kind: "read", path: "bridge/result.txt" });
      if (response["ok"] !== true || response["kind"] !== "read" || !(response["content"] instanceof Uint8Array)) {
        return `bridge-error:${String(response["errorCode"] ?? "invalid-response")}`;
      }
      return new TextDecoder().decode(response["content"]);
    });
    expect(narrowRead).toBe("mounted-bridge");
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await result.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);

    const video = await result.evaluate(async () => {
      const element = document.createElement("video");
      element.preload = "none";
      document.body.append(element);
      const blob = await new Promise<Blob>((resolveBlob, reject) => {
        const original = URL.createObjectURL;
        const cleanup = () => { clearTimeout(timer); URL.createObjectURL = original; element.removeEventListener("error", fail); };
        const fail = () => { cleanup(); reject(new Error("The Library video did not load.")); };
        const timer = setTimeout(fail, 20_000);
        element.addEventListener("error", fail, { once: true });
        URL.createObjectURL = value => {
          const url = original.call(URL, value);
          if (value instanceof Blob && value.type === "video/mp4") { cleanup(); resolveBlob(value); }
          return url;
        };
        element.src = "library/clip.mp4";
      });
      const marker = new Uint8Array(await blob.slice(20 * 1024 * 1024, 20 * 1024 * 1024 + 1).arrayBuffer())[0];
      const waitForMedia = (event: string, start: () => void) => new Promise<void>((resolveEvent, reject) => {
        const timer = setTimeout(() => reject(new Error(`Video ${event} timed out.`)), 10_000);
        element.addEventListener(event, () => { clearTimeout(timer); resolveEvent(); }, { once: true });
        start();
      });
      const supported = element.canPlayType('video/mp4; codecs="avc1.42C00A"') !== "";
      if (supported) {
        element.preload = "metadata";
        await waitForMedia("loadedmetadata", () => element.load());
        await waitForMedia("seeked", () => { element.currentTime = 1.25; });
      }
      return { bytes: blob.size, mime: blob.type, marker, supported, time: element.currentTime };
    });
    expect(video).toMatchObject({ bytes: 24 * 1024 * 1024, mime: "video/mp4", marker: 0x53 });
    if (video.supported) expect(video.time).toBeCloseTo(1.25);
    console.info(`Mounted Library video ${video.supported ? "decoded and sought" : "assembled without a supported decoder"}.`);
    expect(browserErrors.filter(error => error.startsWith("pageerror:"))).toEqual([]);
  }, 90_000);
});

async function writeLibraryVideo(manager: PairedClient, extension: ExtensionCatalogEntry): Promise<void> {
  const clip = Buffer.alloc(24 * 1024 * 1024);
  SYNTHETIC_VIDEO.copy(clip);
  // Extend the fixture with a legal top-level free box without changing the video samples.
  clip.writeUInt32BE(clip.length - SYNTHETIC_VIDEO.length, SYNTHETIC_VIDEO.length);
  clip.write("free", SYNTHETIC_VIDEO.length + 4, "ascii");
  clip[20 * 1024 * 1024] = 0x53;
  const api = manager.clients.extension;
  const owner = { extensionId: extension.extensionId, expectedRevision: extension.revision };
  const { surface } = await api.openExtensionMainView(owner);
  if (!surface) throw new Error("The video fixture did not receive a main view.");
  try {
    const { library } = await api.openExtensionLibrary({ ...owner, surfaceId: surface.surfaceId });
    if (!library) throw new Error("The video fixture did not receive a Library.");
    const call = async (operation: ExtensionLibraryCall["operation"]) => (await api.callExtensionLibrary({
      sessionId: library.sessionId, call: create(ExtensionLibraryCallSchema, { operation })
    })).result?.result;
    const start = await call({ case: "writeBegin", value: { path: "clip.mp4", totalBytes: BigInt(clip.length), ifNotExists: true } });
    if (start?.case !== "stream") throw new Error("The video fixture did not receive a write stream.");
    const { streamId } = start.value;
    const chunkBytes = 4 * 1024 * 1024;
    for (let offset = 0; offset < clip.length; offset += chunkBytes) {
      await call({ case: "writeChunk", value: { streamId, sequence: offset / chunkBytes, content: clip.subarray(offset, offset + chunkBytes) } });
    }
    expect(await call({ case: "writeCommit", value: { streamId } })).toMatchObject({ case: "write", value: { bytes: BigInt(clip.length) } });
  } finally {
    await api.closeExtensionMainView({ surfaceId: surface.surfaceId });
  }
}

// A synthetic two-second 16 × 16 black H.264 clip, with no audio.
const SYNTHETIC_VIDEO = Buffer.from(`
AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMQbW9vdgAAAGxtdmhkAAAAAAAAAAAA
AAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA
AABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAl90cmFrAAAAXHRraGQAAAADAAAA
AAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA
AAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAA
AAHXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZp
ZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABgm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAA
ACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUJzdGJsAAAAtnN0c2QAAAAAAAAA
AQAAAKZhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABDExhdmMg
bGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALGF2Y0MBQsAK/+EAFWdCwAraewEQAAAD
ABAAAAMAQPEiagEABGjOD8gAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAAvAAAAAAAAAAY
c3R0cwAAAAAAAAABAAAABAAAIAAAAAAYc3RzcwAAAAAAAAACAAAAAQAAAAMAAAAcc3RzYwAAAAAA
AAABAAAAAQAAAAQAAAABAAAAJHN0c3oAAAAAAAAAAAAAAAQAAAAOAAAACQAAAA8AAAAJAAAAFHN0
Y28AAAAAAAAAAQAAA0AAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBw
bAAAAAAAAAAAAAAAAAhpbHN0AAAACGZyZWUAAAA3bWRhdAAAAApliIQ6JigACQLgAAAABUGaIBKl
AAAAC2WIggMomKAALC+AAAAABUGaIBKl
`, "base64");

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function nonBlankEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(name: string): string {
  const value = nonBlankEnvironment(name);
  if (value === undefined) throw new Error(`${name} is required for the mounted Extension Library E3.`);
  return value;
}
