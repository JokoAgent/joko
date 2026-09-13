/** Multilingual samples used to verify text, encoding, and font behavior. */
export const unicodeCorpus = {
  urlWithParentheticalProse: "https://example.test/file（说明）",
  urlWithCjkFilename: "https://example.test/文件名",
  urlWithCjkPathSuffix: "https://example.test/path这是内容",
  internationalUrl: "https://例子。测试/文件",
  authorityFollowedByProse: "https://example.test。这里是说明",
  portFollowedByProse: "https://example.test:8443。说明",
  urlWithBracketedProse: "https://example.test/file[说明]",
  emphasizedUrlFollowedByProse: "**https://example.test/name**，说明",
  japaneseUrlFollowedByEllipsis: "https://example.test/カタカナ…次",
  adjacentUrlsInProse: "链接 https://example.test/one（说明），https://other.test/two。结束",
  invalidInternationalAuthority: "https://。不是域名",
  browserSearch: "浏览器",
  cjkWithAsciiPunctuation: "中文, () 内容",
  cjkWithComma: "中文,",
  quotedCjkWord: "《旧》",
  compositionWithComma: ",中",
  repeatedCjkParagraph: "<p>中文 中文</p>",
  cjkWord: "中文",
  mixedNormalizationParagraph: "<p>前🐾 Cafe<span>́</span> STRAẞE <b>하</b>ᆫ ﬁle</p><p>different block</p>",
  cjkAndKoreanWhitespaceParagraphs: "<p>中\n文</p><p>한\n글</p><pre style=\"white-space:pre\">中\n文</pre><div style=\"visibility:hidden\"><span style=\"visibility:visible\">visible</span></div>",
  cjkWordAcrossLine: "中\n文",
  mixedMarkdownLinks: "https://example.test/foo（说明），https://other.test/y。 [query](https://example.test/search?q=[a]) [semi](https://example.test/x;)",
  mixedMarkdownLinkLabels: "https://example.test/foo（说明），https://other.test/y。 query semi",
  shortMixedScriptText: "short English 中文",
  streamedUnclosedMarkdownLink: "Stable **paragraph**.\n\n[文档](https://example.test/search?q=[a]",
  streamedCompleteMarkdownLinks: "Stable **paragraph**.\n\n[文档](https://example.test/search?q=[a]) [标点](https://example.test/x;) <https://example.test/path（说明）>\n\nhttps://example.test/foo/93（含说明），https://other.test/y。",
  bareLinksWithCjkProse: "https://example.test/foo/93（含说明），https://other.test/y。",
  explicitLinksCodeAndCjkHeading: "[https://example.test/file（完整）](https://example.test/file（完整）)\n\nhttps://example.test/search?q=[a]#part{b}\n\nhttps://example.test/search?q=a)b\n\n`https://example.test/code（原文）`\n\n**小标题：**正文",
  urlWithLiteralCjkParentheses: "https://example.test/file（完整）",
  codeUrlWithCjkParentheses: "https://example.test/code（原文）",
  cjkHeadingWithColon: "小标题：",
  wideCharacter: "界",
  utf8SearchPreview: "  前🐾后🐾",
  utf8SearchPrefix: "前🐾后",
  internationalTaskId: "task / 一"
} as const;

export function longCjkUrlSource(length: number): string {
  return `https://example.test/${"字".repeat(length)}（说明）`;
}

export function longPunctuationRun(length: number): string {
  return `${"(".repeat(length)}中`;
}
