import { expect, it } from "vitest";
import { auditSimulatorScreenMap, diffSimulatorScreenMaps, normalizeSimulatorScreenMap,
  SimulatorScreenMapStore } from "./screen-map.js";

it("normalizes a bounded accessibility tree and keeps semantic element identities stable", () => {
  const input = { instanceId: "instance-1", generation: 4, interactionEpoch: 2,
    capturedAt: "2026-09-24T00:00:00.000Z", tree: { type: "XCUIElementTypeApplication",
      label: "Example", rect: { x: 0, y: 0, width: 393, height: 852 }, children: [
        { type: "XCUIElementTypeButton", label: "Continue", enabled: true,
          rect: { x: 24, y: 700, width: 345, height: 48 }, privatePath: "/private/device" },
        { role: "text-field", identifier: "email", value: "name@example.com",
          frame: { x: 24, y: 160, width: 345, height: 44 } }
      ] } } as const;
  const first = normalizeSimulatorScreenMap(input);
  const second = normalizeSimulatorScreenMap(input);
  expect(first.snapshotId).not.toBe(second.snapshotId);
  expect(first.elements).toEqual(second.elements);
  expect(first.elements).toHaveLength(3);
  expect(first.elements[1]).toMatchObject({ role: "XCUIElementTypeButton", label: "Continue",
    enabled: true });
  expect(JSON.stringify(first)).not.toContain("/private/device");
  const capped = normalizeSimulatorScreenMap({ ...input, maxElements: 2 });
  expect(capped).toMatchObject({ truncated: true, elements: [first.elements[0], first.elements[1]] });
});

it("audits high-signal accessibility gaps and compares bounded screen changes", () => {
  const base = { instanceId: "instance-1", generation: 2, interactionEpoch: 0,
    capturedAt: "2026-09-24T00:00:00.000Z" } as const;
  const baseline = normalizeSimulatorScreenMap({ ...base, tree: { children: [
    { type: "XCUIElementTypeButton", rect: { x: 0, y: 0, width: 0, height: 40 } },
    { type: "staticText", label: "Stable", rect: { x: 0, y: 50, width: 100, height: 20 } }
  ] } });
  expect(auditSimulatorScreenMap(baseline, 1)).toMatchObject({ checkedElements: 2,
    violationCount: 2, truncated: true, violations: [{ code: "missing-label" }] });
  const current = normalizeSimulatorScreenMap({ ...base, tree: { children: [
    { type: "XCUIElementTypeButton", label: "Continue",
      rect: { x: 0, y: 0, width: 100, height: 40 } },
    { type: "staticText", label: "Stable", rect: { x: 0, y: 50, width: 100, height: 20 } }
  ] } });
  expect(diffSimulatorScreenMaps(baseline, current, 1)).toMatchObject({
    added: [expect.any(Object)], removed: [], unchangedCount: 1, truncated: true
  });
  expect(() => diffSimulatorScreenMaps(baseline, { ...current, generation: 3 }))
    .toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
});

it("retires process-local snapshots when an interaction or instance route changes", () => {
  const store = new SimulatorScreenMapStore();
  const snapshot = store.capture({ instanceId: "instance-1", generation: 1,
    capturedAt: "2026-09-24T00:00:00.000Z", tree: { type: "button", label: "Continue" } });
  expect(store.requireCurrent({ instanceId: "instance-1", generation: 1,
    snapshotId: snapshot.snapshotId })).toBe(snapshot);
  expect(store.invalidate("instance-1")).toBe(1);
  expect(() => store.requireCurrent({ instanceId: "instance-1", generation: 1,
    snapshotId: snapshot.snapshotId })).toThrowError(expect.objectContaining({ code: "STALE_UI_SNAPSHOT" }));
  store.clear("instance-1");
  expect(store.current("instance-1")).toBeNull();
});
