import { create } from "@bufbuild/protobuf";
import { ConnectError, Code, type Transport } from "@connectrpc/connect";
import { SshAgentState, SshInstallShell, SshKeyPassphrasePurpose } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("sends SSH passphrases only over the ticket upload channel and preserves key and host fences in generated RPCs", async () => {
  const fixture = await mount();
  const uploads: string[] = []; const buffers: Uint8Array[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    uploads.push(new TextDecoder().decode(init.body as Uint8Array)); buffers.push(init.body as Uint8Array);
    return new Response(undefined, { status: 204 });
  }); vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await expect(fixture.gateway.listSshKeys(signal)).resolves.toEqual({ keys: [{ id: "opaque-key", name: "work-key", algorithm: "ssh-ed25519", comment: "Work", sha256Fingerprint: "SHA256:observed", modifiedAt: 2500, inAgent: true }], generationSupported: true, agentState: "ready" });
  await fixture.gateway.generateSshKey({ name: "", comment: "new-key", passphrase: "generation-test-secret" }, signal);
  await fixture.gateway.addSshKeyToAgent("opaque-key", "SHA256:observed", "agent-test-secret", signal);
  await expect(fixture.gateway.readSshPublicKey("opaque-key", "SHA256:observed", signal)).resolves.toBe("ssh-ed25519 AAAA Work");
  await expect(fixture.gateway.getSshKeyInstallCommand({ keyId: "opaque-key", expectedFingerprint: "SHA256:observed", destination: { kind: "savedHost", targetId: "project", hostId: "host", expectedRevision: 9n }, shell: "powershell" }, signal)).resolves.toBe("fixture-command");
  expect(uploads).toEqual(["generation-test-secret", "agent-test-secret"]);
  expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  expect(fetch).toHaveBeenCalledWith("https://service.example/v1/credential-uploads/ssh-ticket", expect.objectContaining({ method: "PUT", signal: expect.any(AbortSignal), headers: { authorization: "Bearer fixture-auth", "content-type": "application/octet-stream" } }));
  expect(fixture.requests.filter((entry) => entry.method === "beginSshKeyPassphraseUpload").map((entry) => entry.input)).toEqual([
    expect.objectContaining({ purpose: SshKeyPassphrasePurpose.GENERATE }),
    expect.objectContaining({ purpose: SshKeyPassphrasePurpose.AGENT_ADD, keyId: "opaque-key", expectedFingerprint: "SHA256:observed" })
  ]);
  expect(fixture.requests.find((entry) => entry.method === "generateSshKey")!.input).toMatchObject({ name: "", comment: "new-key", passphraseUploadTicketId: "ssh-ticket" });
  expect(fixture.requests.find((entry) => entry.method === "addSshKeyToAgent")!.input).toMatchObject({ keyId: "opaque-key", expectedFingerprint: "SHA256:observed", passphraseUploadTicketId: "ssh-ticket" });
  expect(fixture.requests.find((entry) => entry.method === "getSshKeyInstallCommand")!.input).toMatchObject({ destination: { case: "savedHost", value: { targetId: "project", hostId: "host", expectedRevision: { value: 9n } } }, shell: SshInstallShell.POWERSHELL });
  const rpcText = JSON.stringify(fixture.requests, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  expect(rpcText).not.toContain("generation-test-secret"); expect(rpcText).not.toContain("agent-test-secret");
  expect(fixture.requests.some((entry) => entry.method === "submitOperation" || entry.method === "beginCredentialUpload")).toBe(false);
  fixture.gateway.disconnect();
});

