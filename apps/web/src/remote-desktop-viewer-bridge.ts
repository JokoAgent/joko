import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import { createClient, ConnectError, type Transport, type Client } from "@connectrpc/connect";
import { RemoteDesktopService, RemoteDesktopFailureSchema, sameDesktopRemoteDesktopViewerOwner,
  type DesktopRemoteDesktopViewerApi, type DesktopRemoteDesktopViewerOwner } from "@joko/contracts";
import type { ControllerState, AppController } from "./controller.js";

export function desktopRemoteDesktopViewerOwner(state: ControllerState): DesktopRemoteDesktopViewerOwner | undefined {
  const profile = state.activeProfile;
  return !state.ready || state.connectionState !== "connected" || profile === undefined || state.connectionGeneration === undefined
    ? undefined : { profileId: profile.id, serverId: profile.serverId, deviceId: profile.deviceId,
      origin: profile.origin, endpointPublicKey: profile.endpointPublicKey, transportKind: profile.transportKind, connectionGeneration: state.connectionGeneration };
}

export async function openDesktopRemoteDesktopViewer(controller: Pick<AppController, "state">,
  expected: DesktopRemoteDesktopViewerOwner | undefined, target: { readonly deviceId: string; readonly name: string; readonly inputHandoffRequestId?: string }): Promise<void> {
  const api = window.jokoDesktop?.remoteDesktopViewer;
  if (expected === undefined || api === undefined || !sameDesktopRemoteDesktopViewerOwner(expected, desktopRemoteDesktopViewerOwner(controller.state))) return;
  await api.bind(expected);
  if (!sameDesktopRemoteDesktopViewerOwner(expected, desktopRemoteDesktopViewerOwner(controller.state))) {
    await api.retire(expected); return;
  }
  await api.open(expected, target);
}

/** The window never receives an origin or bearer; its Main owner supplies the peer identity. */
export function createDesktopRemoteDesktopViewerClient(api: DesktopRemoteDesktopViewerApi, generation: number): Client<typeof RemoteDesktopService> {
  const transport: Transport = {
    async unary(method, signal, _timeout, _header, input) {
      signal?.throwIfAborted();
      const reply = await api.request(generation, method.localName, toBinary(method.input, create(method.input, input)));
      signal?.throwIfAborted();
      if (!reply.ok) throw new ConnectError("Remote Desktop request failed.", reply.code, undefined,
        [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: reply.reason }) }]);
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(),
        message: fromBinary(method.output, reply.bytes) };
    },
    stream: () => { throw new TypeError("Desktop viewer has no streaming RPC bridge."); }
  };
  return createClient(RemoteDesktopService, transport);
}
