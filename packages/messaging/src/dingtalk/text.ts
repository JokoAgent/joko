export const DINGTALK_TEXT_LIMIT = 3_500;

export function splitDingTalkText(source: string): readonly string[] {
  const normalized = source.trim() || "(Empty response)";
  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > DINGTALK_TEXT_LIMIT) {
    let splitAt = remaining.lastIndexOf("\n", DINGTALK_TEXT_LIMIT);
    if (splitAt < Math.floor(DINGTALK_TEXT_LIMIT / 2)) splitAt = DINGTALK_TEXT_LIMIT;
    if (splitAt > 0 && isHighSurrogate(remaining.charCodeAt(splitAt - 1)) && isLowSurrogate(remaining.charCodeAt(splitAt))) {
      splitAt -= 1;
    }
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/u, "");
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
