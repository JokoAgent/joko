import type { PublicError } from "./types.js";

export class JokoError extends Error {
  readonly publicError: PublicError;

  constructor(error: PublicError, options?: ErrorOptions) {
    const sanitized = sanitizePublicError(error);
    super(sanitized.message, options);
    this.name = "JokoError";
    this.publicError = sanitized;
  }
}

export function toPublicError(error: unknown, fallback: Omit<PublicError, "message">): PublicError {
  if (error instanceof JokoError) return sanitizePublicError(error.publicError);
  const message = error instanceof Error ? error.message : "Unknown error";
  return sanitizePublicError({ ...fallback, message });
}

export function sanitizePublicError(error: PublicError): PublicError {
  return {
    ...error,
    code: sanitizePublicErrorToken(error.code, "internal_error"),
    phase: sanitizePublicErrorToken(error.phase, "internal"),
    message: sanitizePublicErrorText(error.message, 2_048),
    recovery: sanitizePublicErrorText(error.recovery, 1_024)
  };
}

export function sanitizePublicErrorText(value: string, maximum = 2_048): string {
  return redactSecrets(value)
    .replace(/\b[A-Za-z]:[\\/](?:[^\s<>:"|?*\r\n]+[\\/])*[^\s<>:"|?*\r\n]*/gu, "[redacted-absolute-path]")
    .replace(/\/(?:Users|home|var|tmp|opt|srv|private|Volumes)\/(?:[^\s<>"'`\r\n]+\/?)+/gu, "[redacted-absolute-path]")
    .replace(/(^|[\s(])\/(?!\/)(?:[^\s<>"'`\r\n]+\/?)+/gmu, "$1[redacted-absolute-path]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�")
    .slice(0, Math.max(0, maximum));
}

function sanitizePublicErrorToken(value: string, fallback: string): string {
  const normalized = redactSecrets(value).trim();
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(normalized) ? normalized : fallback;
}

export function redactSecrets(value: string): string {
  const json = redactJsonDocument(value);
  return json ?? redactPlainTextSecrets(value);
}

function redactPlainTextSecrets(value: string): string {
  let redacted = value;
  redacted = redacted.replace(
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|$)/gu,
    "[REDACTED PRIVATE KEY]"
  );
  redacted = redactBearerCredentials(redacted);
  redacted = redactKnownCredentials(redacted);
  redacted = redactJwtTokens(redacted);
  redacted = redactUrlUserInformation(redacted);
  redacted = redacted.replace(
    /((?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/giu,
    "$1[REDACTED]"
  );
  redacted = redactNamedAssignments(redacted);
  return redacted;
}

function redactJsonDocument(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !["{", "[", '"'].includes(trimmed[0]!)) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  const start = value.indexOf(trimmed);
  const replacements: TextReplacement[] = [];
  try {
    collectJsonValueReplacements(value, start, replacements);
  } catch {
    return `${value.slice(0, start)}"[REDACTED]"${value.slice(start + trimmed.length)}`;
  }
  return applyTextReplacements(value, replacements);
}

interface TextReplacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function collectJsonValueReplacements(
  source: string,
  start: number,
  replacements: TextReplacement[]
): number {
  const code = source.charCodeAt(start);
  if (code === 0x22) {
    const end = quotedValueEnd(source, start, code);
    collectJsonStringReplacement(source, start, end, replacements);
    return end;
  }
  if (code === 0x7b) return collectJsonObjectReplacements(source, start, replacements);
  if (code === 0x5b) return collectJsonArrayReplacements(source, start, replacements);
  return jsonPrimitiveEnd(source, start);
}

function collectJsonObjectReplacements(
  source: string,
  start: number,
  replacements: TextReplacement[]
): number {
  let cursor = skipWhitespace(source, start + 1);
  if (source.charCodeAt(cursor) === 0x7d) return cursor + 1;

  while (cursor < source.length) {
    const keyStart = cursor;
    const keyEnd = quotedValueEnd(source, keyStart, 0x22);
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string;
    const redactedKey = redactPlainTextSecrets(key);
    if (redactedKey !== key) {
      replacements.push({ start: keyStart, end: keyEnd, value: JSON.stringify(redactedKey) });
    }

    cursor = skipWhitespace(source, keyEnd);
    if (source.charCodeAt(cursor) !== 0x3a) throw new SyntaxError("Invalid JSON object separator.");
    const valueStart = skipWhitespace(source, cursor + 1);
    let valueEnd: number;
    if (isSensitiveFieldName(key)) {
      valueEnd = jsonValueEnd(source, valueStart);
      if (!jsonValueContainsNoSecret(source, valueStart, valueEnd)) {
        replacements.push({ start: valueStart, end: valueEnd, value: '"[REDACTED]"' });
      }
    } else {
      valueEnd = collectJsonValueReplacements(source, valueStart, replacements);
    }

    cursor = skipWhitespace(source, valueEnd);
    const delimiter = source.charCodeAt(cursor);
    if (delimiter === 0x7d) return cursor + 1;
    if (delimiter !== 0x2c) throw new SyntaxError("Invalid JSON object delimiter.");
    cursor = skipWhitespace(source, cursor + 1);
  }
  throw new SyntaxError("Unterminated JSON object.");
}

function collectJsonArrayReplacements(
  source: string,
  start: number,
  replacements: TextReplacement[]
): number {
  let cursor = skipWhitespace(source, start + 1);
  if (source.charCodeAt(cursor) === 0x5d) return cursor + 1;
  while (cursor < source.length) {
    cursor = skipWhitespace(source, collectJsonValueReplacements(source, cursor, replacements));
    const delimiter = source.charCodeAt(cursor);
    if (delimiter === 0x5d) return cursor + 1;
    if (delimiter !== 0x2c) throw new SyntaxError("Invalid JSON array delimiter.");
    cursor = skipWhitespace(source, cursor + 1);
  }
  throw new SyntaxError("Unterminated JSON array.");
}

function collectJsonStringReplacement(
  source: string,
  start: number,
  end: number,
  replacements: TextReplacement[]
): void {
  const decoded = JSON.parse(source.slice(start, end)) as string;
  const redacted = redactPlainTextSecrets(decoded);
  if (redacted !== decoded) replacements.push({ start, end, value: JSON.stringify(redacted) });
}

function jsonValueEnd(source: string, start: number): number {
  const code = source.charCodeAt(start);
  if (code === 0x22) return quotedValueEnd(source, start, code);
  if (code === 0x7b || code === 0x5b) return structuredValueEnd(source, start);
  return jsonPrimitiveEnd(source, start);
}

function jsonPrimitiveEnd(source: string, start: number): number {
  let end = start;
  while (end < source.length && !/[\s,}\]]/u.test(source[end]!)) end += 1;
  return end;
}

function jsonValueContainsNoSecret(source: string, start: number, end: number): boolean {
  if (end - start === 4 && source.slice(start, end) === "null") return true;
  return source.charCodeAt(start) === 0x22 && JSON.parse(source.slice(start, end)) === "";
}

function applyTextReplacements(source: string, replacements: readonly TextReplacement[]): string {
  if (replacements.length === 0) return source;
  const chunks: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) continue;
    chunks.push(source.slice(cursor, replacement.start), replacement.value);
    cursor = replacement.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

function redactBearerCredentials(value: string): string {
  const bearerPattern = /\bBearer/giu;
  const nextNonWhitespace = /\S/gu;
  let copyIndex = 0;
  let chunks: string[] | undefined;
  let match: RegExpExecArray | null;

  while ((match = bearerPattern.exec(value)) !== null) {
    const prefixEnd = bearerPattern.lastIndex;
    nextNonWhitespace.lastIndex = prefixEnd;
    const content = nextNonWhitespace.exec(value);
    if (content === null) break;
    if (content.index === prefixEnd) continue;

    const tokenStart = content.index;
    let tokenEnd = tokenStart;
    while (tokenEnd < value.length && isBearerTokenCharacter(value.charCodeAt(tokenEnd))) tokenEnd += 1;
    if (tokenEnd - tokenStart < 12) continue;
    let end = tokenEnd;
    while (value.charCodeAt(end) === 0x3d) end += 1;

    chunks ??= [];
    chunks.push(value.slice(copyIndex, tokenStart), "[REDACTED]");
    copyIndex = end;
    bearerPattern.lastIndex = end;
  }

  if (chunks === undefined) return value;
  chunks.push(value.slice(copyIndex));
  return chunks.join("");
}

function isBearerTokenCharacter(code: number): boolean {
  return isAsciiAlphaNumeric(code)
    || code === 0x2e
    || code === 0x5f
    || code === 0x7e
    || code === 0x2b
    || code === 0x2f
    || code === 0x2d;
}

function redactKnownCredentials(value: string): string {
  const prefixPattern = /\b(?:github_pat_|gh[pousr]_|glpat-|npm_|AIza|hf_|xox[baprs]-|LTAI|AKIA|ASIA|sk_(?:live|test)_|rk_(?:live|test)_|sk-|pk-|rk-)/gu;
  let copyIndex = 0;
  let chunks: string[] | undefined;
  let match: RegExpExecArray | null;

  while ((match = prefixPattern.exec(value)) !== null) {
    const prefix = match[0];
    const suffixStart = prefixPattern.lastIndex;
    const specification = knownCredentialSpecification(prefix);
    if (specification.firstAlphaNumeric && !isAsciiAlphaNumeric(value.charCodeAt(suffixStart))) continue;
    let end = suffixStart;
    while (end < value.length && specification.allows(value.charCodeAt(end))) end += 1;
    if (end - suffixStart < specification.minimumLength) continue;

    chunks ??= [];
    chunks.push(value.slice(copyIndex, match.index), "[REDACTED]");
    copyIndex = end;
    prefixPattern.lastIndex = end;
  }

  if (chunks === undefined) return value;
  chunks.push(value.slice(copyIndex));
  return chunks.join("");
}

function knownCredentialSpecification(prefix: string): {
  readonly minimumLength: number;
  readonly firstAlphaNumeric: boolean;
  readonly allows: (code: number) => boolean;
} {
  if (prefix === "sk-" || prefix.startsWith("sk_") || prefix.startsWith("rk_")) {
    return {
      minimumLength: prefix === "sk-" ? 12 : 8,
      firstAlphaNumeric: false,
      allows: isAlphaNumericUnderscoreHyphen
    };
  }
  if (prefix === "pk-" || prefix === "rk-") {
    return { minimumLength: 7, firstAlphaNumeric: true, allows: isAlphaNumericDotUnderscoreHyphen };
  }
  if (prefix.startsWith("gh") && prefix !== "github_pat_") {
    return { minimumLength: 20, firstAlphaNumeric: false, allows: isAsciiAlphaNumeric };
  }
  if (prefix === "github_pat_") {
    return { minimumLength: 20, firstAlphaNumeric: false, allows: isAlphaNumericUnderscore };
  }
  if (prefix === "glpat-" || prefix === "AIza") {
    return { minimumLength: 20, firstAlphaNumeric: false, allows: isAlphaNumericUnderscoreHyphen };
  }
  if (prefix.startsWith("xox")) {
    return { minimumLength: 10, firstAlphaNumeric: false, allows: isAlphaNumericHyphen };
  }
  if (prefix === "AKIA" || prefix === "ASIA") {
    return { minimumLength: 16, firstAlphaNumeric: false, allows: isUppercaseAlphaNumeric };
  }
  return { minimumLength: prefix === "LTAI" ? 16 : 20, firstAlphaNumeric: false, allows: isAsciiAlphaNumeric };
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiLetter(code) || (code >= 0x30 && code <= 0x39);
}

function isAlphaNumericUnderscore(code: number): boolean {
  return isAsciiAlphaNumeric(code) || code === 0x5f;
}

function isAlphaNumericHyphen(code: number): boolean {
  return isAsciiAlphaNumeric(code) || code === 0x2d;
}

function isAlphaNumericUnderscoreHyphen(code: number): boolean {
  return isAlphaNumericUnderscore(code) || code === 0x2d;
}

function isAlphaNumericDotUnderscoreHyphen(code: number): boolean {
  return isAlphaNumericUnderscoreHyphen(code) || code === 0x2e;
}

function isUppercaseAlphaNumeric(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39);
}

function redactNamedAssignments(value: string): string {
  let searchIndex = 0;
  let copyIndex = 0;
  let chunks: string[] | undefined;

  while (searchIndex < value.length) {
    const keyStart = searchIndex;
    const first = value.charCodeAt(keyStart);
    let keyEnd: number;
    let key: string;
    let quote: number | undefined;

    if ((first === 0x22 || first === 0x27) && isEscapedCharacter(value, keyStart)) {
      searchIndex += 1;
      continue;
    }
    if (first === 0x22 || first === 0x27) {
      quote = first;
      keyEnd = quotedValueEnd(value, keyStart, first);
      if (value.charCodeAt(keyEnd - 1) !== first) {
        searchIndex += 1;
        continue;
      }
      key = decodeQuotedKey(value.slice(keyStart, keyEnd), first);
    } else if (isAssignmentKeyCharacter(first)
      && (keyStart === 0 || !isAssignmentKeyCharacter(value.charCodeAt(keyStart - 1)))) {
      keyEnd = keyStart + 1;
      while (keyEnd < value.length && isAssignmentKeyCharacter(value.charCodeAt(keyEnd))) keyEnd += 1;
      key = value.slice(keyStart, keyEnd);
    } else {
      searchIndex += 1;
      continue;
    }

    let separatorIndex = skipWhitespace(value, keyEnd);
    const separator = value.charCodeAt(separatorIndex);
    if (separator !== 0x3a && separator !== 0x3d) {
      searchIndex = quote === undefined ? keyEnd : keyStart + 1;
      continue;
    }
    separatorIndex += 1;
    const valueStart = skipWhitespace(value, separatorIndex);
    if (!isSensitiveFieldName(key)) {
      searchIndex = Math.max(valueStart, keyStart + 1);
      continue;
    }
    if (valueStart >= value.length) break;
    if (value.startsWith("[REDACTED]", valueStart)) {
      searchIndex = valueStart + "[REDACTED]".length;
      continue;
    }

    const valueFirst = value.charCodeAt(valueStart);
    const kind = valueFirst === 0x22
      ? "double_quoted"
      : valueFirst === 0x27
        ? "single_quoted"
        : valueFirst === 0x7b || valueFirst === 0x5b
          ? "structured"
          : "bare";
    const valueEnd = kind === "double_quoted" || kind === "single_quoted"
      ? quotedValueEnd(value, valueStart, valueFirst)
      : kind === "structured"
        ? structuredValueEnd(value, valueStart)
        : bareValueEnd(value, valueStart);
    searchIndex = Math.max(valueEnd, valueStart + 1);

    if ((kind === "double_quoted" || kind === "single_quoted") && valueEnd === valueStart + 2) continue;
    if (kind === "bare" && valueEnd - valueStart === 4
      && value.slice(valueStart, valueEnd).toLowerCase() === "null") continue;

    const replacement = kind === "double_quoted"
      ? '"[REDACTED]"'
      : kind === "single_quoted"
        ? "'[REDACTED]'"
        : quote === 0x22 && separator === 0x3a
          ? '"[REDACTED]"'
          : "[REDACTED]";
    chunks ??= [];
    chunks.push(value.slice(copyIndex, valueStart), replacement);
    copyIndex = valueEnd;
  }

  if (chunks === undefined) return value;
  chunks.push(value.slice(copyIndex));
  return chunks.join("");
}

function isSensitiveFieldName(value: string): boolean {
  const candidate = value.length > 512 ? value.slice(-512) : value;
  const normalized = candidate
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  if (normalized === "key") return true;
  return /(?:^|_)(?:api_key|apikey|access_key|accesskey|secret|secret_key|client_secret|password|passwd|token|credential|credentials|private_key|privatekey|passphrase|authorization|proxy_authorization|cookie|set_cookie)$/u.test(normalized);
}

function isAssignmentKeyCharacter(code: number): boolean {
  return isAsciiAlphaNumeric(code) || code === 0x5f || code === 0x2e || code === 0x2d;
}

function decodeQuotedKey(value: string, quote: number): string {
  if (quote === 0x22) {
    try {
      const decoded = JSON.parse(value) as unknown;
      if (typeof decoded === "string") return decoded;
    } catch {
      // Continue with the bounded plain-text decoder.
    }
  }
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    if (value.charCodeAt(index) === 0x5c && index + 1 < value.length - 1) index += 1;
    decoded += value[index];
  }
  return decoded;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/u.test(value[index]!)) index += 1;
  return index;
}

function quotedValueEnd(value: string, start: number, quote: number): number {
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x5c) {
      index = Math.min(value.length, index + 2);
      continue;
    }
    index += 1;
    if (code === quote) return index;
  }
  return value.length;
}

function isEscapedCharacter(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value.charCodeAt(cursor) === 0x5c; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function structuredValueEnd(value: string, start: number): number {
  const stack = [value.charCodeAt(start) === 0x7b ? 0x7d : 0x5d];
  let index = start + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x27) {
      index = quotedValueEnd(value, index, code);
      continue;
    }
    if (code === 0x7b) stack.push(0x7d);
    else if (code === 0x5b) stack.push(0x5d);
    else if (code === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
    index += 1;
  }
  return value.length;
}

function bareValueEnd(value: string, start: number): number {
  const terminator = /[&\s,;)}\]}'"#]/gu;
  terminator.lastIndex = start;
  return terminator.exec(value)?.index ?? value.length;
}

