import { unicodeCorpus, longCjkUrlSource } from "./i18n/test-corpus.js";
import { describe, expect, it } from "vitest";
import { scanChatUrls } from "./chat-url-boundary.js";

describe("chat HTTP link boundaries", () => {
  it("separates prose wrappers from real international paths, authorities and query data", () => {
    const examples: readonly (readonly [string, string])[] = [
      [unicodeCorpus.urlWithParentheticalProse, "https://example.test/file"],
      [unicodeCorpus.urlWithCjkFilename, unicodeCorpus.urlWithCjkFilename],
      [unicodeCorpus.urlWithCjkPathSuffix, unicodeCorpus.urlWithCjkPathSuffix],
      ["https://example.test/%E6%96%87%EF%BC%88a%EF%BC%89", "https://example.test/%E6%96%87%EF%BC%88a%EF%BC%89"],
      [unicodeCorpus.internationalUrl, unicodeCorpus.internationalUrl],
      [unicodeCorpus.authorityFollowedByProse, "https://example.test"],
      [unicodeCorpus.portFollowedByProse, "https://example.test:8443"],
      ["https://[::1]/file。", "https://[::1]/file"],
      [unicodeCorpus.urlWithBracketedProse, "https://example.test/file"],
      ["https://example.test/search?q=[a]#part{b}", "https://example.test/search?q=[a]#part{b}"],
      ["https://example.test/search?q=[a]]tail", "https://example.test/search?q=[a]"],
      ["https://example.test/search?q=(word)&a=b", "https://example.test/search?q=(word)&a=b"],
      ["https://example.test/search?q=a)b", "https://example.test/search?q=a)b"],
      ["https://example.test/search?q=a)", "https://example.test/search?q=a)"],
      ["(https://example.test/search?q=a)b)next", "https://example.test/search?q=a)b"],
      ["https://example.test/Foo_(bar)", "https://example.test/Foo_(bar)"],
      ["https://example.test/issues/123(v2)", "https://example.test/issues/123(v2)"],
      ["https://example.test/path(note", "https://example.test/path"],
      ["https://github.com/example/project/pull/42(base main,OPEN)", "https://github.com/example/project/pull/42"],
      ["https://gitlab.com/example/project/-/merge_requests/42#note(base,OPEN)", "https://gitlab.com/example/project/-/merge_requests/42#note"],
      ["https://github.com/example/project/pull/42?q=(base,OPEN)", "https://github.com/example/project/pull/42?q=(base,OPEN)"],
      ["https://github.com/example/project/pull/42#note(base", "https://github.com/example/project/pull/42#note"],
      ["'https://example.test/name'", "https://example.test/name"],
      ["https://example.test/Guns_N'_Roses", "https://example.test/Guns_N'_Roses"],
      ["https://example.test/name'", "https://example.test/name'"],
      [unicodeCorpus.emphasizedUrlFollowedByProse, "https://example.test/name"],
      ["https://example.test/name*", "https://example.test/name*"],
      ["https://example.test/name_;", "https://example.test/name_"],
      ["https://example.test/name_\u{10100}text", "https://example.test/name"],
      ["https://example.test/path;", "https://example.test/path"],
      [unicodeCorpus.japaneseUrlFollowedByEllipsis, "https://example.test/カタカナ"]
    ];
    for (const [source, expected] of examples) {
      expect(scanChatUrls(source).map((match) => match.url), source).toEqual([expected]);
      const match = scanChatUrls(source)[0]!;
      expect(source.slice(match.start, match.end), source).toBe(expected);
    }
  });

  it("keeps adjacent URL boundaries ordered without consuming the intervening text or truncating long source", () => {
    const source = unicodeCorpus.adjacentUrlsInProse;
    expect(scanChatUrls(source).map((match) => match.url)).toEqual(["https://example.test/one", "https://other.test/two"]);
    const long = longCjkUrlSource(100_000);
    expect(scanChatUrls(long)[0]?.url).toBe(long.slice(0, -4));
    const query = `https://github.com/example/project/pull/42?q=${"(".repeat(100_000)}`;
    expect(scanChatUrls(query)[0]?.url).toBe(query);
    const invalidAuthorities = `${"https://[ ".repeat(10_000)}https://example.test/end`;
    expect(scanChatUrls(invalidAuthorities).map((match) => match.url)).toEqual(["https://example.test/end"]);
    expect(scanChatUrls("https://example.test/(".repeat(10_000))).toEqual([]);
    expect(scanChatUrls(unicodeCorpus.invalidInternationalAuthority)).toEqual([]);
    expect(scanChatUrls("file:///private/a javascript:alert(1)")).toEqual([]);
  });
});
