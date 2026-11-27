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
  let earliest = cleaned.length;
  let clipped = false;
  for (let index = cleaned.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = cleaned[index]!;
    const text = item.text.slice(-remaining);
    if (text.length < 80 && item.text.length > remaining) break;
    earliest = index;
    clipped = text.length < item.text.length;
    messages.unshift({ ...item, text });
    remaining -= text.length;
  }
  // The digest's purpose is carried in the head when the tail consumes the
  // budget; keep one bounded origin row rather than silently losing it.
  const firstUserIndex = cleaned.findIndex((item) => item.role === "user");
  const firstUser = cleaned[firstUserIndex];
  if (firstUser !== undefined && (firstUserIndex < earliest || firstUserIndex === earliest && clipped)) {
    if (firstUserIndex === earliest) messages.shift();
    const purpose = { ...firstUser, text: firstUser.text.slice(0, 200) };
    while (messages.reduce((sum, item) => sum + item.text.length, 0) + purpose.text.length > 4_000) messages.shift();
    messages.unshift(purpose);
  }
  return { messages, truncated: !whole || clipped || messages.length < cleaned.length || all.some((item) => item.text.length > 1_200) };
}
