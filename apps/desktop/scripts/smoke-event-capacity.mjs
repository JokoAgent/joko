import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Manual product boundary: actual built worker, generated Connect HTTP/1 server,
// hidden Documents. This does not replace the packaged Main/full product smoke.
const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const desktopRequire = createRequire(join(desktopRoot, "package.json"));
const webRequire = createRequire(resolve(desktopRoot, "../web/package.json"));
const arguments_ = process.argv.slice(2);
const unpacked = arguments_.includes("--unpacked");
const resultIndex = arguments_.indexOf("--result");
if (arguments_.some((value, index) => value !== "--unpacked" && value !== "--result" && !(resultIndex >= 0 && index === resultIndex + 1))
  || resultIndex >= 0 && !arguments_[resultIndex + 1]) throw new Error("Use smoke-event-capacity.mjs [--unpacked] [--result path].");
const resultPath = resolve(resultIndex < 0 ? join(repositoryRoot, ".runtime/validation/event-capacity-result.json") : arguments_[resultIndex + 1]);
const privateRoot = await mkdtemp(join(tmpdir(), "joko-event-capacity-"));
const webRoot = unpacked ? join(desktopRoot, "release/win-unpacked/resources/app/dist/web") : join(desktopRoot, "dist/web");
const contractsEntry = unpacked
  ? join(desktopRoot, "release/win-unpacked/resources/orchestrator-runtime/node_modules/@joko/contracts/dist/index.js")
  : join(repositoryRoot, "packages/contracts/dist/index.js");
const runtimeExecutable = desktopRequire("electron");
const startedAt = new Date().toISOString();
const output = { format: 1, boundary: "built SharedWorker/generated HTTP1 multi-Document capacity", unpacked, startedAt, privateRoot,
  hiddenOnly: true, accountDatabase: false, agentTurn: false, phases: [], cleanup: {} };
let child, server, watchdog;
const sockets = new Set();
const keys = { A: randomUUID(), B: randomUUID() };
const groups = Object.fromEntries(["A", "B"].map(label => [label, { sequence: 0, history: [], streams: new Set(), opened: 0, unary: 0 }]));
const httpVersions = new Set();
function check(value, name) { if (!value) throw new Error(name.startsWith("CAPACITY_") ? name : `CAPACITY_${name}`); }
const cursorFor = (label, sequence) => ({ opaqueToken: `capacity-${label}-${sequence}`, generation: 1n,
  sequence: BigInt(sequence), issuedAt: { seconds: 1n, nanos: 0 } });
