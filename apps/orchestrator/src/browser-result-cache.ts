import { randomUUID } from "node:crypto";

export interface BrowserResultSource {
  readonly owner: string;
  readonly epoch: string;
  readonly pages: readonly string[];
}
/** Sanitized originals live only in memory. Each tool session keeps at most four. */
export class BrowserResultCache {
  readonly #entries = new Map<string, { readonly text: string; readonly source: BrowserResultSource }>();
  #characters = 0;
  clear(): void { this.#entries.clear(); this.#characters = 0; }
  clearOwner(owner: string): void { for (const [id, entry] of this.#entries) if (entry.source.owner === owner) this.remove(id); }
  source(id: string, owner: string): BrowserResultSource | undefined { const entry = this.#entries.get(id); return entry?.source.owner === owner ? entry.source : undefined; }
  digest(payload: { readonly ok: boolean; readonly action: string; readonly data: unknown }, source: BrowserResultSource): typeof payload | undefined {
    const text = JSON.stringify(payload);
    if (text.length <= 16_384 || text.length > 2_000_000 || payload.action === "readResult") return undefined;
    const owned = [...this.#entries].filter(([, entry]) => entry.source.owner === source.owner);
    if (owned.length >= 4) this.remove(owned[0]![0]);
    while (this.#characters + text.length > 8_000_000 || this.#entries.size >= 128) this.remove(this.#entries.keys().next().value!);
    const id = `result-${randomUUID()}`; this.#entries.set(id, { text, source }); this.#characters += text.length;
    return { ok: payload.ok, action: payload.action, data: { truncated: true, summary: sample(payload.data, 0, { remaining: 6_000 }),
      fullResult: { id, chars: text.length, read: { action: "readResult", resultId: id, ...(source.pages[0] ? { targetId: source.pages[0] } : {}), offset: 0, maxChars: 12_000 } },
      hint: "This summary is incomplete. Use readResult to read retained JSON in segments. Do not guess missing facts or repeat a write action. Originals expire with this tool session or Browser authority." } };
  }
  read(id: string, owner: string, offset: number, maximum: number): Readonly<Record<string, unknown>> {
    const entry = this.#entries.get(id);
    if (!entry || entry.source.owner !== owner) return { ok: false, action: "readResult", message: "This result expired or belongs to another tool session. Fetch the needed information with a read action; do not repeat a write." };
    const text = entry.text;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 24_000) return { ok: false, action: "readResult", message: "The result offset or page size is invalid.", chars: text.length };
    let end = Math.min(text.length, offset + maximum);
    if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end += end - 1 > offset ? -1 : 1;
    return { ok: true, action: "readResult", data: { resultId: id, offset, chars: text.length, text: text.slice(offset, end), nextOffset: end < text.length ? end : null } };
  }
  private remove(id: string): void { const entry = this.#entries.get(id); if (entry) { this.#characters -= entry.text.length; this.#entries.delete(id); } }
}
function high(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function low(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }
function sample(value: unknown, depth: number, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0) return "[omitted]"; budget.remaining -= 80;
  if (typeof value === "string") { budget.remaining -= Math.min(value.length, 240); return value.length > 240 ? `${value.slice(0, 240)}… [${value.length} chars]` : value; }
  if (Array.isArray(value)) return { count: value.length, sample: depth >= 4 ? [] : value.slice(0, 2).map(item => sample(item, depth + 1, budget)) };
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (depth >= 4) return { keys: entries.slice(0, 12).map(([key]) => key.slice(0, 80)), keyCount: entries.length };
    return Object.fromEntries([...entries.slice(0, 12).map(([key, item]) => [key.slice(0, 80), sample(item, depth + 1, budget)]), ...(entries.length > 12 ? [["omittedKeys", entries.length - 12]] : [])]);
  }
  return value;
}
