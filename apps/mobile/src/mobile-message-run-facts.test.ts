import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, UsageSchema } from "@joko/contracts";
import { expect, it } from "vitest";
import { mobileMessageRunFacts } from "./mobile-message-run-facts";
import { timelineRows } from "./timeline";

it("rebuilds model and usage facts from the exact assistant completion without inventing price or billed charges", () => {
  const event = create(EventSchema, { eventId: "complete", identity: { sessionId: "task", runId: "run" }, cursor: { sequence: 1n, generation: 1n },
    payload: { kind: { case: "messageCompleted", value: { messageId: "answer", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "text", value: "Done" } }], turnUsage: {
        usage: { totalTokens: 12_000n, costMicros: 1_230_000n, currencyCode: "USD" }, estimated: true, costComplete: true, tokensComplete: true,
        completionEventId: "complete", messageId: "answer"
      }, modelSubstitution: { selectedModelId: "selected", actualModelId: "actual" } } } } });
  const row = timelineRows([event])[0]!;
  expect(mobileMessageRunFacts(row, "en")).toEqual({ modelNotice: "This turn used actual instead of the selected model selected.",
    usageLabel: "≈$1.23", usageDescription: "Estimated value this turn: $1.23" });
  expect(mobileMessageRunFacts({ ...row, usageIsEstimate: false }, "en").usageDescription).toBe("Cost this turn: $1.23");
  expect(mobileMessageRunFacts({ ...row, usageIsEstimate: false, usageCostComplete: false }, "en"))
    .toMatchObject({ usageLabel: "$1.23+", usageDescription: "Known cost this turn: $1.23 (incomplete)" });
  expect(mobileMessageRunFacts({ ...row, usageCostComplete: false }, "en"))
    .toMatchObject({ usageLabel: "≈$1.23+", usageDescription: "Estimated value this turn: $1.23 (incomplete)" });
  expect(mobileMessageRunFacts({ ...row, usageTokensComplete: false }, "en"))
    .toMatchObject({ usageLabel: "≈$1.23 · 12K reported tokens", usageDescription:
      "Estimated value this turn: $1.23 · Reported tokens this turn: 12K (incomplete accounting)" });
  expect(mobileMessageRunFacts({ ...row, usage: create(UsageSchema, { totalTokens: 12_000n }) }, "en").usageLabel).toBe("12K tokens");
  expect(mobileMessageRunFacts({ ...row, usageCostComplete: false, usage: create(UsageSchema, { totalTokens: 12_000n }) }, "en"))
    .toMatchObject({ usageLabel: "12K tokens", usageDescription: "Tokens this turn: 12K; cost unavailable" });
  expect(mobileMessageRunFacts({ ...row, usageCostComplete: false, usageTokensComplete: false, usage: create(UsageSchema, { totalTokens: 12_000n }) }, "en"))
    .toMatchObject({ usageLabel: "12K reported tokens", usageDescription: "Reported tokens this turn: 12K (incomplete accounting); cost unavailable" });
  expect(mobileMessageRunFacts({ ...row, usage: create(UsageSchema, { totalTokens: 12_000n, costMicros: 2n ** 62n, currencyCode: "USD" }) }, "en").usageLabel).toBe("12K tokens");
  expect(mobileMessageRunFacts({ ...row, completed: false }, "en")).toEqual({});
  expect(mobileMessageRunFacts({ ...row, kind: "user" }, "en")).toEqual({});
  expect(mobileMessageRunFacts({ ...row, usage: create(UsageSchema), modelSubstitution: undefined }, "en").usageLabel).toBeUndefined();
  for (const usage of [create(UsageSchema, { totalTokens: -1n }), create(UsageSchema, { totalTokens: 2n ** 64n }),
    create(UsageSchema, { totalTokens: 1n, costMicros: -1n })]) {
    expect(mobileMessageRunFacts({ ...row, usage }, "en").usageLabel).toBeUndefined();
  }
  expect(mobileMessageRunFacts({ ...row, modelSubstitution: { selectedModelId: "model", actualModelId: "model" } }, "en").modelNotice).toBeUndefined();
});
