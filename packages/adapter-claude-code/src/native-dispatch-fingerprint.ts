import { createHash } from "node:crypto";

/** Claude persists both string and text-block spellings of a human message.
 * Native transport object ordering does not change the input's identity. */
export function claudeNativeDispatchFingerprint(content: unknown): string {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(blocks) || blocks.length === 0) throw new TypeError("The native user input is unavailable.");
  return createHash("sha256").update(JSON.stringify(canonical({ role: "user", content: blocks }, 0))).digest("hex");
}

function canonical(value: unknown, depth: number): unknown {
  if (depth > 32) throw new TypeError("The native user input exceeds its nesting limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item, depth + 1)]));
  }
  throw new TypeError("The native user input contains an unsupported value.");
}
