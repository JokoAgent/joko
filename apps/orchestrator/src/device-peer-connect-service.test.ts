import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  DEVICE_PEER_AGENT_AUTHORIZATION_HEADER,
  DevicePeerRouteRegistry
} from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ConnectionManager, digestAuthKey } from "./connection-manager.js";
import { createDevicePeerConnectService } from "./device-peer-connect-service.js";
import { DevicePeerOwner } from "./device-peer-owner.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("DevicePeerService Connect boundary", () => {
  it.each([false, true])("persists the trusted native default while preserving the manual name (split=%s)", async (split) => {
    const fixture = setup({ targetKind: "desktop" });
    const device = fixture.store.getDevice(fixture.target.deviceId);
    const manual = fixture.store.renameDevice(device.id, "My workstation", device.revision);
    const request = hello(device.id, "hello-native-name", "Renamed OS host");
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(request);
    const handler = context(fixture.targetKey, new AbortController().signal, fixture.targetHostKey!);
    const output = split
      ? openCommandRoute(fixture.service, request, handler)
      : openRoute(fixture.service, input, handler);
    await expect(output.next()).resolves.toMatchObject({ value: { payload: { case: "accepted" } } });
    const refreshed = fixture.store.getDevice(device.id);
    expect(refreshed).toMatchObject({ defaultName: "Renamed OS host", manualName: "My workstation", name: "My workstation" });
    expect(refreshed.revision).toBe(manual.revision + 1n);
    await output.return?.(undefined);
    input.close();
  });

  it("requires the Main-only Desktop host authorization on every public agent-route half", async () => {
    const fixture = setup({ targetKind: "desktop" });
    const deniedInput = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    deniedInput.push(hello(fixture.target.deviceId, "hello-renderer-denied"));
    await expect(openRoute(
      fixture.service,
      deniedInput,
      context(fixture.targetKey)
    ).next()).rejects.toMatchObject({ code: Code.Unauthenticated });

    await expect(openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-command-denied"),
      context(fixture.targetKey)
    ).next()).rejects.toMatchObject({ code: Code.Unauthenticated });

    const downlink = openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-host-authorized"),
      context(fixture.targetKey, new AbortController().signal, fixture.targetHostKey!)
    );
    await expect(downlink.next()).resolves.toMatchObject({
      value: { targetDeviceId: fixture.target.deviceId, payload: { case: "accepted" } }
    });

    const deniedUpload = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    deniedUpload.push(attachment(fixture.target.deviceId, 1n, "hello-host-authorized"));
    deniedUpload.close();
    await expect(publishRoute(fixture.service, deniedUpload, context(fixture.targetKey)))
      .rejects.toMatchObject({ code: Code.Unauthenticated });

    const upload = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    upload.push(attachment(fixture.target.deviceId, 1n, "hello-host-authorized"));
    upload.close();
    await expect(publishRoute(
      fixture.service,
      upload,
      context(fixture.targetKey, new AbortController().signal, fixture.targetHostKey!)
    )).resolves.toBeDefined();
    await downlink.next();
    await downlink.next();
  });

  it("authenticates the exact target route and fences directory results plus heartbeat presence", async () => {
    const fixture = setup();
    const routeAbort = new AbortController();
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(hello(fixture.target.deviceId, "hello-1"));
    const output = openRoute(fixture.service, input, context(fixture.targetKey, routeAbort.signal));

    const accepted = await output.next();
    expect(accepted.value).toMatchObject({
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: 1n,
      requestId: "hello-1",
      payload: { case: "accepted" }
    });

    const peers = await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    );
    expect(peers.peers).toHaveLength(1);
    const peer = peers.peers[0]!.route!;
    expect(peer).toMatchObject({
      targetDeviceId: fixture.target.deviceId,
      relationId: `${fixture.controller.deviceId}:${fixture.target.deviceId}`,
      routeGeneration: 1n
    });

    const listed = invoke<contract.ListDevicePeerDirectoriesResponse>(
      fixture.service.listDevicePeerDirectories,
      { peer, path: "" },
      context(fixture.controllerKey)
    );
    const command = await output.next();
    expect(command.value).toMatchObject({
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: 1n,
      payload: {
        case: "command",
        value: {
          capability: contract.DevicePeerCapabilityKind.FILES,
          effect: contract.DevicePeerEffectKind.READ_ONLY,
          action: { case: "listDirectories", value: { path: "", maximumEntries: 200 } }
        }
      }
    });
    const requestId = command.value!.requestId;
    input.push(agentResult(fixture.target.deviceId, 1n, requestId, {
      phase: contract.DevicePeerResponsePhase.ACCEPTED,
      sequence: 1n,
      payload: {
        case: "acknowledgement",
        value: create(contract.DevicePeerAcknowledgementSchema)
      }
    }));
    input.push(agentResult(fixture.target.deviceId, 1n, requestId, {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 2n,
      payload: {
        case: "directories",
        value: create(contract.DevicePeerDirectoriesResultSchema, {
          path: "C:\\Users\\peer",
          parentPath: "C:\\Users",
          directories: [create(contract.DevicePeerDirectoryEntrySchema, {
            name: "work",
            path: "C:\\Users\\peer\\work"
          })],
          truncated: true
        })
      }
    }));
    await expect(listed).resolves.toMatchObject({
      path: "C:\\Users\\peer",
      parentPath: "C:\\Users",
      directories: [{ name: "work", path: "C:\\Users\\peer\\work" }],
      truncated: true,
      peer: { targetDeviceId: fixture.target.deviceId, routeGeneration: 1n }
    });

    const connectionRevision = fixture.store.getConnection(fixture.target.id).revision;
    const deviceRevision = fixture.store.getDevice(fixture.target.deviceId).revision;
    fixture.clock.value = 200;
    input.push(create(contract.OpenDevicePeerAgentRouteRequestSchema, {
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: 1n,
      requestId: "heartbeat-1",
      payload: { case: "heartbeat", value: create(contract.DevicePeerAgentHeartbeatSchema) }
    }));
    await expect.poll(() => fixture.store.getConnection(fixture.target.id).lastSeenAt).toBe(200);
    expect(fixture.store.getConnection(fixture.target.id).revision).toBe(connectionRevision);
    expect(fixture.store.getDevice(fixture.target.deviceId).revision).toBe(deviceRevision);

    input.close();
    const retired = await output.next();
    expect(retired.value?.payload).toMatchObject({
      case: "retire",
      value: { reason: contract.DevicePeerRetireReason.CONNECTION_RETIRED }
    });
    await expect(output.next()).resolves.toMatchObject({ done: true });
  });

  it("retires the route on a non-contiguous or phase-invalid agent result", async () => {
    const fixture = setup();
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(hello(fixture.target.deviceId, "hello-invalid"));
    const output = openRoute(fixture.service, input, context(fixture.targetKey));
    await output.next();
    const peers = await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    );
    const pending = invoke<contract.InspectDevicePeerDirectoryResponse>(
      fixture.service.inspectDevicePeerDirectory,
      { peer: peers.peers[0]!.route, path: "C:\\work" },
      context(fixture.controllerKey)
    );
    const command = await output.next();
    input.push(agentResult(fixture.target.deviceId, 1n, command.value!.requestId, {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 1n,
      payload: {
        case: "directoryInspection",
        value: create(contract.DevicePeerDirectoryInspectionResultSchema, {
          path: "C:\\work",
          kind: contract.DevicePeerDirectoryKind.DIRECTORY
        })
      }
    }));

    const retired = await output.next();
    expect(retired.value?.payload).toMatchObject({
      case: "retire",
      value: { reason: contract.DevicePeerRetireReason.PROTOCOL_VIOLATION }
    });
    await expect(pending).rejects.toBeInstanceOf(ConnectError);
    await expect.poll(async () => (await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    )).peers).toEqual([]);
  });

  it("keeps an accepted start claim fenced while post-receipt stream frames arrive", async () => {
    const fixture = setup();
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(hello(fixture.target.deviceId, "hello-stream"));
    const output = openRoute(fixture.service, input, context(fixture.targetKey));
    await output.next();

    const authority = fixture.owner.capture(
      fixture.store.getConnection(fixture.controller.id),
      fixture.owner.list(fixture.store.getConnection(fixture.controller.id))[0]!,
      ["process"]
    );
    const events: unknown[] = [];
    const start = create(contract.DevicePeerCommandSchema, {
      capability: contract.DevicePeerCapabilityKind.PROCESS,
      effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
      action: {
        case: "startProcess",
        value: create(contract.DevicePeerStartProcessActionSchema, {
          executable: "joko-agent",
          workingDirectory: "C:\\work"
        })
      }
    });
    const leasePromise = fixture.owner.dispatchStream(authority, {
      requestId: "process-start-1",
      capability: "process",
      effectKind: "side_effect",
      action: "startProcess",
      payload: start
    }, (event) => events.push(event));
    const command = await output.next();
    expect(command.value).toMatchObject({ requestId: "process-start-1", payload: { case: "command" } });
    input.push(agentResult(fixture.target.deviceId, 1n, "process-start-1", {
      phase: contract.DevicePeerResponsePhase.ACCEPTED,
      sequence: 1n,
      payload: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) }
    }));
    input.push(agentResult(fixture.target.deviceId, 1n, "process-start-1", {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 2n,
      payload: {
        case: "processStarted",
        value: create(contract.DevicePeerProcessStartedResultSchema, { processId: "process-1" })
      }
    }));
    const lease = await leasePromise;
    expect(lease.response).toMatchObject({ outcome: "completed" });

    input.push(agentResult(fixture.target.deviceId, 1n, "process-start-1", {
      phase: contract.DevicePeerResponsePhase.STARTED,
      sequence: 3n,
      payload: {
        case: "processOutput",
        value: create(contract.DevicePeerProcessOutputResultSchema, {
          processId: "process-1",
          stream: contract.DevicePeerProcessOutputStream.STANDARD_OUTPUT,
          data: new TextEncoder().encode("ready\n")
        })
      }
    }));
    input.push(agentResult(fixture.target.deviceId, 1n, "process-start-1", {
      phase: contract.DevicePeerResponsePhase.STARTED,
      sequence: 4n,
      payload: {
        case: "processExited",
        value: create(contract.DevicePeerProcessExitedResultSchema, { processId: "process-1", exitCode: 0 })
      }
    }));
    await expect.poll(() => events.length).toBe(2);
    expect(events).toEqual([
      expect.objectContaining({
        requestId: "process-start-1",
        streamId: "process-1",
        sequence: 1,
        channel: "process_stdout"
      }),
      expect.objectContaining({
        requestId: "process-start-1",
        streamId: "process-1",
        sequence: 2,
        channel: "process_exit",
        exitCode: 0
      })
    ]);
    lease.close();
    input.close();
    await output.next();
    await output.next();
  });

  it("rejects a hello for a Device other than the authenticated Connection", async () => {
    const fixture = setup();
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(hello(fixture.controller.deviceId, "hello-wrong-device"));
    const output = openRoute(fixture.service, input, context(fixture.targetKey));
    await expect(output.next()).rejects.toMatchObject({ code: Code.PermissionDenied });
    const peers = await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    );
    expect(peers.peers).toEqual([]);
  });

  it("sends an explicit replacement retirement to the old reverse route", async () => {
    const fixture = setup();
    const firstInput = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    firstInput.push(hello(fixture.target.deviceId, "hello-first"));
    const first = openRoute(fixture.service, firstInput, context(fixture.targetKey));
    await expect(first.next()).resolves.toMatchObject({ value: { routeGeneration: 1n } });

    const secondInput = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    secondInput.push(hello(fixture.target.deviceId, "hello-second"));
    const second = openRoute(fixture.service, secondInput, context(fixture.targetKey));
    await expect(second.next()).resolves.toMatchObject({ value: { routeGeneration: 2n } });
    await expect(first.next()).resolves.toMatchObject({
      value: {
        routeGeneration: 1n,
        payload: { case: "retire", value: { reason: contract.DevicePeerRetireReason.REPLACED } }
      }
    });

    secondInput.close();
    await second.next();
    await second.next();
  });

  it("retires the reverse route when its authenticated Connection is revoked", async () => {
    const fixture = setup();
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(hello(fixture.target.deviceId, "hello-revoked"));
    const output = openRoute(fixture.service, input, context(fixture.targetKey));
    await output.next();

    fixture.connections.revoke(fixture.target.id);
    await expect(output.next()).resolves.toMatchObject({
      value: {
        payload: { case: "retire", value: { reason: contract.DevicePeerRetireReason.DEVICE_REVOKED } }
      }
    });
    await expect(output.next()).resolves.toMatchObject({ done: true });
  });

  it("requests only the target protocol recent-directory budget", async () => {
    const fixture = setup();
    const input = new TestInput<contract.OpenDevicePeerAgentRouteRequest>();
    input.push(hello(fixture.target.deviceId, "hello-recents"));
    const output = openRoute(fixture.service, input, context(fixture.targetKey));
    await output.next();
    const peers = await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    );
    const listed = invoke<contract.ListDevicePeerRecentDirectoriesResponse>(
      fixture.service.listDevicePeerRecentDirectories,
      { peer: peers.peers[0]!.route },
      context(fixture.controllerKey)
    );
    const command = await output.next();
    expect(command.value).toMatchObject({
      payload: {
        case: "command",
        value: {
          action: { case: "listRecentDirectories", value: { maximumEntries: 100 } }
        }
      }
    });
    const requestId = command.value!.requestId;
    input.push(agentResult(fixture.target.deviceId, 1n, requestId, {
      phase: contract.DevicePeerResponsePhase.ACCEPTED,
      sequence: 1n,
      payload: {
        case: "acknowledgement",
        value: create(contract.DevicePeerAcknowledgementSchema)
      }
    }));
    input.push(agentResult(fixture.target.deviceId, 1n, requestId, {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 2n,
      payload: {
        case: "recentDirectories",
        value: create(contract.DevicePeerRecentDirectoriesResultSchema)
      }
    }));
    await expect(listed).resolves.toMatchObject({ directories: [] });
    input.close();
    await output.next();
    await output.next();
  });

  it("binds the split HTTP/1 route exactly before releasing commands and closes both halves together", async () => {
    const fixture = setup();
    const downlink = openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-split"),
      context(fixture.targetKey)
    );
    const accepted = await downlink.next();
    expect(accepted.value).toMatchObject({
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: 1n,
      requestId: "hello-split",
      payload: { case: "accepted" }
    });
    expect((await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    )).peers).toEqual([]);
    let commandReleased = false;
    const commandPending = downlink.next().then((value) => {
      commandReleased = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(commandReleased).toBe(false);

    const wrongIdentity = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    wrongIdentity.push(attachment(fixture.controller.deviceId, 1n, "hello-split"));
    wrongIdentity.close();
    await expect(publishRoute(
      fixture.service,
      wrongIdentity,
      context(fixture.controllerKey, new AbortController().signal, fixture.targetKey)
    ))
      .rejects.toMatchObject({ code: Code.PermissionDenied });
    const stale = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    stale.push(attachment(fixture.target.deviceId, 2n, "hello-split"));
    stale.close();
    await expect(publishRoute(fixture.service, stale, context(fixture.targetKey)))
      .rejects.toMatchObject({ code: Code.Aborted });

    const uplink = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    uplink.push(attachment(fixture.target.deviceId, 1n, "hello-split"));
    const published = publishRoute(fixture.service, uplink, context(fixture.targetKey));
    await expect.poll(async () => (await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    )).peers).toHaveLength(1);
    const peers = await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    );
    const inspected = invoke<contract.InspectDevicePeerDirectoryResponse>(
      fixture.service.inspectDevicePeerDirectory,
      { peer: peers.peers[0]!.route, path: "C:\\work" },
      context(fixture.controllerKey)
    );
    const command = await commandPending;
    expect(command.value).toMatchObject({ payload: { case: "command" } });
    const duplicate = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    duplicate.push(attachment(fixture.target.deviceId, 1n, "hello-split"));
    duplicate.close();
    await expect(publishRoute(fixture.service, duplicate, context(fixture.targetKey)))
      .rejects.toMatchObject({ code: Code.Aborted });

    const requestId = command.value!.requestId;
    uplink.push(publishAgentResult(fixture.target.deviceId, 1n, requestId, {
      phase: contract.DevicePeerResponsePhase.ACCEPTED,
      sequence: 1n,
      payload: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) }
    }));
    uplink.push(publishAgentResult(fixture.target.deviceId, 1n, requestId, {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 2n,
      payload: {
        case: "directoryInspection",
        value: create(contract.DevicePeerDirectoryInspectionResultSchema, {
          path: "C:\\work",
          kind: contract.DevicePeerDirectoryKind.DIRECTORY
        })
      }
    }));
    await expect(inspected).resolves.toMatchObject({ path: "C:\\work" });
    uplink.close();
    await expect(published).resolves.toBeDefined();
    await expect(downlink.next()).resolves.toMatchObject({
      value: { payload: { case: "retire", value: { reason: contract.DevicePeerRetireReason.CONNECTION_RETIRED } } }
    });
    await expect(downlink.next()).resolves.toMatchObject({ done: true });
  });

  it("admits a split side effect before releasing it and keeps lost target admission unknown", async () => {
    const fixture = setup();
    const downlink = openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-admission"),
      context(fixture.targetKey)
    );
    await downlink.next();
    const uplink = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    uplink.push(attachment(fixture.target.deviceId, 1n, "hello-admission"));
    const published = publishRoute(fixture.service, uplink, context(fixture.targetKey));
    await expect.poll(() => fixture.routes.getRoute(fixture.target.deviceId)).toBeDefined();

    const lease = fixture.routes.getRoute(fixture.target.deviceId)!;
    const claim = fixture.routes.registerClaim({
      requestId: "mkdir-admission",
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: lease.routeGeneration,
      capability: "files",
      effectKind: "side_effect",
      action: "createDirectory",
      payload: create(contract.DevicePeerCommandSchema, {
        capability: contract.DevicePeerCapabilityKind.FILES,
        effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
        controllerDeviceId: fixture.controller.deviceId,
        action: {
          case: "createDirectory",
          value: create(contract.DevicePeerCreateDirectoryActionSchema, {
            path: "C:\\peer\\created",
            recursive: true
          })
        }
      })
    });
    const dispatched = fixture.routes.dispatch(claim);
    await expect(downlink.next()).resolves.toMatchObject({
      value: { requestId: "mkdir-admission", payload: { case: "command" } }
    });

    // The command has reached the target and may already be executing, but its
    // ACCEPTED upload never reaches the controller.
    uplink.close();
    await expect(published).resolves.toBeDefined();
    await expect(dispatched).resolves.toMatchObject({
      outcome: "outcome_unknown",
      requestId: "mkdir-admission"
    });
    await expect(downlink.next()).resolves.toMatchObject({
      value: { payload: { case: "retire" } }
    });
    await expect(downlink.next()).resolves.toMatchObject({ done: true });
  });

  it("routes both clipboard transfers as Remote Desktop side effects with exact completed payloads", async () => {
    const fixture = setup();
    const request = remoteDesktopHello(fixture.target.deviceId, "hello-clipboard");
    const downlink = openCommandRoute(fixture.service, request, context(fixture.targetKey));
    await downlink.next();
    const uplink = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    uplink.push(attachment(fixture.target.deviceId, 1n, "hello-clipboard"));
    const published = publishRoute(fixture.service, uplink, context(fixture.targetKey));
    await expect.poll(() => fixture.routes.getRoute(fixture.target.deviceId)).toBeDefined();

    const cases: readonly {
      readonly requestId: string;
      readonly action: contract.DevicePeerCommand["action"];
      readonly expectedCase: "remoteDesktopClipboardText" | "remoteDesktopClipboardContent";
      readonly result: contract.DevicePeerAgentResult["payload"];
    }[] = [
      {
        requestId: "clipboard-text",
        action: {
          case: "transferRemoteDesktopClipboardText",
          value: create(contract.RemoteDesktopClipboardTextRequestSchema, {
            leaseId: "lease-1",
            controlGeneration: 1n,
            action: { case: "copy", value: create(contract.RemoteDesktopClipboardTextCopyActionSchema) }
          })
        },
        expectedCase: "remoteDesktopClipboardText",
        result: {
          case: "remoteDesktopClipboardText",
          value: create(contract.RemoteDesktopClipboardTextResultSchema, { text: "portable" })
        }
      },
      {
        requestId: "clipboard-content",
        action: {
          case: "transferRemoteDesktopClipboardContent",
          value: create(contract.RemoteDesktopClipboardContentRequestSchema, {
            leaseId: "lease-1",
            controlGeneration: 1n,
            action: { case: "copy", value: create(contract.RemoteDesktopClipboardContentCopyActionSchema) }
          })
        },
        expectedCase: "remoteDesktopClipboardContent",
        result: {
          case: "remoteDesktopClipboardContent",
          value: create(contract.RemoteDesktopClipboardContentResultSchema, {
            transferId: "transfer-1",
            length: 24
          })
        }
      }
    ];

    for (const item of cases) {
      const lease = fixture.routes.getRoute(fixture.target.deviceId)!;
      const command = create(contract.DevicePeerCommandSchema, {
        capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
        effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
        controllerDeviceId: fixture.controller.deviceId,
        action: item.action
      });
      const claim = fixture.routes.registerClaim({
        requestId: item.requestId,
        controllerDeviceId: fixture.controller.deviceId,
        targetDeviceId: fixture.target.deviceId,
        routeGeneration: lease.routeGeneration,
        capability: "remote_desktop",
        effectKind: "side_effect",
        action: item.action.case!,
        payload: command
      });
      const dispatched = fixture.routes.dispatch(claim);
      await expect(downlink.next()).resolves.toMatchObject({
        value: {
          requestId: item.requestId,
          payload: {
            case: "command",
            value: {
              capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
              effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
              action: { case: item.action.case }
            }
          }
        }
      });
      uplink.push(publishAgentResult(fixture.target.deviceId, 1n, item.requestId, {
        phase: contract.DevicePeerResponsePhase.ACCEPTED,
        sequence: 1n,
        payload: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) }
      }));
      uplink.push(publishAgentResult(fixture.target.deviceId, 1n, item.requestId, {
        phase: contract.DevicePeerResponsePhase.COMPLETED,
        sequence: 2n,
        payload: item.result
      }));
      await expect(dispatched).resolves.toMatchObject({
        outcome: "completed",
        value: {
          case: item.expectedCase,
          value: item.result.value
        }
      });
    }

    uplink.close();
    await expect(published).resolves.toBeDefined();
    await downlink.next();
    await expect(downlink.next()).resolves.toMatchObject({ done: true });
  });

  it("routes display-mode list as read-only and display-mode set as an acknowledged side effect", async () => {
    const fixture = setup();
    const request = remoteDesktopHello(fixture.target.deviceId, "hello-display-modes");
    const downlink = openCommandRoute(fixture.service, request, context(fixture.targetKey));
    await downlink.next();
    const uplink = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    uplink.push(attachment(fixture.target.deviceId, 1n, "hello-display-modes"));
    const published = publishRoute(fixture.service, uplink, context(fixture.targetKey));
    await expect.poll(() => fixture.routes.getRoute(fixture.target.deviceId)).toBeDefined();
    const lease = fixture.routes.getRoute(fixture.target.deviceId)!;

    const listCommand = create(contract.DevicePeerCommandSchema, {
      capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
      effect: contract.DevicePeerEffectKind.READ_ONLY,
      controllerDeviceId: fixture.controller.deviceId,
      action: {
        case: "listRemoteDesktopDisplayModes",
        value: create(contract.DevicePeerListRemoteDesktopDisplayModesActionSchema, { leaseId: "lease-1" })
      }
    });
    const listClaim = fixture.routes.registerClaim({
      requestId: "display-modes-list",
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: lease.routeGeneration,
      capability: "remote_desktop",
      effectKind: "read_only",
      action: "listRemoteDesktopDisplayModes",
      payload: listCommand
    });
    const listed = fixture.routes.dispatch(listClaim);
    await expect(downlink.next()).resolves.toMatchObject({
      value: {
        requestId: "display-modes-list",
        payload: {
          case: "command",
          value: {
            effect: contract.DevicePeerEffectKind.READ_ONLY,
            action: { case: "listRemoteDesktopDisplayModes" }
          }
        }
      }
    });
    uplink.push(publishAgentResult(fixture.target.deviceId, 1n, "display-modes-list", {
      phase: contract.DevicePeerResponsePhase.ACCEPTED,
      sequence: 1n,
      payload: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) }
    }));
    uplink.push(publishAgentResult(fixture.target.deviceId, 1n, "display-modes-list", {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 2n,
      payload: {
        case: "remoteDesktopDisplayModes",
        value: create(contract.DevicePeerRemoteDesktopDisplayModesResultSchema, {
          modes: [create(contract.RemoteDesktopDisplayModeSchema, {
            modeId: "101",
            width: 1920,
            height: 1080,
            current: true,
            native: true
          })]
        })
      }
    }));
    await expect(listed).resolves.toMatchObject({
      outcome: "completed",
      value: { case: "remoteDesktopDisplayModes", value: { modes: [{ modeId: "101" }] } }
    });

    const setCommand = create(contract.DevicePeerCommandSchema, {
      capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
      effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
      controllerDeviceId: fixture.controller.deviceId,
      action: {
        case: "setRemoteDesktopDisplayMode",
        value: create(contract.DevicePeerSetRemoteDesktopDisplayModeActionSchema, {
          leaseId: "lease-1",
          controlGeneration: 7n,
          modeId: "101"
        })
      }
    });
    const setClaim = fixture.routes.registerClaim({
      requestId: "display-mode-set",
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: lease.routeGeneration,
      capability: "remote_desktop",
      effectKind: "side_effect",
      action: "setRemoteDesktopDisplayMode",
      payload: setCommand
    });
    const changed = fixture.routes.dispatch(setClaim);
    await expect(downlink.next()).resolves.toMatchObject({
      value: {
        requestId: "display-mode-set",
        payload: {
          case: "command",
          value: {
            effect: contract.DevicePeerEffectKind.SIDE_EFFECT,
            action: {
              case: "setRemoteDesktopDisplayMode",
              value: { leaseId: "lease-1", controlGeneration: 7n, modeId: "101" }
            }
          }
        }
      }
    });
    uplink.push(publishAgentResult(fixture.target.deviceId, 1n, "display-mode-set", {
      phase: contract.DevicePeerResponsePhase.ACCEPTED,
      sequence: 1n,
      payload: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) }
    }));
    uplink.push(publishAgentResult(fixture.target.deviceId, 1n, "display-mode-set", {
      phase: contract.DevicePeerResponsePhase.COMPLETED,
      sequence: 2n,
      payload: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) }
    }));
    await expect(changed).resolves.toMatchObject({
      outcome: "completed",
      value: { case: "acknowledgement" }
    });

    uplink.close();
    await expect(published).resolves.toBeDefined();
    await downlink.next();
    await expect(downlink.next()).resolves.toMatchObject({ done: true });
  });

  it("fences split attachment across replacement and revocation and bounds unattached lifetime", async () => {
    const fixture = setup({ splitRouteAttachmentTimeoutMs: 30 });
    const first = openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-split-first"),
      context(fixture.targetKey)
    );
    await expect(first.next()).resolves.toMatchObject({ value: { routeGeneration: 1n } });
    const firstRetired = first.next();
    const second = openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-split-second"),
      context(fixture.targetKey)
    );
    await expect(second.next()).resolves.toMatchObject({ value: { routeGeneration: 2n } });
    await expect(firstRetired).resolves.toMatchObject({
      value: { routeGeneration: 1n, payload: { case: "retire", value: { reason: contract.DevicePeerRetireReason.REPLACED } } }
    });
    const stale = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    stale.push(attachment(fixture.target.deviceId, 1n, "hello-split-first"));
    stale.close();
    await expect(publishRoute(fixture.service, stale, context(fixture.targetKey)))
      .rejects.toMatchObject({ code: Code.Aborted });

    fixture.connections.revoke(fixture.target.id);
    await expect(second.next()).resolves.toMatchObject({
      value: { payload: { case: "retire", value: { reason: contract.DevicePeerRetireReason.DEVICE_REVOKED } } }
    });
    const revoked = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    revoked.push(attachment(fixture.target.deviceId, 2n, "hello-split-second"));
    revoked.close();
    await expect(publishRoute(fixture.service, revoked, context(fixture.targetKey)))
      .rejects.toMatchObject({ code: Code.Unauthenticated });

    const timeoutFixture = setup({ splitRouteAttachmentTimeoutMs: 10 });
    const unattached = openCommandRoute(
      timeoutFixture.service,
      hello(timeoutFixture.target.deviceId, "hello-unattached"),
      context(timeoutFixture.targetKey)
    );
    await unattached.next();
    await expect(unattached.next()).resolves.toMatchObject({
      value: { payload: { case: "retire", value: { reason: contract.DevicePeerRetireReason.CONNECTION_RETIRED } } }
    });
    await expect.poll(async () => (await invoke<contract.ListDevicePeersResponse>(
      timeoutFixture.service.listDevicePeers,
      {},
      context(timeoutFixture.controllerKey)
    )).peers).toEqual([]);
  });

  it("aborts the split upload when the command stream closes", async () => {
    const fixture = setup();
    const commandAbort = new AbortController();
    const downlink = openCommandRoute(
      fixture.service,
      hello(fixture.target.deviceId, "hello-command-close"),
      context(fixture.targetKey, commandAbort.signal)
    );
    await downlink.next();
    const commandPending = downlink.next();
    const uplink = new TestInput<contract.PublishDevicePeerAgentRouteRequest>();
    uplink.push(attachment(fixture.target.deviceId, 1n, "hello-command-close"));
    const published = publishRoute(fixture.service, uplink, context(fixture.targetKey));
    await expect.poll(async () => (await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    )).peers).toHaveLength(1);
    const peers = await invoke<contract.ListDevicePeersResponse>(
      fixture.service.listDevicePeers,
      {},
      context(fixture.controllerKey)
    );
    const inspected = invoke<contract.InspectDevicePeerDirectoryResponse>(
      fixture.service.inspectDevicePeerDirectory,
      { peer: peers.peers[0]!.route, path: "C:\\work" },
      context(fixture.controllerKey)
    );
    await expect(commandPending).resolves.toMatchObject({ value: { payload: { case: "command" } } });
    const waiting = downlink.next();
    commandAbort.abort();
    await expect(waiting).rejects.toMatchObject({ code: Code.Canceled });
    await expect(published).rejects.toMatchObject({ code: Code.Canceled });
    await expect(inspected).rejects.toBeInstanceOf(ConnectError);
  });
});

