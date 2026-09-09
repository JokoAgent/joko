import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Terminal } from "@xterm/headless";
import { describe, expect, test, vi } from "vitest";
import { TERMINAL_UNICODE_CORPUS } from "./i18n/unicode.test-fixture.js";
import { TerminalProvider, TERMINAL_LIMITS, type TerminalPty, type TerminalPtyFactory, type TerminalRuntime } from "./provider.js";
import { TerminalError, type TerminalDescriptor, type TerminalReference, type TerminalScope, type TerminalShell } from "./types.js";

const shell: TerminalShell = { id: "test-shell", label: "Test shell", executable: process.execPath, args: [], isDefault: true };

const palette = { ansiRgb: [0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec], foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff };
let nextView = 0;
const appearance = () => ({ viewId: `view-${++nextView}`, viewRevision: 1, palette });

describe("TerminalProvider", () => {
  test("uses one remote runtime for POSIX shell discovery, canonical cwd and spawn without touching local facilities", async () => {
    const fixture = remoteSetup();
    try {
      const { provider, runtime, resolveRuntime, scope } = fixture;
      expect(await provider.discoverShells(scope)).toEqual([remoteShell]);
      resolveRuntime.mockClear(); runtime.discoverShells.mockClear();
      const request = { ...scope, id: "remote", cwd: "child/../child", cols: 91, rows: 27 };
      const [created, duplicate] = await Promise.all([provider.create(request), provider.create(request)]);
      expect(created).toEqual(duplicate);
      expect(created).toMatchObject({ cwd: "/srv/project/child", shellId: remoteShell.id, exitConfirmed: false });
      expect(created).not.toHaveProperty("pid");
      expect(resolveRuntime).toHaveBeenCalledExactlyOnceWith({ sessionId: scope.sessionId, targetId: scope.targetId, workspaceRoot: scope.workspaceRoot, remoteHostId: scope.remoteHostId }, expect.any(AbortSignal));
      expect(runtime.discoverShells).toHaveBeenCalledOnce();
      expect(runtime.canonicalDirectory).toHaveBeenCalledExactlyOnceWith("/srv/project", "child/../child");
      expect(runtime.spawn).toHaveBeenCalledExactlyOnceWith(remoteShell, { cwd: "/srv/project/child", cols: 91, rows: 27 }, expect.any(AbortSignal));
      await expect(provider.input({ ...ref(scope, created), remoteHostId: "another-host", data: "do not send" }))
        .rejects.toMatchObject({ code: "TERMINAL_SCOPE_MISMATCH" });
      await expect(provider.create({ ...request, remoteHostId: "another-host" })).rejects.toMatchObject({ code: "TERMINAL_SCOPE_MISMATCH" });
      expect(provider.list({ ...scope, remoteHostId: "another-host" })).toEqual([]);
      await expect(provider.discoverShells({ ...scope, workspaceRoot: "C:\\local\\workspace" })).rejects.toMatchObject({ code: "WORKSPACE_PATH_DENIED" });
      expect(fixture.localSpawn).not.toHaveBeenCalled();
      expect(fixture.localShells).not.toHaveBeenCalled();
    } finally { await fixture.provider.dispose(); }
  });

  test("rejects unavailable remote runtimes without selecting a local shell or spawning a local process", async () => {
    const fixture = remoteSetup(false);
    try {
      await expect(fixture.provider.discoverShells(fixture.scope)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      await expect(fixture.provider.create({ ...fixture.scope, id: "unavailable" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(fixture.provider.hasActiveTerminals()).toBe(false);
      expect(fixture.localSpawn).not.toHaveBeenCalled();
      expect(fixture.localShells).not.toHaveBeenCalled();
    } finally { await fixture.provider.dispose(); }
  });

  test("re-resolves a remote runtime after confirmed exit and keeps the checkpoint without replaying input", async () => {
    const fixture = remoteSetup();
    try {
      const created = await fixture.provider.create({ ...fixture.scope, id: "remote-restart", cwd: "child" });
      const previous = ref(fixture.scope, created);
      await fixture.provider.input({ ...previous, data: "first command\r" });
      fixture.ptys[0]!.output("remote checkpoint\r\n");
      fixture.ptys[0]!.exit(0);
      expect((await fixture.provider.snapshot(previous)).terminal).toMatchObject({ status: "exited", exitConfirmed: true });
      const replacementPty = new FakePty();
      const replacementRuntime = {
        discoverShells: vi.fn(async () => [{ ...remoteShell, executable: "/usr/bin/bash" }]),
        canonicalDirectory: vi.fn(async () => "/srv/project/child"),
        spawn: vi.fn<TerminalRuntime["spawn"]>(() => replacementPty)
      } satisfies TerminalRuntime;
      fixture.resolveRuntime.mockResolvedValueOnce(replacementRuntime);
      const restarted = await fixture.provider.restart(previous);
      expect(fixture.resolveRuntime).toHaveBeenCalledTimes(2);
      expect(replacementRuntime.discoverShells).toHaveBeenCalledOnce();
      expect(replacementRuntime.canonicalDirectory).toHaveBeenCalledExactlyOnceWith("/srv/project", "child");
      expect(replacementRuntime.spawn.mock.calls[0]?.[0]).toMatchObject({ executable: "/usr/bin/bash" });
      expect((await fixture.provider.snapshot(ref(fixture.scope, restarted))).serialized).toContain("remote checkpoint");
      expect(replacementPty.writes).toEqual([]);
      expect(restarted).toMatchObject({ status: "running", exitConfirmed: false });
      replacementPty.exit(0);
      await fixture.provider.snapshot(ref(fixture.scope, restarted));
      replacementRuntime.discoverShells.mockResolvedValueOnce([]);
      fixture.resolveRuntime.mockResolvedValueOnce(replacementRuntime);
      await expect(fixture.provider.restart(ref(fixture.scope, restarted))).rejects.toMatchObject({ code: "SHELL_UNAVAILABLE" });
      expect(replacementRuntime.spawn).toHaveBeenCalledOnce();
    } finally { await fixture.provider.dispose(); }
  });

  test.each([true, false])("preserves scope ownership until a cancelled remote spawn confirms cleanup: %s", async (confirmed) => {
    const fixture = remoteSetup();
    try {
      let complete!: (pty: TerminalPty) => void;
      fixture.runtime.spawn.mockImplementationOnce(() => new Promise((done) => { complete = done; }));
      const pending = fixture.provider.create({ ...fixture.scope, id: "remote-cancel" });
      const expectation = expect(pending).rejects.toMatchObject({ code: confirmed ? "ABORTED" : "CLEANUP_UNKNOWN", stateMayHaveChanged: !confirmed });
      await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
      const closing = fixture.provider.closeSession(fixture.scope.sessionId);
      const closingExpectation = confirmed ? closing : expect(closing).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
      expect(fixture.provider.hasActiveTerminals()).toBe(true);
      const late = new FakePty();
      late.kill = () => {
        late.killCalls += 1;
        for (const listener of late.exitListeners) listener({ exitCode: 0, processExitConfirmed: confirmed, ...(confirmed ? {} : { failureCode: "REMOTE_DISCONNECTED" }) });
      };
      complete(late);
      await expectation;
      await closingExpectation;
      expect(late.killCalls).toBe(1);
      expect(fixture.provider.hasActiveTerminals()).toBe(!confirmed);
      if (!confirmed) await expect(fixture.provider.create({ ...fixture.scope, id: "remote-cancel" })).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
    } finally {
      if (confirmed) await fixture.provider.dispose();
      else await expect(fixture.provider.dispose()).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
    }
  });

  test("publishes delayed exit confirmation after a failed remote stream and refuses restart until then", async () => {
    const fixture = remoteSetup();
    try {
      const created = await fixture.provider.create({ ...fixture.scope, id: "remote-exit" });
      const reference = ref(fixture.scope, created);
      const pty = fixture.ptys[0]!;
      for (const listener of pty.exitListeners) listener({ exitCode: -1, failureCode: "REMOTE_DISCONNECTED", processExitConfirmed: false });
      const failed = await fixture.provider.snapshot(reference);
      expect(failed.terminal).toMatchObject({ status: "failed", exitConfirmed: false, failureCode: "REMOTE_DISCONNECTED" });
      await expect(fixture.provider.restart(reference)).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
      expect(fixture.resolveRuntime).toHaveBeenCalledOnce();
      for (const listener of pty.exitListeners) listener({ exitCode: 0, processExitConfirmed: true });
      const confirmed = await fixture.provider.snapshot(reference);
      expect(confirmed.terminal).toMatchObject({ status: "failed", exitConfirmed: true, failureCode: "REMOTE_DISCONNECTED" });
      expect(confirmed.sequence).toBeGreaterThan(failed.sequence);
      const restarted = await fixture.provider.restart(reference);
      expect(restarted.exitConfirmed).toBe(false);
      expect(fixture.resolveRuntime).toHaveBeenCalledTimes(2);
      await fixture.provider.kill(ref(fixture.scope, restarted));
      expect((await fixture.provider.snapshot(ref(fixture.scope, restarted))).terminal).toMatchObject({ status: "closed", exitConfirmed: true });
    } finally { await fixture.provider.dispose(); }
  });

  test("creates once for an exact request, isolates task ownership and does not inherit service credentials", async () => {
    const fixture = await setup({ environment: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      JOKO_SERVICE_TOKEN: "service-secret", ANTHROPIC_API_KEY: "provider-secret", HTTP_PROXY: "http://secret:password@example.test",
      NODE_OPTIONS: "--inspect", SSH_AUTH_SOCK: "private-agent", TERM_PROGRAM: "other-terminal", LANG: "en_US.UTF-8"
    } });
    try {
      const request = { ...fixture.scope, id: "one" };
      const [one, duplicate] = await Promise.all([fixture.provider.create(request), fixture.provider.create(request)]);
      expect(duplicate).toEqual(one);
      expect(fixture.spawn).toHaveBeenCalledOnce();
      const environment = fixture.spawn.mock.calls[0]![2].env!;
      expect(environment).toMatchObject({ TERM: "xterm-256color", LANG: "en_US.UTF-8" });
      expect(Object.values(environment)).not.toContain("service-secret");
      expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(environment).not.toHaveProperty("HTTP_PROXY");
      expect(environment).not.toHaveProperty("NODE_OPTIONS");
      expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
      expect(environment).not.toHaveProperty("TERM_PROGRAM");
      await expect(fixture.provider.create({ ...request, cols: 90 })).rejects.toMatchObject({ code: "TERMINAL_CONFLICT" });
      const reference = ref(fixture.scope, one);
      await expect(fixture.provider.input({ ...reference, sessionId: "other-task", data: "secret" })).rejects.toMatchObject({ code: "TERMINAL_SCOPE_MISMATCH" });
      expect(fixture.provider.list({ ...fixture.scope, sessionId: "other-task" })).toEqual([]);
      await fixture.provider.create({ ...fixture.scope, id: "two" });
      expect(fixture.provider.list(fixture.scope)).toHaveLength(2);
      expect(fixture.provider.hasActiveTerminals()).toBe(true);
      await fixture.provider.closeSession(fixture.scope.sessionId);
      expect(fixture.provider.list(fixture.scope)).toEqual([]);
      expect(fixture.ptys.every((pty) => pty.killCalls === 1)).toBe(true);
      expect(fixture.provider.hasActiveTerminals()).toBe(false);
    } finally { await fixture.dispose(); }
  });

  test("preserves ANSI screen, colors, alternate buffer and split unicode across reconnect checkpoints", async () => {
    const fixture = await setup();
    const restored = new Terminal({ cols: 40, rows: 10, allowProposedApi: true, logLevel: "off" });
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "ansi", cols: 40, rows: 10 });
      const reference = ref(fixture.scope, descriptor);
      const pty = fixture.ptys[0]!;
      pty.output("normal\r\n\x1b[31");
      const incomplete = await fixture.provider.snapshot(reference);
      expect(incomplete.serialized).not.toContain("\x1b[31");
      pty.output(TERMINAL_UNICODE_CORPUS.splitHead);
      pty.output(TERMINAL_UNICODE_CORPUS.splitTail);
      const snapshot = await fixture.provider.snapshot(reference);
      await parsed(restored, snapshot.serialized);
      expect(restored.buffer.active.type).toBe("alternate");
      expect(restored.buffer.active.getLine(1)!.translateToString(true)).toBe(TERMINAL_UNICODE_CORPUS.renderedLine);
      expect(restored.buffer.active.getLine(1)!.getCell(3)!.getFgColor()).toBe(0x010203);
      expect(restored.buffer.active.cursorX).toBe(6);
      await parsed(restored, "\x1b[?1049l");
      expect(restored.buffer.active.getLine(0)!.translateToString(true)).toBe("normal");
      expect(restored.buffer.active.getLine(1)!.getCell(0)!.getFgColor()).toBe(1);
    } finally { restored.dispose(); await fixture.dispose(); }
  });

  test("resets an expired output cursor and disconnects a stream without closing its process", async () => {
    const fixture = await setup({ maximumOutputFrames: 2 });
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "stream" });
      const reference = ref(fixture.scope, descriptor);
      for (const text of ["one", "two", "three", "four"]) {
        fixture.ptys[0]!.output(text);
        await fixture.provider.snapshot(reference);
      }
      const stream = fixture.provider.stream({ ...reference, appearance: appearance(), afterSequence: 0 });
      const initial = await stream.next();
      expect(initial.value).toMatchObject({ kind: "reset", terminal: descriptor });
      expect(initial.value && "serialized" in initial.value ? initial.value.serialized : "").toContain("onetwothreefour");
      const waiting = stream.next();
      await stream.return!();
      expect(await waiting).toMatchObject({ done: true });
      expect(fixture.ptys[0]!.killCalls).toBe(0);
      await fixture.provider.input({ ...reference, data: "continue\r" });
      expect(fixture.ptys[0]!.writes).toEqual(["continue\r"]);
      await expect(fixture.provider.stream({ ...reference, appearance: appearance(), afterSequence: 9999 }).next()).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    } finally { await fixture.dispose(); }
  });

  test("retains natural exit, restarts the original shell and fences late data/exit/input from the previous PTY", async () => {
    const fixture = await setup();
    try {
      const original = await fixture.provider.create({ ...fixture.scope, id: "restart", cols: 80, rows: 24 });
      const reference = ref(fixture.scope, original);
      const cancelled = new AbortController();
      fixture.ptys[0]!.output("pending");
      const resizing = fixture.provider.resize({ ...reference, cols: 90, rows: 25 }, cancelled.signal);
      cancelled.abort();
      await expect(resizing).rejects.toMatchObject({ name: "AbortError" });
      expect(fixture.ptys[0]!.sizes).toEqual([]);
      await fixture.provider.resize({ ...reference, cols: 100, rows: 30 });
      const old = fixture.ptys[0]!;
      const lateData = [...old.dataListeners][0]!;
      const lateExit = [...old.exitListeners][0]!;
      old.output("old output");
      old.exit(7);
      const exited = await fixture.provider.snapshot(reference);
      expect(exited.terminal).toMatchObject({ status: "exited", exitCode: 7, cols: 100, rows: 30 });
      fixture.shells.mockResolvedValue([{ ...shell, id: "replacement-default" }]);
      const restarted = await fixture.provider.restart(reference);
      expect(restarted.generation).toBeGreaterThan(original.generation);
      expect(restarted).toMatchObject({ id: "restart", status: "running", shellId: shell.id, cols: 100, rows: 30, cwd: original.cwd });
      expect(fixture.shells).toHaveBeenCalledOnce();
      lateData("late data");
      lateExit({ exitCode: 88 });
      const current = ref(fixture.scope, restarted);
      fixture.ptys[1]!.output("new output");
      const restartedScreen = (await fixture.provider.snapshot(current)).serialized;
      expect(restartedScreen).toContain("old outputnew output");
      expect(restartedScreen).not.toContain("late");
      await expect(fixture.provider.input({ ...reference, data: "stale\r" })).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      await expect(fixture.provider.snapshot(reference)).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      await fixture.provider.kill(current);
      expect((await fixture.provider.snapshot(current)).terminal.status).toBe("closed");
      await fixture.provider.close(current);
      await fixture.provider.close(current);
      expect(fixture.provider.list(fixture.scope)).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  test("rejects oversized paste without executing a prefix and terminates oversized control output", async () => {
    const fixture = await setup();
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "bounded" });
      const reference = ref(fixture.scope, descriptor);
      await expect(fixture.provider.input({ ...reference, data: TERMINAL_UNICODE_CORPUS.wideCharacter.repeat(TERMINAL_LIMITS.maximumInputBytes) })).rejects.toMatchObject({ code: "INPUT_LIMIT" });
      expect(fixture.ptys[0]!.writes).toEqual([]);
      await expect(fixture.provider.resize({ ...reference, cols: 0, rows: 20 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      fixture.ptys[0]!.output("\x1b]2;" + "a".repeat(70 * 1024));
      expect((await fixture.provider.snapshot(reference)).terminal).toMatchObject({ status: "failed", failureCode: "OUTPUT_LIMIT" });
      expect(fixture.ptys[0]!.killCalls).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test("answers native device queries once while no client stream is connected", async () => {
    const fixture = await setup();
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "device-query" });
      const reference = ref(fixture.scope, descriptor);
      fixture.ptys[0]!.output("\x1b[3;5H\x1b[6n\x1b[c\x1b[?6n");
      await fixture.provider.snapshot(reference);
      expect(fixture.ptys[0]!.writes).toEqual(["\x1b[3;5R", "\x1b[?1;2c", "\x1b[?3;5R"]);
      const one = fixture.provider.stream({ ...reference, appearance: appearance() });
      const two = fixture.provider.stream({ ...reference, appearance: appearance() });
      await one.next(); await two.next();
      expect(fixture.ptys[0]!.writes).toHaveLength(3);
      await one.return!(); await two.return!();
    } finally { await fixture.dispose(); }
  });

  test("keeps mixed OSC settings in their original VT order while omitting display-side protocol queries", async () => {
    const fixture = await setup();
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "palette" });
      const reference = ref(fixture.scope, descriptor);
      fixture.ptys[0]!.output("\x1b]4;1;#ff0000;1;?\x07red\x1b]4;1;#0000ff\x07blue\x1b]10;?;#010203\x1b\\\x1b[6n\x1bP$qm\x1b\\");
      await fixture.provider.snapshot(reference);
      const stream = fixture.provider.stream({ ...reference, appearance: appearance(), afterSequence: 1 });
      expect((await stream.next()).value).toMatchObject({
        kind: "output", data: "\x1b]4;1;#ff0000\x07red\x1b]4;1;#0000ff\x07blue\x1b]10;;#010203\x1b\\"
      });
      expect(fixture.ptys[0]!.writes).toHaveLength(4);
      expect(fixture.ptys[0]!.writes[0]).toBe("\x1b]4;1;rgb:ffff/0000/0000\x1b\\");
      await stream.return!();
      fixture.ptys[0]!.exit(0);
      await fixture.provider.snapshot(reference);
      const restarted = await fixture.provider.restart(reference);
      fixture.ptys[1]!.output("\x1b]4;1;?\x07");
      await fixture.provider.snapshot(ref(fixture.scope, restarted));
      expect(fixture.ptys[1]!.writes).toEqual(["\x1b]4;1;rgb:0000/0000/ffff\x1b\\"]);
    } finally { await fixture.dispose(); }
  });

  test("shutdown releases pending output and observers without leaving a live process", async () => {
    const fixture = await setup();
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "shutdown" });
      const reference = ref(fixture.scope, descriptor);
      const stream = fixture.provider.stream({ ...reference, appearance: appearance() });
      await stream.next();
      const waiting = stream.next();
      const stoppedStream = expect(waiting).rejects.toMatchObject({ code: "PROVIDER_CLOSED" });
      fixture.ptys[0]!.output("pending output");
      const snapshot = fixture.provider.snapshot(reference);
      const stoppedSnapshot = expect(snapshot).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      await fixture.provider.dispose();
      await stoppedStream;
      await stoppedSnapshot;
      expect(fixture.ptys[0]!.killCalls).toBe(1);
      expect(fixture.ptys[0]!.dataListeners.size).toBe(0);
      expect(fixture.ptys[0]!.exitListeners.size).toBe(0);
      expect(fixture.provider.hasActiveTerminals()).toBe(false);
    } finally { await fixture.dispose(); }
  });

  test("completes a string terminated by a new escape without leaving checkpoint parser state pending", async () => {
    const fixture = await setup();
    const restored = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, logLevel: "off" });
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "escape" });
      const reference = ref(fixture.scope, descriptor);
      fixture.ptys[0]!.output("\x1b]2;title\x1b");
      await fixture.provider.snapshot(reference);
      fixture.ptys[0]!.output("[6n\x1b[31mred\x1bP$qm\x1b[32mgreen");
      const checkpoint = await fixture.provider.snapshot(reference);
      const stream = fixture.provider.stream({ ...reference, appearance: appearance(), afterSequence: 1 });
      const frame = (await stream.next()).value;
      expect(frame).toMatchObject({ kind: "output" });
      await parsed(restored, frame?.kind === "output" ? frame.data : "");
      expect(restored.buffer.active.getLine(0)!.translateToString(true)).toBe("redgreen");
      await stream.return!();
      restored.reset();
      await parsed(restored, checkpoint.serialized);
      expect(restored.buffer.active.getLine(0)!.translateToString(true)).toBe("redgreen");
      expect(restored.buffer.active.getLine(0)!.getCell(0)!.getFgColor()).toBe(1);
      expect(restored.buffer.active.getLine(0)!.getCell(3)!.getFgColor()).toBe(2);
      expect(fixture.ptys[0]!.writes).toHaveLength(2);
    } finally { restored.dispose(); await fixture.dispose(); }
  });

  test("rejects escaped/linked cwd and fences a pending creation after its task is closed", async () => {
    const fixture = await setup();
    const outside = await mkdtemp(join(tmpdir(), "joko-terminal-outside-"));
    try {
      await symlink(outside, join(fixture.scope.workspaceRoot, "outside"), "junction");
      await expect(fixture.provider.create({ ...fixture.scope, id: "escape", cwd: "../" })).rejects.toMatchObject({ code: "WORKSPACE_PATH_DENIED" });
      await expect(fixture.provider.create({ ...fixture.scope, id: "link", cwd: "outside" })).rejects.toMatchObject({ code: "WORKSPACE_PATH_DENIED" });
      await expect(fixture.provider.create({ ...fixture.scope, id: "shell", shellId: "unavailable" })).rejects.toMatchObject({ code: "SHELL_UNAVAILABLE" });
      let resolveShells!: (shells: readonly TerminalShell[]) => void;
      fixture.shells.mockImplementation(() => new Promise((done) => { resolveShells = done; }));
      const creation = fixture.provider.create({ ...fixture.scope, id: "late" });
      const rejected = expect(creation).rejects.toBeDefined();
      await vi.waitFor(() => expect(resolveShells).toBeTypeOf("function"));
      expect(fixture.provider.hasActiveTerminals()).toBe(true);
      await fixture.provider.closeSession(fixture.scope.sessionId);
      resolveShells([shell]);
      await rejected;
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(fixture.provider.hasActiveTerminals()).toBe(false);
    } finally { await fixture.dispose(); await rm(outside, { recursive: true, force: true }); }
  });

  test("serializes focused view defaults with queries, retires leases, rejects stale claims and preserves restart colors", async () => {
    const fixture = await setup();
    try {
      const descriptor = await fixture.provider.create({ ...fixture.scope, id: "views" });
      const reference = ref(fixture.scope, descriptor);
      const first = appearance();
      const second = { ...appearance(), palette: { ...palette, foregroundRgb: 0x010203 } };
      const one = fixture.provider.stream({ ...reference, appearance: first });
      const initial = (await one.next()).value!;
      const two = fixture.provider.stream({ ...reference, appearance: second, afterSequence: initial.sequence });
      expect((await two.next()).value).toMatchObject({ kind: "state", appearanceRevision: initial.appearanceRevision });
      const claim = { ...reference, appearance: { ...second, viewRevision: 2 }, claimFocus: true, expectedAppearanceRevision: initial.appearanceRevision };
      const accepted = await fixture.provider.updateAppearance(claim);
      expect(accepted).toMatchObject({ accepted: true, ownsDefaults: true });
      const firstClaim = { ...reference, appearance: { ...first, viewRevision: 2 }, claimFocus: true, expectedAppearanceRevision: initial.appearanceRevision };
      expect(await fixture.provider.updateAppearance(firstClaim)).toMatchObject({ accepted: false, appearanceRevision: accepted.appearanceRevision });
      const claimedBack = await fixture.provider.updateAppearance({ ...firstClaim, expectedAppearanceRevision: accepted.appearanceRevision });
      expect(await fixture.provider.updateAppearance(claim)).toMatchObject({ accepted: true, ownsDefaults: false, appearanceRevision: claimedBack.appearanceRevision });
      await expect(fixture.provider.updateAppearance({ ...claim, claimFocus: false })).rejects.toMatchObject({ code: "VIEW_REVISION_CONFLICT" });
      await one.return!();
      fixture.ptys[0]!.output("\x1b]10;?\x07\x1b]11;#123456\x07");
      const snapshot = await fixture.provider.snapshot(reference);
      expect(fixture.ptys[0]!.writes).toEqual(["\x1b]10;rgb:0101/0202/0303\x1b\\"]);
      expect(snapshot.activeColorOverrides).toBe("\x1b]11;rgb:1212/3434/5656\x1b\\");
      await expect(fixture.provider.updateAppearance(firstClaim)).rejects.toMatchObject({ code: "VIEW_UNAVAILABLE" });
      await two.return!();
      fixture.ptys[0]!.exit(0);
      await fixture.provider.snapshot(reference);
      const restarted = await fixture.provider.restart(reference);
      fixture.ptys[1]!.output("\x1b]10;?;?\x07\x1b]111\x07\x1b]11;?\x07");
      await fixture.provider.snapshot(ref(fixture.scope, restarted));
      expect(fixture.ptys[1]!.writes).toEqual(["\x1b]10;rgb:0101/0202/0303\x1b\\\x1b]11;rgb:1212/3434/5656\x1b\\", "\x1b]11;rgb:0000/0000/0000\x1b\\"]);
    } finally { await fixture.dispose(); }
  });

  test("runs a real local PTY, preserves it across client disconnect and confirms process cleanup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "joko-terminal-native-"));
    const scope: TerminalScope = { sessionId: "native-test", targetId: "native-target", workspaceRoot: await realpath(workspace) };
    const provider = new TerminalProvider();
    try {
      const shells = await provider.discoverShells();
      const selected = shells.find((candidate) => candidate.id === (process.platform === "win32" ? "cmd" : "sh"));
      expect(selected).toBeDefined();
      const descriptor = await provider.create({ ...scope, initialPalette: palette, id: "real", shellId: selected!.id });
      const reference = ref(scope, descriptor);
      const stream = provider.stream({ ...reference, appearance: appearance() });
      await stream.next();
      await stream.return!();
      const marker = `JOKO_TTY_${Date.now()}`;
      await provider.input({ ...reference, data: `"${process.execPath}" -e "process.stdout.write('${marker}:'+process.stdin.isTTY+':'+process.stdout.isTTY+'\\r\\n')"\r` });
      await vi.waitFor(async () => {
        expect((await provider.snapshot(reference)).serialized).toContain(`${marker}:true:true`);
      }, { timeout: 12_000, interval: 50 });
      await provider.resize({ ...reference, cols: 92, rows: 28 });
      await provider.input({ ...reference, data: process.platform === "win32" ? "exit /b 7\r" : "exit 7\r" });
      await vi.waitFor(async () => {
        expect((await provider.snapshot(reference)).terminal).toMatchObject({ status: "exited", exitCode: 7 });
      }, { timeout: 5000, interval: 50 });
      const restarted = await provider.restart(reference);
      expect(restarted).toMatchObject({ cols: 92, rows: 28, shellId: selected!.id });
      expect(provider.hasActiveTerminals()).toBe(true);
      await provider.close(ref(scope, restarted));
      expect(provider.hasActiveTerminals()).toBe(false);
    } finally { await provider.dispose(); await rm(workspace, { recursive: true, force: true }); }
  }, 25_000);

  test("waits for cancelled asynchronous creation and restart hosts to close before releasing a task", async () => {
    const fixture = await setup();
    try {
      for (const kind of ["create", "restart"] as const) {
        let reference: TerminalReference | undefined;
        if (kind === "restart") {
          const descriptor = await fixture.provider.create({ ...fixture.scope, id: kind });
          reference = ref(fixture.scope, descriptor);
          fixture.ptys.at(-1)!.exit(0);
          await fixture.provider.snapshot(reference);
        }
        let complete!: (pty: TerminalPty) => void;
        fixture.spawn.mockImplementationOnce(() => new Promise((done) => { complete = done; }));
        const pending = kind === "create" ? fixture.provider.create({ ...fixture.scope, id: kind }) : fixture.provider.restart(reference!);
        const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED", stateMayHaveChanged: false });
        await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
        const closing = fixture.provider.closeSession(fixture.scope.sessionId);
        expect(fixture.provider.hasActiveTerminals()).toBe(true);
        const late = new FakePty();
        complete(late);
        await closing;
        await rejected;
        expect(late.killCalls).toBe(1);
        expect(fixture.provider.list(fixture.scope)).toEqual([]);
        expect(fixture.provider.hasActiveTerminals()).toBe(false);
      }
    } finally { await fixture.dispose(); }
  });

  test.each(["starting", "running"] as const)("retains a scope fence when a %s host cannot confirm its native process exit", async (phase) => {
    const fixture = await setup();
    try {
      if (phase === "starting") {
        fixture.spawn.mockRejectedValueOnce(new TerminalError("CLEANUP_UNKNOWN", "Native process exit is unconfirmed.", true));
        await expect(fixture.provider.create({ ...fixture.scope, id: "uncertain" })).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
        await expect(fixture.provider.create({ ...fixture.scope, id: "uncertain" })).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN" });
        expect(fixture.spawn).toHaveBeenCalledOnce();
      } else {
        const descriptor = await fixture.provider.create({ ...fixture.scope, id: "uncertain" });
        for (const listener of fixture.ptys[0]!.exitListeners) listener({ exitCode: -1, failureCode: "HOST_EXITED", processExitConfirmed: false });
        expect((await fixture.provider.snapshot(ref(fixture.scope, descriptor))).terminal.status).toBe("failed");
      }
      expect(fixture.provider.hasActiveTerminals()).toBe(true);
      await expect(fixture.provider.closeSession(fixture.scope.sessionId)).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
      await expect(fixture.provider.dispose()).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
      await expect(fixture.provider.dispose()).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
      expect(fixture.provider.hasActiveTerminals()).toBe(true);
    } finally {
      try { await fixture.dispose(); }
      catch (error) { expect(error).toMatchObject({ code: "CLEANUP_UNKNOWN" }); await rm(fixture.scope.workspaceRoot, { recursive: true, force: true }); }
    }
  });
});

