import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Builds only the controlled WinForms smoke target, without installing SDKs or packages. */
export async function buildNativeFrontmostSmokeTarget(directory) {
  if (process.platform !== "win32" || typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error("Native foreground smoke target requires an absolute Windows output directory.");
  }
  const compiler = resolve(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!existsSync(compiler)) throw new Error("Native foreground smoke requires the installed .NET Framework compiler.");
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../test/support/windows-frontmost-target.cs");
  const executable = resolve(directory, "joko-windows-frontmost-smoke-target.exe");
  await new Promise((accept, reject) => {
    execFile(compiler, [
      "/nologo", "/target:exe", "/optimize+", "/debug-", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll",
      `/out:${executable}`, source
    ], { timeout: 15_000, windowsHide: true, encoding: "utf8", maxBuffer: 32 * 1024 }, (error) => {
      if (error === null) accept();
      else reject(new Error("The controlled native foreground smoke target could not be compiled."));
    });
  });
  return executable;
}

/** Produces a self-contained Electron run-as-Node script using the actual product sampler and runner. */
export function nativeSystemFrontmostElectronSmokeSource({ desktopModulePath, nativeDirectory, targetExecutable }) {
  for (const path of [desktopModulePath, nativeDirectory, targetExecutable]) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new TypeError("Native foreground smoke paths must be absolute.");
  }
  return [
    'import assert from "node:assert/strict";',
    'import { spawn } from "node:child_process";',
    'import { realpathSync } from "node:fs";',
    'import { dirname, resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    `await (${runNativeFrontmostSmoke.toString()})(${JSON.stringify({ desktopModulePath, nativeDirectory, targetExecutable })});`,
    ""
  ].join("\n");
}

