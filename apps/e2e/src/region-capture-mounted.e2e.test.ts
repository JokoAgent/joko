import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { RealPiSystemFixture } from "./real-pi-fixture.js";
import { conditionTimeoutMs } from "./test-deadlines.js";

const executable = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const directory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mounted = executable && directory ? it : it.skip;
let browser: Browser | undefined, fixture: RealPiSystemFixture | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
  await fixture?.close({ removeRoot: true });
  fixture = undefined;
});

mounted("applies mosaic and blur to the PNG sent for copy or attach and restores pixels on undo", { timeout: 90_000 }, async () => {
  fixture = await RealPiSystemFixture.start({ webDirectory: directory! });
  browser = await chromium.launch({ executablePath: executable!, headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const source = document.createElement("canvas");
    const width = source.width = 160, height = source.height = 90;
    const context = source.getContext("2d")!;
    const pixels = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        pixels.data.set([(x * 83 + y * 73) % 256, (x * 73 + y * 37) % 256, (x * 29 + y * 49) % 256, 255], i);
      }
    }
    context.putImageData(pixels, 0, 0);
    const png = () => new Promise<Blob | null>(resolve => source.toBlob(resolve, "image/png"));
    const results: { action: string; language?: string; signature: string; pixels: number[][] }[] = [];
    Object.assign(window, { redactionTestResults: results, jokoRegionCapture: {
      read: async () => ({ png: new Uint8Array(await (await png())!.arrayBuffer()), width, height,
        mode: "edit", locale: "en", dark: false, attachAvailable: true }),
      action: async (action: string, bytes: Uint8Array, language?: string) => {
        const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        context.drawImage(image, 0, 0);
        image.close();
        const samples = [[8, 8], [28, 40], [29, 40], [116, 46], [117, 46]];
        const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
        results.push({ action, language, signature: Array.from(new Uint8Array(digest)).join("-"),
          pixels: samples.map(([x, y]) => Array.from(context.getImageData(x!, y!, 1, 1).data)) });
        return true;
      },
      onShortcutStop: () => () => {}
    } });
  });
  await page.goto(`${fixture.baseUrl}/region-capture.html`);
  const evidence = () => page.evaluate(() => Reflect.get(window, "redactionTestResults") as { action: string; language?: string; signature: string; pixels: number[][] }[]);
  const exportPng = async (name: string, count: number) => {
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(async () => ({ count: (await evidence()).length, notice: await page.locator("#status").textContent() }),
      { timeout: conditionTimeoutMs, message: `${name} must finish exporting its PNG` }).toEqual({ count, notice: "" });
    return (await evidence()).at(-1)!;
  };
  const original = await exportPng("Copy", 1);
  const drag = async (left: number, right: number) => {
    const bounds = (await page.locator("#capture").boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * left, bounds.y + bounds.height * 0.18);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * right, bounds.y + bounds.height * 0.82, { steps: 5 });
    await page.mouse.up();
  };
  await page.getByRole("button", { name: "Mosaic", exact: true }).click();
  await drag(0.125, 0.45);
  const mosaic = await exportPng("Copy", 2);
  expect(mosaic.pixels[0]).toEqual(original.pixels[0]);
  expect(mosaic.pixels[1]).toEqual(mosaic.pixels[2]);
  expect(mosaic.pixels[1]).not.toEqual(original.pixels[1]);
  expect(mosaic.pixels.slice(3)).toEqual(original.pixels.slice(3));
  await page.getByRole("button", { name: "Blur", exact: true }).click();
  await drag(0.55, 0.86);
  const blurred = await exportPng("Attach to new task", 3);
  expect(blurred.action).toBe("attach");
  expect(blurred.pixels.slice(0, 3)).toEqual(mosaic.pixels.slice(0, 3));
  expect(blurred.pixels.slice(3)).not.toEqual(original.pixels.slice(3));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await exportPng("Save", 4)).pixels).toEqual(mosaic.pixels);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await exportPng("Copy", 5)).pixels).toEqual(original.pixels);
  let signature = original.signature, count = 5;
  for (const label of ["Ellipse", "Line", "Arrow", "Highlighter", "Text", "Step number"]) {
    const tool = page.getByRole("button", { name: label, exact: true });
    await tool.click();
    expect(await tool.getAttribute("aria-pressed")).toBe("true");
    if (label === "Text") await page.getByRole("textbox", { name: "Annotation text" }).fill("Check this");
    await drag(0.22, 0.76);
    const edited = await exportPng("Copy", ++count);
    expect(edited.signature).not.toBe(signature);
    signature = edited.signature;
  }
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await exportPng("Copy", ++count)).signature).not.toBe(signature);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await exportPng("Save", ++count)).signature).toBe(signature);
  await page.getByText("Analyze screenshot", { exact: true }).click();
  await page.getByRole("combobox", { name: "Translation language" }).selectOption("de");
  expect(await exportPng("Translate", ++count)).toMatchObject({ action: "translate", language: "de", signature });
  expect(await exportPng("Explain", ++count)).toMatchObject({ action: "explain", signature });
  expect(await exportPng("Extract text", ++count)).toMatchObject({ action: "extract", signature });
});

