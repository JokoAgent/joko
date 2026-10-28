import { expect, it } from "vitest";
import { partnerTaskContextUsage, suggestPartnerTaskRoute } from "./partner-task-route.js";

const wide = { backendId: "runtime", providerId: "account", modelId: "wide", fastMode: false };
const small = { ...wide, modelId: "small" }, backup = { ...wide, modelId: "backup" };
const windows: Record<string, number> = { wide: 1_000_000, small: 272_000, backup: 1_000_000 };
const input = (patch: Partial<Parameters<typeof suggestPartnerTaskRoute>[0]> = {}): Parameters<typeof suggestPartnerTaskRoute>[0] => ({
  chain: [wide, small, backup], current: wide, failure: { code: "QUOTA_EXCEEDED", message: "Account quota exhausted." },
  visitedRoutes: [], contextTokens: 40_000, currentContextWindow: 1_000_000,
  available: () => true, windowOf: route => windows[route.modelId], ...patch
});

it("suggests only exact unvisited configured routes for a failure another route can address", () => {
  expect(suggestPartnerTaskRoute(input())).toEqual(small);
  expect(suggestPartnerTaskRoute(input({ current: { ...wide, providerId: "owner-account" } }))).toBeUndefined();
  expect(suggestPartnerTaskRoute(input({ current: { ...wide, modelId: "owner-choice" } }))).toBeUndefined();
  expect(suggestPartnerTaskRoute(input({ visitedRoutes: ["runtime\0account\0small"] }))).toEqual(backup);
  expect(suggestPartnerTaskRoute(input({ available: route => route.modelId !== "small" }))).toEqual(backup);
  expect(suggestPartnerTaskRoute(input({ failure: undefined }))).toBeUndefined();
});

it.each(["INVALID_REQUEST", "CONTEXT_OVERFLOW", "CONTENT_POLICY", "SANDBOX_ERROR", "TOOL_USE_LOOP_DETECTED",
  "CLAUDE_CODE_CONTEXT_LIMIT", "CLAUDE_CODE_TURN_LIMIT"])("does not recommend a model change for %s", code => {
  expect(suggestPartnerTaskRoute(input({ failure: { code } }))).toBeUndefined();
});

it("skips smaller windows at the warning line and keeps equal, larger and unknown windows", () => {
  expect(suggestPartnerTaskRoute(input({ contextTokens: 190_399 }))).toEqual(small);
  expect(suggestPartnerTaskRoute(input({ contextTokens: 190_400 }))).toEqual(backup);
  expect(suggestPartnerTaskRoute(input({ contextTokens: 220_000, chain: [wide, small] }))).toBeUndefined();
  expect(suggestPartnerTaskRoute(input({ contextTokens: null }))).toEqual(backup);
  expect(suggestPartnerTaskRoute(input({ current: small, contextTokens: 240_000, currentContextWindow: 272_000 }))).toEqual(backup);
  expect(suggestPartnerTaskRoute(input({ contextTokens: null, windowOf: () => undefined }))).toEqual(small);
});

it.each([
  [0, 220_000, 220_000], [220_000, 0, 220_000], [40_000, 220_000, 220_000],
  [0, 0, null], [undefined, undefined, null]
] as const)("keeps trusted observed %s and retained %s usage without treating zero as an empty context", (observed, retained, expected) => {
  expect(partnerTaskContextUsage(observed === undefined ? undefined : { contextTokens: observed },
    retained === undefined ? undefined : { contextTokens: retained }).contextTokens).toBe(expected);
});

it("uses durable usage only as a floor for a trustworthy runtime reading", () => {
  expect(partnerTaskContextUsage(undefined, undefined, { contextTokens: 40_000 }).contextTokens).toBeNull();
  expect(partnerTaskContextUsage({ contextTokens: 0 }, { contextTokens: 0 }, { contextTokens: 40_000 }).contextTokens).toBeNull();
  expect(partnerTaskContextUsage({ contextTokens: 40_000 }, undefined, { contextTokens: 220_000 }).contextTokens).toBe(220_000);
});
