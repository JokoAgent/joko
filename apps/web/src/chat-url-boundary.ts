export interface ChatUrlContext {
  openParentheses: number;
  tail: string;
}

export interface ChatUrlMatch {
  readonly start: number;
  readonly end: number;
  readonly url: string;
}

export function createChatUrlContext(): ChatUrlContext {
  return { openParentheses: 0, tail: "" };
}

/** Advances once over preceding prose, rather than rescanning every URL's prefix. */
export function advanceChatUrlContext(context: ChatUrlContext, text: string): void {
  for (const character of text) {
    if (character === "(") context.openParentheses += 1;
    else if (character === ")") context.openParentheses = Math.max(0, context.openParentheses - 1);
  }
  context.tail = (context.tail + text.slice(-4)).slice(-4);
}

/** Returns a boundary only for a bare HTTP(S) candidate, never an explicit destination. */
export function chatUrlEnd(raw: string, context: ChatUrlContext): number {
  if (!/^https?:\/\//iu.test(raw)) return raw.length;
  const hostname = hostnameRange(raw);
  let end = raw.length;
  for (let index = 0; index < end;) {
    const character = String.fromCodePoint(raw.codePointAt(index)!);
    if (character === '"' || isProsePunctuation(character)) {
      if (!isHostnameDot(raw, index, hostname)) { end = index; break; }
    }
    index += character.length;
  }
  const punctuationEnd = end;
  const marker = wrappingMarker(context.tail);
  if (marker !== undefined) {
    let index = raw.indexOf(marker);
    while (index >= 0 && index < end) {
      if (!marker.includes("_") || !(/[A-Za-z0-9]/u.test(raw[index - 1] ?? "") && /[A-Za-z0-9]/u.test(raw[index + marker.length] ?? ""))) {
        end = index; break;
      }
      index = raw.indexOf(marker, index + marker.length);
    }
  }
  end = bracketBoundary(raw, end, hostname, context.openParentheses);
  const formattingTail = marker !== undefined || punctuationEnd < raw.length;
  while (end > 0) {
    const character = raw[end - 1]!;
    if (/[?!.,:;]/u.test(character) || (formattingTail && /[*_~]/u.test(character)) || (character === "'" && context.tail.endsWith("'"))) end -= 1;
    else break;
  }
  // Some generated status links carry a closing emphasis marker with no opener.
  for (const suffix of ["**", "__", "~~"]) {
    if (raw.slice(0, end).endsWith(suffix) && isNumericReviewUrl(raw.slice(0, end - suffix.length))) end -= suffix.length;
  }
  return end;
}

export function scanChatUrls(text: string): readonly ChatUrlMatch[] {
  const matches: ChatUrlMatch[] = [];
  const pattern = /https?:\/\//giu;
  const context = createChatUrlContext();
  const scanBudget = text.length * 8;
  let scanned = 0;
  let consumed = 0;
  let candidate: RegExpExecArray | null;
  while ((candidate = pattern.exec(text)) !== null) {
    advanceChatUrlContext(context, text.slice(consumed, candidate.index));
    const remaining = text.slice(candidate.index);
    const hostname = hostnameRange(remaining);
    let candidateEnd = candidate[0].length;
    while (candidateEnd < remaining.length) {
      const character = String.fromCodePoint(remaining.codePointAt(candidateEnd)!);
      if (/[\s<>"]/u.test(character) || (isProsePunctuation(character) && !isHostnameDot(remaining, candidateEnd, hostname))) break;
      candidateEnd += character.length;
    }
    scanned += candidateEnd;
    // Reclaimed malformed tails can contain more schemes. Bound repeated candidate work;
    // callers retain the entire source as prose when automatic linkification is too costly.
    if (scanned > scanBudget) return [];
    const delimiterCodePoint = remaining.codePointAt(candidateEnd);
    const delimiter = delimiterCodePoint === undefined ? undefined : String.fromCodePoint(delimiterCodePoint);
    const raw = remaining.slice(0, candidateEnd + (delimiter !== undefined && isProsePunctuation(delimiter) ? delimiter.length : 0));
    const length = chatUrlEnd(raw, context);
    const url = raw.slice(0, length);
    let valid = false;
    try { valid = new URL(url).hostname.length > 0; } catch { /* Keep an invalid candidate as prose. */ }
    if (length > 0 && valid) {
      const end = candidate.index + length;
      matches.push({ start: candidate.index, end, url });
      advanceChatUrlContext(context, url);
      consumed = end;
      pattern.lastIndex = end;
    } else {
      consumed = candidate.index + candidateEnd;
      advanceChatUrlContext(context, raw);
      pattern.lastIndex = consumed;
    }
  }
  return matches;
}

function isProsePunctuation(character: string): boolean {
  return character === "`" || (/[^\x00-\x7f]/u.test(character) && /[\p{P}\p{Z}]/u.test(character));
}

function wrappingMarker(tail: string): string | undefined {
  for (const marker of ["**", "__", "~~", "*", "_", "~"]) {
    if (tail.endsWith(marker) && !/[A-Za-z0-9]/u.test(tail[tail.length - marker.length - 1] ?? "")) return marker;
  }
  return undefined;
}

function hostnameRange(raw: string): { readonly start: number; readonly end: number; readonly authorityEnd: number } {
  const authorityStart = raw.indexOf("://") + 3;
  const delimiter = raw.slice(authorityStart).search(/[/?#\s<>"]/u);
  const authorityEnd = delimiter < 0 ? raw.length : authorityStart + delimiter;
  const authority = raw.slice(authorityStart, authorityEnd);
  const start = authority.lastIndexOf("@") + 1;
  const ipv6End = authority[start] === "[" ? authority.indexOf("]", start + 1) : -1;
  const port = authority.indexOf(":", start);
  const end = ipv6End >= 0 ? ipv6End + 1 : port >= 0 ? port : authority.length;
  return { start: authorityStart + start, end: authorityStart + end, authorityEnd };
}

function isHostnameDot(raw: string, index: number, hostname: ReturnType<typeof hostnameRange>): boolean {
  if (!/[。．｡]/u.test(raw[index]!) || index <= hostname.start || index >= hostname.end) return false;
  let end = index + 1;
  while (end < hostname.end && !/[.。．｡]/u.test(raw[end]!)) end += 1;
  const label = raw.slice(index + 1, end);
  if (label.length === 0 || /[\p{P}\p{Z}]/u.test(label)) return false;
  if (/[A-Za-z0-9]/u.test(label) || [...label].some((character) => /\p{L}/u.test(character) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character))) return true;
  return end < hostname.end || hostname.end < hostname.authorityEnd || /[/?#]/u.test(raw[hostname.authorityEnd] ?? "") || [...label].length <= 3;
}

function bracketBoundary(raw: string, limit: number, hostname: ReturnType<typeof hostnameRange>, wrappingParentheses: number): number {
  const queryAt = raw.search(/[?#]/u);
  const query = queryAt >= 0 && queryAt < limit ? queryAt : limit;
  const parentheses: number[] = [];
  const unmatchedQueryClosers: number[] = [];
  const brackets: string[] = [];
  let lastPair: { readonly open: number; readonly close: number } | undefined;
  let end = limit;
  for (let index = raw.indexOf("://") + 3; index < end; index += 1) {
    const character = raw[index]!;
    if ("[]{}".includes(character)) {
      if (index < query) {
        if (raw[hostname.start] === "[" && index >= hostname.start && index < hostname.end) continue;
        end = index; break;
      }
      if (character === "[") brackets.push("]");
      else if (character === "{") brackets.push("}");
      else if (brackets.at(-1) === character) brackets.pop();
      else { end = index; break; }
    } else if (character === "(") parentheses.push(index);
    else if (character === ")") {
      const open = parentheses.pop();
      if (open !== undefined) lastPair = { open, close: index };
      else if (index < query) { end = index; break; }
      else unmatchedQueryClosers.push(index);
    }
  }
  const unclosedPath = parentheses.find((index) => index < query);
  if (unclosedPath !== undefined) end = Math.min(end, unclosedPath);
  if (wrappingParentheses > 0 && unmatchedQueryClosers.length > 0) {
    end = Math.min(end, unmatchedQueryClosers[Math.max(0, unmatchedQueryClosers.length - wrappingParentheses)]!);
  }
  let contentEnd = end;
  while (contentEnd > 0 && /[?!.,:;*_~]/u.test(raw[contentEnd - 1]!)) contentEnd -= 1;
  if (lastPair?.close === contentEnd - 1 && reviewStatusSuffix(raw, lastPair.open, lastPair.close, query)) end = Math.min(end, lastPair.open);
  // The status suffix grammar excludes "("; only the last unmatched opener can match.
  const incompleteStatus = parentheses.at(-1);
  if (incompleteStatus !== undefined && incompleteStatus >= query && reviewStatusSuffix(raw, incompleteStatus, contentEnd, query, true)) end = Math.min(end, incompleteStatus);
  return end;
}

function reviewStatusSuffix(raw: string, open: number, close: number, query: number, incomplete = false): boolean {
  if (open < query) return isNumericReviewUrl(raw.slice(0, open));
  if (!isNumericReviewUrl(raw.slice(0, query))) return false;
  const segment = raw.slice(Math.max(query + 1, raw.lastIndexOf("&", open - 1) + 1), open);
  if (segment.includes("=") && segment.toLowerCase() !== "diff=split") return false;
  const suffix = raw.slice(open + 1, close);
  return incomplete ? /^base(?: [A-Za-z0-9._/-]*)?$/iu.test(suffix) : /^base(?: [A-Za-z0-9._/-]+)*,[A-Z][A-Z0-9_-]*$/iu.test(suffix);
}

function isNumericReviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./iu, "");
    return host === "github.com" ? /^\/[^/]+\/[^/]+\/(?:pulls?|issues?)\/\d+\/?$/iu.test(url.pathname)
      : host === "gitlab.com" && /^\/.+\/(?:-\/)?(?:issues?|merge_requests?)\/\d+\/?$/iu.test(url.pathname);
  } catch { return false; }
}
