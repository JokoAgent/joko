import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import { ConnectionAuthenticationError } from "./connection-manager.js";
import type { PartnerNetworkHost, PartnerNetworkAuthority } from "./partner-network-host.js";
import { partnerNetworkError } from "./partner-network-host.js";
import type { PartnerNetworkHome } from "./partner-network-home.js";

export function createPartnerNetworkService(options: { readonly host: PartnerNetworkHost; readonly home: PartnerNetworkHome; readonly connections: ConnectionManager;
  readonly configureProject?: (request: contract.ConfigurePartnerNetworkProjectRequest, auth: PartnerNetworkAuthority) => Promise<contract.ConfigurePartnerNetworkProjectResponse>;
  readonly ownerControls?: (request: contract.GetPartnerNetworkOwnerControlsRequest, auth: PartnerNetworkAuthority) => Promise<contract.GetPartnerNetworkOwnerControlsResponse>;
  readonly respondOwnerInteraction?: (request: contract.RespondPartnerNetworkOwnerInteractionRequest, auth: PartnerNetworkAuthority) => Promise<contract.RespondPartnerNetworkOwnerInteractionResponse> }): ServiceImpl<typeof contract.PartnerNetworkService> {
  const owner = async <T>(context: HandlerContext, action: (auth: PartnerNetworkAuthority) => T | Promise<T>): Promise<T> => {
    let stop: (() => void) | undefined;
    try {
      const connection = options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined), revoked = new AbortController();
      stop = options.connections.onRevoked(connection.id, () => revoked.abort());
      const signal = AbortSignal.any([revoked.signal, context.signal]), authority: PartnerNetworkAuthority = { deviceId: connection.deviceId, signal,
        assertCurrent: () => { signal.throwIfAborted(); options.connections.fence(connection); } };
      authority.assertCurrent(); const result = await action(authority); authority.assertCurrent(); return result;
    } catch (error) { if (context.signal.aborted) throw new ConnectError("The conversation request was cancelled.", Code.Canceled);
      if (error instanceof ConnectionAuthenticationError) throw new ConnectError("The original connection is missing or was revoked.", Code.Unauthenticated);
      return partnerNetworkError(error); }
    finally { stop?.(); }
  };
  return {
    listPartnerNetwork: (_request, context) => owner(context, async auth => create(contract.ListPartnerNetworkResponseSchema, { rooms: [...options.host.list(), ...await options.home.refresh(auth)] })),
    createPartnerNetwork: (request, context) => owner(context, () => create(contract.CreatePartnerNetworkResponseSchema, { room: options.host.create(request) })),
    invitePartnerNetwork: (request, context) => owner(context, async auth => request.joinId ? options.home.invite(request, auth) : options.host.invite(request, options.host.selfId)),
    previewPartnerNetwork: (request, context) => owner(context, auth => options.home.preview(request.invitation, auth)),
    joinPartnerNetwork: (request, context) => owner(context, async auth => create(contract.JoinPartnerNetworkResponseSchema, { room: await options.home.join(request, auth) })),
    getPartnerNetwork: (request, context) => owner(context, async auth => create(contract.GetPartnerNetworkResponseSchema, { snapshot: request.joinId ? await options.home.snapshot(request, auth) : options.host.snapshot(request, options.host.selfId) })),
    readPartnerNetworkFailures: (request, context) => owner(context, auth => request.joinId ? options.home.failures(request, auth) : options.host.failures(request, options.host.selfId)),
    sendPartnerNetwork: (request, context) => owner(context, async auth => create(contract.SendPartnerNetworkResponseSchema, { message: request.joinId ? await options.home.send(request, auth) : options.host.send(request, options.host.selfId) })),
    managePartnerNetwork: (request, context) => owner(context, async auth => create(contract.ManagePartnerNetworkResponseSchema, { room: request.joinId ? await options.home.manage(request, auth) : options.host.manage(request, options.host.selfId, true) })),
    reactPartnerNetwork: (request, context) => owner(context, async auth => create(contract.ReactPartnerNetworkResponseSchema, { message: request.joinId ? await options.home.react(request, auth) : options.host.react(request, options.host.selfId) })),
    mediaPartnerNetwork: (request, context) => owner(context, auth => request.joinId ? options.home.media(request, auth) : options.host.media(request, options.host.selfId, auth)),
    planPartnerNetwork: (request, context) => owner(context, auth => request.joinId ? options.home.plan(request, auth) : options.host.plan(request, options.host.selfId)),
    configurePartnerNetworkProject: (request, context) => owner(context, auth => { if (!options.configureProject) throw new ConnectError("Local project settings are unavailable.", Code.Unimplemented);
      return options.configureProject(request, auth); }),
    getPartnerNetworkOwnerControls: (request, context) => owner(context, auth => options.ownerControls?.(request, auth) ?? create(contract.GetPartnerNetworkOwnerControlsResponseSchema)),
    respondPartnerNetworkOwnerInteraction: (request, context) => owner(context, auth => { if (!options.respondOwnerInteraction) throw new ConnectError("Conversation controls are unavailable.", Code.Unimplemented); return options.respondOwnerInteraction(request, auth); })
  };
}
export function createPartnerNetworkGuestService(host: PartnerNetworkHost): ServiceImpl<typeof contract.PartnerNetworkGuestService> {
  const invoke = async <T>(context: HandlerContext, action: () => T | Promise<T>): Promise<T> => {
    try { context.signal.throwIfAborted(); const result = await action(); context.signal.throwIfAborted(); return result; }
    catch (error) { if (context.signal.aborted) throw new ConnectError("The conversation request was cancelled.", Code.Canceled); return partnerNetworkError(error); }
  };
  const actor = (roomId: string, context: HandlerContext) => host.actor(roomId, context.requestHeader.get("authorization") ?? undefined);
  return {
    inspectPartnerNetwork: (request, context) => invoke(context, () => create(contract.InspectPartnerNetworkResponseSchema, { ...host.inspect(request.invitation), $typeName: undefined })),
    acceptPartnerNetwork: (request, context) => invoke(context, () => host.accept(request)),
    invitePartnerNetwork: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServiceInvitePartnerNetworkResponseSchema,
      { ...host.invite(create(contract.InvitePartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context)), $typeName: undefined })),
    getPartnerNetwork: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServiceGetPartnerNetworkResponseSchema,
      { snapshot: host.snapshot(create(contract.GetPartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context)) })),
    readPartnerNetworkFailures: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServiceReadPartnerNetworkFailuresResponseSchema,
      { ...host.failures(create(contract.ReadPartnerNetworkFailuresRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context)), $typeName: undefined })),
    sendPartnerNetwork: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServiceSendPartnerNetworkResponseSchema,
      { message: host.send(create(contract.SendPartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context)) })),
    managePartnerNetwork: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServiceManagePartnerNetworkResponseSchema,
      { room: host.manage(create(contract.ManagePartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context), false) })),
    reactPartnerNetwork: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServiceReactPartnerNetworkResponseSchema,
      { message: host.react(create(contract.ReactPartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context)) })),
    mediaPartnerNetwork: (request, context) => invoke(context, async () => { const actorId = actor(request.roomId, context);
      const result = await host.media(create(contract.MediaPartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actorId,
        { signal: context.signal, assertCurrent: () => { if (actor(request.roomId, context) !== actorId) throw new ConnectError("The conversation membership changed.", Code.PermissionDenied); } });
      return create(contract.PartnerNetworkGuestServiceMediaPartnerNetworkResponseSchema, { ...result, $typeName: undefined }); }),
    claimPartnerNetwork: (request, context) => invoke(context, () => host.claim(request, actor(request.roomId, context))),
    settlePartnerNetwork: (request, context) => invoke(context, () => create(contract.SettlePartnerNetworkResponseSchema, { execution: host.settle(request, actor(request.roomId, context)) })),
    publishPartnerNetworkActor: (request, context) => invoke(context, () => create(contract.PublishPartnerNetworkActorResponseSchema, { message: host.publish(request, actor(request.roomId, context)) })),
    planPartnerNetwork: (request, context) => invoke(context, () => create(contract.PartnerNetworkGuestServicePlanPartnerNetworkResponseSchema,
      { ...host.plan(create(contract.PlanPartnerNetworkRequestSchema, { ...request, $typeName: undefined }), actor(request.roomId, context)), $typeName: undefined })),
    getPartnerNetworkExecution: (request, context) => invoke(context, () => host.readExecution(request, actor(request.roomId, context)))
  };
}
