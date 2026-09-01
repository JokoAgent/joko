import { describe, expect, it } from "vitest";

import { reorderedSortableIds } from "./SortableList.js";

describe("SortableList", () => {
  it("derives the committed order without mutating React-owned items", () => {
    const items = Object.freeze([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(reorderedSortableIds(items, (item) => item.id, 0, 2)).toEqual(["b", "c", "a"]);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(reorderedSortableIds(items, (item) => item.id, 4, 0)).toBeUndefined();
  });
});
