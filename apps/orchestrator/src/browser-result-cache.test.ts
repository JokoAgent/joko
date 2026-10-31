import { expect, it } from "vitest";
import { BrowserResultCache, type BrowserResultSource } from "./browser-result-cache.js";
const source: BrowserResultSource = { owner: "session-a:1", epoch: "browser:1", pages: ["page-one"] };
const payload = (value = "large text ".repeat(2_000)) => ({ ok: true, action: "extract", data: { value } });
function descriptor(cache: BrowserResultCache, value = payload(), scope = source) {
  const result = cache.digest(value, scope)!;
  return (result.data as { fullResult: { id: string; chars: number } }).fullResult;
}
it("retains only the last four originals per tool session and does not advertise oversized or small results", () => {
  const cache = new BrowserResultCache(), first = descriptor(cache);
  for (let index = 0; index < 4; index++) descriptor(cache);
  expect(cache.source(first.id, source.owner)).toBeUndefined();
  const other = descriptor(cache, payload(), { ...source, owner: "session-b:1" });
  expect(cache.source(other.id, source.owner)).toBeUndefined();
  expect(cache.read(other.id, source.owner, 0, 12_000)).toMatchObject({ ok: false });
  expect(cache.digest(payload("x".repeat(2_000_000)), source)).toBeUndefined();
  expect(cache.digest(payload("small"), source)).toBeUndefined();
});
it("reconstructs complete sanitized JSON across Unicode-safe pages without another Browser action", () => {
  const cache = new BrowserResultCache(), value = payload("你好🙂 ".repeat(4_000)), full = descriptor(cache, value);
  let offset: number | null = 0, output = "";
  while (offset !== null) {
    const page = cache.read(full.id, source.owner, offset, 127)["data"] as { text: string; nextOffset: number | null };
    expect(page.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u); output += page.text; offset = page.nextOffset;
  }
  expect(output.length).toBe(full.chars); expect(JSON.parse(output)).toEqual(value);
  expect(cache.read(full.id, source.owner, full.chars + 1, 10)).toMatchObject({ ok: false });
  cache.clearOwner(source.owner); expect(cache.read(full.id, source.owner, 0, 10)).toMatchObject({ ok: false });
});
