import { describe, expect, it } from "vitest";

import { enqueueRepositoryWrite } from "./repository-queue.js";

describe("repository write queue", () => {
  it("serializes writers for one repository while preserving task results", async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const task = (name: string, delayMs: number) => enqueueRepositoryWrite("D:\\workspace\\repo", async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`${name}:end`);
      active -= 1;
      return name;
    });

    await expect(Promise.all([task("one", 15), task("two", 1), task("three", 1)]))
      .resolves.toEqual(["one", "two", "three"]);
    expect(maximumActive).toBe(1);
    expect(order).toEqual([
      "one:start", "one:end",
      "two:start", "two:end",
      "three:start", "three:end"
    ]);
  });
});
