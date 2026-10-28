import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { RevisionConflictError } from "@joko/store";
import { HostedAgentHostError, type HostedAgentHost, type HostedAgentPrincipal } from "./hosted-agent-host.js";
import { HostedAgentWireError, HOSTED_AGENT_WIRE_FORMAT, assertHostedAgentWireFormat,
  decodeHostedAgentOpen, decodeHostedAgentReply, decodeHostedAgentInvocation, encodeHostedAgentValue } from "./hosted-agent-wire.js";
import type { HostedNativeInferenceRequest } from "@joko/adapter-hosted";
import type { HostedAgentSettings, HostedAgentSettingsUpdate } from "./hosted-agent-settings.js";
import { HostedAgentLimitError, type HostedAgentSessionSlots } from "./hosted-agent-limits.js";

export type HostedAgentEndpointPort = Pick<HostedAgentHost, "call" | "poll" | "reply" | "readArtifact" | "close"> & {
  infer?(principal: HostedAgentPrincipal, request: HostedNativeInferenceRequest, signal: AbortSignal): Promise<string>;
  begin(principal: HostedAgentPrincipal, input: Parameters<HostedAgentHost["begin"]>[1]): Promise<{ readonly workspaceRoot: string }>;
};
export type HostedAgentLifecycleEndpointPort = HostedAgentEndpointPort & Pick<HostedAgentHost, "closePrincipal" | "closeProviderGrant" | "closeRelayedGuest" | "activeProviderTurns" | "sweep" | "dispose">;
export interface HostedAgentConnectOptions {
  readonly host: HostedAgentEndpointPort;
  /** The authority remains valid after this individual HTTP request ends.
   * It must derive owner/guest, Device and Provider access from a current grant. */
  readonly authenticate: (context: HandlerContext) => HostedAgentPrincipal | Promise<HostedAgentPrincipal>;
  readonly catalog?: (principal: HostedAgentPrincipal) => contract.GetHostedAgentCatalogResponse;
  readonly management?: { readonly settings: HostedAgentSettings; readonly slots: HostedAgentSessionSlots;
    readonly assertProviderExists: (backendId: string, providerId: string) => void; readonly onChanged?: () => Promise<void> };
}
export function createHostedAgentConnectService(options: HostedAgentConnectOptions): ServiceImpl<typeof contract.HostedAgentService> {
  const invoke = async <T>(format: number, context: HandlerContext, action: (principal: HostedAgentPrincipal) => Promise<T>): Promise<T> => {
    try {
      assertHostedAgentWireFormat(format); context.signal.throwIfAborted();
      const principal = await options.authenticate(context); principal.assertCurrent(); context.signal.throwIfAborted();
      const result = await action(principal); principal.assertCurrent(); context.signal.throwIfAborted(); return result;
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      if (context.signal.aborted) throw new ConnectError("Hosted Agent request was cancelled.", Code.Canceled);
      const code = error instanceof HostedAgentWireError ? Code.InvalidArgument : error instanceof RevisionConflictError ? Code.Aborted
        : error instanceof HostedAgentLimitError ? Code.ResourceExhausted : error instanceof HostedAgentHostError ? {
        INVALID_REQUEST: Code.InvalidArgument, ACCESS_DENIED: Code.PermissionDenied, CONFLICT: Code.Aborted,
        UNAVAILABLE: Code.Unavailable, RESOURCE_EXHAUSTED: Code.ResourceExhausted
      }[error.code] : Code.FailedPrecondition;
      const metadata = error instanceof HostedAgentLimitError ? { "x-joko-native-capacity": error.scope } : undefined;
      throw new ConnectError("Hosted Agent request is unavailable.", code, metadata);
    }
  };
  const identity = (value: string) => { if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) throw new HostedAgentWireError(); return value; };
  const integer = (value: bigint | number) => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new HostedAgentWireError(); return number; };
  const format = HOSTED_AGENT_WIRE_FORMAT;
  const management = (principal: HostedAgentPrincipal) => {
    if (principal.trust !== "owner") throw new ConnectError("Only the computer owner can manage hosted Agents.", Code.PermissionDenied);
    if (!options.management) throw new ConnectError("Hosted Agent management is unavailable.", Code.Unimplemented); return options.management;
  };
  const settings = (principal: HostedAgentPrincipal) => {
    const owner = management(principal), snapshot = owner.settings.snapshot();
    return create(contract.HostedAgentSettingsSchema, { revision: snapshot.revision, remoteControlEnabled: snapshot.value.remoteControlEnabled,
      providers: snapshot.value.providers.map(provider => ({ backendId: provider.backendId, providerId: provider.providerId, enabled: provider.enabled,
        modelAccess: contract.toRemoteModelAccess(provider.modelIds) })),
      limits: owner.settings.limits(), limitsOverridden: snapshot.value.limits !== undefined, usage: owner.slots.summary(), idleReleaseMinutes: owner.settings.idleReleaseMinutes() });
  };
  return {
    getHostedAgentCatalog: (request, context) => invoke(request.format, context, async principal => {
      if (!options.catalog) throw new ConnectError("Hosted Agent catalog is unavailable.", Code.Unimplemented);
      return options.catalog(principal);
    }),
    getHostedAgentSettings: (_request, context) => invoke(format, context, async principal => create(contract.GetHostedAgentSettingsResponseSchema, { settings: settings(principal) })),
    updateHostedAgentSettings: (request, context) => invoke(format, context, async principal => {
      const owner = management(principal); let update: HostedAgentSettingsUpdate;
      switch (request.update.case) {
        case "remoteControl": update = { kind: "remote_control", enabled: request.update.value.enabled }; break;
        case "provider": {
          const provider = request.update.value; identity(provider.backendId); identity(provider.providerId);
          if (provider.enabled) owner.assertProviderExists(provider.backendId, provider.providerId);
          update = { kind: "provider", backendId: provider.backendId, providerId: provider.providerId, enabled: provider.enabled }; break;
        }
        case "limits": update = { kind: "limits", value: request.update.value }; break;
        case "idleReleaseMinutes": update = { kind: "idle_release", minutes: request.update.value }; break;
        case "modelAccess": {
          const provider = request.update.value; identity(provider.backendId); identity(provider.providerId);
          if (!provider.access) throw new HostedAgentWireError();
          owner.assertProviderExists(provider.backendId, provider.providerId);
          update = { kind: "model_access", backendId: provider.backendId, providerId: provider.providerId,
            modelIds: contract.readRemoteModelAccess(provider.access) }; break;
        }
        case "resetLimits": update = { kind: "reset_limits" }; break;
        default: throw new HostedAgentWireError();
      }
      owner.settings.update(update, request.expectedRevision); await owner.onChanged?.();
      return create(contract.UpdateHostedAgentSettingsResponseSchema, { settings: settings(principal) });
    }),
    openHostedAgent: (request, context) => invoke(request.format, context, async principal => {
      const input = decodeHostedAgentOpen(request.openJson);
      try {
        const run = await options.host.begin(principal, input);
        return create(contract.OpenHostedAgentResponseSchema, { format, runId: input.runId, virtualRoot: run.workspaceRoot });
      } catch (error) {
        const capacityRejection = nativeCapacity(error); if (capacityRejection === undefined) throw error;
        return create(contract.OpenHostedAgentResponseSchema, { format, runId: input.runId, capacityRejection });
      }
    }),
    callHostedAgent: (request, context) => invoke(request.format, context, async principal => {
      const command = decodeHostedAgentInvocation(request.commandJson);
      if (command.kind === "infer" && (request.runId !== command.request.requestId || request.callId !== command.request.requestId)) throw new HostedAgentWireError();
      if (command.kind === "infer" && !options.host.infer) throw new ConnectError("Isolated native inference is unavailable.", Code.Unimplemented);
      try {
        const result = command.kind === "infer" ? await options.host.infer!(principal, command.request, context.signal)
          : await options.host.call(principal, identity(request.runId), identity(request.callId), command);
        return create(contract.CallHostedAgentResponseSchema, { format, resultJson: encodeHostedAgentValue(result) });
      } catch (error) {
        const capacityRejection = nativeCapacity(error); if (capacityRejection === undefined) throw error;
        return create(contract.CallHostedAgentResponseSchema, { format, capacityRejection });
      }
    }),
    pollHostedAgents: (request, context) => invoke(request.format, context, async principal => {
      const runs = await options.host.poll(principal, request.cursors.map(cursor => ({ runId: identity(cursor.runId), after: integer(cursor.after) })), context.signal);
      return create(contract.PollHostedAgentsResponseSchema, { format, runs: runs.map(run => ({ runId: run.runId, cursor: BigInt(run.cursor),
        finished: run.finished, framesJson: encodeHostedAgentValue(run.frames) })) });
    }),
    replyHostedAgent: (request, context) => invoke(request.format, context, async principal => {
      await options.host.reply(principal, identity(request.runId), identity(request.requestId), decodeHostedAgentReply(request.resultJson));
      return create(contract.ReplyHostedAgentResponseSchema, { format });
    }),
    readHostedAgentArtifact: (request, context) => invoke(request.format, context, async principal => {
      const result = await options.host.readArtifact(principal, identity(request.runId), identity(request.artifactId), integer(request.offset), integer(request.maximumBytes));
      return create(contract.ReadHostedAgentArtifactResponseSchema, { format, data: Buffer.from(result.data, "base64") });
    }),
    closeHostedAgent: (request, context) => invoke(request.format, context, async principal => {
      await options.host.close(principal, identity(request.runId)); return create(contract.CloseHostedAgentResponseSchema, { format });
    })
  };
}
function nativeCapacity(error: unknown): contract.HostedAgentCapacityRejection | undefined {
  const scope = error instanceof HostedAgentLimitError ? error.scope : error instanceof ConnectError && error.code === Code.ResourceExhausted
    ? error.metadata.get("x-joko-native-capacity") : undefined;
  return scope === "device" ? contract.HostedAgentCapacityRejection.DEVICE_LIMIT : scope === "total" ? contract.HostedAgentCapacityRejection.TOTAL_LIMIT : undefined;
}
