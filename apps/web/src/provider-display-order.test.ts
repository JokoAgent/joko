import { describe, expect, it } from "vitest";

import {
  applyProviderDisplayOrder,
  mergeObservedProviderDisplayOrder,
  mergeVisibleProviderDisplayOrder,
  moveProviderDisplayOrder,
  normalizeProviderDisplayOrder
} from "./provider-display-order.js";

describe("Provider display order", () => {
  it("normalizes persisted values to bounded unique printable IDs", () => {
    expect(normalizeProviderDisplayOrder(["first", "", "first", 42, "bad\n", "second"]))
      .toEqual(["first", "second"]);
  });

  it("places known ordered IDs first and appends newly introduced Providers", () => {
    const providers = [{ id: "first" }, { id: "second" }, { id: "third" }, { id: "new" }];
    expect(applyProviderDisplayOrder(providers, ["third", "missing", "first"]).map(({ id }) => id))
      .toEqual(["third", "first", "second", "new"]);
  });

  it("reorders visible slots while retaining hidden Provider positions", () => {
    expect(mergeVisibleProviderDisplayOrder(
      ["first", "hidden-a", "second", "hidden-b", "third"],
      ["third", "first", "second"]
    )).toEqual(["third", "hidden-a", "first", "hidden-b", "second"]);
  });

  it("appends first-seen Providers before merging their visible order", () => {
    expect(mergeObservedProviderDisplayOrder(
      ["first", "hidden"],
      ["new", "first"]
    )).toEqual(["new", "hidden", "first"]);
  });

  it("fails closed on duplicate or unknown reorder input", () => {
    const order = ["first", "second"];
    expect(mergeVisibleProviderDisplayOrder(order, ["first", "first"])).toEqual(order);
    expect(mergeVisibleProviderDisplayOrder(order, ["third", "first"])).toEqual(order);
    expect(mergeObservedProviderDisplayOrder(order, ["first", "first"])).toEqual(order);
  });

  it("moves one Provider by a keyboard step without crossing either edge", () => {
    const ids = ["first", "second", "third"];
    expect(moveProviderDisplayOrder(ids, "second", -1)).toEqual(["second", "first", "third"]);
    expect(moveProviderDisplayOrder(ids, "second", 1)).toEqual(["first", "third", "second"]);
    expect(moveProviderDisplayOrder(ids, "first", -1)).toEqual(ids);
    expect(moveProviderDisplayOrder(ids, "third", 1)).toEqual(ids);
    expect(moveProviderDisplayOrder(ids, "missing", 1)).toEqual(ids);
  });
});
