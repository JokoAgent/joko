import { describe, expect, it } from "vitest";
import { publicToolResultWorkingPhase, publicToolWorkingPhase } from "./working-status.js";

describe("public execution phases", () => {
  it("uses execution subjects without model descriptions, targets or results", () => {
    expect(publicToolWorkingPhase("Bash", '{"command":"pnpm test","description":"Everything passed in /private/repo"}')).toBe("testing");
    expect(publicToolWorkingPhase("command", "$: pnpm typecheck")).toBe("checking");
    expect(publicToolWorkingPhase("command", "$: cat /private/notes.txt")).toBe("reading-file");
    expect(publicToolWorkingPhase("command", "$: rg secret src")).toBe("searching-files");
    expect(publicToolWorkingPhase("command", "$: curl https://example.test/private")).toBe("reading-web");
    expect(publicToolWorkingPhase("Read", '{"path":"/private/notes.txt"}')).toBe("reading-file");
    expect(publicToolWorkingPhase("Write", '{"path":"/private/notes.txt"}')).toBe("saving-file");
    expect(publicToolWorkingPhase("WebSearch", '{"query":"private terms"}')).toBe("searching");
    expect(publicToolWorkingPhase("WebFetch", '{"url":"https://example.test/private"}')).toBe("reading-web");
    expect(publicToolWorkingPhase("mcp__joko_memory__memory_read", "payload withheld", true)).toBe("reading-memory");
    expect(publicToolWorkingPhase("joko_memory/memory_delete", "payload withheld", true)).toBe("deleting-memory");
    expect(publicToolWorkingPhase("mcp__joko_memory__call_tool", '{"name":"memory_write","content":"private"}')).toBe("saving-memory");
    expect(publicToolResultWorkingPhase("saving-memory")).toBe("reviewing-memory");
    expect(publicToolResultWorkingPhase("testing")).toBe("reviewing-checks");
  });

  it("rejects executable substitutions, redirects, mixed effects and misleading partial commands", () => {
    for (const command of ["cat a > b", "cat a>b", "cat a | tee b", "cat a && rm -rf b", "cat $(touch b)",
      "find . -name '*.ts' -delete", "rg --pre 'touch b' needle .", "make test deploy", "pnpm test && pnpm install",
      "sed -i 's/a/b/g' a", "cat <(rm -rf b)", "cat > \"&2\"", "cat a &", "cat a\nunknown-command"]) {
      expect(publicToolWorkingPhase("command", command), command).toBe("processing");
    }
    expect(publicToolWorkingPhase("command", "cat a | head -5")).toBe("reading-file");
    expect(publicToolWorkingPhase("command", "cd repo && pnpm test && pnpm lint")).toBe("checking");
    expect(publicToolWorkingPhase("command", "pnpm test && pnpm build")).toBe("checking");
    expect(publicToolWorkingPhase("command", "cat a && head b")).toBe("processing");
    expect(publicToolWorkingPhase("command", "cat a 2>&1")).toBe("reading-file");
  });

  it("unwraps only complete platform shell commands and keeps withheld input generic", () => {
    expect(publicToolWorkingPhase("command", "/bin/zsh -lc 'pnpm test'")).toBe("testing");
    expect(publicToolWorkingPhase("command", 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command "pnpm lint"')).toBe("checking");
    expect(publicToolWorkingPhase("command", 'cmd.exe /c "pnpm test"')).toBe("testing");
    expect(publicToolWorkingPhase("command", "/bin/zsh -lc 'cat a' && rm -rf b")).toBe("processing");
    expect(publicToolWorkingPhase("Bash", '{"command":"pnpm test"}', true)).toBe("processing");
    expect(publicToolWorkingPhase("unknown_tool", '{"description":"Reading files"}')).toBe("processing");
    expect(publicToolWorkingPhase("command", "x".repeat(70_000))).toBe("processing");
  });
});