function setup(options: {
  readonly splitRouteAttachmentTimeoutMs?: number;
  readonly maximumUnattachedSplitRoutes?: number;
  readonly targetKind?: "desktop" | "service";
} = {}): {
  readonly store: OperationalStore;
  readonly service: ReturnType<typeof createDevicePeerConnectService>;
  readonly owner: DevicePeerOwner;
  readonly routes: DevicePeerRouteRegistry;
  readonly connections: ConnectionManager;
  readonly controller: ReturnType<OperationalStore["createConnection"]>;
  readonly target: ReturnType<OperationalStore["createConnection"]>;
  readonly controllerKey: string;
  readonly targetKey: string;
  readonly targetHostKey?: string;
  readonly clock: { value: number };
} {
  const clock = { value: 100 };
  const store = new OperationalStore(":memory:", { now: () => clock.value });
  stores.push(store);
  const controllerKey = "controller-key";
  let targetKey = "target-key";
  const controller = store.createConnection({
    id: "connection-controller",
    deviceId: "device-controller",
    device: { defaultName: "Controller", kind: "web", platform: "web" },
    name: "Controller",
    authKeyDigest: digestAuthKey(controllerKey)
  });
  const connections = new ConnectionManager(store, { now: () => clock.value });
  let targetHostKey: string | undefined;
  const target = options.targetKind === "desktop"
    ? (() => {
        targetHostKey = "H".repeat(43);
        const issued = connections.issueTrustedDesktopConnection({
          desktopInstanceId: "4e56f4d8-c6ee-4a17-9a89-56e059b7e592",
          desktopDeviceId: "d6a365ef-ef33-4fb7-a0f1-a02eb57fef75",
          defaultDeviceName: "Target Desktop",
          platform: "windows",
          appVersion: "0.1.0",
          desktopHostAuthKey: targetHostKey
        });
        targetKey = issued.authKey;
        connections.confirmTrustedDesktopConnection(issued.connection.id, issued.authKey);
        return issued.connection;
      })()
    : store.createConnection({
        id: "connection-target",
        deviceId: "device-target",
        device: { defaultName: "Target Service", kind: "service", platform: "windows" },
        name: "Target Service",
        authKeyDigest: digestAuthKey(targetKey)
      });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const routes = new DevicePeerRouteRegistry({ generationSeed: 1 });
  const owner = new DevicePeerOwner({ store, routes });
  const service = createDevicePeerConnectService({
    owner,
    connections,
    store,
    ...(options.splitRouteAttachmentTimeoutMs === undefined
      ? {}
      : { splitRouteAttachmentTimeoutMs: options.splitRouteAttachmentTimeoutMs }),
    ...(options.maximumUnattachedSplitRoutes === undefined
      ? {}
      : { maximumUnattachedSplitRoutes: options.maximumUnattachedSplitRoutes })
  });
  return {
    store, service, owner, routes, connections, controller, target, controllerKey, targetKey,
    ...(targetHostKey === undefined ? {} : { targetHostKey }),
    clock
  };
}

