import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { SshKeyManager } from "@joko/remote-ssh";
import { expect, it, vi } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { createSshKeyConnectService } from "./ssh-key-connect-service.js";

it("authenticates unavailable capability and fences late key observations on connection revocation", async () => {
  const context = { signal: new AbortController().signal } as HandlerContext;
  const denied = createSshKeyConnectService({ authenticate: () => { throw new ConnectError("Pair first", Code.Unauthenticated); }, onRevoked: () => () => undefined });
  await expect(denied.listSshKeys(create(contract.ListSshKeysRequestSchema), context)).rejects.toMatchObject({ code: Code.Unauthenticated });
  const unavailable = createSshKeyConnectService({ authenticate: () => ({ connectionId: "a" }), onRevoked: () => () => undefined });
  await expect(unavailable.listSshKeys(create(contract.ListSshKeysRequestSchema), context)).rejects.toMatchObject({ code: Code.Unimplemented });
  const directory = await mkdtemp(join(tmpdir(), "joko-ssh-service-"));
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let ownerSignal: AbortSignal | undefined;
  const keys = new SshKeyManager({ directory, agentCommand: async (_args, _input, signal) => {
    ownerSignal = signal; started();
    await new Promise<void>(resolve => { release = resolve; });
    return { code: 1, stdout: "The agent has no identities." };
  } });
  let revoked = (): void => undefined;
  const unsubscribe = vi.fn();
  const service = createSshKeyConnectService({ keys, authenticate: () => ({ connectionId: "a" }), onRevoked: (id, callback) => { expect(id).toBe("a"); revoked = callback; return unsubscribe; } });
  const listing = service.listSshKeys(create(contract.ListSshKeysRequestSchema), context);
  await entered;
  revoked();
  expect(ownerSignal?.aborted).toBe(true);
  release();
  await expect(listing).rejects.toMatchObject({ code: Code.Canceled, rawMessage: "ssh_key.aborted" });
  expect(unsubscribe).toHaveBeenCalledOnce();
  keys.close();
});

it("does not publish thrown process details", async () => {
  const keys = new SshKeyManager({ directory: await mkdtemp(join(tmpdir(), "joko-ssh-errors-")) });
  vi.spyOn(keys, "generate").mockRejectedValue(new Error("PRIVATE_PROCESS_OUTPUT"));
  const service = createSshKeyConnectService({ keys, authenticate: () => ({ connectionId: "a" }), onRevoked: () => () => undefined });
  await expect(service.generateSshKey(create(contract.GenerateSshKeyRequestSchema, { name: "id_joko" }), { signal: new AbortController().signal } as HandlerContext))
    .rejects.toMatchObject({ code: Code.Internal, rawMessage: "ssh_key.io_failed" });
  keys.close();
});

it("reports an uncertain mutation when its successful result loses the original connection authority", async () => {
  const keys = new SshKeyManager({ directory: await mkdtemp(join(tmpdir(), "joko-ssh-retirement-")) });
  let revoked = (): void => undefined;
  vi.spyOn(keys, "generate").mockImplementation(async () => {
    revoked();
    return { id: "id_joko", name: "id_joko", algorithm: "ssh-ed25519", comment: "", sha256Fingerprint: "SHA256:key", modifiedAt: 1, inAgent: false };
  });
  const service = createSshKeyConnectService({ keys, authenticate: () => ({ connectionId: "a" }), onRevoked: (_id, callback) => { revoked = callback; return () => undefined; } });
  await expect(service.generateSshKey(create(contract.GenerateSshKeyRequestSchema, { name: "id_joko" }), { signal: new AbortController().signal } as HandlerContext))
    .rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "ssh_key.outcome_unknown" });
  expect(keys.generate).toHaveBeenCalledOnce();
  keys.close();
});
