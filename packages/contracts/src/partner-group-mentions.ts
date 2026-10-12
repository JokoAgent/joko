interface PartnerGroupMention { readonly all: boolean; readonly partnerIds: string[]; }

export interface PartnerGroupMentionMember {
  partnerId: string;
  name: string;
}

/** A mention picked from the candidate list; `label` is the text after `@`. */
export interface PartnerGroupTrackedMention {
  partnerId: string;
  label: string;
}

export interface PartnerGroupMentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Text typed after `@`, up to the caret. */
  query: string;
}

/** 候选词最长这么多字；再长就当成普通正文，不再弹候选。 */
const MAX_MENTION_QUERY_CHARS = 32;

/** `@` 紧跟在这些字符后面时是邮箱或标识符的一部分，不是点名。 */
const WORD_BEFORE_AT = /[A-Za-z0-9._%+-]/;
const LATIN_WORD_CHAR = /[A-Za-z0-9_]/;

function isMentionStart(text: string, at: number): boolean {
  return at === 0 || !WORD_BEFORE_AT.test(text[at - 1] ?? '');
}

/**
 * 中文名后面常常直接接正文（「@小满帮我查一下」），所以名字不要求后面跟空格；
 * 只有以拉丁字母或数字结尾的名字才要求词边界，免得 `@Anna` 被当成 `@Ann`。
 */
function endsAtBoundary(label: string, next: string | undefined): boolean {
  if (next === undefined) return true;
  const last = label[label.length - 1] ?? '';
  return !(LATIN_WORD_CHAR.test(last) && LATIN_WORD_CHAR.test(next));
}

interface LabelEntry {
  label: string;
  all: boolean;
  partnerIds: string[];
}

function buildLabelEntries(
  members: readonly PartnerGroupMentionMember[],
  allLabels: readonly string[],
  tracked: readonly PartnerGroupTrackedMention[],
): LabelEntry[] {
  const byLabel = new Map<string, LabelEntry>();
  for (const raw of allLabels) {
    const label = raw.trim();
    if (label) byLabel.set(label, { label, all: true, partnerIds: [] });
  }
  const memberIds = new Set(members.map((member) => member.partnerId));
  const trackedByLabel = new Map<string, string[]>();
  for (const mention of tracked) {
    const label = mention.label.trim();
    if (!label || !memberIds.has(mention.partnerId)) continue;
    const ids = trackedByLabel.get(label) ?? [];
    if (!ids.includes(mention.partnerId)) ids.push(mention.partnerId);
    trackedByLabel.set(label, ids);
  }
  for (const member of members) {
    const label = member.name.trim();
    if (!label || byLabel.get(label)?.all) continue;
    const entry = byLabel.get(label) ?? { label, all: false, partnerIds: [] };
    if (!entry.partnerIds.includes(member.partnerId)) entry.partnerIds.push(member.partnerId);
    byLabel.set(label, entry);
  }
  // 重名时正文分辨不出是哪一位，才用选择候选时记下的 partnerId 收窄。
  for (const [label, ids] of trackedByLabel) {
    const entry = byLabel.get(label);
    if (entry && !entry.all) entry.partnerIds = ids;
  }
  // 最长优先：`@小满满` 不能先被 `@小满` 截走。
  return [...byLabel.values()].sort((a, b) => b.label.length - a.label.length);
}

interface MentionToken {
  start: number;
  end: number;
  entry: LabelEntry;
}

function scanMentionTokens(text: string, entries: readonly LabelEntry[]): MentionToken[] {
  const tokens: MentionToken[] = [];
  let index = text.indexOf('@');
  while (index >= 0) {
    let next = index + 1;
    if (isMentionStart(text, index)) {
      const entry = entries.find(
        (candidate) =>
          text.startsWith(candidate.label, index + 1) &&
          endsAtBoundary(candidate.label, text[index + 1 + candidate.label.length]),
      );
      if (entry) {
        const end = index + 1 + entry.label.length;
        tokens.push({ start: index, end, entry });
        next = end;
      }
    }
    index = text.indexOf('@', next);
  }
  return tokens;
}

/**
 * Resolve who a group message addresses. Mentions are re-derived from the text
 * at send time; a tracked pick only disambiguates members that share a name.
 */
export function resolvePartnerGroupMentions(
  text: string,
  input: {
    members: readonly PartnerGroupMentionMember[];
    allLabels: readonly string[];
    tracked?: readonly PartnerGroupTrackedMention[];
  },
): PartnerGroupMention {
  const entries = buildLabelEntries(input.members, input.allLabels, input.tracked ?? []);
  const memberIds = new Set(input.members.map((member) => member.partnerId));
  const partnerIds: string[] = [];
  let all = false;
  for (const token of scanMentionTokens(text, entries)) {
    if (token.entry.all) all = true;
    for (const partnerId of token.entry.partnerIds) {
      if (memberIds.has(partnerId) && !partnerIds.includes(partnerId)) partnerIds.push(partnerId);
    }
  }
  // 按正文里点名的先后输出：宿主直接按这个顺序轮流发言（group mention contract §4.1）。
  return { all, partnerIds };
}

/** The `@query` being typed right before the caret, if any. */
export function findPartnerGroupMentionQuery(text: string, caret: number): PartnerGroupMentionQuery | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf('@');
  if (at < 0 || !isMentionStart(before, at)) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_MENTION_QUERY_CHARS || /\s/.test(query)) return null;
  return { start: at, query };
}

/** Case-insensitive match; names starting with the query come first. */
export function filterPartnerGroupMentionCandidates<T extends { name: string }>(
  query: string,
  candidates: readonly T[],
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...candidates];
  const prefix: T[] = [];
  const inner: T[] = [];
  for (const candidate of candidates) {
    const name = candidate.name.toLocaleLowerCase();
    if (name.startsWith(needle)) prefix.push(candidate);
    else if (name.includes(needle)) inner.push(candidate);
  }
  return [...prefix, ...inner];
}

/** Replace `@query` (from `start` to `end`) with `@label ` and return the new caret. */
export function insertPartnerGroupMention(
  text: string,
  range: { start: number; end: number },
  label: string,
): { text: string; caret: number } {
  const after = text.slice(range.end);
  const inserted = after.startsWith(' ') ? `@${label}` : `@${label} `;
  const caret = range.start + inserted.length + (after.startsWith(' ') ? 1 : 0);
  return { text: text.slice(0, range.start) + inserted + after, caret };
}

export interface PartnerGroupTextSegment {
  text: string;
  mention: boolean;
}

/** Split message text so `@name` tokens can be shown as mention chips. */
export function splitPartnerGroupMentionSegments(
  text: string,
  labels: readonly string[],
): PartnerGroupTextSegment[] {
  const entries = [...new Set(labels.map((label) => label.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((label) => ({ label, all: false, partnerIds: [] }));
  const segments: PartnerGroupTextSegment[] = [];
  let cursor = 0;
  for (const token of scanMentionTokens(text, entries)) {
    if (token.start > cursor) segments.push({ text: text.slice(cursor, token.start), mention: false });
    segments.push({ text: text.slice(token.start, token.end), mention: true });
    cursor = token.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false });
  return segments;
}
