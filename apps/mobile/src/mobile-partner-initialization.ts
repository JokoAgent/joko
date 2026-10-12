import type { RetryPartnerInitializationResponse } from "@joko/contracts";
import { projectMobilePartnerProfile, type MobilePartnerDirectoryOpenResult,
  type MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import { projectMobilePartnerProfileOptions } from "./mobile-partner-profile";

export interface MobilePartnerInitializationTransport {
  readonly ownerKey: string;
  load(partnerId: string, signal: AbortSignal): Promise<MobilePartnerDirectoryProfile>;
  retry(partner: MobilePartnerDirectoryProfile, signal: AbortSignal): Promise<MobilePartnerDirectoryProfile>;
  open(partner: MobilePartnerDirectoryProfile, signal: AbortSignal): Promise<MobilePartnerDirectoryOpenResult>;
}

export function projectMobilePartnerInitializationRetry(partnerId: string, expectedRevision: bigint,
  response: RetryPartnerInitializationResponse): MobilePartnerDirectoryProfile {
  if (!response.partner) throw new Error("The Joko node returned no Partner initialization result.");
  const partner = projectMobilePartnerProfile(response.partner);
  projectMobilePartnerProfileOptions(response.directory);
  if (partner.partnerId !== partnerId || partner.lifecycle !== "active" || partner.revision <= expectedRevision) {
    throw new Error("The Joko node returned a mismatched Partner initialization result.");
  }
  return partner;
}
