import { isValidHlcNodeId } from './hlc.js';
import { dictionaryTermKey } from './text.js';

const ALIAS_REMOVAL_KEY_PREFIX = '\u0000joko-alias-removal-v1:';

export interface AliasRemovalKey {
  aliasKey: string;
  counterNodeId: string;
}

export function isAliasRemovalMarkerKey(value: string): boolean {
  return value.startsWith(ALIAS_REMOVAL_KEY_PREFIX);
}

export function createAliasRemovalMarkerKey(marker: AliasRemovalKey): string {
  if (dictionaryTermKey(marker.aliasKey) !== marker.aliasKey || !isValidHlcNodeId(marker.counterNodeId)) {
    throw new Error('alias removal marker identity is invalid');
  }
  const payload = encodeURIComponent(JSON.stringify([1, marker.aliasKey, marker.counterNodeId]));
  return `${ALIAS_REMOVAL_KEY_PREFIX}${payload}`;
}

export function parseAliasRemovalMarkerKey(value: string): AliasRemovalKey | null {
  if (!isAliasRemovalMarkerKey(value)) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(value.slice(ALIAS_REMOVAL_KEY_PREFIX.length)));
    if (!Array.isArray(raw) || raw.length !== 3 || raw[0] !== 1) return null;
    const [, aliasKey, counterNodeId] = raw;
    if (typeof aliasKey !== 'string' || dictionaryTermKey(aliasKey) !== aliasKey) return null;
    if (typeof counterNodeId !== 'string' || !isValidHlcNodeId(counterNodeId)) return null;
    return { aliasKey, counterNodeId };
  } catch {
    return null;
  }
}
