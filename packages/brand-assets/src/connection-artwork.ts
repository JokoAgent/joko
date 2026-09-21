export const CONNECTION_ARTWORK_GROUP_IDS = ["jogging", "acrobat", "bike"] as const;
export const CONNECTION_ARTWORK_VARIANTS = ["base", "alt"] as const;
export const CONNECTION_ARTWORK_THEMES = ["light", "dark"] as const;

export type ConnectionArtworkGroupId = typeof CONNECTION_ARTWORK_GROUP_IDS[number];
export type ConnectionArtworkVariant = typeof CONNECTION_ARTWORK_VARIANTS[number];
export type ConnectionArtworkTheme = typeof CONNECTION_ARTWORK_THEMES[number];

export function connectionArtworkFrameId(group: ConnectionArtworkGroupId, variant: ConnectionArtworkVariant): string {
  return variant === "base" ? group : `${group}-alt`;
}

export function nextConnectionArtworkGroupIndex(
  currentIndex: number,
  length: number = CONNECTION_ARTWORK_GROUP_IDS.length
): number {
  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    throw new RangeError("Connection artwork group index must be a non-negative integer.");
  }
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError("Connection artwork groups must not be empty.");
  }
  return (currentIndex + 1) % length;
}
