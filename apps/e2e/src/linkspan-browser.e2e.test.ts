import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from './fixture.js';

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt("loads the production secure backend only after the user selects a pinned path", async () => {
  if (!browserPath || !webDirectory || !isAbsolute(browserPath) || !isAbsolute(webDirectory)) throw new Error("Browser and production Web paths must be absolute.");
  const secureAssets: string[] = [];
  const secureKinds = new Set<string>();
  const chunks = new Set(Object.values(JSON.parse(await readFile(join(webDirectory, '.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>).map(value => '/' + value.file));
  for (const file of await readdir(join(webDirectory, "assets"))) {
    if (!file.endsWith(".js.map") || !chunks.has(`/assets/${file.slice(0, -4)}`)) continue;
    const map = JSON.parse(await readFile(join(webDirectory, "assets", file), "utf8")) as { readonly sources: readonly string[] };
    for (const source of map.sources) { const kind = /@jokoagent\/linkspan-(noise|http)\//u.exec(source)?.[1]; if (kind !== undefined) secureKinds.add(kind); }
    if (map.sources.some(source => /@jokoagent\/linkspan-(?:noise|http)\//u.test(source))) secureAssets.push(`/assets/${file.slice(0, -4)}`);
  }
  expect([...secureKinds].sort()).toEqual(['http', 'noise']);
  expect(secureAssets.length).toBeGreaterThan(0);
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const requested = new Set<string>();
    const origin = "https://trusted-client.invalid";
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { await route.abort(); return; }
      requested.add(url.pathname);
      const file = resolve(webDirectory, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
      const location = relative(webDirectory, file);
      if (location.startsWith("..") || isAbsolute(location)) { await route.abort(); return; }
      try { await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] ?? "application/octet-stream" }); }
      catch { await route.abort(); }
    });
    // This probe observes selected module fetching, without opening any real
    // supplier endpoint or sending a fixture pairing code over the network.
    await page.routeWebSocket("wss://selected-node.invalid/**", socket => socket.close());
    await page.goto(origin);
    await page.locator(".connection-screen").waitFor();
    await page.waitForLoadState("networkidle");
    expect(secureAssets.filter(asset => requested.has(asset))).toEqual([]);
    expect([...requested].some(path => path.endsWith(".wasm"))).toBe(false);
    await page.locator(".connection-tabs button:last-child").click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.locator('input[type="url"]').fill("https://selected-node.invalid");
    await page.locator('.pair-form textarea').fill(`ed25519:${"a".repeat(64)}`);
    await page.locator('input[autocomplete="one-time-code"]').fill("local-fixture-code");
    await page.locator('input[autocomplete="off"]').fill("Selected path device");
    await page.waitForLoadState("networkidle");
    expect(secureAssets.filter(asset => requested.has(asset))).toEqual([]);
    await page.locator(".pair-form__submit").click();
    await expect.poll(() => secureAssets.every(asset => requested.has(asset)), { timeout: 10_000 }).toBe(true);
    expect([...requested].some(path => path.endsWith(".wasm"))).toBe(false);
  } finally { await browser.close(); }
}, 30_000);

mountedIt('pairs the production Web through selected WebRTC and restores the pinned connection without loading other SDKs', async () => {
  if (!browserPath || !webDirectory || !isAbsolute(browserPath) || !isAbsolute(webDirectory)) throw new Error('Browser and production Web paths must be absolute.');
  const evidence = process.env.JOKO_LINKSPAN_BROWSER_EVIDENCE_DIR;
  if (evidence !== undefined && !isAbsolute(evidence)) throw new Error('The browser evidence directory must be absolute.');
  if (evidence !== undefined) await mkdir(evidence, { recursive: true, mode: 0o700 });
  const selectedAssets: string[] = [], unselectedAssets: string[] = [], nodeAssets: string[] = [];
  const chunks = new Set(Object.values(JSON.parse(await readFile(join(webDirectory, '.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>).map(value => '/' + value.file));
  for (const file of await readdir(join(webDirectory, 'assets'))) {
    if (!file.endsWith('.js.map') || !chunks.has(`/assets/${file.slice(0, -4)}`)) continue;
    const map = JSON.parse(await readFile(join(webDirectory, 'assets', file), 'utf8')) as { sources: string[] };
    const path = `/assets/${file.slice(0, -4)}`;
    if (map.sources.some(source => /connection-transport\/(?:src|dist)\/webrtc\.(?:ts|js)$/u.test(source) || /@jokoagent\/linkspan-webrtc\//u.test(source))) selectedAssets.push(path);
    if (map.sources.some(source => /@jokoagent\/linkspan-(?:iroh|tailcat)(?:-[^/]+)?\//u.test(source))) unselectedAssets.push(path);
    if (map.sources.some(source => /@jokoagent\/linkspan-webrtc-node\/|\bwerift\b/u.test(source))) nodeAssets.push(path);
  }
  expect(selectedAssets.length).toBeGreaterThan(0); expect(nodeAssets).toEqual([]);
  const fixture = await OrchestratorE2eFixture.start({ webDirectory, webRtc: true });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const requested = new Set<string>();
  try {
    const page = await browser.newPage({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      const Native = globalThis.RTCPeerConnection;
      const states: { connection: string[]; data: string[]; sent: number[]; received: number[]; path?: string; errors: { detail: string; cause?: number }[] }[] = [];
      (globalThis as unknown as { jokoRtcStates: unknown }).jokoRtcStates = states;
      globalThis.RTCPeerConnection = class extends Native {
        constructor(configuration?: RTCConfiguration) {
          super(configuration);
          const state = { connection: [] as string[], data: [] as string[], sent: [] as number[], received: [] as number[], path: undefined as string | undefined,
            errors: [] as { detail: string; cause?: number }[] }; states.push(state);
          this.addEventListener('connectionstatechange', () => state.connection.push(this.connectionState));
          const create = this.createDataChannel.bind(this);
          this.createDataChannel = (label, options) => {
            const data = create(label, options);
            const send = data.send.bind(data);
            data.send = ((value: Parameters<RTCDataChannel['send']>[0]) => {
              const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : undefined;
              if (bytes !== undefined) {
                state.sent.push(bytes[0]!);
                if (bytes[0] === 0) {
                  try { const target = (JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { target?: unknown }).target;
                    if (typeof target === 'string' && /^\/joko\.v1\.[A-Za-z]+\/[A-Za-z]+$/u.test(target)) state.path = target;
                  } catch { /* Diagnostic metadata never changes protocol handling. */ }
                }
              }
              send(value);
            }) as RTCDataChannel['send'];
            data.addEventListener('message', event => { if (event.data instanceof ArrayBuffer) state.received.push(new Uint8Array(event.data)[0]!); });
            for (const kind of ['open', 'close']) data.addEventListener(kind, () => state.data.push(kind));
            data.addEventListener('error', event => {
              const error = (event as RTCErrorEvent).error;
              state.errors.push({ detail: error.errorDetail, ...(error.sctpCauseCode === null ? {} : { cause: error.sctpCauseCode }) });
            });
            return data;
          };
        }
      };
    });
    page.on('request', request => { requested.add(new URL(request.url()).pathname); });
    const screenshot = async (name: string) => {
      if (evidence !== undefined) await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false, animations: 'disabled', mask: [page.locator('.pair-form input')] });
    };
    await page.goto(fixture.baseUrl); await page.locator('.connection-screen').waitFor(); await page.waitForLoadState('networkidle');
    expect(selectedAssets.some(asset => requested.has(asset))).toBe(false);
    await page.locator('.connection-tabs button:last-child').click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.locator('input[type="url"]').fill(fixture.baseUrl);
    await page.locator('.connection-transport-choice button').filter({ hasText: 'WebRTC' }).click();
    await page.locator('input[autocomplete="one-time-code"]').fill('unused-without-a-pin');
    await page.locator('input[autocomplete="off"]').fill('Production WebRTC');
    await page.locator('.pair-form__submit').click();
    await page.getByRole('alert').filter({ hasText: 'Obtain the endpoint public key' }).waitFor();
    expect(fixture.webRtcSignalingRequests).toBe(0);
    const rtc = page.locator('.connection-transport-choice button').filter({ hasText: 'WebRTC' });
    const keyboardFocusRtc = async () => {
      const https = page.locator('.connection-transport-choice button').first();
      // Theme rendering precedes its preference-save action's final busy reset.
      await expect.poll(async () => await https.isEnabled() && await rtc.isEnabled(), { timeout: 10_000 }).toBe(true);
      await https.focus();
      await page.keyboard.press('Tab');
      expect(await rtc.evaluate(element => document.activeElement === element && element.matches(':focus-visible'))).toBe(true);
    };
    await keyboardFocusRtc();
    const theme = async (target: 'light' | 'dark') => {
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== target) await page.locator('.connection-theme-toggle').click();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);
    };
    await theme('light'); await keyboardFocusRtc(); await screenshot('webrtc-light-focus-and-missing-pin');
    await theme('dark'); await screenshot('webrtc-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('webrtc-dark-narrow');
    await theme('light'); await screenshot('webrtc-light-narrow');
    await page.setViewportSize({ width: 1200, height: 900 });
    const automatic = page.locator('.connection-auto-choice').getByRole('checkbox');
    await automatic.click(); expect(await automatic.getAttribute('aria-checked')).toBe('true');
    fixture.application.connections.closePairingWindow();
    const invitation = fixture.application.connections.issuePairing('Browser WebRTC owner');
    await page.locator('.pair-form textarea').fill(fixture.application.linkspanIdentity!.publicKey);
    expect(await rtc.getAttribute('aria-pressed')).toBe('true');
    await page.locator('input[autocomplete="one-time-code"]').fill(invitation.code);
    await page.locator('.pair-form__submit').click();
    await page.locator('.app').waitFor({ state: 'visible', timeout: 60_000 });
    expect(fixture.webRtcSignalingRequests).toBeGreaterThan(2);
    // The first snapshot can render before the original pairing action commits
    // its final automatic-entry preference transaction.
    await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open('joko-ui');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const read = database.transaction('preferences', 'readonly').objectStore('preferences').get('ui');
        read.onerror = () => { database.close(); reject(read.error); };
        read.onsuccess = () => { database.close(); resolve(read.result?.automaticConnectionTarget?.kind === 'profile'); };
      };
    })), { timeout: 30_000 }).toBe(true);
    const before = fixture.webRtcSignalingRequests;
    await page.reload(); await page.locator('.app').waitFor({ state: 'visible', timeout: 60_000 });
    await expect.poll(() => fixture.webRtcSignalingRequests, { timeout: 30_000 }).toBeGreaterThan(before);
    expect(selectedAssets.every(asset => requested.has(asset))).toBe(true);
    expect(unselectedAssets.filter(asset => requested.has(asset))).toEqual([]);
    expect([...requested].some(path => path.endsWith('.wasm'))).toBe(false);
    const connections = fixture.application.store.listConnections();
    expect(connections).toHaveLength(1);
    fixture.application.connections.revoke(connections[0]!.id);
    await page.reload(); await page.locator('.connection-screen').waitFor({ timeout: 60_000 });
    await screenshot('webrtc-revoked-connection');
    if (evidence !== undefined) await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ transport: 'webrtc', actualSignalingRequests: fixture.webRtcSignalingRequests,
      selectedAssets, selectedRequested: selectedAssets.filter(asset => requested.has(asset)), unselectedRequested: [], nodeAssets, wasmRequested: false,
      responses: fixture.webRtcResponses, ui: ['light', 'dark', 'narrow', 'keyboard-focus', 'missing-pin', 'pairing', 'reload', 'revocation'] }, null, 2) + '\n');
  } catch (error) {
    if (evidence !== undefined) {
      const page = browser.contexts()[0]?.pages()[0];
      await page?.screenshot({ path: join(evidence, 'webrtc-failure.png'), animations: 'disabled', mask: [page.locator('.pair-form input')] }).catch(() => undefined);
      await writeFile(join(evidence, 'failure.json'), JSON.stringify({ transport: 'webrtc', actualSignalingRequests: fixture.webRtcSignalingRequests,
        selectedRequested: selectedAssets.filter(asset => requested.has(asset)), unselectedRequested: unselectedAssets.filter(asset => requested.has(asset)), responses: fixture.webRtcResponses,
        rtc: await page?.evaluate(() => (globalThis as unknown as { jokoRtcStates?: unknown }).jokoRtcStates).catch(() => undefined) }, null, 2) + '\n');
    }
    throw error;
  } finally { await browser.close(); await fixture.close(); }
}, 180_000);
