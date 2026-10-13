import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
import { DesktopRemoteCredentialsNative, type DesktopRemoteCredentialsNativeRuntime } from
  "../src/remote-desktop-credentials-native.js";

const owner = { serverId: "paired-server", deviceId: "device:local", profileId: "profile:local" };
const handle = "d788a5a0-50ab-4670-a069-dc7cc99b1350";

describe("native credential pipe", () => {
  it("starts Linux only with the isolated fixed interpreter and captured parent, and refuses controller methods", async () => {
    const fixture = create("linux");
    await expect(fixture.native.request("viewerSettings", { owner, target: "target" }))
      .rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(fixture.spawn).not.toHaveBeenCalled();
    const pending = fixture.native.request("configure", { owner }); const sent = await fixture.next();
    expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith("/usr/bin/python3", ["-I", "-B", "-u", "/signed/helper",
      "--serve", "/private/credentials", String(process.pid), process.execPath]);
    fixture.receipt(sent, "public.descriptor"); await expect(pending).resolves.toBe("public.descriptor");
    await fixture.close();
  });
  it("configures authenticated ordinary IDs and accepts only the typed nonsecret receipt", async () => {
    const fixture = create();
    const request = fixture.native.request("configure", { owner });
    const sent = await fixture.next();
    expect(sent).toMatchObject({ method: "configure", owner });
    fixture.receipt(sent, '{"version":1,"publicKey":{}}');
    await expect(request).resolves.toBe('{"version":1,"publicKey":{}}');
    await fixture.close();
  });

  it("does not start an unsupported platform, pre-aborted operation or extra-field identity", async () => {
    const fixture = create("win32");
    await expect(fixture.native.request("configure", { owner })).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(fixture.spawn).not.toHaveBeenCalled();
    const supported = create();
    const abort = new AbortController(); abort.abort();
    await expect(supported.native.request("status", {}, { signal: abort.signal })).rejects.toMatchObject({ code: "CREDENTIAL_CANCELLED" });
    const malformedOwner = { ...owner, token: "extra" };
    await expect(supported.native.request("configure", { owner: malformedOwner }))
      .rejects.toMatchObject({ code: "CREDENTIAL_INVALID_IDENTITY" });
    expect(supported.spawn).not.toHaveBeenCalled();
  });

  it("retains a dispatched operation after abort and exposes a late handle for exact cleanup", async () => {
    const fixture = create(), abort = new AbortController();
    const opening = fixture.native.request("begin", { peer: "target:paired", offer: "opaque.offer", descriptor: "{}" }, { signal: abort.signal });
    const sent = await fixture.next();
    abort.abort();
    expect(fixture.native.hasPendingEffect()).toBe(true);
    fixture.receipt(sent, { handle, offer: "host.offer" });
    await expect(opening).resolves.toEqual({ handle, offer: "host.offer" });
    const cleanup = fixture.native.request("closeHandle", { peer: "target:paired", handle });
    const closing = await fixture.next();
    expect(closing).toMatchObject({ method: "closeHandle", peer: "target:paired", handle });
    fixture.receipt(closing, true); await cleanup;
    await fixture.close();
  });

  it("holds an unknown native effect through kill failure and exit until actual close", async () => {
    const fixture = create();
    const operation = fixture.native.request("viewerPassword", { handle, useSaved: true, locale: "en", theme: "light" });
    const failure = expect(operation).rejects.toMatchObject({ code: "CREDENTIAL_OUTCOME_UNKNOWN" });
    const sent = await fixture.next();
    fixture.process.kill.mockReturnValue(false);
    let closed = false;
    const closing = fixture.native.close().then(() => { closed = true; });
    fixture.process.emit("exit", 77);
    fixture.receipt(sent, "late.packet");
    await Promise.resolve();
    expect(closed).toBe(false); expect(fixture.native.hasPendingEffect()).toBe(true);
    await expect(fixture.native.request("status", {})).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    fixture.process.emit("close", 77); await closing; await failure;
    await fixture.native.awaitSettlement(); expect(fixture.native.hasPendingEffect()).toBe(false);
  });

  it("keeps a read-only missing receipt known unavailable at actual close", async () => {
    const fixture = create();
    const reading = fixture.native.request("viewerSettings", { owner, target: "target:paired" });
    const failure = expect(reading).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    await fixture.next(); await fixture.close(); await failure;
  });

  it("retires on timeout without settling or replaying before actual close", async () => {
    const fixture = create("darwin", 10);
    const operation = fixture.native.request("begin", { peer: "target:paired", offer: "opaque", descriptor: "{}" });
    const failure = expect(operation).rejects.toMatchObject({ code: "CREDENTIAL_OUTCOME_UNKNOWN" });
    await fixture.next();
    await vi.waitFor(() => expect(fixture.process.kill).toHaveBeenCalled());
    expect(fixture.native.hasPendingEffect()).toBe(true);
    fixture.process.emit("close", 77); await failure; await fixture.native.awaitSettlement();
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it("sanitizes unknown errors and rejects malformed proof without exposing raw native text", async () => {
    const fixture = create();
    const pending = fixture.native.request("status", {}), sent = await fixture.next();
    fixture.stdout.write(`${JSON.stringify({ id: sent["id"], error: "arbitrary native diagnostic" })}\n`);
    await expect(pending).rejects.toMatchObject({ message: "CREDENTIAL_UNAVAILABLE", code: "CREDENTIAL_UNAVAILABLE" });
    const proof = fixture.native.request("status", {}), proofSent = await fixture.next();
    fixture.receipt(proofSent, { "target:paired": "invalid-session" });
    await expect(proof).rejects.toMatchObject({ code: "CREDENTIAL_INVALID_MESSAGE" });
    await fixture.close();
  });
});

function create(platform: NodeJS.Platform = "darwin", timeoutMs = 10_000) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
  const process = Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, kill: vi.fn(() => true) });
  const sent: Record<string, unknown>[] = [];
  stdin.setEncoding("utf8"); stdin.on("data", (line: string) => { sent.push(JSON.parse(line)); });
  const spawn = vi.fn<DesktopRemoteCredentialsNativeRuntime["spawn"]>(() => process);
  const native = new DesktopRemoteCredentialsNative({ platform, storageDirectory: "/private/credentials",
    timeoutMs, resolveBinary: async () => "/signed/helper", spawn });
  return { native, process, stdout, spawn,
    next: async (): Promise<Record<string, unknown>> => {
      await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0)); return sent.shift()!;
    },
    receipt: (request: Record<string, unknown>, result: unknown): void => { stdout.write(`${JSON.stringify({ id: request["id"], result })}\n`); },
    close: async (): Promise<void> => { const close = native.close(); process.emit("close", 0); await close; }
  };
}