it("does not allocate an upload for explicit unencrypted actions or replay a rejected mutation", async () => {
  const fixture = await mount(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const signal = new AbortController().signal;
  await fixture.gateway.generateSshKey({ name: "", comment: "" }, signal);
  fixture.failure = new ConnectError("ssh_key.bad_passphrase", Code.InvalidArgument);
  await expect(fixture.gateway.addSshKeyToAgent("opaque-key", "SHA256:observed", undefined, signal)).rejects.toMatchObject({ rawMessage: "ssh_key.bad_passphrase", code: Code.InvalidArgument });
  expect(fetch).not.toHaveBeenCalled(); expect(fixture.requests.filter((entry) => entry.method === "addSshKeyToAgent")).toHaveLength(1);
  expect(fixture.requests.some((entry) => entry.method === "beginSshKeyPassphraseUpload")).toBe(false);
  expect(fixture.requests.find((entry) => entry.method === "generateSshKey")!.input.passphraseUploadTicketId).toBeUndefined();
  fixture.gateway.disconnect();
});

it.each(["generate:ticket", "generate:put", "generate:mutation", "agent:ticket", "agent:put", "agent:mutation"] as const)("retires the entire original connection chain during %s", async (scenario) => {
  const [action, stage] = scenario.split(":"); const entered = deferred(); const release = deferred();
  const fixture = await mount(); const calls: string[] = [];
  const pause = async (step: string) => { calls.push(step); if (stage === step) { entered.resolve(); await release.promise; } };
  fixture.pause = pause;
  vi.stubGlobal("fetch", vi.fn(async () => { await pause("put"); return new Response(undefined, { status: 204 }); }));
  const caller = new AbortController();
  const pending = (action === "generate" ? fixture.gateway.generateSshKey({ name: "", comment: "", passphrase: "test-secret" }, caller.signal)
    : fixture.gateway.addSshKeyToAgent("opaque-key", "SHA256:observed", "test-secret", caller.signal)).then(() => undefined, (cause: unknown) => cause);
  await entered.promise; const admitted = [...calls];
  if (stage === "ticket") caller.abort(); else fixture.gateway.disconnect();
  release.resolve();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(calls).toEqual(admitted);
  expect(fixture.requests.filter((entry) => entry.method.includes("SshKey")).every((entry) => entry.signal?.aborted === true)).toBe(true);
  fixture.gateway.disconnect();
});

async function mount() {
  const requests: { method: string; input: any; signal?: AbortSignal }[] = [];
  const key = { id: "opaque-key", name: "work-key", algorithm: "ssh-ed25519", comment: "Work", sha256Fingerprint: "SHA256:observed", modifiedAt: { seconds: 2n, nanos: 500_000_000 }, inAgent: true };
  const transport = {
    unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
      requests.push({ method: method.localName, signal, input }); let value: object;
      switch (method.localName) {
        case "getSnapshot": value = { snapshot: {} }; break;
        case "listSshKeys": value = { keys: [key], generationSupported: true, agentState: SshAgentState.READY }; break;
        case "readSshPublicKey": value = { publicKey: "ssh-ed25519 AAAA Work" }; break;
        case "getSshKeyInstallCommand": value = { command: "fixture-command" }; break;
        case "beginSshKeyPassphraseUpload": await fixture.pause?.("ticket"); value = { ticket: { ticketId: "ssh-ticket", relativeEndpoint: "/v1/credential-uploads/ssh-ticket", maximumBytes: 1024n } }; break;
        case "generateSshKey": case "addSshKeyToAgent":
          await fixture.pause?.("mutation"); if (fixture.failure !== undefined) throw fixture.failure;
          value = method.localName === "generateSshKey" ? { key } : {}; break;
        default: throw new Error(`Unexpected RPC ${method.localName}`);
      }
      return response(method, create(method.output, value));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "profile", deviceId: "device", name: "Node", origin: "https://service.example", serverId: "node" }, "fixture-auth", {}, () => transport);
  const fixture = { gateway, requests, pause: undefined as undefined | ((step: string) => Promise<void>), failure: undefined as ConnectError | undefined };
  await gateway.connect(); return fixture;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve }; }
function response(method: any, message: any, stream = false): any { return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message }; }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
