import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { app, BrowserWindow } from "electron";
import { configureNativeTrackpadInput, installNativeTrackpad } from "../dist/native-trackpad.js";

const profile = await mkdtemp(join(tmpdir(), "joko-trackpad-electron-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("site-per-process");
configureNativeTrackpadInput(app.commandLine, "darwin");
app.on("window-all-closed", () => {});
const [bootstrap, script] = await Promise.all(["isolated-surface.html", "isolated-surface.js"].map(path =>
  readFile(new URL(`../../web/public/${path}`, import.meta.url))));
const server = createServer((request, response) => {
  if (request.url === "/isolated-surface.html") return response.writeHead(200, { "content-type": "text/html" }).end(bootstrap);
  if (request.url === "/isolated-surface.js") return response.writeHead(200, { "content-type": "application/javascript" }).end(script);
  if (request.url === "/") return response.writeHead(200, { "content-type": "text/html" }).end(ownerDocument());
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1");
const bound = once(server, "listening");
void run().catch(error => {
  console.error("Could not retire the trackpad fixture.", error);
  app.exit(1);
});

async function run() {
  let window;
  let status = 1;
  const touchCommands = [];
  let phase = "waiting for Electron and the owned HTTP listener";
  const watchdog = setTimeout(() => {
    console.error(`Trackpad fixture timed out while ${phase}.`);
    app.exit(1);
  }, 45_000);
  try {
    await Promise.all([app.whenReady(), bound]);
    window = new BrowserWindow({ width: 930, height: 520, show: false, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false
    } });
    const contents = window.webContents;
    const sendCommand = contents.debugger.sendCommand.bind(contents.debugger);
    contents.debugger.sendCommand = async (method, params, sessionId) => {
      if (method !== "Input.dispatchTouchEvent") return sendCommand(method, params, sessionId);
      const observed = { type: params.type, points: params.touchPoints.length, childTarget: typeof sessionId === "string", outcome: "pending" };
      touchCommands.push(observed);
      try {
        const reply = await sendCommand(method, params, sessionId);
        observed.outcome = "accepted";
        return reply;
      } catch (error) {
        observed.outcome = error instanceof Error ? error.message : "rejected";
        throw error;
      }
    };
    const zoom = 1.25;
    phase = "loading the trusted owner window";
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    contents.setZoomFactor(zoom);
    window.show(); window.focus(); contents.focus();
    const features = await until(() => contents.executeJavaScript("window.ready?.length === 3 ? window.ready : null"), "three opaque frame documents");
    assert.deepEqual(features.sort(), ["contacts", "ordinary", "touch"]);
    await until(() => window.isFocused() && contents.isFocused(), "focused BrowserWindow and renderer");

    let pointer = { x: 575 * zoom, y: 90 * zoom };
    let callback, started = 0, stopped = 0;
    let owner = true;
    installNativeTrackpad(window, {
      directory: profile, platform: "darwin", isCurrent: () => owner,
      load: () => ({
        start: (_handle, listener) => { callback = listener; return ++started; },
        stop: token => { assert.equal(token, started); stopped++; },
        position: () => pointer
      })
    });
    const pointAt = async (x, y) => {
      pointer = { x: x * zoom, y: y * zoom };
      contents.sendInputEvent({ type: "mouseMove", x: Math.round(pointer.x), y: Math.round(pointer.y) });
      // The native position is controlled here; Electron still owns DOM hit testing and dispatch.
      contents.emit("before-mouse-event", {}, { type: "mouseMove" });
    };
    phase = "checking the frame without an opt-in";
    await pointAt(575, 90);
    await wait(240);
    assert.equal(started, 0, "the marked frame without a document opt-in keeps ordinary input");

    phase = "delivering contacts to the opted-in isolated frame";
    await pointAt(100, 110);
    await until(() => started === 1, "the contact-mode owner under the zoomed pointer");
    sequence(callback);
    const contacts = await until(async () => {
      const frames = await contents.executeJavaScript("window.records.contacts");
      return frames.length === 4 ? frames : undefined;
    }, "contacts emitted by the actual isolated frame");
    assert.deepEqual(contacts.map(frame => [frame.phase, frame.ids]), [
      ["begin", [0, 1]], ["change", [0, 1]], ["change", [1]], ["end", []]
    ]);
    assert.ok(contacts[0].points.every(({ x, y }) => x > 0 && x < 240 && y > 0 && y < 220));

    const retiredCallback = callback;
    retiredCallback(packet("begin", 0, 1));
    await until(async () => (await contents.executeJavaScript("window.records.contacts.length")) === 5, "second contact gesture");
    phase = "canceling the retired focused owner";
    owner = false;
    window.blur();
    await until(async () => (await contents.executeJavaScript("window.records.contacts.at(-1)?.phase")) === "cancel", "bound owner cancellation");
    retiredCallback(packet("change", 1));
    assert.equal(await contents.executeJavaScript("window.records.contacts.length"), 6);
    assert.equal(stopped, 1);

    phase = "delivering trusted Chromium touch events";
    owner = true;
    pointer = { x: 370 * zoom, y: 120 * zoom };
    window.focus(); contents.focus();
    await until(() => window.isFocused() && contents.isFocused(), "restored window focus");
    await wait(60);
    await pointAt(370, 120);
    await until(() => started > 1 && callback !== retiredCallback, "touch-mode owner under the zoomed pointer");
    sequence(callback);
    const touchEvents = await until(async () => {
      const frames = await contents.executeJavaScript("window.records.touch");
      return frames.some(frame => frame.phase === "touchend" && frame.ids.length === 0) ? frames : undefined;
    }, "trusted Chromium touch events including the final lift");
    assert.ok(touchEvents.every(frame => frame.trusted));
    assert.ok(touchEvents.some(frame => frame.phase === "touchstart" && frame.ids.length === 2));
    assert.ok(touchEvents.some(frame => frame.phase === "touchend" && frame.ids.length === 1 && frame.changed.length === 1));
    await until(() => touchCommands.at(-1)?.outcome === "accepted", "the acknowledged final touch frame");
    assert.deepEqual(await contents.executeJavaScript("window.records.ordinary"), []);
    phase = "canceling native Chromium touches before window closure";
    callback(packet("begin", 0, 1));
    await until(() => touchCommands.length === 5 && touchCommands.at(-1)?.outcome === "accepted", "an acknowledged second touch gesture");
    owner = false;
    window.blur();
    await until(async () => (await contents.executeJavaScript("window.records.touch")).some(frame =>
      frame.phase === "touchcancel" && frame.trusted && frame.ids.length === 0), "the trusted touch cancellation");
    await until(() => !contents.debugger.isAttached(), "the retired trackpad debugger");
    console.log(JSON.stringify({ opaqueDocuments: features, contactPhases: contacts.map(frame => frame.phase),
      touchPhases: touchEvents.map(frame => [frame.phase, frame.ids.length]), retiredOwnerCancelled: true, touchCommands }));
    status = 0;
  } catch (error) {
    console.error(`Trackpad fixture failed while ${phase}.`, error);
    if (window && !window.isDestroyed()) {
      const observation = await window.webContents.executeJavaScript("({ready: window.ready, records: window.records})").catch(() => null);
      console.error("Trackpad frame observations", JSON.stringify({ observation, touchCommands }));
    }
  } finally {
    if (window && !window.isDestroyed()) {
      const closed = once(window, "closed");
      window.close();
      await closed;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
    clearTimeout(watchdog);
    if (status === 0) app.quit();
    else app.exit(status);
  }
}

function packet(phase, ...ids) {
  return JSON.stringify({ phase, width: 100, height: 65, touches: ids.map(id => ({ id, x: id ? 0.56 : 0.44, y: phase === "change" ? 0.55 : 0.5 })) });
}

function sequence(send) {
  for (const value of [packet("begin", 0, 1), packet("change", 0, 1), packet("change", 1), packet("end")]) send(value);
}

async function until(resolve, label) {
  const deadline = Date.now() + 7_000;
  while (Date.now() < deadline) {
    const value = await resolve();
    if (value) return value;
    await wait(35);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function ownerDocument() {
  const modes = ["contacts", "touch", "ordinary"];
  const html = Object.fromEntries(modes.map(mode => [mode, frameDocument(mode)]));
  return `<!doctype html><style>body{margin:0} iframe{position:absolute; top:50px; width:240px; height:220px; border:0}</style>
    ${modes.map((mode, index) => `<iframe id="${mode}" style="left:${20 + index * 255}px" sandbox="allow-scripts" data-joko-extension-surface></iframe>`).join("")}
    <script>
    window.ready = []; window.records = { contacts: [], touch: [], ordinary: [] };
    const docs = ${JSON.stringify(html).replaceAll("<", "\\u003c")};
    for (const mode of Object.keys(docs)) {
      const frame = document.getElementById(mode), nonce = "v1-" + String(Object.keys(docs).indexOf(mode)).repeat(32);
      addEventListener("message", event => {
        if (event.source !== frame.contentWindow || event.origin !== "null") return;
        if (event.data?.type === "joko:isolated-ready" && event.data.nonce === nonce)
          frame.contentWindow.postMessage({ type: "joko:isolated-document", nonce, html: docs[mode], policy: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }, "*");
        if (event.data?.type === "test:ready") window.ready.push(mode);
        if (event.data?.type === "test:trackpad") window.records[mode].push(event.data.record);
      });
      frame.src = "/isolated-surface.html#" + nonce;
    }
    </script>`;
}

function frameDocument(mode) {
  return `${mode === "ordinary" ? "" : '<meta name="joko-native-trackpad" content="touch">'}
    <style>html,body,#target{margin:0;width:100%;height:100%;touch-action:none}</style>
    <div id="target" data-joko-trackpad="${mode === "ordinary" ? "contacts" : mode}"></div>
    <script>
    const target = document.getElementById("target");
    const post = record => parent.postMessage({ type: "test:trackpad", record }, "*");
    target.addEventListener("joko-trackpad", event => post({ phase: event.detail.phase,
      ids: event.detail.touches.map(touch => touch.id), points: event.detail.touches }));
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      target.addEventListener(type, event => {
        event.preventDefault();
        post({ phase: type, trusted: event.isTrusted,
          ids: Array.from(event.touches, touch => touch.identifier), changed: Array.from(event.changedTouches, touch => touch.identifier) });
      }, { passive: false });
    }
    parent.postMessage({ type: "test:ready" }, "*");
    </script>`;
}
