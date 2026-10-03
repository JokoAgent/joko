export const MAX_DICTIONARY_TERM_CHARS = 120;

export function normalizeDictionaryTermText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (/[\u0000-\u001f\u007f]/u.test(value)) return '';
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= MAX_DICTIONARY_TERM_CHARS ? normalized : '';
}

export function dictionaryTermKey(text: unknown): string {
  return normalizeDictionaryTermText(text).toLowerCase();
}
