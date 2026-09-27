import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  DevicePeerAcknowledgementSchema,
  DevicePeerAgentRouteAcceptedSchema,
  DevicePeerCapabilityKind,
  DevicePeerCommandSchema,
  DevicePeerCreateDirectoryActionSchema,
  DevicePeerEffectKind,
  DevicePeerFailureCode,
  DevicePeerFailureSchema,
  DevicePeerResponsePhase,
  DevicePeerRetireReason,
  DevicePeerRetireRouteSchema,
  DeviceKind,
  type OpenDevicePeerAgentRouteRequest,
  type OpenDevicePeerAgentRouteResponse,
  OpenDevicePeerAgentRouteResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";
import { DesktopDevicePeerAgentExecutor } from "./device-peer-agent.js";
import {
  type DesktopDevicePeerAgentRoutePort,
  runDesktopDevicePeerAgentRoute
} from "./device-peer-agent-route.js";

const CONNECTION: DesktopManagedOrchestratorConnection = Object.freeze({
  profileId: "profile-1",
  deviceId: "device-1",
  serverId: "server-1",
  name: "Local",
  origin: "http://127.0.0.1:47123"
});
const AUTH_KEY = "A".repeat(43);
const ROUTE_AUTHORIZATION = "R".repeat(43);

describe("Desktop Device peer agent route", () => {
  it("rejects reuse of the renderer-readable profile bearer as route authorization", async () => {
    const retire = vi.fn(async () => undefined);
    const open = vi.fn();
    await expect(runDesktopDevicePeerAgentRoute({
      connection: CONNECTION,
      executor: {
        capabilities: [DevicePeerCapabilityKind.FILES],
        execute: vi.fn(),
        retire
      },
      signal: new AbortController().signal,
      readAuthKey: async () => AUTH_KEY,
      readRouteAuthorization: async () => AUTH_KEY,
      isAuthorityCurrent: () => true,
      port: {
        readServerId: async () => CONNECTION.serverId,
        verifyIdentity: async () => undefined,
        open
      }
    })).rejects.toThrow("Device peer agent route is unavailable.");
    expect(open).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledOnce();
  });

  it("fences anonymous identity before auth, performs hello, command results, heartbeat, and retire", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-peer-route-"));
    const directory = join(root, "project");
    const executor = new DesktopDevicePeerAgentExecutor({
      recentDirectoriesPath: join(root, "state", "recent.json")
    });
    const ordering: string[] = [];
    const outbound: OpenDevicePeerAgentRouteRequest[] = [];

    const port: DesktopDevicePeerAgentRoutePort = {
      async readServerId(origin, signal) {
        expect(origin).toBe(CONNECTION.origin);
        expect(signal.aborted).toBe(false);
        ordering.push("identity");
        return CONNECTION.serverId;
      },
      async verifyIdentity(origin, authKey, connection, signal) {
        expect(origin).toBe(CONNECTION.origin);
        expect(authKey).toBe(AUTH_KEY);
        expect(connection).toMatchObject({
          credentialId: CONNECTION.profileId,
          deviceId: CONNECTION.deviceId,
          expectedDeviceKind: DeviceKind.DESKTOP
        });
        expect(signal.aborted).toBe(false);
        ordering.push("authenticated-identity");
      },
      async *open(origin, routeAuthorization, requests) {
        expect(origin).toBe(CONNECTION.origin);
        expect(routeAuthorization).toBe(ROUTE_AUTHORIZATION);
        ordering.push("open");
        const iterator = requests[Symbol.asyncIterator]();
        const hello = await requiredNext(iterator);
        outbound.push(hello);
        expect(hello.targetDeviceId).toBe(CONNECTION.deviceId);
        expect(hello.routeGeneration).toBe(0n);
        expect(hello.payload.case).toBe("hello");

        yield accepted(hello, 7n);
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: CONNECTION.deviceId,
          routeGeneration: 7n,
          requestId: "command-1",
          payload: {
            case: "command",
            value: create(DevicePeerCommandSchema, {
              capability: DevicePeerCapabilityKind.FILES,
              effect: DevicePeerEffectKind.SIDE_EFFECT,
              action: {
                case: "createDirectory",
                value: create(DevicePeerCreateDirectoryActionSchema, {
                  path: directory,
                  recursive: true
                })
              }
            })
          }
        });

        const admitted = await requiredNext(iterator);
        const completed = await requiredNext(iterator);
        outbound.push(admitted, completed);
        expectResult(admitted, "command-1", 7n, 1n, DevicePeerResponsePhase.ACCEPTED);
        expectResult(completed, "command-1", 7n, 2n, DevicePeerResponsePhase.COMPLETED);
        expect(completed.payload.case === "result" && completed.payload.value.payload.case).toBe("directoryCreated");

        const heartbeat = await requiredNext(iterator);
        outbound.push(heartbeat);
        expect(heartbeat.targetDeviceId).toBe(CONNECTION.deviceId);
        expect(heartbeat.routeGeneration).toBe(7n);
        expect(heartbeat.payload.case).toBe("heartbeat");
        expect(heartbeat.requestId).not.toBe(hello.requestId);
        expect(heartbeat.requestId).not.toBe("command-1");

        yield retire(hello.requestId, 7n);
      }
    };

    await runDesktopDevicePeerAgentRoute({
      connection: CONNECTION,
      executor,
      signal: new AbortController().signal,
      async readAuthKey(profileId) {
        expect(profileId).toBe(CONNECTION.profileId);
        ordering.push("credential");
        return AUTH_KEY;
      },
      async readRouteAuthorization(profileId) {
        expect(profileId).toBe(CONNECTION.profileId);
        ordering.push("route-authorization");
        return ROUTE_AUTHORIZATION;
      },
      async isAuthorityCurrent(connection) {
        expect(connection).toBe(CONNECTION);
        ordering.push("fence");
        return true;
      },
      heartbeatIntervalMs: 10,
      port
    });

    expect(ordering.indexOf("identity")).toBeLessThan(ordering.indexOf("credential"));
    expect(ordering.indexOf("credential")).toBeLessThan(ordering.indexOf("authenticated-identity"));
    expect(ordering.indexOf("authenticated-identity")).toBeLessThan(ordering.indexOf("open"));
    expect(ordering.indexOf("authenticated-identity")).toBeLessThan(ordering.indexOf("route-authorization"));
    expect(ordering.indexOf("route-authorization")).toBeLessThan(ordering.indexOf("open"));
    expect((await stat(directory)).isDirectory()).toBe(true);
    expect(outbound.every((frame) => frame.targetDeviceId === CONNECTION.deviceId)).toBe(true);
  });

  it("propagates an exact command abort and retains contiguous result sequence", async () => {
    const retireExecutor = vi.fn(async () => undefined);
    const executor = {
      capabilities: [DevicePeerCapabilityKind.FILES] as const,
      async execute(
        _command: Parameters<DesktopDevicePeerAgentExecutor["execute"]>[0],
        signal: AbortSignal,
        emit: Parameters<DesktopDevicePeerAgentExecutor["execute"]>[2]
      ) {
        await emit({
          $typeName: "joko.v1.DevicePeerAgentResult",
          phase: DevicePeerResponsePhase.ACCEPTED,
          sequence: 1n,
          payload: { case: "acknowledgement", value: create(DevicePeerAcknowledgementSchema) }
        });
        await new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
        await emit({
          $typeName: "joko.v1.DevicePeerAgentResult",
          phase: DevicePeerResponsePhase.ABORTED,
          sequence: 2n,
          payload: {
            case: "failure",
            value: create(DevicePeerFailureSchema, {
              code: DevicePeerFailureCode.CANCELLED,
              retryable: false
            })
          }
        });
      },
      retire: retireExecutor
    };

    const port: DesktopDevicePeerAgentRoutePort = {
      async readServerId() { return CONNECTION.serverId; },
      async verifyIdentity(_origin, _authKey, connection) {
        expect(connection.expectedDeviceKind).toBe(DeviceKind.DESKTOP);
      },
      async *open(_origin, _authKey, requests) {
        const iterator = requests[Symbol.asyncIterator]();
        const hello = await requiredNext(iterator);
        yield accepted(hello, 3n, [DevicePeerCapabilityKind.FILES]);
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: CONNECTION.deviceId,
          routeGeneration: 3n,
          requestId: "abortable-command",
          payload: {
            case: "command",
            value: create(DevicePeerCommandSchema, {
              capability: DevicePeerCapabilityKind.FILES,
              effect: DevicePeerEffectKind.SIDE_EFFECT,
              action: {
                case: "createDirectory",
                value: create(DevicePeerCreateDirectoryActionSchema, { path: "C:\\bounded" })
              }
            })
          }
        });
        const admitted = await requiredNext(iterator);
        expectResult(admitted, "abortable-command", 3n, 1n, DevicePeerResponsePhase.ACCEPTED);
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: CONNECTION.deviceId,
          routeGeneration: 3n,
          requestId: "abortable-command",
          payload: { case: "abort", value: { $typeName: "joko.v1.DevicePeerAbortCommand" } }
        });
        const aborted = await requiredNext(iterator);
        expectResult(aborted, "abortable-command", 3n, 2n, DevicePeerResponsePhase.ABORTED);
        yield retire(hello.requestId, 3n);
      }
    };

    await runDesktopDevicePeerAgentRoute({
      connection: CONNECTION,
      executor,
      signal: new AbortController().signal,
      readAuthKey: async () => AUTH_KEY,
      readRouteAuthorization: async () => ROUTE_AUTHORIZATION,
      isAuthorityCurrent: () => true,
      port
    });
    expect(retireExecutor).toHaveBeenCalledOnce();
  });

  it("fails closed on an inexact accepted identity without exposing the credential", async () => {
    const retireExecutor = vi.fn(async () => undefined);
    const executor = {
      capabilities: [DevicePeerCapabilityKind.FILES] as const,
      execute: vi.fn(),
      retire: retireExecutor
    };
    const port: DesktopDevicePeerAgentRoutePort = {
      async readServerId() { return CONNECTION.serverId; },
      async verifyIdentity(_origin, _authKey, connection) {
        expect(connection.expectedDeviceKind).toBe(DeviceKind.DESKTOP);
      },
      async *open(_origin, routeAuthorization, requests) {
        expect(routeAuthorization).toBe(ROUTE_AUTHORIZATION);
        const hello = await requiredNext(requests[Symbol.asyncIterator]());
        yield create(OpenDevicePeerAgentRouteResponseSchema, {
          targetDeviceId: "wrong-device",
          routeGeneration: 1n,
          requestId: hello.requestId,
          payload: {
            case: "accepted",
            value: create(DevicePeerAgentRouteAcceptedSchema, {
              capabilities: [DevicePeerCapabilityKind.FILES]
            })
          }
        });
      }
    };

    let message = "";
    try {
      await runDesktopDevicePeerAgentRoute({
        connection: CONNECTION,
        executor,
        signal: new AbortController().signal,
        readAuthKey: async () => AUTH_KEY,
        readRouteAuthorization: async () => ROUTE_AUTHORIZATION,
        isAuthorityCurrent: () => true,
        port
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toBe("Error: Device peer agent route is unavailable.");
    expect(message).not.toContain(AUTH_KEY);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(retireExecutor).toHaveBeenCalledOnce();
  });
});

function accepted(
  hello: OpenDevicePeerAgentRouteRequest,
  generation: bigint,
  capabilities = hello.payload.case === "hello" ? hello.payload.value.capabilities : []
): OpenDevicePeerAgentRouteResponse {
  return create(OpenDevicePeerAgentRouteResponseSchema, {
    targetDeviceId: CONNECTION.deviceId,
    routeGeneration: generation,
    requestId: hello.requestId,
    payload: {
      case: "accepted",
      value: create(DevicePeerAgentRouteAcceptedSchema, { capabilities: [...capabilities] })
    }
  });
}

function retire(requestId: string, generation: bigint): OpenDevicePeerAgentRouteResponse {
  return create(OpenDevicePeerAgentRouteResponseSchema, {
    targetDeviceId: CONNECTION.deviceId,
    routeGeneration: generation,
    requestId,
    payload: {
      case: "retire",
      value: create(DevicePeerRetireRouteSchema, { reason: DevicePeerRetireReason.SERVICE_SHUTDOWN })
    }
  });
}

async function requiredNext<T>(iterator: AsyncIterator<T>): Promise<T> {
  const next = await iterator.next();
  if (next.done) throw new Error("Expected another route frame.");
  return next.value;
}

function expectResult(
  frame: OpenDevicePeerAgentRouteRequest,
  requestId: string,
  generation: bigint,
  sequence: bigint,
  phase: DevicePeerResponsePhase
): void {
  expect(frame.targetDeviceId).toBe(CONNECTION.deviceId);
  expect(frame.routeGeneration).toBe(generation);
  expect(frame.requestId).toBe(requestId);
  expect(frame.payload.case).toBe("result");
  if (frame.payload.case !== "result") throw new Error("Expected a result frame.");
  expect(frame.payload.value.sequence).toBe(sequence);
  expect(frame.payload.value.phase).toBe(phase);
}
