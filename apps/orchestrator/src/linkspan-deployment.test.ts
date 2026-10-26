import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { formatTrustedNodeInvitation, parseTrustedNodeInvitation } from "@joko/connection-transport/trust";
import { linkspanHttpConnectTransport, linkspanMediaUdpEntryId, readLinkspanDeployment, resolvePreparedPinggySdkDirectory } from "./linkspan-deployment.js";

// Permission inspection has separate OS-specific tests. These cases exercise
// the deployment format using real bounded file reads, without provider effects.
vi.mock("@joko/remote-ssh", () => ({
  inspectKeyDirectoryPermissions: vi.fn(async () => {}),
  inspectPrivateKeyPermissions: vi.fn(async () => ({ verifyFinal: async () => {}, close: async () => {} }))
}));

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function read(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "joko-linkspan-deployment-")); directories.push(directory);
  const path = join(directory, "deployment.json"); await writeFile(path, JSON.stringify(value));
  return readLinkspanDeployment(path, new AbortController().signal, { resolveRuntime: false });
}

it("supports UDP-only deployment and separate NetBird resource management without an HTTP entrance", async () => {
  const entry = { id: "media", mediaUdp: { provider: "netbird", setupKey: "private-peer-key" },
    mediaUdpManagement: { provider: "netbird", mode: "udp", managementUrl: "https://management.example", domain: "udp.example", peerId: "media-peer", targetPort: 45000, listenPort: 0, tokenPath: "private-token-file" } };
  expect(await read([entry])).toEqual([entry]);
  expect((await read([entry]))[0]).not.toHaveProperty("connector");
  const paired = { ...entry, connector: { provider: "localtunnel" } };
  expect(await read([paired])).toEqual([paired]);
});

it("rejects mismatched or missing UDP management scope before creating any resource", async () => {
  const mediaUdp = { provider: "netbird" };
  for (const value of [
    { id: "media" },
    { id: "media", mediaUdp, management: { provider: "netbird" } },
    { id: "media", mediaUdp, mediaUdpManagement: { provider: "netbird", mode: "tcp" } },
    { id: "media", mediaUdp: { provider: "pangolin" }, mediaUdpManagement: { provider: "netbird", mode: "udp" } },
    { id: "media", mediaUdp, mediaUdpManagement: { provider: "cloudflare", mode: "udp" } },
    { id: "media", mediaUdp: { provider: "localtunnel" } },
    { id: "media", mediaUdp: { provider: "pinggy", runtime: "ssh" } },
    { id: "media", mediaUdp: { provider: "pinggy" } }
  ]) await expect(read([value])).rejects.toThrow(/invalid/u);
});

it("keeps independently configured HTTP/TCP and UDP entrances intact for offline administration", async () => {
  const entries = [
    { id: "frp-http", connector: { provider: "frp", mode: "http", publicOrigin: "https://http.example" } },
    { id: "frp-udp", mediaUdp: { provider: "frp", serverAddress: "relay.example", remotePort: 45000, publicHost: "udp.example", publicPort: 45000 } },
    { id: "rathole-udp", mediaUdp: { provider: "rathole", remoteAddress: "relay.example:2333", serviceName: "media", publicHost: "udp.example", publicPort: 45001 } },
    { id: "pinggy-tcp", connector: { provider: "pinggy", runtime: "sdk", mode: "tcp", publicOrigin: "https://tcp.example:45002" } },
    { id: "pinggy-tlstcp", connector: { provider: "pinggy", runtime: "sdk", mode: "tlstcp", tlstcpEndpoint: "tcp", publicOrigin: "https://tcp.example:443", budget: { paidEnabled: true } } },
    { id: "pinggy-udp", mediaUdp: { provider: "pinggy", runtime: "sdk" } }
  ];
  const restored = await read(entries);
  expect(restored).toEqual(entries);
  for (const entry of restored.filter(value => value.mediaUdp !== undefined)) expect(entry).not.toHaveProperty("connector");
  await expect(read([{ ...entries[5], mediaUdpManagement: { provider: "netbird", mode: "udp" } }])).rejects.toThrow(/invalid/u);
});

