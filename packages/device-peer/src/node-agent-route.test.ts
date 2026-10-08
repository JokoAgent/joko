import { create } from "@bufbuild/protobuf";
import {
  DeviceKind,
  DevicePeerAgentRouteAcceptedSchema,
  DevicePeerCapabilityKind,
  DevicePeerRetireReason,
  DevicePeerRetireRouteSchema,
  type OpenDevicePeerAgentRouteRequest,
  OpenDevicePeerAgentRouteResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  type NodeDevicePeerAgentRoutePort,
  runNodeDevicePeerAgentRoute
} from "./node-agent-route.js";

const CAPABILITIES = Object.freeze([
  DevicePeerCapabilityKind.FILES,
  DevicePeerCapabilityKind.PROCESS,
  DevicePeerCapabilityKind.TERMINAL,
  DevicePeerCapabilityKind.FORWARDING,
  DevicePeerCapabilityKind.REMOTE_DESKTOP
]);

describe("Node Device peer agent route capabilities", () => {
  it("admits the complete current-v1 capability set including Remote Desktop", async () => {
    const retire = vi.fn(async () => undefined);
    const outbound: OpenDevicePeerAgentRouteRequest[] = [];
    const port: NodeDevicePeerAgentRoutePort = {
      async readServerId(origin, signal) {
        expect(origin).toBe("http://127.0.0.1:47123");
        expect(signal.aborted).toBe(false);
        return "server-1";
      },
      async verifyIdentity(_origin, authKey, connection, signal) {
        expect(authKey).toBe("A".repeat(43));
        expect(connection.deviceId).toBe("desktop-1");
        expect(signal.aborted).toBe(false);
      },
      async *open(_origin, routeAuthorization, requests) {
        expect(routeAuthorization).toBe("R".repeat(43));
        const iterator = requests[Symbol.asyncIterator]();
        const hello = await requiredNext(iterator);
        outbound.push(hello);
        expect(hello.payload.case).toBe("hello");
        if (hello.payload.case !== "hello") throw new Error("Expected a route hello.");
        expect(hello.payload.value.capabilities).toEqual(CAPABILITIES);
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "desktop-1",
          routeGeneration: 1n,
          requestId: hello.requestId,
          payload: {
            case: "accepted",
            value: create(DevicePeerAgentRouteAcceptedSchema, { capabilities: [...CAPABILITIES] })
          }
        });
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "desktop-1",
          routeGeneration: 1n,
          requestId: hello.requestId,
          payload: {
            case: "retire",
            value: create(DevicePeerRetireRouteSchema, { reason: DevicePeerRetireReason.SERVICE_SHUTDOWN })
          }
        });
      }
    };

    await expect(runNodeDevicePeerAgentRoute({
      connection: {
        credentialId: "profile-1",
        deviceId: "desktop-1",
        serverId: "server-1",
        origin: "http://127.0.0.1:47123",
        expectedDeviceKind: DeviceKind.DESKTOP
      },
      executor: {
        capabilities: CAPABILITIES,
        execute: vi.fn(),
        retire
      },
      signal: new AbortController().signal,
      readAuthKey: async () => "A".repeat(43),
      readRouteAuthorization: async () => "R".repeat(43),
      readDefaultDeviceName: () => "Desktop",
      isAuthorityCurrent: () => true,
      port
    })).resolves.toBeUndefined();
    expect(outbound).toHaveLength(1);
    expect(retire).toHaveBeenCalledOnce();
  });
});

async function requiredNext<T>(iterator: AsyncIterator<T>): Promise<T> {
  const next = await iterator.next();
  if (next.done) throw new Error("Expected another route frame.");
  return next.value;
}