async function runNativeFrontmostSmoke(configuration) {
  const { loadNativeSystemFrontmostInput } = await import(pathToFileURL(configuration.desktopModulePath).href);
  const { createPlatformSystemFrontmostInput } = await import(pathToFileURL(resolve(
    dirname(configuration.desktopModulePath), "dedicated-hardware-action/system-frontmost-input.js"
  )).href);
  assert.equal(process.platform, "win32");
  assert.ok(process.versions.electron, "Native foreground smoke must execute in Electron.");
  const helper = loadNativeSystemFrontmostInput({
    directory: configuration.nativeDirectory, platform: process.platform, architecture: process.arch
  });
  assert.ok(helper, "The product foreground input helper did not load.");
  const atomicCapture = helper.captureTarget;
  assert.equal(typeof atomicCapture, "function", "The product foreground sampler did not load.");
  const input = createPlatformSystemFrontmostInput({ platform: process.platform, windowsHelper: helper });
  assert.equal(input.status, "available");
  const child = spawn(configuration.targetExecutable, [], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  let active = true;
  let exited = false;
  let targetExitCode;
  let inputBytes = 0;
  let stderrBytes = 0;
  let buffer = "";
  let failure;
  let pending;
  const records = [];
  let closeChild;
  const childClosed = new Promise((accept) => { closeChild = accept; });
  const deadline = Date.now() + 38_000;
  let deadlineTimer;
  const interrupted = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error("Native foreground smoke exceeded its deadline.")), 38_000);
  });
  const abort = (error) => {
    failure ??= error;
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
  };
  const assertActive = () => {
    if (!active || failure !== undefined || Date.now() >= deadline) {
      throw failure ?? new Error("Native foreground smoke is retired.");
    }
  };
  const parseRecord = (line) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error("Native foreground target returned invalid JSON."); }
    const identity = (candidate) => typeof candidate === "string" && /^[1-9][0-9]{0,18}$/u.test(candidate);
    const counter = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 1000;
    assert.equal(Object.keys(value).sort().join(","), "clipboardPrepared,event,first,foreground,pid,second");
    assert.ok(["ready", "state", "closed"].includes(value.event));
    assert.equal(value.pid, child.pid);
    assert.ok(identity(value.foreground) || value.foreground === "0");
    assert.equal(typeof value.clipboardPrepared, "boolean");
    for (const target of [value.first, value.second]) {
      assert.equal(Object.keys(target).sort().join(","), "focused,nativeId,pasteMatches,pastes,returnDown,returnUp,textLength,wheelDelta,wheels");
      assert.ok(identity(target.nativeId));
      for (const key of ["pastes", "returnDown", "returnUp", "wheels"]) assert.ok(counter(target[key]));
      assert.ok(Number.isSafeInteger(target.wheelDelta) && Math.abs(target.wheelDelta) <= 24_000);
      assert.equal(typeof target.pasteMatches, "boolean");
      assert.equal(typeof target.focused, "boolean");
      assert.ok(counter(target.textLength));
    }
    return value;
  };
  child.stdout.on("data", (bytes) => {
    try {
      inputBytes += bytes.length;
      if (inputBytes > 64 * 1024) throw new Error("Native foreground target exceeded its output budget.");
      buffer += bytes.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        if (index > 2048) throw new Error("Native foreground target exceeded its record budget.");
        const value = parseRecord(buffer.slice(0, index).trimEnd());
        buffer = buffer.slice(index + 1);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          pending.accept(value);
          pending = undefined;
        } else {
          if (records.length >= 2) throw new Error("Native foreground target returned unsolicited records.");
          records.push(value);
        }
      }
      if (buffer.length > 2048) throw new Error("Native foreground target exceeded its record budget.");
    } catch { abort(new Error("Native foreground target protocol failed.")); }
  });
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 32 * 1024) abort(new Error("Native foreground target exceeded its diagnostic budget."));
  });
  child.on("error", () => abort(new Error("Native foreground smoke target could not start.")));
  child.on("close", (code) => {
    exited = true;
    targetExitCode = code;
    closeChild(code);
    if (active) abort(new Error("Native foreground smoke target exited before completion."));
  });
  child.stdin.on("error", () => {
    if (active) abort(new Error("Native foreground target command channel failed."));
  });
  const nextRecord = () => {
    assertActive();
    if (records.length > 0) return Promise.resolve(records.shift());
    if (pending !== undefined) throw new Error("Native foreground target already has a pending command.");
    return new Promise((accept, reject) => {
      pending = {
        accept, reject,
        timer: setTimeout(() => abort(new Error("Native foreground target did not acknowledge its command.")), 4000)
      };
    });
  };
  const command = (name) => {
    assertActive();
    const response = nextRecord();
    child.stdin.write(`${JSON.stringify({ command: name })}\n`);
    return response;
  };
  const sampleIdentity = () => {
    try { return atomicCapture(); } catch { return null; }
  };
  const postEffect = async (runner, action, target, deltaY, preparation) => {
    assertActive();
    const before = sampleIdentity();
    try {
      if (action === "postScroll") await runner.postScroll(target, deltaY);
      else await runner[action](target);
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : null;
      const sanitized = new Error(`Native foreground effect failed: ${JSON.stringify({
        action, code, target: { nativeId: target.nativeId, processId: target.processId },
        before, after: sampleIdentity(), ...(preparation === undefined ? {} : { preparation })
      })}`);
      Object.defineProperty(sanitized, "code", { value: code });
      throw sanitized;
    }
  };
  const sleep = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));
  const focus = async (name, nativeId) => {
    let latest;
    let observed;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await command(name);
      latest = state;
      let captured;
      try { captured = atomicCapture(); }
      catch {
        observed = undefined;
        // Activation can briefly leave Win32 without a valid foreground HWND.
        await sleep(50);
        continue;
      }
      observed = captured;
      if (state.foreground === nativeId && captured.nativeId === nativeId && captured.processId === child.pid) return state;
      await sleep(50);
    }
    throw new Error(`The controlled native target could not become foreground: ${JSON.stringify({
      expectedNativeId: nativeId, expectedProcessId: child.pid,
      observed: observed ?? null, foreground: latest?.foreground ?? "0",
      first: latest?.first ?? null, second: latest?.second ?? null
    })}`);
  };
  const stateAfter = async (phase, matches) => {
    let latest;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const state = await command("state");
      latest = state;
      if (matches(state)) return state;
      await sleep(25);
    }
    throw new Error(`The controlled native target did not receive its input effect: ${JSON.stringify({
      phase, foreground: latest?.foreground ?? "0", processId: latest?.pid ?? null,
      first: latest?.first ?? null, second: latest?.second ?? null
    })}`);
  };
  let stopping;
  const stopChild = () => {
    if (stopping !== undefined) return stopping;
    active = false;
    abort(new Error("Native foreground smoke is retired."));
    stopping = (async () => {
      if (exited) return;
      try { child.stdin.end(`${JSON.stringify({ command: "exit" })}\n`); } catch { }
      const graceful = await Promise.race([childClosed.then(() => true), sleep(2000).then(() => false)]);
      if (!graceful) {
        child.kill();
        const killed = await Promise.race([childClosed.then(() => true), sleep(2000).then(() => false)]);
        if (!killed) throw new Error("Native foreground smoke target cleanup did not finish.");
      }
    })();
    return stopping;
  };
  const onSignal = () => {
    void stopChild().catch(() => {}).finally(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result;
  try {
    result = await Promise.race([(async () => {
      const ready = await nextRecord();
      assert.equal(ready.event, "ready");
      assert.notEqual(ready.first.nativeId, ready.second.nativeId);
      await focus("focus-first", ready.first.nativeId);
      const target = input.runner.captureTarget();
      assert.equal(target.nativeId, ready.first.nativeId);
      assert.equal(target.processId, child.pid);
      assert.ok(Object.isFrozen(target));
      await focus("focus-second", ready.second.nativeId);
      const secondTarget = input.runner.captureTarget();
      assert.equal(secondTarget.nativeId, ready.second.nativeId);
      assert.equal(secondTarget.processId, child.pid);

      await postEffect(input.runner, "postReturn", target);
      const returned = await stateAfter("return", (value) => value.first.returnDown === 1 && value.first.returnUp === 1);
      assert.equal(returned.second.returnDown, 0);
      assert.equal(returned.second.returnUp, 0);
      await focus("focus-second", ready.second.nativeId);
      await postEffect(input.runner, "postScroll", target, 120);
      const wheeled = await stateAfter("wheel", (value) => value.first.wheels === 1 && value.first.wheelDelta === 120);
      assert.equal(wheeled.second.wheels, 0);

      // Return and wheel already prove the fixed target after foreground changes.
      // Finish clipboard COM access before the final exact focus and activation grant.
      const beforeClipboard = sampleIdentity();
      const prepared = await command("clipboard");
      assert.equal(prepared.clipboardPrepared, true);
      const afterClipboard = sampleIdentity();
      await focus("focus-first", ready.first.nativeId);
      await postEffect(input.runner, "postPaste", target, undefined, { beforeClipboard, afterClipboard });
      const pasted = await stateAfter("paste", (value) => value.first.pastes === 1 && value.first.pasteMatches === true);
      assert.equal(pasted.second.pastes, 0);

      const rejectionBaseline = await focus("focus-first", ready.first.nativeId);
      const currentInput = createPlatformSystemFrontmostInput({
        platform: process.platform, windowsHelper: helper, currentProcessId: child.pid
      });
      assert.equal(currentInput.status, "available");
      assert.throws(() => currentInput.runner.captureTarget(), /belongs to this process/u);
      let wrongProcessId = child.pid === 0xffff_ffff ? child.pid - 1 : child.pid + 1;
      if (wrongProcessId === process.pid) wrongProcessId += 1;
      const wrongInput = createPlatformSystemFrontmostInput({
        platform: process.platform, windowsHelper: {
          ...helper,
          captureTarget: () => ({ nativeId: ready.first.nativeId, processId: wrongProcessId })
        }
      });
      assert.equal(wrongInput.status, "available");
      const wrongTarget = wrongInput.runner.captureTarget();
      for (const effect of ["postReturn", "postScroll", "postPaste"]) {
        assertActive();
        await assert.rejects(() => postEffect(wrongInput.runner, effect, wrongTarget, 120), (error) => error.code === 3);
      }
      const final = await command("state");
      assert.deepEqual(final.first, rejectionBaseline.first);
      assert.deepEqual(final.second, rejectionBaseline.second);
      return {
        sampler: true, exactTarget: true, fixedTargetAfterFocusMove: true,
        return: true, wheel: true, paste: true, currentProcessRejected: true, wrongProcessRejected: true
      };
    })(), interrupted]);
  } finally {
    clearTimeout(deadlineTimer);
    try { await stopChild(); }
    finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
  assert.equal(exited, true, "Native foreground smoke left its controlled target running.");
  assert.equal(targetExitCode, 0, "Native foreground smoke target did not exit normally.");
  process.stdout.write(`${JSON.stringify({
    ok: true, runtimeRoot: realpathSync(process.argv[2]), version: process.versions.node,
    electronVersion: process.versions.electron, ...result, targetCleanup: true
  })}\n`);
}
