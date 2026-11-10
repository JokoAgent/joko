import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ProviderAccountResetStateSchema, DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, parseProviderAccountResetSettings, providerAccountResetOperationId } from "../dist/index.js";

test("preserves an unknown reset count separately from zero through the generated contract", () => {
  const roundTrip = value => fromBinary(ProviderAccountResetStateSchema, toBinary(ProviderAccountResetStateSchema, create(ProviderAccountResetStateSchema, value)));
  assert.equal(roundTrip({}).availableCount, undefined);
  assert.equal(roundTrip({ availableCount: 0 }).availableCount, 0);
});
test("keeps settings bounds, explicit defaults and a separate canonical operation identity for each connection", () => {
  assert.deepEqual(parseProviderAccountResetSettings(DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS), DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS);
  assert.throws(() => parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true, lowQuota: false, expiring: false }));
  assert.throws(() => parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, minimumDays: 366 }));
  assert.throws(() => parseProviderAccountResetSettings({ ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, expiryMinutes: 90 }));
  const offer = "0d724809-86af-4f8d-93dc-fbfa21e81afe";
  assert.equal(providerAccountResetOperationId(offer, "owner"), providerAccountResetOperationId(offer, "owner"));
  assert.notEqual(providerAccountResetOperationId(offer, "owner"), providerAccountResetOperationId(offer, "other"));
});