function hello(targetDeviceId: string, requestId: string, defaultDisplayName = "Target Service"): contract.OpenDevicePeerAgentRouteRequest {
  return create(contract.OpenDevicePeerAgentRouteRequestSchema, {
    targetDeviceId,
    routeGeneration: 0n,
    requestId,
    payload: {
      case: "hello",
      value: create(contract.DevicePeerAgentHelloSchema, {
        deviceNameSource: create(contract.DeviceNameSourceSchema, { defaultDisplayName }),
        capabilities: [
          contract.DevicePeerCapabilityKind.FILES,
          contract.DevicePeerCapabilityKind.PROCESS,
          contract.DevicePeerCapabilityKind.TERMINAL,
          contract.DevicePeerCapabilityKind.FORWARDING
        ]
      })
    }
  });
}

function remoteDesktopHello(targetDeviceId: string, requestId: string): contract.OpenDevicePeerAgentRouteRequest {
  return create(contract.OpenDevicePeerAgentRouteRequestSchema, {
    targetDeviceId,
    routeGeneration: 0n,
    requestId,
    payload: {
      case: "hello",
      value: create(contract.DevicePeerAgentHelloSchema, {
        deviceNameSource: create(contract.DeviceNameSourceSchema, { defaultDisplayName: "Target Service" }),
        capabilities: [contract.DevicePeerCapabilityKind.REMOTE_DESKTOP]
      })
    }
  });
}

