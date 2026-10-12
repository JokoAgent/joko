import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNativeTranscriptWindow } from "./native-transcript-window.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), "joko-transcript-window-")); roots.push(root); return join(root, "session.jsonl"); }
describe("bounded native transcript source", () => {
  it("reads a complete small file, and retires a file whose identity changed after discovery", async () => {
    const file = path(); writeFileSync(file, '{"message":"first"}\n{"message":"last"}');
    const window = await readNativeTranscriptWindow(file);
    expect(window.whole).toBe(true); expect(window.head).toHaveLength(2);
    writeFileSync(file, '{"message":"replaced"}\n');
    await expect(readNativeTranscriptWindow(file, window.identity)).rejects.toThrow("changed");
  });
  it("skips a long metadata first line and returns complete head and tail records without the middle", async () => {
    const file = path();
    writeFileSync(file, `${"m".repeat(100_000)}\n{"message":"purpose"}\n${"{\"tool\":\"middle\"}\n".repeat(20_000)}{"message":"latest"}\n`);
    const window = await readNativeTranscriptWindow(file);
    expect(window.whole).toBe(false);
    expect(window.head[0]).toBe('{"message":"purpose"}');
    expect(window.tail.at(-1)).toBe('{"message":"latest"}');
    expect(window.head.join("\n").length + window.tail.join("\n").length).toBeLessThan(131_072);
  });
});
