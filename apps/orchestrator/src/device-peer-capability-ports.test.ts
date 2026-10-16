import { DevicePeerLoopbackHost, type DevicePeerCommand } from "@joko/contracts";
import { createInProcessDevicePeerHarness, type DevicePeerRequestFrame } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { createDevicePeerCapabilityPorts } from "./device-peer-capability-ports.js";
import { DevicePeerOwner } from "./device-peer-owner.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("Device peer capability ports", () => {
  it("dispatches typed file commands through the exact captured route", async () => {
    const fixture = setup();
    const commands: DevicePeerCommand[] = [];
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process", "terminal", "forwarding"],
      agent: {
        handle: async (frame) => {
          const command = frame.payload as DevicePeerCommand;
          commands.push(command);
          return { outcome: "completed", value: { case: "realpath", value: { path: "C:\\peer\\project" } } };
        }
      }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!);
    const files = createDevicePeerCapabilityPorts({ owner: fixture.owner, authority }).files!;

    await expect(files.realpath("C:\\peer\\project")).resolves.toBe("C:\\peer\\project");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      capability: 1,
      effect: 1,
      action: { case: "realpath", value: { path: "C:\\peer\\project" } }
    });
  });

  it("keeps process output owned by the start claim until the process exits", async () => {
    const fixture = setup();
    const commands: DevicePeerCommand[] = [];
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: {
        handle: async (frame: DevicePeerRequestFrame) => {
          const command = frame.payload as DevicePeerCommand;
          commands.push(command);
          if (command.action.case === "startProcess") {
            return { outcome: "completed", value: { case: "processStarted", value: { processId: "process-1" } } };
          }
          return { outcome: "completed", value: { case: "acknowledgement", value: {} } };
        }
      }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!);
    const processes = createDevicePeerCapabilityPorts({ owner: fixture.owner, authority }).processes!;
    const process = await processes.open({ executable: "tool", args: ["--version"], cwd: "C:\\peer\\project" });
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    await new Promise<void>((resolve, reject) => process.stdin.write("input", (error) => error ? reject(error) : resolve()));

    const start = harness.acceptedRequests.find((frame) => (frame.payload as DevicePeerCommand).action.case === "startProcess")!;
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: start.requestId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "process-1",
      sequence: 1,
      channel: "process_stdout",
      data: Buffer.from("ok")
    });
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      process.once("error", reject);
      process.once("exit", (code, signal) => resolve([code, signal]));
    });
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: start.requestId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "process-1",
      sequence: 2,
      channel: "process_exit",
      exitCode: 0,
      signal: null
    });

    await expect(exited).resolves.toEqual([0, null]);
    expect(Buffer.concat(output).toString("utf8")).toBe("ok");
    expect(commands.map((command) => command.action.case)).toEqual(["startProcess", "writeProcess"]);
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);
  });

  it.each([false, true])("owns a failed input acknowledgement without losing an earlier process exit: %s", async (exitFirst) => {
    const fixture = setup();
    let rejectInput!: (value: { outcome: "failed"; errorCode: string }) => void;
    const inputReply = new Promise<{ outcome: "failed"; errorCode: string }>(resolve => { rejectInput = resolve; });
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: { handle: async frame => (frame.payload as DevicePeerCommand).action.case === "startProcess"
        ? { outcome: "completed", value: { case: "processStarted", value: { processId: "process-1" } } }
        : await inputReply }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!);
    const child = await createDevicePeerCapabilityPorts({ owner: fixture.owner, authority }).processes!
      .open({ executable: "tool", args: [], cwd: "C:\\peer\\project" });
    const handleErrors: Error[] = [], inputErrors: Error[] = [], exits: unknown[] = [];
    child.on("error", error => handleErrors.push(error));
    child.stdin.on("error", error => inputErrors.push(error));
    child.on("exit", (code, signal) => exits.push([code, signal]));
    const input = new Promise<Error | null | undefined>(resolve => child.stdin.write("input", resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    if (exitFirst) {
      const start = harness.acceptedRequests.find(frame => (frame.payload as DevicePeerCommand).action.case === "startProcess")!;
      harness.emit({ protocolVersion: 1, kind: "stream_event", requestId: start.requestId,
        targetDeviceId: fixture.target.deviceId, routeGeneration: authority.identity.routeGeneration,
        streamId: "process-1", sequence: 1, channel: "process_exit", exitCode: 0, signal: null });
    }
    rejectInput({ outcome: "failed", errorCode: "not_found" });
    const error = await input;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(error).toMatchObject({ code: "not_found", stateMayHaveChanged: false });
    expect(inputErrors).toEqual([error]);
    expect(handleErrors).toEqual(exitFirst ? [] : [error]);
    expect(exits).toEqual(exitFirst ? [[0, null]] : []);
  });

  it("retains terminal startup queries until the runtime attaches its output consumer", async () => {
    const fixture = setupTerminal();
    const terminal = await fixture.terminals.open({ executable: "C:\\peer\\pwsh.exe", args: ["-NoLogo"], cwd: "C:\\peer\\project", cols: 90, rows: 30 });
    const start = fixture.harness.acceptedRequests[0]!;
    const emit = (sequence: number, data: string): void => fixture.harness.emit({
      protocolVersion: 1, kind: "stream_event", requestId: start.requestId,
      targetDeviceId: fixture.target.deviceId, routeGeneration: fixture.authority.identity.routeGeneration,
      streamId: "terminal-1", sequence, channel: "terminal_data", data
    });
    // The remote open claim is already complete while the runtime still awaits
    // its outer creation/authority checks before subscribing to native output.
    emit(1, "\u001b[6n");
    emit(2, "");
    emit(3, "startup prompt");
    const output: string[] = [];
    let response = Promise.resolve();
    const subscription = terminal.onData((data) => {
      output.push(data);
      if (data === "\u001b[6n") {
        response = terminal.write("\u001b[1;1R");
        emit(4, "live output");
      }
    });
    expect(output).toEqual(["\u001b[6n", "startup prompt", "live output"]);
    await response;
    expect(fixture.commands.at(-1)?.action).toMatchObject({
      case: "writeTerminal", value: { data: Buffer.from("\u001b[1;1R") }
    });
    subscription.dispose();
    const replacement: string[] = [];
    terminal.onData((data) => replacement.push(data));
    expect(replacement).toEqual([]);
    emit(5, "next output");
    expect(replacement).toEqual(["next output"]);
    await terminal.kill();
  });

  it("finishes flushing earlier terminal output before a reentrant exit and replays that exit once", async () => {
    const fixture = setupTerminal();
    const terminal = await fixture.terminals.open({ executable: "C:\\peer\\pwsh.exe", args: [], cwd: "C:\\peer\\project", cols: 90, rows: 30 });
    const start = fixture.harness.acceptedRequests[0]!;
    const identity = { protocolVersion: 1 as const, kind: "stream_event" as const, requestId: start.requestId,
      targetDeviceId: fixture.target.deviceId, routeGeneration: fixture.authority.identity.routeGeneration, streamId: "terminal-1" };
    fixture.harness.emit({ ...identity, sequence: 1, channel: "terminal_data", data: "first" });
    fixture.harness.emit({ ...identity, sequence: 2, channel: "terminal_data", data: "second" });
    const events: string[] = [];
    terminal.onExit(() => events.push("exit"));
    terminal.onData((data) => {
      events.push(data);
      if (data === "first") fixture.harness.emit({ ...identity, sequence: 3, channel: "terminal_exit", exitCode: 0, signal: null,
        failureCode: null, processExitConfirmed: true });
    });
    expect(events).toEqual(["first", "second", "exit"]);
    const lateExits: unknown[] = [];
    terminal.onExit((event) => lateExits.push(event));
    await Promise.resolve();
    expect(lateExits).toEqual([{ exitCode: 0, processExitConfirmed: true }]);
    await Promise.resolve();
    expect(lateExits).toHaveLength(1);
  });

  it.each(["exit", "identity"] as const)("retains startup output and a terminal %s received before consumers attach", async (failure) => {
    const fixture = setupTerminal();
    const terminal = await fixture.terminals.open({ executable: "C:\\peer\\pwsh.exe", args: [], cwd: "C:\\peer\\project", cols: 90, rows: 30 });
    const start = fixture.harness.acceptedRequests[0]!;
    const identity = { protocolVersion: 1 as const, kind: "stream_event" as const, requestId: start.requestId,
      targetDeviceId: fixture.target.deviceId, routeGeneration: fixture.authority.identity.routeGeneration, streamId: "terminal-1" };
    fixture.harness.emit({ ...identity, sequence: 1, channel: "terminal_data", data: "startup" });
    fixture.harness.emit(failure === "exit"
      ? { ...identity, sequence: 2, channel: "terminal_exit", exitCode: 7, signal: null, failureCode: null, processExitConfirmed: true }
      : { ...identity, streamId: "other-terminal", sequence: 2, channel: "terminal_data", data: "wrong identity" });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));
    expect(output).toEqual(["startup"]);
    const exit = await new Promise<unknown>((resolve) => terminal.onExit(resolve));
    expect(exit).toMatchObject(failure === "exit"
      ? { exitCode: 7, processExitConfirmed: true }
      : { exitCode: -1, failureCode: "route_closed", processExitConfirmed: false });
  });

  it("ignores empty startup chunks and bounds retained terminal bytes before attachment", async () => {
    const fixture = setupTerminal();
    const terminal = await fixture.terminals.open({ executable: "C:\\peer\\pwsh.exe", args: [], cwd: "C:\\peer\\project", cols: 90, rows: 30 });
    const start = fixture.harness.acceptedRequests[0]!;
    let sequence = 0;
    const emit = (data: string): void => fixture.harness.emit({
      protocolVersion: 1, kind: "stream_event", requestId: start.requestId,
      targetDeviceId: fixture.target.deviceId, routeGeneration: fixture.authority.identity.routeGeneration,
      streamId: "terminal-1", sequence: ++sequence, channel: "terminal_data", data
    });
    for (let index = 0; index < 3; index += 1) emit("");
    const chunk = "x".repeat(64 * 1024);
    for (let index = 0; index < 16; index += 1) emit(chunk);
    emit("x");
    const output: string[] = [];
    terminal.onData((data) => output.push(data));
    expect(output).toEqual([]);
    await expect(new Promise((resolve) => terminal.onExit(resolve))).resolves.toMatchObject({
      exitCode: -1, failureCode: "output_limit", processExitConfirmed: false
    });
  });

  it("keeps the shared route alive while locally closed forwards drain their original claims", async () => {
    const fixture = setup();
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process", "forwarding"],
      agent: {
        handle: async (frame: DevicePeerRequestFrame) => {
          const command = frame.payload as DevicePeerCommand;
          if (command.action.case === "openLoopbackForward") {
            return {
              outcome: "completed",
              value: { case: "loopbackForwardOpened", value: { forwardId: "forward-1" } }
            };
          }
          if (command.action.case === "listenLoopbackForward") {
            return {
              outcome: "completed",
              value: {
                case: "loopbackListenerOpened",
                value: { listenerId: "listener-1", peerListenHost: DevicePeerLoopbackHost.IPV4, peerListenPort: 34567 }
              }
            };
          }
          return { outcome: "completed", value: { case: "acknowledgement", value: {} } };
        }
      }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!);
    const forwarding = createDevicePeerCapabilityPorts({ owner: fixture.owner, authority }).forwarding!;

    const forward = await forwarding.open({ destinationHost: "127.0.0.1", destinationPort: 3000 });
    const forwardStart = harness.acceptedRequests.find(
      (frame) => (frame.payload as DevicePeerCommand).action.case === "openLoopbackForward"
    )!;
    const forwardClosed = new Promise<void>((resolve) => forward.once("close", resolve));
    forward.destroy();
    await forwardClosed;
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: forwardStart.requestId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "forward-1",
      sequence: 1,
      channel: "forward_close",
      errorCode: null
    });
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);

    const listener = await forwarding.listen({
      localDestinationHost: "127.0.0.1",
      localDestinationPort: 3001
    });
    const listenerStart = harness.acceptedRequests.find(
      (frame) => (frame.payload as DevicePeerCommand).action.case === "listenLoopbackForward"
    )!;
    await listener.close();
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: listenerStart.requestId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "connection-1",
      sequence: 1,
      channel: "reverse_forward_close",
      errorCode: null
    });
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: listenerStart.requestId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "listener-1",
      sequence: 1,
      channel: "forward_close",
      errorCode: null
    });
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);
  });

  it("rejects requests outside the target executor file and process budgets before dispatch", async () => {
    const fixture = setup();
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: { handle: async () => { throw new Error("An invalid command reached the target route."); } }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!);
    const ports = createDevicePeerCapabilityPorts({ owner: fixture.owner, authority });

    await expect(ports.files!.read({ path: "C:\\peer\\project\\empty", maximumBytes: 0 }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(ports.processes!.open({
      executable: "tool",
      args: ["a".repeat(256 * 1024 + 1)],
      cwd: "C:\\peer\\project"
    })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(ports.processes!.open({
      executable: "tool",
      args: [],
      cwd: "C:\\peer\\project",
      env: { TOO_LARGE: "a".repeat(256 * 1024) }
    })).rejects.toMatchObject({ code: "invalid_request" });
    expect(harness.acceptedRequests).toHaveLength(0);
  });
});

