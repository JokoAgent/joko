import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ProviderGroupRebalanceSuggestionSchema } from "@joko/contracts";

export function rebalanceSuggestionFixture(generation = 8n, patch: MessageInitShape<typeof ProviderGroupRebalanceSuggestionSchema> = {}) {
  const { $typeName: _typeName, ...fields } = patch;
  return create(ProviderGroupRebalanceSuggestionSchema, { suggestionKey: `rebalance_${"a".repeat(64)}`, generation,
    group: { backendId: "backend", providerId: "group" }, fromMemberKey: "current", toMemberKey: "target",
    fromLabel: "Current account", toLabel: "Target account", automatic: false,
    currentQuota: { limited: false, usagePercent: 80, urgency: 0.2, pacingWindow: { usedPercent: 80, windowMs: 18_000_000 } },
    targetQuota: { limited: false, usagePercent: 20, urgency: 0.8, pacingWindow: { usedPercent: 20, windowMs: 18_000_000 } }, ...fields });
}
