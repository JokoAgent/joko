import { describe, expect, it } from "vitest";
import {
  CONNECTION_ARTWORK_GROUP_IDS,
  mobileConnectionAppIcon,
  mobileConnectionArtworkFrame,
  mobileLoadingIllustration,
  nextConnectionArtworkGroupIndex
} from "./connection-artwork";

describe("mobile connection artwork", () => {
  it("uses every canonical theme and base/alt frame without a mobile asset copy", () => {
    expect(CONNECTION_ARTWORK_GROUP_IDS).toEqual(["jogging", "acrobat", "bike"]);
    for (const [index, group] of CONNECTION_ARTWORK_GROUP_IDS.entries()) {
      const baseLight = mobileConnectionArtworkFrame(index, "base", "light");
      const baseDark = mobileConnectionArtworkFrame(index, "base", "dark");
      const altLight = mobileConnectionArtworkFrame(index, "alt", "light");
      const altDark = mobileConnectionArtworkFrame(index, "alt", "dark");
      expect(baseLight.id).toBe(group);
      expect(baseDark.id).toBe(group);
      expect(altLight.id).toBe(`${group}-alt`);
      expect(altDark.id).toBe(`${group}-alt`);
      expect(new Set([baseLight.source, baseDark.source, altLight.source, altDark.source]).size).toBe(4);
      expect([baseLight.source, baseDark.source, altLight.source, altDark.source].every(Boolean)).toBe(true);
    }
    expect(mobileConnectionAppIcon("light")).not.toBe(mobileConnectionAppIcon("dark"));
    expect(mobileLoadingIllustration("light")).not.toBe(mobileLoadingIllustration("dark"));
  });

  it("cycles groups independently and rejects an invalid frame index", () => {
    expect(nextConnectionArtworkGroupIndex(0)).toBe(1);
    expect(nextConnectionArtworkGroupIndex(CONNECTION_ARTWORK_GROUP_IDS.length - 1)).toBe(0);
    expect(() => mobileConnectionArtworkFrame(CONNECTION_ARTWORK_GROUP_IDS.length, "base", "light")).toThrow(/Unknown connection artwork group index/iu);
  });
});