function agentResult(
  targetDeviceId: string,
  routeGeneration: bigint,
  requestId: string,
  result: Parameters<typeof create<typeof contract.DevicePeerAgentResultSchema>>[1]
): contract.OpenDevicePeerAgentRouteRequest {
  return create(contract.OpenDevicePeerAgentRouteRequestSchema, {
    targetDeviceId,
    routeGeneration,
    requestId,
    payload: {
      case: "result",
      value: create(contract.DevicePeerAgentResultSchema, result)
    }
  });
}

function publishAgentResult(
  targetDeviceId: string,
  routeGeneration: bigint,
  requestId: string,
  result: Parameters<typeof create<typeof contract.DevicePeerAgentResultSchema>>[1]
): contract.PublishDevicePeerAgentRouteRequest {
  return create(contract.PublishDevicePeerAgentRouteRequestSchema, {
    targetDeviceId,
    routeGeneration,
    requestId,
    payload: {
      case: "result",
      value: create(contract.DevicePeerAgentResultSchema, result)
    }
  });
}

function context(
  key: string,
  signal = new AbortController().signal,
  agentRouteAuthorization = key
): HandlerContext {
  return {
    requestHeader: new Headers({
      authorization: `Bearer ${key}`,
      [DEVICE_PEER_AGENT_AUTHORIZATION_HEADER]: `Bearer ${agentRouteAuthorization}`
    }),
    signal
  } as HandlerContext;
}

