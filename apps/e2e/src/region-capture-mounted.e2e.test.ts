import { chromium, type Browser } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { RealPiSystemFixture } from "./real-pi-fixture.js";

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
    draw(0);
    const initial = async () => {
      const blob = await new Promise<Blob | null>(resolve => feed.toBlob(resolve, "image/png"));
      return { png: new Uint8Array(await blob!.arrayBuffer()), width, height };
    };
    const audioTracks: MediaStreamTrack[] = [];
    const evidence = { actions: [] as { action: string; data: number[] }[], modes: [] as string[], audioTracks, draw };
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