function setupTerminal() {
  const fixture = setup();
  const commands: DevicePeerCommand[] = [];
  const harness = createInProcessDevicePeerHarness({
    targetDeviceId: fixture.target.deviceId,
    capabilities: ["files", "process", "terminal"],
    agent: { handle: async (frame) => {
      const command = frame.payload as DevicePeerCommand;
      commands.push(command);
      return command.action.case === "openTerminal"
        ? { outcome: "completed", value: { case: "terminalOpened", value: { terminalId: "terminal-1" } } }
        : { outcome: "completed", value: { case: "acknowledgement", value: {} } };
    } }
  });
  fixture.owner.registerRoute(fixture.target, harness.transport);
  const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!);
  return { ...fixture, commands, harness, authority, terminals: createDevicePeerCapabilityPorts({ owner: fixture.owner, authority }).terminals! };
}

function setup(): {
  readonly owner: DevicePeerOwner;
  readonly controller: ReturnType<OperationalStore["createConnection"]>;
  readonly target: ReturnType<OperationalStore["createConnection"]>;
} {
  const store = new OperationalStore(":memory:");
  stores.push(store);
  const controller = store.createConnection({
    id: "connection-controller",
    deviceId: "device-controller",
    device: { defaultName: "Controller", kind: "web", platform: "web" },
    name: "Controller",
    authKeyDigest: "controller-digest"
  });
  const target = store.createConnection({
    id: "connection-target",
    deviceId: "device-target",
    device: { defaultName: "Target Desktop", kind: "desktop", platform: "windows" },
    name: "Target Desktop",
    authKeyDigest: "target-digest"
  });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  return { owner: new DevicePeerOwner({ store }), controller, target };
}
