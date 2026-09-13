import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { loadClaudeRemoteManagerSource } from "./remote-manager-source.js";

const execute = promisify(execFile);

describe("remote Claude manager bundle", () => {
  it("ships one bounded executable module with the exact protocol identity", async () => {
    const source = await loadClaudeRemoteManagerSource();
    expect(source.byteLength).toBeGreaterThan(1_024);
    expect(source.byteLength).toBeLessThanOrEqual(512 * 1_024);

    const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), ".manager-bundle-test-"));
    const modulePath = join(root, "manager.mjs");
    try {
      await writeFile(modulePath, source, { mode: 0o600 });
      const result = await execute(process.execPath, [modulePath, "--version"], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1_024
      });
      expect(JSON.parse(result.stdout.trim())).toEqual({
        managerVersion: "1.0.0",
        protocolVersion: 1,
        managerSha256: createHash("sha256").update(source).digest("hex")
      });
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
