import type { ComposerInlineMentionRange, ComposerMentionDraft } from "./model.js";

/** Validate explicit occurrences; token spelling never supplies an identity. */
export function normalizeComposerInlineMentionRanges(
  value: unknown,
  text: string,
  mentions: readonly ComposerMentionDraft[]
): readonly ComposerInlineMentionRange[] | undefined {
  const byId = new Map<string, string>();
  const identities = new Set<string>();
  for (const mention of mentions) {
    if (identities.has(mention.id)) return undefined;
    identities.add(mention.id);
    if (mention.kind === "message") continue;
    if (mention.token.length < 2 || !mention.token.startsWith("@") || /[\u0000-\u001f\u007f]/u.test(mention.token)) return undefined;
    byId.set(mention.id, mention.token);
  }
  if (value === undefined) return byId.size === 0 ? [] : undefined;
  if (!Array.isArray(value)) return undefined;
  const result: ComposerInlineMentionRange[] = [];
  const represented = new Set<string>();
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const range = candidate as Record<string, unknown>;
    if (Object.keys(range).length !== 3 || typeof range["mentionId"] !== "string"
      || typeof range["from"] !== "number" || typeof range["to"] !== "number"
      || !Number.isSafeInteger(range["from"]) || !Number.isSafeInteger(range["to"])
      || range["from"] < 0 || range["to"] <= range["from"] || range["to"] > text.length) return undefined;
    const token = byId.get(range["mentionId"]);
    if (token === undefined || text.slice(range["from"], range["to"]) !== token) return undefined;
    result.push({ mentionId: range["mentionId"], from: range["from"], to: range["to"] });
    represented.add(range["mentionId"]);
  }
  result.sort((left, right) => left.from - right.from || left.to - right.to);
  if (result.some((range, index) => index > 0 && range.from < result[index - 1]!.to)
    || represented.size !== byId.size) return undefined;
  return result;
}

/** Map one known edit, including insertions at either edge of a token. */
export function remapComposerInlineMentionReplacement(
  ranges: readonly ComposerInlineMentionRange[],
  from: number,
  to: number,
  insertedLength: number
): readonly ComposerInlineMentionRange[] {
  if (![from, to, insertedLength].every(Number.isSafeInteger) || from < 0 || to < from || insertedLength < 0) return [];
  if (from === to && insertedLength === 0) return ranges;
  const delta = insertedLength - (to - from);
  return ranges.flatMap((range) => {
    if (to <= range.from) return [{ ...range, from: range.from + delta, to: range.to + delta }];
    if (from >= range.to) return [range];
    return [];
  });
}
