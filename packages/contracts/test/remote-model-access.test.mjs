import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import { readRemoteModelAccess, toRemoteModelAccess, HostedAgentModelAccessSchema, ProviderSharingInsightsSchema,
  projectProviderSharingInsights } from "../dist/index.js";

test("remote model grants retain empty, inherited, and exact missing identities", () => {
  assert.equal(readRemoteModelAccess(toRemoteModelAccess(undefined)), undefined);
  assert.deepEqual(readRemoteModelAccess(toRemoteModelAccess([])), []);
  assert.deepEqual(readRemoteModelAccess(toRemoteModelAccess(["model", "temporary/missing"])), ["model", "temporary/missing"]);
  assert.throws(() => readRemoteModelAccess(create(HostedAgentModelAccessSchema, { allModels: true, modelIds: ["model"] })));
  assert.throws(() => toRemoteModelAccess(["model", "model"]));
  assert.throws(() => toRemoteModelAccess(["model\nforeign"]));
});

test("closed visibility removes peer data and malformed quota never becomes zero usage", () => {
  const row = create(ProviderSharingInsightsSchema, { visibility: { quota: false, usage: false }, quotaStatus: "ready", usageStatus: "ready",
    accounts: [{ state: "ready", usage: { primaryWindow: { usedPercent: 0 } } }], days: [{ day: "2026-10-28", modelId: "model", turns: 1n }] });
  const closed = projectProviderSharingInsights(row);
  assert.deepEqual(closed.accounts, []); assert.deepEqual(closed.days, []); assert.equal(closed.quotaStatus, "disabled");
  assert.throws(() => projectProviderSharingInsights(create(ProviderSharingInsightsSchema, { visibility: { quota: true, usage: false }, quotaStatus: "ready",
    accounts: [{ state: "ready", usage: { observedAt: { seconds: 1n }, primaryWindow: { usedPercent: Number.NaN } } }] })));
  assert.throws(() => projectProviderSharingInsights(create(ProviderSharingInsightsSchema, { visibility: { quota: false, usage: true }, usageStatus: "ready",
    days: [{ day: "2026-02-30", modelId: "model" }] })));
});
