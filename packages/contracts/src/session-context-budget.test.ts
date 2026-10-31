import { expect, it } from "vitest";
import { contextBudgetOptions } from "./session-context-budget.js";
it("keeps exact 25/50/100-percent tiers, the default inheritance choice and the larger two distinct tiers", () => {
  expect(contextBudgetOptions({ defaultWindow: 1_000_000, maximumWindow: 1_000_000 })).toEqual([
    { tokens: 250_000, isDefault: false }, { tokens: 500_000, isDefault: false }, { tokens: 1_000_000, isDefault: true }
  ]);
  expect(contextBudgetOptions({ defaultWindow: 500_000, maximumWindow: 1_000_000 })).toEqual([
    { tokens: 250_000, isDefault: false }, { tokens: 500_000, isDefault: true }, { tokens: 1_000_000, isDefault: false }
  ]);
  expect(contextBudgetOptions({ defaultWindow: 272_000 })).toEqual([{ tokens: 272_000, isDefault: true }]);
  expect(contextBudgetOptions({ defaultWindow: 1_000_000, maximumWindow: 1_000_000, modelLimit: 600_000 })).toEqual([
    { tokens: 300_000, isDefault: false }, { tokens: 600_000, isDefault: true }
  ]);
  expect(contextBudgetOptions({ defaultWindow: 800_001, maximumWindow: 800_001 })[0]?.tokens).toBe(200_000);
});
