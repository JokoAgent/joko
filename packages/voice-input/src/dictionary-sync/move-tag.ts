import { HLC_PREFIX_LENGTH, type HlcTimestamp } from "./hlc.js";

export function deriveMoveTag(
  sourceTag: HlcTimestamp,
  targetKey: string,
): HlcTimestamp {
  const prefix = sourceTag.slice(0, HLC_PREFIX_LENGTH);
  return `${prefix}mv${fold36(`${sourceTag}\u0000${targetKey}`)}`;
}

function fold36(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
