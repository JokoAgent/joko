import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { DevicePeerAuthority, DevicePeerOwner } from "./device-peer-owner.js";
import { createHostedAgentPeerTransport } from "./hosted-agent-peer-transport.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import type { ProviderSharingRecipient } from "./provider-sharing-ports.js";
import type { HostedAgentOpen } from "./hosted-agent-host.js";

/** Called by the group service after its own original guest grant is captured.
 * No public open payload, TaskShare grant, or Model identifier creates this. */
export function createHostedAgentGuestPeerCapture(options: { readonly owner: DevicePeerOwner; readonly authority: DevicePeerAuthority;
  readonly recipient: ProviderSharingRecipient; readonly backendId: string; readonly providerId: string; readonly modelIds: readonly string[];
  readonly assertCurrent: () => void; readonly shouldPurge?: () => boolean }) {
  options.assertCurrent(); options.authority.assertCurrent(["native_agents"]);
  if (!options.recipient.shareId || !options.recipient.memberId || !Number.isSafeInteger(options.recipient.generation) || options.recipient.generation < 1) throw new Error("The original Provider recipient is invalid.");
  const scope = create(contract.HostedAgentGuestRelayScopeSchema, { relayId: createHash("sha256").update(JSON.stringify([options.recipient.shareId, options.recipient.memberId])).digest("hex"),
    backendId: options.backendId, providerId: options.providerId, modelIds: [...options.modelIds] });
  const generated = createClient(contract.HostedAgentService, createHostedAgentPeerTransport({ owner: options.owner, authority: options.authority,
    guestRelay: { scope, ...(options.shouldPurge === undefined ? {} : { shouldPurge: options.shouldPurge }) } }));
  const assertCurrent = () => { options.authority.assertCurrent(["native_agents"]); options.assertCurrent(); };
  const cleanups = new Map<string, (signal?: AbortSignal) => Promise<void>>();
  class CapturedClient extends HostedAgentConnectClient {
    override open(input: HostedAgentOpen, signal: AbortSignal) {
      assertCurrent();
      if (!cleanups.has(input.runId)) cleanups.set(input.runId, options.owner.captureHostedAgentCleanup(options.authority, input.runId,
        { scope, ...(options.shouldPurge === undefined ? {} : { shouldPurge: options.shouldPurge }) }));
      return super.open(input, signal);
    }
  }
  return { client: new CapturedClient(generated, assertCurrent), assertCurrent,
    close: async (runId: string, signal: AbortSignal) => { signal.throwIfAborted(); const cleanup = cleanups.get(runId);
      if (!cleanup) throw new Error("The original guest relay cleanup was not captured."); await cleanup(signal); signal.throwIfAborted(); } };
}