function redactJwtTokens(value: string): string {
  const minimumSegmentLength = 20;
  let searchIndex = 0;
  let copyIndex = 0;
  let chunks: string[] | undefined;

  while (searchIndex < value.length) {
    if (!isJwtCharacter(value.charCodeAt(searchIndex))
      || (searchIndex > 0 && isJwtCharacter(value.charCodeAt(searchIndex - 1)))) {
      searchIndex += 1;
      continue;
    }

    const firstEnd = jwtSegmentEnd(value, searchIndex);
    if (firstEnd - searchIndex < minimumSegmentLength || value.charCodeAt(firstEnd) !== 0x2e) {
      searchIndex = firstEnd + 1;
      continue;
    }
    const secondStart = firstEnd + 1;
    const secondEnd = jwtSegmentEnd(value, secondStart);
    if (secondEnd - secondStart < minimumSegmentLength || value.charCodeAt(secondEnd) !== 0x2e) {
      searchIndex = secondStart;
      continue;
    }
    const thirdStart = secondEnd + 1;
    const thirdEnd = jwtSegmentEnd(value, thirdStart);
    if (thirdEnd - thirdStart < minimumSegmentLength || isJwtCharacter(value.charCodeAt(thirdEnd))) {
      searchIndex = secondStart;
      continue;
    }

    chunks ??= [];
    chunks.push(value.slice(copyIndex, searchIndex), "[REDACTED]");
    copyIndex = thirdEnd;
    searchIndex = thirdEnd;
  }

  if (chunks === undefined) return value;
  chunks.push(value.slice(copyIndex));
  return chunks.join("");
}

function jwtSegmentEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && isJwtCharacter(value.charCodeAt(end))) end += 1;
  return end;
}

function isJwtCharacter(code: number): boolean {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || code === 0x5f
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d;
}

function redactUrlUserInformation(value: string): string {
  const userInformationEnd = /[@/\s]/gu;
  let separatorIndex = value.indexOf("://");
  let copyIndex = 0;
  let chunks: string[] | undefined;

  while (separatorIndex >= 0) {
    let schemeStart = separatorIndex;
    while (schemeStart > 0 && isSchemeCharacter(value.charCodeAt(schemeStart - 1))) schemeStart -= 1;
    if (hasRecognizedSchemeStart(value, schemeStart, separatorIndex)) {
      const userInformationStart = separatorIndex + 3;
      userInformationEnd.lastIndex = userInformationStart;
      const end = userInformationEnd.exec(value);
      if (end?.[0] === "@" && end.index > userInformationStart) {
        chunks ??= [];
        chunks.push(value.slice(copyIndex, userInformationStart), "[REDACTED]");
        copyIndex = end.index;
      }
    }
    separatorIndex = value.indexOf("://", separatorIndex + 3);
  }

  if (chunks === undefined) return value;
  chunks.push(value.slice(copyIndex));
  return chunks.join("");
}

function hasRecognizedSchemeStart(value: string, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (isAsciiLetter(code) && (index === 0 || !isAsciiWord(value.charCodeAt(index - 1)))) return true;
  }
  return false;
}

function isSchemeCharacter(code: number): boolean {
  return isAsciiLetter(code)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x2b
    || code === 0x2d
    || code === 0x2e;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiWord(code: number): boolean {
  return isAsciiLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f;
}