it("binds tcpmux to its explicit CONNECT proxy and canonical logical authority without putting the proxy in origin", async () => {
  const connector = { provider: "frp", mode: "tcpmux", publicOrigin: "https://node.example:8443", publicProxyOrigin: "http://relay.example:1337" };
  const [entry] = await read([{ id: "mux", connector }]);
  expect(linkspanHttpConnectTransport(entry!.connector!)).toEqual({ kind: "http-connect", proxyOrigin: connector.publicProxyOrigin, authority: "node.example:8443" });
  const [defaultPort] = await read([{ id: "default", connector: { ...connector, publicOrigin: "https://node.example" } }]);
  expect(linkspanHttpConnectTransport(defaultPort!.connector!)?.authority).toBe("node.example:443");
  const endpointTransport = linkspanHttpConnectTransport(entry!.connector!)!;
  const invitation = formatTrustedNodeInvitation({ origin: connector.publicOrigin, serverId: "original-node",
    endpointPublicKey: `ed25519:${"a".repeat(64)}`, endpointTransport });
  expect(parseTrustedNodeInvitation(invitation)).toEqual({ version: 1, origin: connector.publicOrigin, serverId: "original-node",
    endpointPublicKey: `ed25519:${"a".repeat(64)}`, endpointTransport });
  for (const publicProxyOrigin of [undefined, "ftp://relay.example", "http://relay.example/", "http://owner:secret@relay.example", "http://relay.example/path"]) {
    await expect(read([{ id: "mux", connector: { ...connector, publicProxyOrigin } }])).rejects.toThrow();
  }
  await expect(read([{ id: "mux", connector: { ...connector, publicOrigin: "https://node.example/path" } }])).rejects.toThrow();
});

it("requires explicit owned relays before restricted iroh lease issuance while allowing explicit direct-only mode", async () => {
  const connector = { provider: "iroh", invitationDirectory: "private-invitations", secretKeyHex: "a".repeat(64) };
  expect(await read([{ id: "direct", connector: { ...connector, relayUrls: [] } }])).toHaveLength(1);
  for (const relayUrls of [undefined, []]) await expect(read([{ id: "restricted", connector: { ...connector, relayUrls, servicesApiSecretPath: "private-services-secret" } }])).rejects.toThrow(/before lease issuance/u);
  expect(await read([{ id: "restricted", connector: { ...connector, relayUrls: ["https://owned-relay.example"], servicesApiSecretPath: "private-services-secret" } }])).toHaveLength(1);
});

it("derives a stable bounded UDP namespace for every valid entry length and keeps HTTP identity separate", () => {
  const id = "a".repeat(64); const derived = linkspanMediaUdpEntryId(id);
  expect(derived).toMatch(/^udp-[a-f0-9]{40}$/u);
  expect(derived).toBe(linkspanMediaUdpEntryId(id)); expect(derived).not.toBe(id);
  expect(linkspanMediaUdpEntryId("udp-" + "a".repeat(60))).not.toBe(derived);
});

it("resolves the actual version/target/ABI SDK layout from a selected relocatable receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-pinggy-receipt-")); directories.push(directory);
  const target = `${process.platform}-${process.arch}`;
  const sdkDirectory = `pinggy/pinggy-0.5.3/${target}/node-137`;
  const selected = { target, backends: ["pinggy-sdk"], prepared: { pinggy: { target, nodeAbi: "137", version: "0.5.3", sdkDirectory } } };
  const actual = join(directory, ...sdkDirectory.split("/"));
  await mkdir(join(actual, "dist"), { recursive: true }); await writeFile(join(actual, "dist", "index.js"), "selected-sdk");
  expect(await readFile(join(resolvePreparedPinggySdkDirectory(directory, selected), "dist", "index.js"), "utf8")).toBe("selected-sdk");
  for (const path of ["pinggy", "../pinggy", "/pinggy/node-137", "C:/pinggy/node-137", "pinggy/../outside", "pinggy\\node-137", "pinggy//node-137", "pinggy/pinggy-0.5.3/linux-other/node-137"]) {
    expect(() => resolvePreparedPinggySdkDirectory(directory, { ...selected, prepared: { pinggy: { ...selected.prepared.pinggy, sdkDirectory: path } } })).toThrow();
  }
  for (const value of [null, {}, { ...selected, target: "other-target" }, { ...selected, backends: [] },
    { ...selected, prepared: {} }, { ...selected, prepared: { pinggy: { ...selected.prepared.pinggy, nodeAbi: "148" } } },
    { ...selected, prepared: { pinggy: { ...selected.prepared.pinggy, version: "0.5.4" } } }]) {
    expect(() => resolvePreparedPinggySdkDirectory(directory, value)).toThrow();
  }
});
