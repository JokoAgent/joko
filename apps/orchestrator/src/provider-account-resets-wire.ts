import { create } from "@bufbuild/protobuf";
import { z } from "zod";
import * as contract from "@joko/contracts";
import type { AccountResetOfferView, AccountResetResult, AccountResetView } from "./provider-account-resets.js";
import { toProtoTimestamp } from "./proto-mapper.js";

const resultSchema = z.strictObject({ backendId: z.string().min(1).max(512), providerId: z.string().min(1).max(512),
  accountKey: z.string().regex(/^[a-f0-9]{64}$/u), offerId: z.uuid(), outcome: z.enum(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]) });
export function accountResetResultFromRecord(value: unknown): AccountResetResult { return resultSchema.parse(value); }

export function toProtoAccountResetResult(value: AccountResetResult): contract.ProviderAccountResetResult {
  const outcomes = { reset: contract.ProviderAccountResetOutcome.RESET, nothingToReset: contract.ProviderAccountResetOutcome.NOTHING_TO_RESET,
    noCredit: contract.ProviderAccountResetOutcome.NO_CREDIT, alreadyRedeemed: contract.ProviderAccountResetOutcome.ALREADY_REDEEMED };
  return create(contract.ProviderAccountResetResultSchema, { ...value, outcome: outcomes[value.outcome] });
}
export function unavailableAccountResetState(backendId: string, providerId: string, unsupported = false): contract.ProviderAccountResetState {
  return create(contract.ProviderAccountResetStateSchema, { backendId, providerId,
    availability: unsupported ? contract.ProviderAccountResetAvailability.UNSUPPORTED : contract.ProviderAccountResetAvailability.UNAVAILABLE });
}
export function toProtoAccountResetState(value: AccountResetView): contract.ProviderAccountResetState {
  return create(contract.ProviderAccountResetStateSchema, { backendId: value.backendId, providerId: value.providerId,
    availability: contract.ProviderAccountResetAvailability.AVAILABLE, accountKey: value.accountKey, accountLabel: value.accountLabel,
    ...(value.availableCount === undefined ? {} : { availableCount: value.availableCount }), detailsAvailable: value.detailsAvailable,
    credits: value.credits.map(credit => ({ title: credit.title, grantedAt: toProtoTimestamp(credit.grantedAt),
      ...(credit.expiresAt === undefined ? {} : { expiresAt: toProtoTimestamp(credit.expiresAt) }), ...(credit.offer ? { offer: offer(credit.offer) } : {}) })),
    ...(value.defaultOffer ? { defaultOffer: offer(value.defaultOffer) } : {}), automaticSettings: value.automaticSettings,
    settingsRevision: { value: value.settingsRevision }, customized: value.customized,
    ...(value.lastAutomaticUse === undefined ? {} : { lastAutomaticUse: toProtoTimestamp(value.lastAutomaticUse) }), capturedAt: toProtoTimestamp(value.capturedAt) });
}
function offer(value: AccountResetOfferView): contract.ProviderAccountResetOffer {
  return create(contract.ProviderAccountResetOfferSchema, { offerId: value.offerId, validUntil: toProtoTimestamp(value.validUntil), retryOnly: value.retryOnly,
    ...(value.expiresAt === undefined ? {} : { expiresAt: toProtoTimestamp(value.expiresAt) }) });
}
