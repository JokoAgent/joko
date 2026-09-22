export const FEISHU_TEXT_LIMIT = 20_000;

export function splitFeishuText(value: string): readonly string[] {
  if (value.length <= FEISHU_TEXT_LIMIT) return value === "" ? [] : [value];
  const output: string[] = [];
  let remaining = value;
  while (remaining.length > FEISHU_TEXT_LIMIT) {
    let boundary = remaining.lastIndexOf("\n", FEISHU_TEXT_LIMIT);
    if (boundary < Math.floor(FEISHU_TEXT_LIMIT * 0.6)) boundary = FEISHU_TEXT_LIMIT;
    output.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/u, "");
  }
  if (remaining !== "") output.push(remaining);
  return output;
}
