import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TerminalColorState, TERMINAL_COLOR_OSC_IDENTIFIERS } from "./terminal-color-state.js";

const palette = { ansiRgb: [0x2e3436, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf, 0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec], foregroundRgb: 0xffffff, backgroundRgb: 0, cursorRgb: 0xffffff };

describe("terminal color state", () => {
  it("replaces query defaults while preserving explicit equal-default overrides until reset", () => {
    const colors = new TerminalColorState(palette);
    colors.consumeOsc(4, "1;#cc0000");
    colors.consumeOsc(10, "#ffffff");
    const next = { ...palette, ansiRgb: palette.ansiRgb.map(() => 0x010203), foregroundRgb: 0x040506, backgroundRgb: 0x070809 };
    colors.replaceDefaults(next);
    next.ansiRgb[0] = 0xffffff;
    expect(colors.consumeOsc(4, "0;?;1;?;16;?").replies).toEqual(["\x1b]4;0;rgb:0101/0202/0303\x1b\\", "\x1b]4;1;rgb:cccc/0000/0000\x1b\\", "\x1b]4;16;rgb:0000/0000/0000\x1b\\"]);
    expect(colors.consumeOsc(10, "?;?").replies).toEqual(["\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1b]11;rgb:0707/0808/0909\x1b\\"]);
    colors.consumeOsc(104, "1"); colors.consumeOsc(110, "");
    expect(colors.replayColors()).toBe("");
    expect(colors.consumeOsc(10, "?").replies).toEqual(["\x1b]10;rgb:0404/0505/0606\x1b\\"]);
  });

  it("answers with the canonical ANSI, color cube, grayscale and default foreground/background/cursor", () => {
    const colors = new TerminalColorState(palette);
    expect(colors.replayColors()).toBe("");
    expect(colors.consumeOsc(4, "0;?;15;?;16;?;21;?;231;?;232;?;255;?").replies).toEqual([
      "\x1b]4;0;rgb:2e2e/3434/3636\x1b\\", "\x1b]4;15;rgb:eeee/eeee/ecec\x1b\\",
      "\x1b]4;16;rgb:0000/0000/0000\x1b\\", "\x1b]4;21;rgb:0000/0000/ffff\x1b\\",
      "\x1b]4;231;rgb:ffff/ffff/ffff\x1b\\", "\x1b]4;232;rgb:0808/0808/0808\x1b\\", "\x1b]4;255;rgb:eeee/eeee/eeee\x1b\\"
    ]);
    expect(colors.consumeOsc(10, "?;?;?").replies).toEqual([
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]12;rgb:ffff/ffff/ffff\x1b\\"
    ]);
    expect(colors.replayColors()).toBe("");
  });

  it("applies mixed settings and queries in order with the same numeric color formats as the renderer", () => {
    const colors = new TerminalColorState(palette);
    expect(colors.consumeOsc(4, "1;#123;1;?;1;rgb:1/2/3;1;?").replies).toEqual([
      "\x1b]4;1;rgb:1010/2020/3030\x1b\\", "\x1b]4;1;rgb:1111/2222/3333\x1b\\"
    ]);
    expect(colors.replayColors()).toBe("\x1b]4;1;rgb:1111/2222/3333\x1b\\");
    const cases = [
      ["#123456", "1212/3434/5656"], ["#123456789", "1212/4545/7878"], ["#123456789ABC", "1212/5656/9a9a"],
      ["RGB:AA/BB/CC", "aaaa/bbbb/cccc"], ["rgb:800/fff/000", "8080/ffff/0000"], ["rgb:8000/ffff/0000", "8080/ffff/0000"]
    ];
    for (const [specification, expected] of cases) {
      expect(colors.consumeOsc(11, specification!).handled).toBe(true);
      expect(colors.consumeOsc(11, "?").replies).toEqual([`\x1b]11;rgb:${expected}\x1b\\`]);
    }
    colors.consumeOsc(10, ";#000000;#ff0000");
    expect(colors.consumeOsc(11, "?;?").replies).toEqual(["\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]12;rgb:ffff/0000/0000\x1b\\"]);
  });

  it("restores selected or all indexed colors and independent special colors to immutable custom defaults", () => {
    const indexed = [...palette.ansiRgb]; indexed[0] = 0x102030; indexed[1] = 0x405060;
    const colors = new TerminalColorState({ ansiRgb: indexed, foregroundRgb: 0x010203, backgroundRgb: 0x040506, cursorRgb: 0x070809 });
    expect(colors.replayColors()).toBe("");
    indexed[0] = 0xffffff;
    colors.consumeOsc(4, "0;#000000;1;#000000");
    colors.consumeOsc(10, "#ffffff;#ffffff;#ffffff");
    colors.consumeOsc(104, "0;999;bad");
    expect(colors.replayColors()).toBe("\x1b]4;1;rgb:0000/0000/0000\x1b\\\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b]12;rgb:ffff/ffff/ffff\x1b\\");
    expect(colors.consumeOsc(4, "0;?;1;?").replies).toEqual(["\x1b]4;0;rgb:1010/2020/3030\x1b\\", "\x1b]4;1;rgb:0000/0000/0000\x1b\\"]);
    colors.consumeOsc(104, "");
    expect(colors.consumeOsc(4, "1;?").replies).toEqual(["\x1b]4;1;rgb:4040/5050/6060\x1b\\"]);
    for (const identifier of [110, 111, 112]) colors.consumeOsc(identifier, "");
    expect(colors.replayColors()).toBe("");
    expect(colors.consumeOsc(10, "?;?;?").replies).toEqual([
      "\x1b]10;rgb:0101/0202/0303\x1b\\", "\x1b]11;rgb:0404/0505/0606\x1b\\", "\x1b]12;rgb:0707/0808/0909\x1b\\"
    ]);
  });

  it("replays only effective process settings through public parser hooks without producing replies", async () => {
    const source = new TerminalColorState(palette);
    source.consumeOsc(4, "7;#102030;255;rgb:f/e/d");
    source.consumeOsc(10, "#123456;#789abc;#fedcba");
    const target = new TerminalColorState(palette);
    target.consumeOsc(4, "7;#000000");
    const terminal = new Terminal({ allowProposedApi: true });
    const replies: string[] = [];
    const subscriptions = TERMINAL_COLOR_OSC_IDENTIFIERS.map((identifier) => terminal.parser.registerOscHandler(identifier, (data) => {
      const result = target.consumeOsc(identifier, data);
      replies.push(...result.replies);
      return result.handled;
    }));
    try {
      const checkpoint = source.replayColors();
      expect(checkpoint.length).toBeLessThan(8 * 1024);
      await new Promise<void>((resolve) => terminal.write(checkpoint, resolve));
      expect(replies).toEqual([]);
      expect(target.replayColors()).toBe(checkpoint);
      await new Promise<void>((resolve) => terminal.write("\x1b]4;7;?\x07\x1b]10;?;?;?\x1b\\", resolve));
      expect(replies).toEqual([...source.consumeOsc(4, "7;?").replies, ...source.consumeOsc(10, "?;?;?").replies]);
    } finally { subscriptions.forEach((subscription) => subscription.dispose()); terminal.dispose(); }
  });

  it("drops reset overrides from replay while preserving later explicit sets and canonical query order", () => {
    const colors = new TerminalColorState(palette);
    colors.consumeOsc(4, "1;#000000;2;#000000");
    colors.consumeOsc(10, "#ffffff;#112233;#ffffff");
    colors.consumeOsc(104, "1");
    colors.consumeOsc(110, "");
    colors.consumeOsc(112, "");
    expect(colors.replayColors()).toBe("\x1b]4;2;rgb:0000/0000/0000\x1b\\\x1b]11;rgb:1111/2222/3333\x1b\\");
    expect(colors.consumeOsc(4, "1;?;1;#abcdef;1;?").replies).toEqual([
      "\x1b]4;1;rgb:cccc/0000/0000\x1b\\", "\x1b]4;1;rgb:abab/cdcd/efef\x1b\\"
    ]);
    colors.consumeOsc(104, "");
    expect(colors.replayColors()).toBe("\x1b]11;rgb:1111/2222/3333\x1b\\");
    colors.consumeOsc(111, "");
    expect(colors.replayColors()).toBe("");
    expect(colors.consumeOsc(11, "?").replies).toEqual(["\x1b]11;rgb:0000/0000/0000\x1b\\"]);
    colors.consumeOsc(11, "#000000");
    expect(colors.replayColors()).toBe("\x1b]11;rgb:0000/0000/0000\x1b\\");
  });

  it("ignores malformed fields and unsupported color forms without growing or changing the palette", () => {
    const colors = new TerminalColorState(palette);
    const before = colors.replayColors();
    for (const value of ["256;?", "-1;?", "1x;?", "1;red", "1;rgb:f/ff/fff", "1;#1234", "1;rgbi:1/0/0", "0;" + "f".repeat(65536)]) {
      expect(colors.consumeOsc(4, value)).toEqual({ handled: false, replies: [] });
    }
    expect(colors.consumeOsc(52, "private clipboard data")).toEqual({ handled: false, replies: [] });
    expect(colors.replayColors()).toBe(before);
    expect(() => new TerminalColorState({ ...palette, ansiRgb: new Array<number>(17).fill(0) })).toThrow();
    expect(() => new TerminalColorState({ ...palette, foregroundRgb: -1 })).toThrow();
  });
});
