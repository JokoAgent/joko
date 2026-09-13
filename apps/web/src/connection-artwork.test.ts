import { describe, expect, it } from "vitest";
import {
  CONNECTION_ARTWORK_GROUPS,
  buildConnectionArtworkGroups,
  connectionArtworkGroupAt,
  nextConnectionArtworkGroupIndex
} from "./connection-artwork.js";

describe("connection artwork groups", () => {
  it("starts with the jogging base/alt group and rotates groups independently of tabs", () => {
    expect(CONNECTION_ARTWORK_GROUPS[0]?.id).toBe("jogging");
    expect(CONNECTION_ARTWORK_GROUPS[0]?.base.id).toBe("jogging");
    expect(CONNECTION_ARTWORK_GROUPS[0]?.alt.id).toBe("jogging-alt");
    expect(connectionArtworkGroupAt(0).id).toBe("jogging");
    expect(nextConnectionArtworkGroupIndex(0)).toBe(CONNECTION_ARTWORK_GROUPS.length === 1 ? 0 : 1);
    expect(nextConnectionArtworkGroupIndex(CONNECTION_ARTWORK_GROUPS.length - 1)).toBe(0);
    expect(() => connectionArtworkGroupAt(CONNECTION_ARTWORK_GROUPS.length)).toThrow(/Unknown connection artwork group index/iu);
  });

  it("discovers an additional group from base and alt filename pairs", () => {
    const groups = buildConnectionArtworkGroups({
      "./landing-artwork/jogging-light.svg": "/jogging-light.svg",
      "./landing-artwork/jogging-dark.svg": "/jogging-dark.svg",
      "./landing-artwork/jogging-light-alt.svg": "/jogging-light-alt.svg",
      "./landing-artwork/jogging-dark-alt.svg": "/jogging-dark-alt.svg",
      "./landing-artwork/kayak-light.svg": "/kayak-light.svg",
      "./landing-artwork/kayak-dark.svg": "/kayak-dark.svg",
      "./landing-artwork/kayak-light-alt.svg": "/kayak-light-alt.svg",
      "./landing-artwork/kayak-dark-alt.svg": "/kayak-dark-alt.svg"
    });

    expect(groups.map((group) => group.id)).toEqual(["jogging", "kayak"]);
    expect(groups[1]?.alt.darkUrl).toBe("/kayak-dark-alt.svg");
  });

  it("rejects incomplete groups and the retired front suffix", () => {
    expect(() => buildConnectionArtworkGroups({
      "./landing-artwork/jogging-light.svg": "/jogging-light.svg",
      "./landing-artwork/jogging-dark.svg": "/jogging-dark.svg"
    })).toThrow(/jogging-alt/iu);
    expect(() => buildConnectionArtworkGroups({
      "./landing-artwork/jogging-light-front.svg": "/jogging-light-front.svg",
      "./landing-artwork/jogging-dark-front.svg": "/jogging-dark-front.svg"
    })).toThrow(/Unsupported connection artwork filename/iu);
  });
});
