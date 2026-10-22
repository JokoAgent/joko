import { createClient, createRouterTransport, Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { expect, it, vi } from "vitest";
import { createDesktopHostedAgentDelegate, probeDesktopHostedAgentDelegate } from "./hosted-agent-delegate.js";

function fixture(serverId = "managed-hub") {
  let current = true, next = 0, failClose = false;
  const calls: contract.InvokeDesktopHostedAgentDelegateRequest[] = [], closed: string[] = [];
  const instances: string[] = [];
  const check = (header: Headers) => {
    expect(header.get("authorization")).toBe(`Bearer ${"a".repeat(43)}`);
    expect(header.get(DESKTOP_HOST_AUTHORIZATION_HEADER)).toBe(`Bearer ${"h".repeat(43)}`);
  };
  const transport = createRouterTransport(({ service }) => {
    service(contract.ConnectionService, { getServerInfo: () => ({ server: { serverId } }) });
    service(contract.DesktopHostedAgentService, {
      openDesktopHostedAgentDelegate: (request, context) => {
        check(context.requestHeader); instances.push(request.routeInstanceId);
        return { format: 1, delegateId: (++next === 1 ? "o" : "n").repeat(43), serverId };
      },
      invokeDesktopHostedAgentDelegate: (request, context) => {
        check(context.requestHeader); calls.push(request);
        return { format: 1, responseBytes: new Uint8Array([4, 0, 255]) };
      },
      closeDesktopHostedAgentDelegate: (request, context) => {
        check(context.requestHeader);
        if (failClose) { failClose = false; throw new ConnectError("Native cleanup is pending.", Code.Unavailable); }
        closed.push(request.delegateId); return { format: 1 };
      }
    });
  });
  const readAuthKey = vi.fn(async () => "a".repeat(43)), readHostKey = vi.fn(async () => "h".repeat(43));
  const options = { connection: { profileId: "managed-profile", deviceId: "desktop-device", serverId: "managed-hub", name: "Local Joko", origin: "http://127.0.0.1:4318" },
    readAuthKey, readHostKey, isAuthorityCurrent: () => current, transport };
  return { options, calls, closed, instances, readAuthKey, readHostKey, setCurrent: (value: boolean) => { current = value; }, failClose: () => { failClose = true; } };
}

it("proves the managed service identity before reading either Main credential and rejects network origins", async () => {
  const f = fixture("replacement-hub");
  await expect(createDesktopHostedAgentDelegate(f.options)).rejects.toThrow("identity changed");
  expect(f.readAuthKey).not.toHaveBeenCalled(); expect(f.readHostKey).not.toHaveBeenCalled();
  await expect(createDesktopHostedAgentDelegate({ ...f.options, connection: { ...f.options.connection, origin: "https://remote.example" } })).rejects.toThrow("loopback");
  expect(f.readAuthKey).not.toHaveBeenCalled(); expect(f.instances).toEqual([]);
});

it("keeps original Device attribution and binary bytes, while retired-route cleanup cannot touch the replacement delegate", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const old = await createDesktopHostedAgentDelegate(f.options), replacement = await createDesktopHostedAgentDelegate(f.options);
  expect(f.instances).toHaveLength(2); expect(f.instances[0]).not.toBe(f.instances[1]);
  try {
    expect(await old.invoke(contract.HostedAgentPeerMethod.GET_CATALOG, new Uint8Array([0, 255]), signal, { controllerDeviceId: "original-source-device" }))
      .toEqual(new Uint8Array([4, 0, 255]));
    expect(f.calls[0]).toMatchObject({ delegateId: "o".repeat(43), controllerDeviceId: "original-source-device", requestBytes: new Uint8Array([0, 255]) });
    await expect(old.invoke(999 as contract.HostedAgentPeerMethod, new Uint8Array(), signal, { controllerDeviceId: "source" })).rejects.toThrow("invalid");
    expect(f.calls).toHaveLength(1);
    f.setCurrent(false); f.failClose();
    await expect(old.invoke(contract.HostedAgentPeerMethod.GET_SETTINGS, new Uint8Array(), signal, { controllerDeviceId: "source" })).rejects.toThrow("retired");
    await expect(old.retire()).rejects.toBeDefined(); await old.retire(); await old.retire();
    expect(f.closed).toEqual(["o".repeat(43)]);
    f.setCurrent(true);
    await replacement.invoke(contract.HostedAgentPeerMethod.GET_CATALOG, new Uint8Array([2]), signal, { controllerDeviceId: "another-source-device" });
    expect(f.calls[1]).toMatchObject({ delegateId: "n".repeat(43), controllerDeviceId: "another-source-device" });
  } finally { await old.retire(); await replacement.retire(); }
  expect(f.closed).toEqual(["o".repeat(43), "n".repeat(43)]);
});

it("requires both committed credentials before it can offer a native port", async () => {
  const f = fixture();
  await expect(createDesktopHostedAgentDelegate({ ...f.options, readHostKey: async () => undefined })).rejects.toThrow("authorization is unavailable");
  expect(f.instances).toEqual([]);
  // The normal owner service remains separate from the private delegate service.
  const owner = createClient(contract.ConnectionService, f.options.transport);
  expect((await owner.getServerInfo({})).server?.serverId).toBe("managed-hub");
});

it("retries an uncertain recovery-probe cleanup on the captured delegate without allocating a replacement", async () => {
  const f = fixture(); f.failClose();
  expect(await probeDesktopHostedAgentDelegate({ ...f.options, signal: new AbortController().signal })).toBe(true);
  expect(f.instances).toHaveLength(1); expect(f.closed).toEqual(["o".repeat(43)]); expect(f.calls).toEqual([]);
});
