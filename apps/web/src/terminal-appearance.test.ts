// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readTerminalAppearance } from "./terminal-appearance.js";
import { validTerminalColorOverrides } from "./terminal-gateway.js";

it("derives all nineteen defaults from the owning Document and rejects missing colors", () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const ownerDocument = frame.contentDocument!;
  const element = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  const colors = { "--text": "#123456", "--surface": "#abcdef", "--text-soft": "#789", "--red": "#a00", "--green": "#0a0", "--amber": "#aa0", "--blue": "#00a", "--purple": "#a0a" };
  const computed = vi.spyOn(frame.contentWindow!, "getComputedStyle").mockReturnValue({ getPropertyValue: (name: string) => colors[name as keyof typeof colors] ?? "" } as unknown as CSSStyleDeclaration);
  try {
    const { palette } = readTerminalAppearance(element);
    expect(palette).toMatchObject({ foregroundRgb: 0x123456, backgroundRgb: 0xabcdef, cursorRgb: 0x123456 });
    expect(palette.ansiRgb).toEqual([0x123456, 0xaa0000, 0x00aa00, 0xaaaa00, 0x0000aa, 0xaa00aa, 0x0000aa, 0x123456, 0x778899, 0xaa0000, 0x00aa00, 0xaaaa00, 0x0000aa, 0xaa00aa, 0x0000aa, 0x123456]);
    computed.mockReturnValue({ getPropertyValue: () => "" } as unknown as CSSStyleDeclaration);
    expect(() => readTerminalAppearance(element)).toThrow("invalid color");
  } finally { computed.mockRestore(); frame.remove(); }
});

it("accepts bounded modified-color snapshots and rejects query, reset or unrelated terminal controls", () => {
  expect(validTerminalColorOverrides("")).toBe(true);
  expect(validTerminalColorOverrides("\x1b]4;0;rgb:1111/2222/3333;255;rgb:aaaa/bbbb/cccc\x1b\\\x1b]12;rgb:0000/1111/2222\x1b\\")).toBe(true);
  for (const value of ["\x1b]4;256;rgb:aaaa/bbbb/cccc\x1b\\", "\x1b]10;?\x1b\\", "\x1b]111\x1b\\", "\x1b]52;c;payload\x07", "\x1b[2J", "x".repeat(16385)]) expect(validTerminalColorOverrides(value)).toBe(false);
});
