import { describe, expect, it } from "vitest";

import { filterWeChatMarkdown, splitWeChatText } from "./text.js";

describe("WeChat text projection", () => {
  it("removes unsupported formatting outside code and preserves Unicode/fences in bounded parts", () => {
    expect(filterWeChatMarkdown("##### 标题\n~~旧~~ **保留** *中文* ![image](https://example.test/x)\n`~~code~~`\n```md\n![keep](x)\n```"))
      .toBe("标题\n旧 **保留** 中文 \n`~~code~~`\n```md\n![keep](x)\n```");
    const chunks = splitWeChatText(`\`\`\`ts\n${"😀".repeat(3_550)}\n\`\`\``);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((part) => Array.from(part).length <= 3_500)).toBe(true);
    expect(chunks[0]).toContain("\n```");
    expect(chunks[1]).toMatch(/^```\n/u);
    expect(splitWeChatText("")).toEqual([]);
  });
});
