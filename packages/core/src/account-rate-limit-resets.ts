import type { ProviderAccountUsageSnapshot, ProviderAccountUsageWindow } from "./types.js";

/** Private Adapter facts. Native credit identifiers must never enter the
 * generated client projection, an Event or an Operation body. */
export interface NativeAccountRateLimitResetCredit {
  readonly creditId: string;
  readonly resetType: "codexRateLimits" | "unknown";
  readonly status: "available" | "redeeming" | "redeemed" | "unknown";
  readonly grantedAt: number;
  readonly expiresAt?: number;
  readonly title?: string;
  readonly description?: string;
}

export interface NativeAccountRateLimitResetSnapshot {
  readonly providerId: string;
  /** Opaque account/workspace identity; contains no bearer or full identifier. */
  readonly accountKey: string;
  readonly accountLabel: string;
  readonly usage: ProviderAccountUsageSnapshot;
  readonly credits?: {
    readonly availableCount: number;
    /** Missing means count-only; an empty array is an authoritative detail read. */
    readonly details?: readonly NativeAccountRateLimitResetCredit[];
  };
  readonly ordinaryQuota?: {
    readonly primaryWindow?: ProviderAccountUsageWindow;
    readonly secondaryWindow?: ProviderAccountUsageWindow;
    readonly creditsDepleted: boolean;
  };
}

export interface NativeAccountRateLimitResetRead {
  readonly providerId: string;
  readonly signal?: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface NativeAccountRateLimitResetConsume extends NativeAccountRateLimitResetRead {
  readonly accountKey: string;
  readonly idempotencyKey: string;
  readonly creditId?: string;
}
export type NativeAccountRateLimitResetOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface NativeAccountRateLimitResetOperations {
  readAccountRateLimitResets(input: NativeAccountRateLimitResetRead): Promise<NativeAccountRateLimitResetSnapshot>;
  consumeAccountRateLimitReset(input: NativeAccountRateLimitResetConsume): Promise<NativeAccountRateLimitResetOutcome>;
}