class FakePty implements TerminalPty {
  readonly pid = 123;
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<Parameters<TerminalPty["onExit"]>[0]>();
  readonly writes: string[] = [];
  readonly sizes: number[][] = [];
  killCalls = 0;
  paused = false;
  onData = (listener: (data: string) => void) => { this.dataListeners.add(listener); return { dispose: () => { this.dataListeners.delete(listener); } }; };
  onExit = (listener: Parameters<TerminalPty["onExit"]>[0]) => { this.exitListeners.add(listener); return { dispose: () => { this.exitListeners.delete(listener); } }; };
  output(data: string) { for (const listener of this.dataListeners) listener(data); }
  exit(exitCode: number) { for (const listener of this.exitListeners) listener({ exitCode }); }
  write(data: string | Buffer) { this.writes.push(data.toString()); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killCalls += 1; this.exit(0); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
}

const remoteShell: TerminalShell = { id: "remote-shell", label: "Remote shell", executable: "/bin/bash", args: ["-l"], isDefault: true };

function remoteSetup(enabled = true) {
  const scope = { sessionId: "remote-task", targetId: "remote-target", remoteHostId: "host-a", workspaceRoot: "/srv/project", initialPalette: palette };
  const ptys: FakePty[] = [];
  const runtime = {
    discoverShells: vi.fn<TerminalRuntime["discoverShells"]>(async () => [remoteShell]),
    canonicalDirectory: vi.fn<TerminalRuntime["canonicalDirectory"]>(async (root, cwd) => posix.resolve(root, cwd)),
    spawn: vi.fn<TerminalRuntime["spawn"]>(() => {
      const pty = new FakePty();
      ptys.push(pty);
      return {
        onData: pty.onData, onExit: pty.onExit, write: pty.write.bind(pty), resize: pty.resize.bind(pty),
        kill: pty.kill.bind(pty), pause: pty.pause.bind(pty), resume: pty.resume.bind(pty)
      };
    })
  };
  const resolveRuntime = vi.fn<NonNullable<ConstructorParameters<typeof TerminalProvider>[0]>["resolveRemoteRuntime"] & {}>(async () => runtime);
  const localSpawn = vi.fn<TerminalPtyFactory>(() => { throw new Error("Local spawn must not serve remote scopes."); });
  const localShells = vi.fn<() => Promise<readonly TerminalShell[]>>(async () => { throw new Error("Local discovery must not serve remote scopes."); });
  const provider = new TerminalProvider({ spawn: localSpawn, shells: localShells, ...(enabled ? { resolveRemoteRuntime: resolveRuntime } : {}) });
  return { provider, scope, runtime, resolveRuntime, localSpawn, localShells, ptys };
}

async function setup(options: ConstructorParameters<typeof TerminalProvider>[0] = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "joko-terminal-"));
  await mkdir(join(workspace, "child"));
  const scope = { sessionId: "task", targetId: "target", workspaceRoot: await realpath(workspace), initialPalette: palette };
  const ptys: FakePty[] = [];
  const spawn = vi.fn<TerminalPtyFactory>(() => { const pty = new FakePty(); ptys.push(pty); return pty; });
  const shells = vi.fn<() => Promise<readonly TerminalShell[]>>(async () => [shell]);
  const provider = new TerminalProvider({ ...options, spawn, shells });
  return { provider, scope, spawn, shells, ptys, dispose: async () => { await provider.dispose(); await rm(workspace, { recursive: true, force: true }); } };
}

function ref(scope: TerminalScope, terminal: TerminalDescriptor): TerminalReference {
  return { ...scope, id: terminal.id, generation: terminal.generation };
}

function parsed(terminal: Terminal, data: string): Promise<void> {
  return new Promise((done) => terminal.write(data, done));
}
