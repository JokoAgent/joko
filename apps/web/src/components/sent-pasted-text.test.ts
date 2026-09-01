import { describe, expect, it } from "vitest";
import {
  buildSentPastedTextMessageSegments,
  buildSentPastedTextTokens,
  projectSentPastedText,
  projectSentPastedTextMessageBody,
  projectSentPastedTextRanges
} from "./sent-pasted-text.js";

function log(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `log line ${index + 1}`).join("\n");
}

describe("sent pasted-text projection", () => {
  it("projects one exact range while preserving typed text around it", () => {
    const pasted = log(440);
    const content = `before\n${pasted}\nafter`;
    const start = content.indexOf(pasted);
    const ranges = [{ start, end: start + pasted.length, display: "Pasted text (440 lines)" }];
    expect(buildSentPastedTextTokens(content, ranges)).toEqual([
      { kind: "text", text: "before\n" },
      { kind: "pasted", text: pasted, display: "Pasted text (440 lines)" },
      { kind: "text", text: "\nafter" }
    ]);
    expect(projectSentPastedText(content, ranges)).toBe("before\nPasted text (440 lines)\nafter");
  });

  it("projects multiple ranges independently", () => {
    const first = log(30);
    const second = log(40);
    const content = `A\n${first}\nB\n${second}\nC`;
    const firstStart = content.indexOf(first);
    const secondStart = content.indexOf(second, firstStart + first.length);
    expect(projectSentPastedText(content, [
      { start: firstStart, end: firstStart + first.length, display: "Pasted A" },
      { start: secondStart, end: secondStart + second.length, display: "Pasted B" }
    ])).toBe("A\nPasted A\nB\nPasted B\nC");
  });

  it("fails open to the complete source for missing, invalid, or overlapping ranges", () => {
    const content = "keep every character";
    expect(projectSentPastedText(content)).toBe(content);
    expect(projectSentPastedText(content, [{ start: 2, end: content.length + 1, display: "bad" }])).toBe(content);
    expect(projectSentPastedText(content, [{ start: 5, end: 3, display: "bad" }])).toBe(content);
    expect(projectSentPastedText(content, [{ start: 0, end: 4, display: "first" }, { start: 2, end: 8, display: "overlap" }])).toBe("first every character");
  });

  it("rebases only ranges wholly contained by a visible text island", () => {
    expect(projectSentPastedTextRanges([
      { start: 4, end: 8, display: "inside" },
      { start: 1, end: 5, display: "crossing" }
    ], 3, 6)).toEqual([{ start: 1, end: 5, display: "inside" }]);
    expect(projectSentPastedTextRanges([], null, 3)).toEqual([]);
  });

  it("maps a repeated body paste after an encoded quote by exact source offset", () => {
    const pasted = log(24);
    const content = `> <!-- joko-selection-quote -->\n> ${pasted.replaceAll("\n", "\n> ")}\n\n${pasted}`;
    const start = content.lastIndexOf(pasted);
    const ranges = [{ start, end: start + pasted.length, display: "Pasted text (24 lines)" }];
    const segments = buildSentPastedTextMessageSegments(content, true, ranges);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.tokens).toEqual([{ kind: "pasted", text: pasted, display: "Pasted text (24 lines)" }]);
    expect(projectSentPastedTextMessageBody(content, true, ranges)).toBe("Pasted text (24 lines)");
  });

  it("keeps source offsets exact across CRLF quote boundaries", () => {
    const pasted = "first\r\nsecond\r\nthird";
    const content = `> <!-- joko-selection-quote -->\r\n> first\r\n\r\nbefore\r\n${pasted}\r\nafter`;
    const start = content.indexOf(pasted);
    const ranges = [{ start, end: start + pasted.length, display: "Pasted text (3 lines)" }];
    expect(buildSentPastedTextMessageSegments(content, true, ranges)[0]?.tokens).toEqual([
      { kind: "text", text: "before\r\n" },
      { kind: "pasted", text: pasted, display: "Pasted text (3 lines)" },
      { kind: "text", text: "\r\nafter" }
    ]);
    expect(projectSentPastedTextMessageBody(content, true, ranges)).toBe("before\nPasted text (3 lines)\nafter");
  });
});
