import Fastify from "fastify";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { createProviderSharingRemote } from "./provider-sharing-home.js";
import { PROVIDER_SHARING_SOURCE_DEVICE_HEADER } from "./provider-sharing-host.js";

it("rechecks the independent server identity before each authenticated request and never follows a credential redirect", async () => {
  const server = Fastify({ logger: false }), trap = Fastify({ logger: false });
  const identityAuth: (string | undefined)[] = [], guestAuth: (string | undefined)[] = [], trapAuth: (string | undefined)[] = [];
  let serverId = "original-home", redirect = false;
  trap.all("/*", async request => { trapAuth.push(request.headers.authorization); return {}; });
  await trap.listen({ host: "127.0.0.1", port: 0 }); const trapAddress = trap.server.address(); if (!trapAddress || typeof trapAddress === "string") throw new Error("Missing redirect trap.");
  server.addHook("onRequest", async (request, reply) => {
    if (request.url.includes("ConnectionService/GetServerInfo")) identityAuth.push(request.headers.authorization);
    if (request.url.includes("ProviderSharingGuestService/ReadProviderShare")) {
      guestAuth.push(request.headers.authorization); expect(request.headers[PROVIDER_SHARING_SOURCE_DEVICE_HEADER]).toBe("original-source");
      if (redirect) return reply.code(307).header("location", `http://127.0.0.1:${trapAddress.port}/other`).send();
    }
  });
  await server.register(fastifyConnectPlugin, { routes: router => {
    router.service(contract.ConnectionService, { getServerInfo: () => create(contract.GetServerInfoResponseSchema, { server: { serverId } }) });
    router.service(contract.ProviderSharingGuestService, { readProviderShare: () => create(contract.ReadProviderShareResponseSchema, { share: { shareId: "share", hostServerId: serverId } }) });
  } });
  await server.listen({ host: "127.0.0.1", port: 0 }); const address = server.server.address(); if (!address || typeof address === "string") throw new Error("Missing Provider sharing listener.");
  const remote = createProviderSharingRemote({ origin: `http://127.0.0.1:${address.port}`, serverId: "original-home", sourceDeviceId: "original-source",
    authorization: () => `ProviderShareGuest ${"s".repeat(43)}`, assertCurrent: () => {} });
  try {
    await remote.guest.readProviderShare({ shareId: "share" }); expect(identityAuth).toEqual([undefined]); expect(guestAuth).toHaveLength(1);
    serverId = "replacement-home"; await expect(remote.guest.readProviderShare({ shareId: "share" })).rejects.toMatchObject({ code: Code.PermissionDenied });
    expect(identityAuth).toEqual([undefined, undefined]); expect(guestAuth).toHaveLength(1);
    serverId = "original-home"; redirect = true; await expect(remote.guest.readProviderShare({ shareId: "share" })).rejects.toBeDefined();
    expect(guestAuth).toHaveLength(2); expect(trapAuth).toEqual([]); expect(identityAuth.every(value => value === undefined)).toBe(true);
  } finally { await server.close(); await trap.close(); }
});
