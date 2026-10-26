import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { type Transport } from "@connectrpc/connect";
import { ConnectionState, OperationState } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createDesktopRemoteDesktopControllerDirectory } from "../src/remote-desktop-controller-directory.js";

function fixture() {
  let current = true, serverId = "node", connected = true, unknown = false;
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const transport: Transport = {
    async unary(method, _signal, _timeout, _header, input) {
      const body = input as Record<string, unknown>; calls.push({ name: method.localName, input: body });
      if (method.localName === "submitOperation" && unknown) throw new Error("outcome unknown");
      const output = method.localName === "getServerInfo" ? { server: { serverId } }
        : method.localName === "getConnection" ? { connection: { connectionId: "profile", deviceId: "host", state: connected ? ConnectionState.CONNECTED : ConnectionState.DISCONNECTED } }
        : method.localName === "getDevice" ? { device: { deviceId: body["deviceId"], displayName: "  My Phone  " } }
        : { operation: { operationId: body["operationId"], connectionId: "profile", state: OperationState.SUCCEEDED } };
      return { stream: false, method, service: method.parent, header: new Headers(), trailer: new Headers(), message: create(method.output, output as unknown as MessageInitShape<typeof method.output>) };
    }, stream() { throw new Error("Unexpected stream"); }
  };
  const readAuthKey = vi.fn(async () => "A".repeat(43)), factory = vi.fn(() => transport);
  const directory = createDesktopRemoteDesktopControllerDirectory({ profileId: "profile", serverId: "node", deviceId: "host", origin: "https://node.example",
    endpointPublicKey: `ed25519:${"e".repeat(64)}`,
    current: () => current, readAuthKey, transport: factory });
  return { directory, calls, readAuthKey, factory, retire: () => { current = false; }, replace: () => { serverId = "other"; }, disconnect: () => { connected = false; }, loseReceipt: () => { unknown = true; } };
}

it("reads a device name and revokes its controller access on the original authenticated node", async () => {
  const f = fixture(); await expect(f.directory.name("phone")).resolves.toBe("My Phone");
  await f.directory.revoke("phone");
  const effects = f.calls.filter(call => call.name === "submitOperation"); expect(effects).toHaveLength(1);
  expect(effects[0]!.input).toMatchObject({ connectionId: "profile", mutation: { payload: { case: "setDeviceControllerAllowed", value: { controllerDeviceId: "phone", allowed: false } } } });
  expect(f.factory).toHaveBeenCalledWith("https://node.example"); expect(f.factory).toHaveBeenCalledWith("https://node.example", "A".repeat(43));
});

it.each(["retire", "replace", "disconnect"] as const)("refuses a %s host binding before revocation", async boundary => {
  const f = fixture(); f[boundary](); await expect(f.directory.revoke("phone")).rejects.toThrow("REMOTE_DESKTOP_ACCESS_REVOKED");
  expect(f.calls.some(call => call.name === "submitOperation")).toBe(false);
});

it("does not replay a mutation when its outcome is unknown", async () => {
  const f = fixture(); f.loseReceipt();
  await expect(f.directory.revoke("phone")).rejects.toThrow();
  expect(f.calls.filter(call => call.name === "submitOperation")).toHaveLength(1);
});