mounted("renders and encodes a scrolling region, a looping GIF, and a WebM from the packaged capture page", { timeout: 90_000 }, async () => {
  fixture = await RealPiSystemFixture.start({ webDirectory: directory! });
  browser = await chromium.launch({ executablePath: executable!, headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const width = 160, height = 90;
    const selection = { left: 0, top: 0, right: 1, bottom: 1 };
    const feed = document.createElement("canvas");
    feed.width = width; feed.height = height;
    const writer = feed.getContext("2d")!;
    const draw = (origin: number) => {
      const pixels = writer.createImageData(width, height);
      for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
        const byte = (row * width + col) * 4, y = origin + row;
        pixels.data[byte] = (y * (y + 47) + col * 33) % 251;
        pixels.data[byte + 1] = (y * 19 + col * 13) % 253;
        pixels.data[byte + 2] = (y * y * 17 + col * 3) % 255;
        pixels.data[byte + 3] = 255;
      }
      writer.putImageData(pixels, 0, 0);
    };
    let frameOrigin = 0;
    draw(frameOrigin);
    const initial = async () => {
      const blob = await new Promise<Blob | null>(resolve => feed.toBlob(resolve, "image/png"));
      return { png: new Uint8Array(await blob!.arrayBuffer()), width, height };
    };
    const audioTracks: MediaStreamTrack[] = [];
    const evidence = { actions: [] as { action: string; data: number[] }[], modes: [] as string[], audioTracks,
      draw: (origin: number) => { frameOrigin = origin; draw(origin); } };
    const action = async (name: string, bytes: Uint8Array) => {
      evidence.actions.push({ action: name, data: Array.from(bytes.subarray(0, 128)) });
      return true;
    };
    const audio = async () => {
      const synthesizer = new AudioContext();
      const destination = synthesizer.createMediaStreamDestination();
      const tone = synthesizer.createOscillator();
      tone.connect(destination);
      tone.start();
      await synthesizer.resume();
      const track = destination.stream.getAudioTracks()[0]!;
      audioTracks.push(track);
      return track;
    };
    Object.defineProperty(navigator, "mediaDevices", { value: {
      getDisplayMedia: async (options: DisplayMediaStreamOptions) => {
        const stream = feed.captureStream(20);
        const track = stream.getVideoTracks()[0]!;
        const frames = window.setInterval(() => {
          if (track.readyState === "ended") window.clearInterval(frames);
          else draw(frameOrigin);
        }, 50);
        if (options.audio === true) stream.addTrack(await audio());
        return stream;
      },
      getUserMedia: async (options: MediaStreamConstraints) =>
        options.audio === true && options.video === false ? new MediaStream([await audio()]) : new MediaStream()
    } });
    Object.assign(window, { regionTest: evidence, jokoRegionCapture: {
      read: async () => ({ ...await initial(), mode: "screen", locale: "en", dark: false, attachAvailable: true }),
      select: initial, startLive: (mode: string) => { evidence.modes.push(mode); return { selection, width, height, shortcutStops: false }; },
      action, recordingAction: action, showLive: async () => {}, endLive: async () => {}, onShortcutStop: () => () => {}
    } });
  });
  const evidence = () => page.evaluate(() => {
    const state = Reflect.get(window, "regionTest");
    return { actions: state.actions, modes: state.modes, audioStates: (state.audioTracks as MediaStreamTrack[]).map(track => track.readyState) } as {
      actions: Array<{ action: string; data: number[] }>; modes: string[]; audioStates: string[];
    };
  });
  const open = async () => {
    await page.goto(`${fixture!.baseUrl}/region-capture.html`);
    await page.getByRole("button", { name: "Full screen", exact: true }).click();
  };
  await open();
  await page.getByRole("button", { name: "Scrolling capture" }).click();
  await page.getByText("Scroll within the selected area · 90 px").waitFor();
  await page.evaluate(() => Reflect.get(window, "regionTest").draw(24));
  await page.getByText("Scroll within the selected area · 114 px").waitFor();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByRole("button", { name: "Attach to new task", exact: true }).click();
  await expect.poll(async () => (await evidence()).actions.at(-1)?.action).toBe("attach");
  expect(Buffer.from((await evidence()).actions[0]!.data).readUInt32BE(20)).toBe(114);

  await open();
  await page.getByRole("button", { name: "GIF", exact: true }).click();
  await page.getByText("Recording · 1s", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.getByRole("img", { name: "Captured animation" }).waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await evidence()).actions.length).toBe(1);
  const gif = Buffer.from((await evidence()).actions[0]!.data);
  expect(gif.toString("ascii", 0, 6)).toBe("GIF89a");
  expect(gif.readUInt16LE(6)).toBe(160);

  await open();
  await page.getByText("Audio", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Microphone" }).check();
  await page.getByRole("checkbox", { name: "Computer audio" }).check();
  await page.getByRole("button", { name: "Record video", exact: true }).click();
  await page.getByText("Recording · 1s", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  const video = page.locator("#playback");
  await video.waitFor({ state: "visible" });
  await expect.poll(() => video.evaluate(node => {
    const duration = (node as HTMLVideoElement).duration;
    return Number.isFinite(duration) && duration > 0.5;
  })).toBe(true);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect.poll(async () => (await evidence()).actions.length).toBe(1);
  expect(Buffer.from((await evidence()).actions[0]!.data).readUInt32BE(0)).toBe(0x1a45dfa3);
  expect((await evidence()).audioStates).toEqual(["ended", "ended"]);
});
