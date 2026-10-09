import type { NativeSessionPreview } from "./types.js";

/** Keep the purpose and most recent text within the same 4,000-character
 * transcript budget used by the workbench. Callers filter typed internal data. */
export function boundNativeSessionPreview(
  head: NativeSessionPreview["messages"], tail: NativeSessionPreview["messages"], whole: boolean
): NativeSessionPreview {
  const all = whole ? head : [...head.slice(0, 2), ...tail];
  const cleaned = all.map((item) => ({ ...item, text: item.text.trim().slice(0, 1_200) })).filter((item) => item.text !== "");
  const messages: Array<NativeSessionPreview["messages"][number]> = [];
  let remaining = 4_000;
  for (let index = cleaned.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = cleaned[index]!;
    const text = item.text.slice(-remaining);
    if (text.length < 80 && item.text.length > remaining) break;
    messages.unshift({ ...item, text });
    remaining -= text.length;
  }
  // The digest's purpose is carried in the head when the tail consumes the
  // budget; keep one bounded origin row rather than silently losing it.
  const firstUser = cleaned.find((item) => item.role === "user");
  if (firstUser !== undefined && !messages.includes(firstUser) && !messages.some((item) => item.at === firstUser.at && item.text === firstUser.text)) {
    const purpose = { ...firstUser, text: firstUser.text.slice(0, 200) };
    while (messages.reduce((sum, item) => sum + item.text.length, 0) + purpose.text.length > 4_000) messages.shift();
    messages.unshift(purpose);
  }
  return { messages, truncated: !whole || messages.length < cleaned.length || all.some((item) => item.text.length > 1_200) };
}
