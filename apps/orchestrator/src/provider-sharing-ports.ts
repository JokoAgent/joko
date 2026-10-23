import type { ProviderModel } from "@joko/core";
import type { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { createHash } from "node:crypto";

export interface ProviderSharingReceivedIdentity {
  readonly joinId: string; readonly shareId: string; readonly memberId: string; readonly generation: number;
  readonly hostServerId: string; readonly nativeBackendId: string; readonly providerId: string;
}
export interface ProviderSharingReceivedEntry extends ProviderSharingReceivedIdentity {
  readonly backendId: string; readonly displayName: string; readonly ownerName: string;
  readonly models: readonly ProviderModel[]; readonly state: "active" | "paused" | "unavailable" | "removed"; readonly sourceNodeId: string;
}
export interface ProviderSharingRecipient {
  readonly shareId: string; readonly memberId: string; readonly generation: number; readonly name: string; readonly avatarUrl: string | null;
}
export interface ProviderSharingDirectoryPort {
  readonly localSourceDeviceId: string;
  listReceived(): readonly ProviderSharingReceivedEntry[];
  subscribe(listener: () => void): () => void;
  assertReceived(identity: ProviderSharingReceivedIdentity): void;
  canRelayToRecipient(identity: ProviderSharingReceivedIdentity, recipient: ProviderSharingRecipient): {
    readonly approved: boolean; readonly opaqueReshareKey: string; assertCurrent(): void;
  };
  syncReshares(identity: ProviderSharingReceivedIdentity, recipients: readonly ProviderSharingRecipient[], signal: AbortSignal): Promise<void>;
  captureNative(identity: ProviderSharingReceivedIdentity, sourceDeviceId: string, recipient?: ProviderSharingRecipient): {
    readonly client: HostedAgentConnectClient; assertCurrent(): void; close(runId: string, signal: AbortSignal): Promise<void>;
  };
}
export function providerSharingBackendId(joinId: string, nativeBackendId: string): string {
  return "shared-provider-" + createHash("sha256").update(JSON.stringify([joinId, nativeBackendId])).digest("hex").slice(0, 32);
}
export function providerSharingReshareKey(recipient: Pick<ProviderSharingRecipient, "shareId" | "memberId">): string {
  return createHash("sha256").update(`provider-reshare\0${recipient.shareId}\0${recipient.memberId}`).digest("hex").slice(0, 32);
}
