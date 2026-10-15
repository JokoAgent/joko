import { describe, expect, it, vi } from "vitest";
import { personalDevelopmentSearchTerms, searchPersonalDevelopmentUpstream } from "./personal-development-upstream.js";

const repository = "JokoAgent/joko", a = "a".repeat(40), b = "b".repeat(40);
const item = (number: number) => ({ number, title: `Rendering ${number}`, html_url: `https://github.com/${repository}/pull/${number}`,
  pull_request: {}, state: "open", user: { login: "author" }, body: "<!-- private template --> Public summary" });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
describe("personal development public upstream lookup", () => {
  it("bounds literal own-repository queries and removes only exact proven included pull requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input)); expect(url.origin).toBe("https://api.github.com"); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      if (url.pathname === "/search/issues") {
        expect(url.searchParams.get("q")).toMatch(/^repo:JokoAgent\/joko is:pr is:(?:open|merged) in:title,body "[\p{L}\p{N}]+"$/u);
        expect(url.searchParams.get("per_page")).toBe("10"); return json({ items: [item(1), item(2)], incomplete_results: false, total_count: 2 });
      }
      const number = Number(url.pathname.split("/").at(-1));
      return json({ number, html_url: item(number).html_url, base: { repo: { full_name: repository } }, merged: number === 1,
        state: number === 1 ? "closed" : "open", merge_commit_sha: a, head: { sha: b } });
    });
    const result = await searchPersonalDevelopmentUpstream('render repo:foreign/name OR is:closed " injection', new AbortController().signal,
      { fetch, runtime: { channel: "release", version: "0.1.0", commit: a, confidence: "exact" }, containsCommit: async () => "notIncluded" });
    expect(result).toMatchObject({ status: "found", excludedIncluded: 1, items: [{ number: 2, state: "open", inclusion: "notIncluded", summary: "Public summary" }] });
    expect(fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/search/issues").length).toBeLessThanOrEqual(6);
    expect(result.items).toHaveLength(1); expect(personalDevelopmentSearchTerms("please help me")).not.toContain("please");
  });
  it("keeps candidates when runtime ownership changes, rejects foreign URLs, and reports rate limits", async () => {
    let current = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/search/issues") return json({ items: [item(1)], incomplete_results: false, total_count: 1 });
      current = false; return json({ number: 1, html_url: item(1).html_url, base: { repo: { full_name: repository } }, merged: true, state: "closed", merge_commit_sha: a });
    });
    const unknown = await searchPersonalDevelopmentUpstream("render", new AbortController().signal,
      { fetch, runtime: { channel: "release", version: "0.1.0", commit: a, confidence: "exact" }, isCurrent: () => current });
    expect(unknown).toMatchObject({ status: "found", runtime: { confidence: "unknown" }, items: [{ inclusion: "unknown" }] });
    await expect(searchPersonalDevelopmentUpstream("render", new AbortController().signal, { fetch: vi.fn(async () => json({
      items: [{ ...item(1), html_url: "https://foreign.example/pull/1" }], incomplete_results: false, total_count: 1 })) })).resolves.toMatchObject({ status: "failed", failure: "invalidResponse" });
    await expect(searchPersonalDevelopmentUpstream("render", new AbortController().signal, { fetch: vi.fn().mockResolvedValue(new Response("limited", { status: 429 })) }))
      .resolves.toMatchObject({ status: "failed", failure: "rateLimit" });
  });
});
