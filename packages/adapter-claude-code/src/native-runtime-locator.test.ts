import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  claudeNativeRuntimePackageCandidates,
  locateClaudeNativeRuntime
} from "./native-runtime-locator.js";

describe("Claude native runtime locator", () => {
  it("selects the exact platform package and orders Linux libc fallbacks", () => {
    expect(claudeNativeRuntimePackageCandidates("win32", "x64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-win32-x64"
    ]);
    expect(claudeNativeRuntimePackageCandidates("darwin", "arm64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64"
    ]);
    expect(claudeNativeRuntimePackageCandidates("linux", "x64", false)).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-x64",
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl"
    ]);
    expect(claudeNativeRuntimePackageCandidates("linux", "arm64", true)).toEqual([
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
      "@anthropic-ai/claude-agent-sdk-linux-arm64"
    ]);
    expect(() => claudeNativeRuntimePackageCandidates("freebsd", "x64", false))
      .toThrow(/does not support this platform/iu);
    expect(() => claudeNativeRuntimePackageCandidates("linux", "ia32", false))
      .toThrow(/does not support this architecture/iu);
  });

  it("authenticates the installed SDK, optional package and target-native binary", async () => {
    const sdkEntry = await realpath(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    const located = await locateClaudeNativeRuntime({ sdkEntry });
    expect(located.packageName).toBe(
      claudeNativeRuntimePackageCandidates(process.platform, process.arch, process.platform === "linux"
        && ((process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined)
          ?.header?.glibcVersionRuntime === undefined))[0]
    );
    expect(located.executable).toBe(await realpath(located.executable));
    expect(located.packageRoot).toBe(await realpath(located.packageRoot));
    expect(located.executable.endsWith(process.platform === "win32" ? "claude.exe" : "claude")).toBe(true);
  });
});
