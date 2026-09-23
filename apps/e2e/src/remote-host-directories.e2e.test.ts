import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { RemoteHostService } from "@joko/contracts";
import { RemoteHostRegistry } from "@joko/orchestrator";
import type { RemoteFileTransportPort } from "@joko/remote-ssh";
import { expect, it, vi } from "vitest";

import { OrchestratorE2eFixture } from "./fixture.js";

it("browses an authenticated current SSH Host over HTTP/SQLite without using the service-node filesystem", async () => {
  const files: RemoteFileTransportPort = {
    realpath: vi.fn(async path => path === "." ? "/home/fixture" : path),
    stat: vi.fn(async () => ({ kind: "directory" as const, size: 0, modifiedAt: 0, mode: 0o755 })),
    list: vi.fn(async path => path === "/home/fixture" ? [
      { name: "work", kind: "directory" as const }, { name: "readme.txt", kind: "file" as const }
    ] : []),
    read: async () => new Uint8Array(), write: async () => undefined,
    mkdir: async () => undefined, rename: async () => undefined, remove: async () => undefined
  };
  const capabilities = { commandExecution: false, processStreaming: false, fileTransfer: true, tcpForwarding: false, interactiveTerminal: false };
  const connect = vi.fn(async (request: Parameters<NonNullable<ConstructorParameters<typeof RemoteHostRegistry>[0]["connector"]>["connect"]>[0]) => {
    request.onAuthenticating();
    await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1, 2, 3) });
    return { capabilities, files, close: async () => undefined };
  });
  const fixture = await OrchestratorE2eFixture.start({ createAuxiliaryServices: async store => ({
    remoteHosts: new RemoteHostRegistry({ store, ownerId: "remote-directory-e2e", connector: { capabilities, connect } })
  }) });
  try {
    const targetId = [...fixture.targets.values()][0]!;
    const registry = fixture.application.remoteHosts!;
    const created = registry.create({ targetId, id: "host-one", hostname: "ssh-fixture.invalid", user: "fixture", source: "manual" });
    expect((await registry.connect(targetId, created.id, created.revision)).ok).toBe(true);
    const host = registry.get(targetId, created.id);
    const targetRevision = fixture.application.store.getTarget(targetId)!.revision;
    const paired = await fixture.pair("SSH directory browser");
    const client = (authKey?: string) => createClient(RemoteHostService, createConnectTransport({
      baseUrl: fixture.baseUrl, httpVersion: "1.1",
      interceptors: authKey === undefined ? [] : [next => request => { request.header.set("authorization", `Bearer ${authKey}`); return next(request); }]
    }));
    const request = { targetId, hostId: host.id, expectedTargetRevision: { value: targetRevision },
      expectedHostRevision: { value: host.revision }, path: "" };
    await expect(client().listRemoteHostDirectories(request)).rejects.toMatchObject({ code: Code.Unauthenticated });
    const listing = await client(paired.authKey).listRemoteHostDirectories(request);
    expect(listing).toMatchObject({ targetId, hostId: host.id, path: "/home/fixture", parentPath: "/home",
      directories: [{ name: "work", path: "/home/fixture/work" }] });
    expect(listing.directories).toHaveLength(1);
    expect(files.realpath).toHaveBeenCalledWith(".", expect.any(AbortSignal));
    await expect(client(paired.authKey).listRemoteHostDirectories({ ...request, expectedHostRevision: { value: host.revision - 1n } }))
      .rejects.toMatchObject({ code: Code.Aborted });
    await expect(client(paired.authKey).listRemoteHostDirectories({ ...request, path: "D:/service-node" }))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(connect).toHaveBeenCalledOnce();
  } finally {
    await fixture.close();
  }
});
