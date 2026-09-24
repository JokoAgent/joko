import { expect, it } from "vitest";
import { normalizeSimulatorTouchPair, normalizeSimulatorTouchPath } from "./native-touch-path.js";

const viewport = { width: 400, height: 800, orientation: "PORTRAIT" as const };
const path = [
  { phase: "down", x: 0, y: 80 },
  { phase: "move", x: 200, y: 400, dtMs: 20 },
  { phase: "up", x: 400, y: 800, dtMs: 16 }
];

it("normalizes bounded device-coordinate native paths and synchronized two-finger timing", () => {
  expect(normalizeSimulatorTouchPath(path, viewport, "left")).toEqual([
    { phase: "down", x: 0, y: 0.1, dtMs: 0, edge: "left" },
    { phase: "move", x: 0.5, y: 0.5, dtMs: 20, edge: "left" },
    { phase: "up", x: 1, y: 1, dtMs: 16, edge: "left" }
  ]);
  const paired = normalizeSimulatorTouchPair(path, path, viewport);
  expect(paired.first).toHaveLength(3);
  expect(paired.second).toHaveLength(3);
  expect(paired.first[0]).toMatchObject({ phase: "down", edge: "none" });
  expect(paired.second[0]).toMatchObject({ phase: "down", edge: "none" });
});

it("rejects malformed phases, timing, viewport coordinates and unsynchronized fingers", () => {
  const invalid = [
    [], [{ phase: "down", x: 0, y: 0 }],
    [{ ...path[0], dtMs: 1 }, ...path.slice(1)],
    [path[0], { ...path[1], dtMs: 3 }, path[2]],
    [path[0], { ...path[1], phase: "up" }, path[2]],
    [path[0], path[1], { ...path[2], x: 401 }],
    [path[0], path[1], { ...path[2], extra: "not accepted" }],
    Array.from({ length: 4_097 }, (_, index) => ({ phase: index === 0 ? "down"
      : index === 4_096 ? "up" : "move", x: 1, y: 1, dtMs: index === 0 ? 0 : 16 }))
  ];
  for (const samples of invalid) {
    expect(() => normalizeSimulatorTouchPath(samples, viewport)).toThrowError();
  }
  expect(() => normalizeSimulatorTouchPath(path, { ...viewport, width: 0 })).toThrowError();
  expect(() => normalizeSimulatorTouchPath(path, viewport, "corner" as never)).toThrowError();
  expect(() => normalizeSimulatorTouchPair(path, path.slice(0, 2), viewport)).toThrowError();
  expect(() => normalizeSimulatorTouchPair(path, [path[0], { ...path[1], dtMs: 21 }, path[2]], viewport))
    .toThrowError();
});
