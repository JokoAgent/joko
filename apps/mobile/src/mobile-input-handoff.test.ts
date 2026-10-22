import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as contract from "@joko/contracts";
import type { PairedCredential } from "./network";
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, CryptoEncoding: { HEX: "hex" },
  digestStringAsync: async (_algorithm: string, value: string) => createHash("sha256").update(value, "utf8").digest("hex") }));
import { createMobileInputHandoffApi, mobileInputHandoffPresentationDigest, mobileInputHandoffSnapshot, readMobileInputHandoffTasks } from "./mobile-input-handoff";

const credential: PairedCredential = { profileId: "profile", origin: "https://node.example.test", serverId: "node", connectionId: "connection", deviceId: "phone", displayName: "Phone", authKey: "synthetic-owner-key" };
const step: contract.InputHandoffSnapshot = { kind: "input_handoff", requestId: "request-1", revision: 3, phase: "ready", remoteInput: true, purpose: "登录 🗝️", source: { app: "终端", origin: "https://example.test" },
  controls: [{ id: "secret", kind: "text", label: "密码", contentType: "password" }], stepNumber: 1 };
function ticket(relativeEndpoint = "/private-input/one") { return create(contract.CredentialUploadTicketSchema, { ticketId: "single-ticket", relativeEndpoint,
  maximumBytes: 128_000n, expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 60) } }); }
function fixture(input: { readonly begin?: () => void; readonly upload?: () => void; readonly endpoint?: string; readonly uncertain?: boolean } = {}) {
  const requests: unknown[] = [], lifetime = new AbortController(), uploaded: string[] = [];
  let current = true, bytes: Uint8Array | undefined;
  const send = vi.fn<typeof fetch>(async (_url, init) => { bytes = init!.body as Uint8Array; uploaded.push(new TextDecoder().decode(bytes)); input.upload?.(); return new Response(null, { status: 204 }); });
  const native = vi.fn(() => {});
  const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, {
    listInputHandoffs: request => { requests.push(request); return { states: [create(contract.InputHandoffStateSchema, { requestId: step.requestId, revision: 3n,
      phase: contract.InputHandoffStatePhase.READY, remoteInput: true, purpose: step.purpose, source: step.source, stepNumber: 1,
      controls: [{ id: "secret", control: { case: "text", value: { label: "密码", contentType: "password" } } }] })] }; },
    beginInputHandoffSubmission: request => { requests.push(request); input.begin?.(); return { ticket: ticket(input.endpoint) }; },
    submitInputHandoff: request => { requests.push(request); native(); if (input.uncertain) throw new Error("Unknown native outcome"); return { accepted: true }; },
    decideInputHandoff: request => { requests.push(request); return { accepted: true }; },
    readInputHandoffPicture: request => { requests.push(request); return { jpeg: new Uint8Array([0xff, 0xd8, 0xff]), width: 200, height: 100, qrText: "https://login.example.test/qr", qrUrl: "https://login.example.test/qr" }; }
  }));
  const api = createMobileInputHandoffApi({ credential, transport, fetch: send, scope: { ownerKey: "owner-session-generation", sessionId: "session", deviceId: credential.deviceId, signal: lifetime.signal,
    assertCurrent: signal => { signal.throwIfAborted(); if (!current) throw new Error("Owner retired"); } } });
  return { api, requests, lifetime, send, native, uploaded, bytes: () => bytes, retire: () => { current = false; } };
}
const signal = () => new AbortController().signal;
const submission = (): contract.InputHandoffSubmission => ({ expectedRevision: 3, values: { secret: "synthetic-private-password" }, action: { kind: "submit" } });