async function digest(path) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function identity(path) { const stat = await lstat(path); check(stat.isFile() && !stat.isSymbolicLink(), "REGULAR_ASSET"); return { path: relative(repositoryRoot, path).split(sep).join("/"), bytes: stat.size, sha256: await digest(path) }; }
async function javascriptAssets(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    check(!entry.isSymbolicLink(), "ASSET_LINK");
    if (entry.isDirectory()) result.push(...await javascriptAssets(join(path, entry.name)));
    else if (entry.isFile() && entry.name.endsWith(".js")) result.push(await identity(join(path, entry.name)));
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function stats() { return { activeA: groups.A.streams.size, activeB: groups.B.streams.size, openedA: groups.A.opened,
  openedB: groups.B.opened, unaryA: groups.A.unary, unaryB: groups.B.unary, httpVersions: [...httpVersions] }; }
function closeStream(stream) { stream.closed = true; stream.wake?.(); }

try {
  check(process.platform === "win32", "WINDOWS_ARTIFACT_BOUNDARY");
  const workerNames = (await readdir(join(webRoot, "assets"))).filter(name => /^shared-owner-events\.worker-[^/]+\.js$/u.test(name));
  check(workerNames.length === 1, "UNIQUE_WORKER_ASSET");
  const workerPath = join(webRoot, "assets", workerNames[0]);
  output.script = await identity(scriptPath);
  output.runtime = await identity(runtimeExecutable);
  output.worker = await identity(workerPath);
  output.webJavaScript = await javascriptAssets(join(webRoot, "assets"));
  if (unpacked) output.packagedExecutable = await identity(join(desktopRoot, "release/win-unpacked/Joko.exe"));
  const { connectNodeAdapter } = await import(pathToFileURL(desktopRequire.resolve("@connectrpc/connect-node")).href);
  const { ConnectError, Code } = await import(pathToFileURL(desktopRequire.resolve("@connectrpc/connect")).href);
  const contract = await import(pathToFileURL(contractsEntry).href);
  const labelFor = context => {
    const header = context.requestHeader.get("authorization");
    const label = ["A", "B"].find(candidate => header === `Bearer ${keys[candidate]}`);
    if (!label) throw new ConnectError("The fixture connection is unavailable.", Code.Unauthenticated);
    return label;
  };
  const adapter = connectNodeAdapter({ routes(router) {
    router.service(contract.EventService, {
      getSnapshot(_request, context) {
        const label = labelFor(context), group = groups[label]; group.unary += 1;
        return { snapshot: { snapshotId: `capacity-${label}`, generation: 1n, resumeCursor: cursorFor(label, group.sequence) } };
      },
      async *streamEvents(request, context) {
        const label = labelFor(context), group = groups[label];
        const cursor = request.afterCursor;
        if (cursor?.generation !== 1n || cursor.sequence < 0n || cursor.sequence > BigInt(group.sequence)
          || cursor.opaqueToken !== `capacity-${label}-${cursor.sequence}` || cursor.issuedAt?.seconds !== 1n || cursor.issuedAt.nanos !== 0) throw new ConnectError("The fixture cursor is invalid.", Code.FailedPrecondition);
        const stream = { queue: [], wake: undefined, closed: false };
        group.streams.add(stream); group.opened += 1;
        const abort = () => closeStream(stream); context.signal.addEventListener("abort", abort, { once: true });
        let observed = Number(cursor.sequence);
        try {
          for (const event of group.history) if (Number(event.cursor.sequence) > observed) { observed = Number(event.cursor.sequence); yield { event }; }
          while (!stream.closed && !context.signal.aborted) {
            if (stream.queue.length === 0) await new Promise(accept => { stream.wake = accept; if (stream.closed || stream.queue.length > 0) accept(); });
            stream.wake = undefined;
            while (stream.queue.length > 0) {
              const event = stream.queue.shift();
              if (Number(event.cursor.sequence) > observed) { observed = Number(event.cursor.sequence); yield { event }; }
            }
          }
        } finally { group.streams.delete(stream); context.signal.removeEventListener("abort", abort); closeStream(stream); }
      }
    });
  } });
  server = createServer((request, response) => {
    httpVersions.add(request.httpVersion);
    response.setHeader("access-control-allow-origin", "joko://app");
    response.setHeader("access-control-allow-methods", "POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization,content-type,connect-protocol-version,connect-timeout-ms,x-joko-client-version");
    response.setHeader("access-control-expose-headers", "connect-content-encoding,connect-accept-encoding,grpc-status,grpc-message");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    void Promise.resolve(adapter(request, response)).catch(() => response.destroy());
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", accept); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of ["home", "roaming", "local", "temp", "codex", "claude", "profile", "page"]) await mkdir(join(privateRoot, name), { mode: 0o700 });
  await mkdir(join(privateRoot, "home/Documents"), { mode: 0o700 });
  const pageEntry = join(privateRoot, "page/probe.js");
  const browserImports = [
    `import {createClient} from ${JSON.stringify(webRequire.resolve("@connectrpc/connect"))};`,
    `import {createConnectTransport} from ${JSON.stringify(webRequire.resolve("@connectrpc/connect-web"))};`,
    `import {fromBinary} from ${JSON.stringify(webRequire.resolve("@bufbuild/protobuf"))};`,
    `import {EventService,EventSchema} from ${JSON.stringify(contractsEntry)};`
  ];
  await writeFile(pageEntry, `${browserImports.join("\n")}\n(${browserFixture.toString()})();\n`, { mode: 0o600 });
  const { build } = await import(pathToFileURL(webRequire.resolve("vite")).href);
  await build({ configFile: false, root: join(privateRoot, "page"), logLevel: "silent", build: { outDir: join(privateRoot, "page/dist"), emptyOutDir: true,
    sourcemap: false, minify: false, lib: { entry: pageEntry, formats: ["es"], fileName: () => "probe.js" } } });
  await writeFile(join(privateRoot, "page/index.html"), '<!doctype html><meta charset="utf-8"><title>Event capacity fixture</title><script type="module" src="/fixture/probe.js"></script>', { mode: 0o600 });
  const config = { privateRoot, webRoot, origin, workerUrl: `joko://app/assets/${workerNames[0]}` };
  await writeFile(join(privateRoot, "config.json"), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(privateRoot, "main.cjs"), `(${electronFixture.toString()})();\n`, { mode: 0o600 });
  await writeFile(join(privateRoot, "package.json"), JSON.stringify({ name: "joko-event-capacity-fixture", main: "main.cjs" }), { mode: 0o600 });
  const environment = {};
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "Path", "PATH", "PATHEXT", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) if (process.env[name] !== undefined) environment[name] = process.env[name];
  Object.assign(environment, { HOME: join(privateRoot, "home"), USERPROFILE: join(privateRoot, "home"), APPDATA: join(privateRoot, "roaming"),
    LOCALAPPDATA: join(privateRoot, "local"), TEMP: join(privateRoot, "temp"), TMP: join(privateRoot, "temp"), TMPDIR: join(privateRoot, "temp"),
    CODEX_HOME: join(privateRoot, "codex"), CLAUDE_CONFIG_DIR: join(privateRoot, "claude") });
  child = spawn(runtimeExecutable, [privateRoot], { cwd: privateRoot, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  output.stderrBytes = 0;
  child.stderr.on("data", value => { output.stderrBytes += value.length; });
  child.stdout.resume();
  child.on("message", message => {
    if (message?.type === "phase" && typeof message.name === "string") { output.phases.push({ name: message.name, at: new Date().toISOString(), ...stats() }); console.log(JSON.stringify({ phase: message.name })); }
    if (message?.type === "outcome") output.renderer = message.value;
    if (message?.type !== "request") return;
    let value;
    if (message.action === "stats") value = stats();
    else if (message.action === "publish" && ["A", "B"].includes(message.label)) {
      const label = message.label, group = groups[label]; group.sequence += 1;
      const event = { eventId: `capacity-${label}-${group.sequence}`, cursor: cursorFor(label, group.sequence),
        identity: { sessionId: `capacity-${label}`, generation: 1n, sequence: BigInt(group.sequence) } };
      group.history.push(event);
      for (const stream of group.streams) { stream.queue.push(event); stream.wake?.(); }
      value = { sequence: group.sequence };
    } else return;
    if (child.connected) child.send({ type: "response", id: message.id, value });
  });
  child.send({ type: "configure", keys });
  const exit = await new Promise((accept, reject) => {
    watchdog = setTimeout(() => { child.kill(); reject(new Error("CAPACITY_OVERALL_TIMEOUT")); }, 240_000);
    child.once("error", () => reject(new Error("CAPACITY_ELECTRON_SPAWN")));
    child.once("exit", (code, signal) => accept({ code, signal }));
  });
  output.exit = exit;
  output.server = stats();
  check(exit.code === 0 && exit.signal === null && output.renderer?.passed === true, output.renderer?.failedCheck ?? "ELECTRON_OUTCOME");
  check(output.renderer.versions.electron === desktopRequire("electron/package.json").version, "ELECTRON_VERSION");
  check(httpVersions.size === 1 && httpVersions.has("1.1"), "ACTUAL_HTTP1");
  check(output.worker.sha256 === await digest(workerPath), "WORKER_CHANGED_DURING_RUN");
  output.passed = true;
} catch (error) {
  output.passed = false;
  output.failedCheck = /^CAPACITY_[A-Z0-9_]+$/u.test(error.message ?? "") ? error.message : "CAPACITY_UNEXPECTED_ERROR";
  output.errorType = error.name;
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const group of Object.values(groups)) for (const stream of group.streams) closeStream(stream);
  if (child && child.exitCode === null && child.signalCode === null) {
    try { if (child.connected) child.send({ type: "stop" }); } catch { /* The child can already be retiring. */ }
    await Promise.race([new Promise(accept => child.once("exit", accept)), new Promise(accept => setTimeout(accept, 5000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(accept => child.once("exit", accept)), new Promise(accept => setTimeout(accept, 5000))]);
    }
  }
  output.cleanup.electronExited = child === undefined || child.exitCode !== null || child.signalCode !== null;
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise(accept => server.close(accept));
  output.cleanup.serverClosed = server === undefined || !server.listening;
  output.cleanup.activeStreams = groups.A.streams.size + groups.B.streams.size;
  if (!output.cleanup.electronExited || !output.cleanup.serverClosed || output.cleanup.activeStreams !== 0) { output.passed = false; process.exitCode = 1; }
  output.finishedAt = new Date().toISOString();
  await mkdir(dirname(resultPath), { recursive: true });
  // Remove only this invocation's verified external fixture; failure is retained.
  output.cleanup.privateDirectoryRemoved = false;
  if (output.passed && dirname(privateRoot) === resolve(tmpdir()) && (await realpath(privateRoot)) === privateRoot
    && !relative(tmpdir(), privateRoot).startsWith(`..${sep}`)) {
    try { await rm(privateRoot, { recursive: true }); output.cleanup.privateDirectoryRemoved = true; } catch { /* Retain an externally locked private fixture. */ }
  }
  await writeFile(resultPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ resultPath, passed: output.passed, failedCheck: output.failedCheck, cleanup: output.cleanup }));
}

function browserFixture() {
  let client, key = "", port, ready = false, cursor = 0n, received = [], errors = [], reads = 0, owner, closed = true;
  const scope = { kind: { case: "owner", value: {} } };
  const retire = () => { closed = true; key = ""; if (port) { port.postMessage({ type: "close" }); port.close(); port = undefined; } };
  addEventListener("pagehide", retire);
  window.capacityProbe = {
    async start(value) {
      retire(); key = value.authKey; owner = value.owner; closed = false; ready = false; errors = []; received = []; reads = 0;
      client = createClient(EventService, createConnectTransport({ baseUrl: owner.origin, useBinaryFormat: true,
        interceptors: [next => request => { request.header.set("authorization", `Bearer ${key}`); return next(request); }] }));
      const snapshot = await client.getSnapshot({ scope }, { signal: AbortSignal.timeout(5000) }); reads += 1;
      const after = value.after === undefined ? snapshot.snapshot.resumeCursor
        : { ...snapshot.snapshot.resumeCursor, sequence: BigInt(value.after), opaqueToken: `capacity-${value.label}-${value.after}` };
      cursor = after.sequence;
      const worker = new SharedWorker(value.workerUrl, { name: "joko-owner-events-v1", type: "module" });
      port = worker.port;
      worker.onerror = () => errors.push("worker");
      port.onmessage = ({ data }) => {
        if (closed) return;
        if (data.type === "ready") { ready = true; return; }
        if (data.type === "accepted") return;
        if (data.type === "ping") { port.postMessage({ type: "pong" }); return; }
        if (data.type === "error") { errors.push(`code:${Number(data.code)}`); return; }
        if (data.type !== "event" || !(data.bytes instanceof ArrayBuffer)) { errors.push("message"); return; }
        const event = fromBinary(EventSchema, new Uint8Array(data.bytes));
        if (event.identity?.sessionId !== `capacity-${value.label}`) errors.push("auth-scope");
        if (event.cursor?.generation !== 1n || event.cursor.sequence !== cursor + 1n) errors.push("cursor");
        if (event.cursor?.opaqueToken !== `capacity-${value.label}-${event.cursor?.sequence}`
          || event.cursor.issuedAt?.seconds !== 1n || event.cursor.issuedAt.nanos !== 0) errors.push("cursor-metadata");
        cursor = event.cursor.sequence; received.push(String(cursor));
        port.postMessage({ type: "ack", serial: data.serial });
      };
      port.onmessageerror = () => errors.push("message-read"); port.start();
      port.postMessage({ type: "subscribe", owner, authKey: key, cursor: after });
    },
    async read() {
      if (closed) throw new Error("CAPACITY_RETIRED_READ");
      const value = await client.getSnapshot({ scope }, { signal: AbortSignal.timeout(5000) }); reads += 1;
      return { generation: String(value.snapshot.generation), sequence: String(value.snapshot.resumeCursor.sequence) };
    },
    view() { return { ready, cursor: String(cursor), received, errors, reads }; }, retire
  };
}

function electronFixture() {
  const { app, BrowserWindow, protocol } = require("electron");
  const { readFile } = require("node:fs/promises");
  const { join, resolve, relative, isAbsolute } = require("node:path");
  const root = app.getAppPath();
  app.setPath("userData", join(root, "profile"));
  app.on("window-all-closed", () => {});
  protocol.registerSchemesAsPrivileged([{ scheme: "joko", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true } }]);
  const windows = new Set(), pending = new Map(); let nextRequest = 0, stopped = false, phase = "starting", maxLiveDocuments = 0;
  const send = value => { if (process.connected) process.send(value); };
  const request = (action, label) => new Promise(accept => { const id = ++nextRequest; pending.set(id, accept); send({ type: "request", id, action, label }); });
  const check = (value, name) => { if (!value) throw new Error(`CAPACITY_${name}`); };
  const pause = delay => new Promise(accept => setTimeout(accept, delay));
  const wait = async (probe, name, timeout = 15000) => { const until = Date.now() + timeout; while (!stopped && Date.now() < until) { if (await probe()) return; await pause(50); } check(false, name); };
  const evaluate = (window, code) => window.webContents.executeJavaScript(code, false);
  const view = window => evaluate(window, "window.capacityProbe.view()");
  const enter = name => { phase = name; send({ type: "phase", name }); };
  process.on("message", message => {
    if (message?.type === "response") { pending.get(message.id)?.(message.value); pending.delete(message.id); }
    if (message?.type === "stop") { stopped = true; for (const window of windows) if (!window.isDestroyed()) window.destroy(); app.exit(1); }
  });
  process.once("disconnect", () => { stopped = true; for (const window of windows) if (!window.isDestroyed()) window.destroy(); app.exit(1); });
  const configuration = new Promise(accept => { const listener = message => { if (message?.type === "configure") { process.removeListener("message", listener); accept(message); } }; process.on("message", listener); });
  void (async () => {
    let outcome;
    try {
      const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
      const credentials = await configuration;
      await app.whenReady();
      protocol.handle("joko", async request_ => {
        const url = new URL(request_.url);
        if (url.host !== "app" || url.search || url.hash || !["GET", "HEAD"].includes(request_.method)) return new Response(null, { status: 404 });
        let file, contentType;
        if (url.pathname === "/index.html") { file = join(root, "page/index.html"); contentType = "text/html"; }
        else if (url.pathname === "/fixture/probe.js") { file = join(root, "page/dist/probe.js"); contentType = "text/javascript"; }
        else if (url.pathname.startsWith("/assets/") && !url.pathname.includes("\\")) {
          file = resolve(config.webRoot, `.${decodeURIComponent(url.pathname)}`);
          const path = relative(config.webRoot, file);
          if (path.startsWith("..") || isAbsolute(path) || !file.endsWith(".js")) return new Response(null, { status: 404 });
          contentType = "text/javascript";
        } else return new Response(null, { status: 404 });
        const policy = `default-src 'none'; script-src 'self'; worker-src 'self'; connect-src ${config.origin}; base-uri 'none'; object-src 'none'`;
        return new Response(request_.method === "HEAD" ? null : await readFile(file), { headers: { "content-type": contentType, "content-security-policy": policy, "cache-control": "no-store" } });
      });
      const open = async (name, label = "A", after) => {
        const window = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        windows.add(window); window.on("closed", () => windows.delete(window));
        maxLiveDocuments = Math.max(maxLiveDocuments, [...windows].filter(candidate => !candidate.isDestroyed()).length);
        check(maxLiveDocuments <= 33, "FIXTURE_DOCUMENT_BOUND");
        await window.loadURL("joko://app/index.html");
        await wait(() => evaluate(window, "Boolean(window.capacityProbe)"), "PAGE_MODULE");
        await initialize(window, name, label, after); return window;
      };
      const initialize = async (window, name, label, after) => {
        const value = { owner: { profileId: `capacity-profile-${label}`, serverId: "capacity-server", deviceId: `capacity-device-${label}`, origin: config.origin },
          authKey: credentials.keys[label], label, workerUrl: config.workerUrl, ...(after === undefined ? {} : { after }) };
        await evaluate(window, `window.capacityProbe.start(${JSON.stringify(value)})`);
        await wait(async () => (await view(window)).ready, `SUBSCRIBER_${name.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`);
      };
      const publish = async (live, label = "A") => {
        const { sequence } = await request("publish", label);
        await wait(async () => (await Promise.all(live.map(view))).every(value => value.cursor === String(sequence) && value.errors.length === 0), "EVENT_OWN_CURSORS");
        const replies = await Promise.all(live.map(window => evaluate(window, "window.capacityProbe.read()")));
        check(replies.every(value => value.generation === "1" && value.sequence === String(sequence)), "UNARY_PROGRESS"); return sequence;
      };
      enter("main_and_32_tasks");
      const live = [];
      for (let index = 0; index < 33; index += 1) live.push(await open(index === 0 ? "main" : `task-${index}`));
      await wait(async () => (await request("stats")).activeA === 1, "ONE_SHARED_STREAM");
      for (let round = 0; round < 4; round += 1) await publish(live);
      check((await request("stats")).openedA === 1, "NO_PER_DOCUMENT_STREAM");
      check(live.every(window => !window.isVisible()), "HIDDEN_DOCUMENTS");
      enter("late_independent_cursor");
      const current = await publish(live);
      const replaced = live.pop(); await evaluate(replaced, "window.capacityProbe.retire()"); replaced.destroy();
      const late = await open("late", "A", current - 2);
      await wait(async () => { const value = await view(late); return value.cursor === String(current) && value.received.join(",") === `${current - 1},${current}` && value.errors.length === 0; }, "LATE_CURSOR_REPLAY");
      live.push(late);
      enter("independent_auth");
      const other = live.pop(); await initialize(other, "independent", "B");
      await wait(async () => { const value = await request("stats"); return value.activeA === 1 && value.activeB === 1; }, "AUTH_STREAM_ISOLATION");
      await publish([other], "B"); await publish(live);
      await evaluate(other, "window.capacityProbe.retire()");
      await wait(async () => (await request("stats")).activeB === 0, "AUTH_STREAM_RETIRED");
      await initialize(other, "auth-restored", "A"); live.push(other);
      enter("reload_crash_and_single_close");
      const reloaded = live[2];
      await reloaded.loadURL("joko://app/index.html");
      await wait(() => evaluate(reloaded, "Boolean(window.capacityProbe)"), "RELOAD_PAGE");
      await initialize(reloaded, "reloaded", "A"); await publish(live);
      const crashed = live[3], survivors = live.filter(window => window !== crashed);
      const crashedEvent = new Promise(accept => crashed.webContents.once("render-process-gone", accept));
      crashed.webContents.forcefullyCrashRenderer(); await crashedEvent; crashed.destroy();
      await publish(survivors);
      const closed = survivors.pop(); await evaluate(closed, "window.capacityProbe.retire()"); closed.destroy();
      await publish(survivors);
      check((await request("stats")).openedA === 1, "SURVIVORS_KEEP_STREAM");
      enter("last_close_actual_stream_end");
      for (const window of survivors) { await evaluate(window, "window.capacityProbe.retire()"); window.destroy(); }
      const closeStarted = Date.now();
      // A renderer crash may leave only the production worker's 120s orphan lease.
      await wait(async () => (await request("stats")).activeA === 0, "LAST_SUBSCRIBER_RELEASE", 155000);
      const lastCloseStreamEndMs = Date.now() - closeStarted;
      enter("reopen_fresh_snapshot");
      const reopened = await open("reopened"); await publish([reopened]);
      check((await request("stats")).openedA === 2, "REOPEN_NEW_STREAM");
      await evaluate(reopened, "window.capacityProbe.retire()"); reopened.destroy();
      await wait(async () => (await request("stats")).activeA === 0, "REOPEN_STREAM_RETIRED");
      outcome = { passed: true, documents: 33, maxLiveDocuments, lastCloseStreamEndMs, versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node } };
    } catch (error) { outcome = { passed: false, phase, failedCheck: /^CAPACITY_[A-Z0-9_]+$/u.test(error.message ?? "") ? error.message : "CAPACITY_RENDERER_ERROR", errorType: error.name }; }
    finally { for (const window of windows) if (!window.isDestroyed()) window.destroy(); send({ type: "outcome", value: outcome }); app.exit(outcome?.passed ? 0 : 1); }
  })();
}
