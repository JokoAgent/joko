import { Code, ConnectError } from "@connectrpc/connect";
import { DeviceKind } from "@joko/contracts";
import { EndpointTrustError } from "@joko/connection-transport/node";
import { expect, it, vi } from "vitest";
import { NodeDevicePeerAgentLifecycle } from "./node-agent-lifecycle.js";
import type { NodeDevicePeerAgentConnection } from "./node-agent-route.js";

const connection: NodeDevicePeerAgentConnection = {
  credentialId: "saved-connection", deviceId: "service-device", serverId: "saved-node",
  origin: "https://node-agent.example", endpointPublicKey: `ed25519:${"d".repeat(64)}`, expectedDeviceKind: DeviceKind.SERVICE
};

it.each(["identity", "revoked"])("suspends the saved Node route after %s failure until explicit authority recovery", async failure => {
  const retire = vi.fn(async () => undefined), wait = vi.fn(async () => undefined);
  const error = failure === "identity" ? new EndpointTrustError() : new ConnectError("Credential revoked.", Code.Unauthenticated);
  const runRoute = vi.fn<NonNullable<ConstructorParameters<typeof NodeDevicePeerAgentLifecycle>[0]["runRoute"]>>()
    .mockRejectedValueOnce(error).mockImplementation(async options => waitForAbort(options.signal));
  const lifecycle = new NodeDevicePeerAgentLifecycle({
    createExecutor: () => ({ capabilities: [], execute: vi.fn(), retire }),
    readAuthKey: async () => "A".repeat(43), readDefaultDeviceName: () => "Service",
    isAuthorityCurrent: () => true, runRoute, wait
  });
  try {
    lifecycle.setConnection(connection);
    await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
    lifecycle.setConnection({ ...connection });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runRoute).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();

    const recovered = { ...connection, endpointPublicKey: `ed25519:${"e".repeat(64)}` };
    lifecycle.setConnection(recovered);
    await vi.waitFor(() => expect(runRoute).toHaveBeenCalledTimes(2));
    expect(runRoute.mock.calls[1]![0].connection).toEqual(recovered);
  } finally { await lifecycle.dispose(); }
  expect(retire).toHaveBeenCalledTimes(2);
});

it("keeps bounded reconnection for a transient carrier failure under the same authority", async () => {
  const retire = vi.fn(async () => undefined), wait = vi.fn(async () => undefined);
  const runRoute = vi.fn<NonNullable<ConstructorParameters<typeof NodeDevicePeerAgentLifecycle>[0]["runRoute"]>>()
    .mockRejectedValueOnce(new Error("The carrier disconnected."))
    .mockImplementation(async options => waitForAbort(options.signal));
  const lifecycle = new NodeDevicePeerAgentLifecycle({
    createExecutor: () => ({ capabilities: [], execute: vi.fn(), retire }),
    readAuthKey: async () => "A".repeat(43), readDefaultDeviceName: () => "Service",
    isAuthorityCurrent: () => true, runRoute, wait
  });
  try {
    lifecycle.setConnection(connection);
    await vi.waitFor(() => expect(runRoute).toHaveBeenCalledTimes(2));
    expect(wait).toHaveBeenCalledExactlyOnceWith(500, expect.any(AbortSignal));
    expect(runRoute.mock.calls[1]![0].connection).toEqual(connection);
  } finally { await lifecycle.dispose(); }
  expect(retire).toHaveBeenCalledTimes(2);
});

it("retires the original route before adopting a changed transport or private SDK locator", async () => {
  const retire = vi.fn(async () => undefined);
  const runRoute = vi.fn<NonNullable<ConstructorParameters<typeof NodeDevicePeerAgentLifecycle>[0]["runRoute"]>>()
    .mockImplementation(async options => waitForAbort(options.signal));
  const lifecycle = new NodeDevicePeerAgentLifecycle({ createExecutor: () => ({ capabilities: [], execute: vi.fn(), retire }),
    readAuthKey: async () => "A".repeat(43), readDefaultDeviceName: () => "Service", isAuthorityCurrent: () => true, runRoute });
  try {
    lifecycle.setConnection(connection); await vi.waitFor(() => expect(runRoute).toHaveBeenCalledOnce());
    const selected = { ...connection, transportKind: "webrtc" as const, endpointTransport: { kind: "webrtc" as const } };
    lifecycle.setConnection(selected); await vi.waitFor(() => expect(runRoute).toHaveBeenCalledTimes(2));
    expect(runRoute.mock.calls[0]![0].signal.aborted).toBe(true); expect(retire).toHaveBeenCalledOnce();
    lifecycle.setConnection({ ...selected }); await new Promise<void>(resolve => setImmediate(resolve)); expect(runRoute).toHaveBeenCalledTimes(2);
    const sdk = { ...connection, transportKind: "iroh" as const, endpointTransport: { kind: "iroh" as const, endpointId: "a".repeat(64), ticket: "a".repeat(24) } };
    lifecycle.setConnection(sdk); await vi.waitFor(() => expect(runRoute).toHaveBeenCalledTimes(3));
    lifecycle.setConnection({ ...sdk, endpointTransport: { ...sdk.endpointTransport, ticket: "b".repeat(24) } });
    await vi.waitFor(() => expect(runRoute).toHaveBeenCalledTimes(4)); expect(runRoute.mock.calls[2]![0].signal.aborted).toBe(true);
  } finally { await lifecycle.dispose(); }
  expect(retire).toHaveBeenCalledTimes(4);
});

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
}
