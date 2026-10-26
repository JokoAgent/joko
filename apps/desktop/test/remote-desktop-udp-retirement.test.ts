import { createRouterTransport } from "@connectrpc/connect";
import { ConnectionService, DesktopHostedAgentService } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { expect, it, vi } from "vitest";
import { createDesktopRemoteDesktopUdpRetirement } from "../src/remote-desktop-udp-retirement.js";

function fixture(input: { readonly enabled?: boolean; readonly wrongServer?: boolean } = {}) {
  let current = true; let unavailable = false;
  const readAuthKey = vi.fn(async () => "a".repeat(43)), readHostKey = vi.fn(async () => "h".repeat(43));
  const calls: unknown[] = [];
  const transport = createRouterTransport(({ service }) => {
    service(ConnectionService, { getServerInfo: () => ({ server: { serverId: input.wrongServer ? "replacement-node" : "node" } }) });
    service(DesktopHostedAgentService, {
      getDesktopMediaUdpPolicy: (_request, context) => { expect(context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER)).toBe(`Bearer ${"h".repeat(43)}`); return { format: 1, retirementRequired: input.enabled ?? true }; },
      retireDesktopMediaUdp: (request, context) => { expect(context.requestHeader.get("authorization")).toBe(`Bearer ${"a".repeat(43)}`); expect(context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER)).toBe(`Bearer ${"h".repeat(43)}`); calls.push(request); if (unavailable) throw new Error("unconfirmed"); return { format: 1 }; }
    });
  });
  return { options: { connection: { profileId: "host-connection", deviceId: "local-main", serverId: "node", name: "Node", origin: "http://127.0.0.1:4318" }, readAuthKey, readHostKey, current: () => current, transport },
    retire: () => { current = false; }, fail: (value: boolean) => { unavailable = value; }, calls, readAuthKey, readHostKey };
}
it("pins the local node before Main secrets and keeps captured cleanup usable after business retirement", async () => {
  const f = fixture(); const cleanup = await createDesktopRemoteDesktopUdpRetirement(f.options); expect(cleanup).toBeTypeOf("function");
  f.retire(); await cleanup!("original-lease", "original-attempt");
  expect(f.calls).toEqual([expect.objectContaining({ connectionId: "host-connection", leaseId: "original-lease", attemptId: "original-attempt" })]);
  expect(f.readHostKey).toHaveBeenCalledTimes(1);
});
it("does not read private keys before node identity or create a cleanup gate when UDP is not selected", async () => {
  const wrong = fixture({ wrongServer: true }); await expect(createDesktopRemoteDesktopUdpRetirement(wrong.options)).rejects.toThrow(/identity/u);
  expect(wrong.readAuthKey).not.toHaveBeenCalled(); expect(wrong.readHostKey).not.toHaveBeenCalled();
  const disabled = fixture({ enabled: false }); expect(await createDesktopRemoteDesktopUdpRetirement(disabled.options)).toBeUndefined(); expect(disabled.calls).toEqual([]);
  await expect(createDesktopRemoteDesktopUdpRetirement({ ...disabled.options, connection: { ...disabled.options.connection, origin: "https://remote.example" } })).rejects.toThrow(/local/u);
});
it("rejects an unknown reply and retries only the same original cleanup identity", async () => {
  const f = fixture(); const cleanup = await createDesktopRemoteDesktopUdpRetirement(f.options); f.fail(true);
  await expect(cleanup!("original-lease", "original-attempt")).rejects.toBeDefined(); f.fail(false); await cleanup!("original-lease", "original-attempt");
  expect(f.calls).toHaveLength(2); expect(f.calls[0]).toEqual(f.calls[1]);
});
