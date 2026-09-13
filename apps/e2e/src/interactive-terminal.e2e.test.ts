import { randomUUID } from "node:crypto";
import { Code } from "@connectrpc/connect";
import { CapabilitySupport, OperationState, RuntimeActivityKind, TerminalStatus, TerminalUpdateKind } from "@joko/contracts";
import { TerminalProvider } from "@joko/tool-terminal";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { archiveMutation, createSessionMutation, sessionIdFrom, submit } from "./operations.js";

describe("interactive terminal product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let terminals: TerminalProvider | undefined;
  afterEach(async () => { await fixture?.close(); await terminals?.dispose(); });

  it("keeps a real PTY across HTTP disconnect and Backend close, restores its screen and closes it on task archive", async () => {
    terminals = new TerminalProvider({ shells: async () => [{ id: "test-tty", label: "Test TTY", executable: process.execPath,
      args: ["-e", "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY+'\\r\\n');process.stdin.on('data',bytes=>{if(bytes.toString()==='query-color')process.stdout.write('\\x1b]10;?\\x07');else if(bytes[0]===27)process.stdout.write('COLOR:'+bytes.toString('hex')+'\\r\\n');else process.stdout.write('INPUT:'+bytes.toString()+'\\r\\n');});"], isDefault: true }] });
    fixture = await OrchestratorE2eFixture.start({ terminals });
    const paired = await fixture.pair();
    const [backendId, targetId] = [...fixture.targets][0]!;
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, createSessionMutation({ backendId, targetId })));
    await expect(fixture.anonymous.terminal.listTerminals({ sessionId })).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect((await paired.clients.terminal.getTerminalCapabilities({ sessionId })).support).toBe(CapabilitySupport.SUPPORTED);
    const created = await paired.clients.terminal.createTerminal({ initialPalette: { ansiRgb: Array.from({ length: 16 }, (_, index) => index * 0x111111), foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff }, sessionId, requestId: randomUUID(), columns: 80, rows: 24 });
    const terminal = created.terminal!;
    const reference = { sessionId, terminalId: terminal.id, generation: terminal.generation };
    const disconnected = new AbortController();
    const appearance = { viewId: randomUUID(), viewRevision: 1n, palette: { ansiRgb: Array.from({ length: 16 }, (_, index) => index * 0x111111), foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff } };
    const stream = paired.clients.terminal.watchTerminal({ ...reference, appearance }, { signal: disconnected.signal })[Symbol.asyncIterator]();
    const registered = (await stream.next()).value!;
    expect(registered).toMatchObject({ kind: TerminalUpdateKind.RESET, activeColorOverrides: "" });
    const focused = await paired.clients.terminal.updateTerminalAppearance({ ...reference, appearance: { ...appearance, viewRevision: 2n, palette: { ...appearance.palette, foregroundRgb: 0x123456 } }, claimFocus: true, expectedAppearanceRevision: registered.appearanceRevision });
    expect(focused).toMatchObject({ accepted: true, ownsDefaults: true, acceptedViewRevision: 2n });
    await paired.clients.terminal.writeTerminal({ ...reference, writerId: appearance.viewId, inputSequence: 1n, data: "query-color" });
    const expectedColor = Buffer.from("\x1b]10;rgb:1212/3434/5656\x1b\\").toString("hex");
    await waitFor(async () => (await paired.clients.terminal.getTerminal(reference)).serialized.includes("COLOR:" + expectedColor), (ready) => ready, "focused terminal color query");
    disconnected.abort();
    await stream.return?.();
    await fixture.application.sessionHost.close(sessionId);
    expect((await paired.clients.terminal.listTerminals({ sessionId })).terminals).toHaveLength(1);
    const inputAbort = new AbortController();
    const inputAppearance = { viewId: randomUUID(), viewRevision: 1n, palette: appearance.palette };
    const inputStream = paired.clients.terminal.watchTerminal({ ...reference, appearance: inputAppearance }, { signal: inputAbort.signal })[Symbol.asyncIterator]();
    const inputRegistered = (await inputStream.next()).value!;
    expect(inputRegistered).toMatchObject({ kind: TerminalUpdateKind.RESET, terminal: { status: TerminalStatus.RUNNING } });
    const inputFocused = await paired.clients.terminal.updateTerminalAppearance({
      ...reference,
      appearance: { ...inputAppearance, viewRevision: 2n },
      claimFocus: true,
      expectedAppearanceRevision: inputRegistered.appearanceRevision
    });
    expect(inputFocused).toMatchObject({ accepted: true, ownsDefaults: true, acceptedViewRevision: 2n });
    await paired.clients.terminal.writeTerminal({ ...reference, writerId: inputAppearance.viewId, inputSequence: 1n, data: "private terminal input" });
    let serialized = "";
    await waitFor(async () => { serialized = (await paired.clients.terminal.getTerminal(reference)).serialized; return serialized.includes("INPUT:private terminal input"); }, (ready) => ready, "terminal echo");
    inputAbort.abort();
    await inputStream.return?.();
    expect(serialized).toContain("TTY:true:true");
    const activity = await paired.clients.event.getRuntimeActivity({});
    expect(activity.summary?.blockingKinds).toContain(RuntimeActivityKind.USER_SHELL);
    const reconnectAbort = new AbortController();
    const reconnected = paired.clients.terminal.watchTerminal({ ...reference, appearance: { viewId: randomUUID(), viewRevision: 1n, palette: { ansiRgb: Array.from({ length: 16 }, (_, index) => index * 0x111111), foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff } } }, { signal: reconnectAbort.signal })[Symbol.asyncIterator]();
    const checkpoint = await reconnected.next();
    expect(checkpoint.value).toMatchObject({ kind: TerminalUpdateKind.RESET, terminal: { status: TerminalStatus.RUNNING }, data: expect.stringContaining("private terminal input") });
    reconnectAbort.abort();
    await reconnected.return?.();
    const archived = await submit(paired.clients.operation, paired.connectionId, archiveMutation(sessionId, true));
    expect(archived.state).toBe(OperationState.SUCCEEDED);
    expect(terminals.hasActiveTerminals()).toBe(false);
    await expect(paired.clients.terminal.getTerminal(reference)).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
});