async function invoke<T>(handler: unknown, request: unknown, rpcContext: HandlerContext): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (input: unknown, context: HandlerContext) => Promise<T> | T)(request, rpcContext);
}

function openRoute(
  service: ReturnType<typeof createDevicePeerConnectService>,
  input: AsyncIterable<contract.OpenDevicePeerAgentRouteRequest>,
  rpcContext: HandlerContext
): AsyncIterator<contract.OpenDevicePeerAgentRouteResponse> {
  if (typeof service.openDevicePeerAgentRoute !== "function") throw new Error("Route handler is missing.");
  const output = (service.openDevicePeerAgentRoute as (
    input: AsyncIterable<contract.OpenDevicePeerAgentRouteRequest>,
    context: HandlerContext
  ) => AsyncIterable<contract.OpenDevicePeerAgentRouteResponse>)(input, rpcContext);
  return output[Symbol.asyncIterator]();
}

function openCommandRoute(
  service: ReturnType<typeof createDevicePeerConnectService>,
  request: contract.OpenDevicePeerAgentRouteRequest,
  rpcContext: HandlerContext
): AsyncIterator<contract.OpenDevicePeerAgentCommandRouteResponse> {
  if (typeof service.openDevicePeerAgentCommandRoute !== "function") throw new Error("Command route handler is missing.");
  const commandRequest = create(contract.OpenDevicePeerAgentCommandRouteRequestSchema, {
    targetDeviceId: request.targetDeviceId,
    routeGeneration: request.routeGeneration,
    requestId: request.requestId,
    payload: request.payload.case === "hello" ? request.payload : { case: undefined }
  });
  const output = (service.openDevicePeerAgentCommandRoute as (
    input: contract.OpenDevicePeerAgentCommandRouteRequest,
    context: HandlerContext
  ) => AsyncIterable<contract.OpenDevicePeerAgentCommandRouteResponse>)(commandRequest, rpcContext);
  return output[Symbol.asyncIterator]();
}

async function publishRoute(
  service: ReturnType<typeof createDevicePeerConnectService>,
  input: AsyncIterable<contract.PublishDevicePeerAgentRouteRequest>,
  rpcContext: HandlerContext
): Promise<contract.PublishDevicePeerAgentRouteResponse> {
  if (typeof service.publishDevicePeerAgentRoute !== "function") throw new Error("Publish route handler is missing.");
  return await (service.publishDevicePeerAgentRoute as (
    input: AsyncIterable<contract.PublishDevicePeerAgentRouteRequest>,
    context: HandlerContext
  ) => Promise<contract.PublishDevicePeerAgentRouteResponse>)(input, rpcContext);
}

function attachment(
  targetDeviceId: string,
  routeGeneration: bigint,
  requestId: string
): contract.PublishDevicePeerAgentRouteRequest {
  return create(contract.PublishDevicePeerAgentRouteRequestSchema, {
    targetDeviceId,
    routeGeneration,
    requestId,
    payload: {
      case: "attachment",
      value: create(contract.DevicePeerAgentRouteAttachmentSchema)
    }
  });
}

class TestInput<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: IteratorResult<T>) => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) throw new Error("Input is closed.");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      }
    };
  }
}