describe("native mobile private input channel", () => {
  it("reads only generated safe Home subjects without requesting or retaining private presentations", async () => {
    const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, { listInputHandoffTasks: () => ({ tasks: [
      { sessionId: "session", requestId: "request", generation: 8n, stepNumber: 1 }
    ] }) }));
    expect(await readMobileInputHandoffTasks(transport, signal())).toEqual([{ sessionId: "session", requestId: "request", generation: 8n, stepNumber: 1 }]);
  });
  it("uses Expo UTF-8 SHA-256 for the exact shared presentation, including non-ASCII labels", async () => {
    expect(await mobileInputHandoffPresentationDigest(step)).toBe(createHash("sha256").update(JSON.stringify(contract.inputHandoffPresentation(step)), "utf8").digest("hex"));
  });
  it("lists typed owner state, uploads only private bytes, then submits the one-time ticket without values", async () => {
    const f = fixture(); expect(await f.api.list(signal())).toEqual([step]);
    expect(await f.api.submit(step, submission(), signal())).toBe(true);
    expect(JSON.parse(f.uploaded[0]!)).toMatchObject(submission());
    expect(f.send).toHaveBeenCalledExactlyOnceWith("https://node.example.test/private-input/one", expect.objectContaining({ method: "PUT", redirect: "error", cache: "no-store", headers: {
      authorization: "Bearer synthetic-owner-key", "content-type": "application/octet-stream" } }));
    expect(f.bytes()!.every(value => value === 0)).toBe(true);
    expect(f.requests).toMatchObject([{ sessionId: "session" }, { requestId: "request-1", expectedRevision: 3n, presentationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { requestId: "request-1", expectedRevision: 3n, credentialUploadTicketId: "single-ticket" }]);
    expect(JSON.stringify(f.requests, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("synthetic-private-password");
  });
  it.each(["begin", "upload"] as const)("retires the captured owner after %s without sending the next phase", async stage => {
    let f: ReturnType<typeof fixture>; f = fixture({ [stage]: () => f.retire() });
    await expect(f.api.submit(step, submission(), signal())).rejects.toThrow("Owner retired");
    expect(f.native).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(stage === "upload" ? 1 : 0);
    if (f.bytes()) expect(f.bytes()!.every(value => value === 0)).toBe(true);
  });
  it.each(["//foreign.example.test/input", "/input?foreign=one", "https://foreign.example.test/input"])("refuses an unbounded or cross-origin private upload endpoint %s", async endpoint => {
    const f = fixture({ endpoint }); await expect(f.api.submit(step, submission(), signal())).rejects.toThrow("private input channel");
    expect(f.send).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled();
  });
  it("does not replay an uncertain native submission and refuses stale revisions or fields", async () => {
    const f = fixture({ uncertain: true }); await expect(f.api.submit(step, submission(), signal())).rejects.toThrow();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.native).toHaveBeenCalledOnce();
    expect(await f.api.submit(step, { ...submission(), expectedRevision: 2 }, signal())).toBe(false);
    expect(await f.api.submit(step, { ...submission(), values: { foreign: "value" } }, signal())).toBe(false);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.native).toHaveBeenCalledOnce();
  });
  it("reads a bounded picture privately and sends only the typed value-less decision", async () => {
    const f = fixture(); expect(await f.api.picture({ ...step, picture: true, qr: "scan" }, signal())).toMatchObject({ mime: "image/jpeg", width: 200, height: 100, qr: { text: "https://login.example.test/qr" } });
    expect(await f.api.decide(step, "claim", signal())).toBe(true);
    expect(f.requests).toMatchObject([{ presentationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) }, { decision: contract.InputHandoffDecisionKind.CLAIM, expectedRevision: 3n }]);
    f.lifetime.abort(); expect(f.api.isCurrent()).toBe(false); await expect(f.api.picture(step, signal())).rejects.toThrow(); expect(f.requests).toHaveLength(2);
  });
  it("rejects unknown generated shapes instead of fabricating a mobile field", () => {
    expect(() => mobileInputHandoffSnapshot(create(contract.InputHandoffStateSchema, { phase: contract.InputHandoffStatePhase.READY, requestId: "one", source: { app: "App" },
      controls: [{ id: "foreign", control: { case: "text", value: { contentType: "unknown" } } }] }))).toThrow("field");
  });
});
