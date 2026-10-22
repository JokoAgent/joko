import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostedExecution } from "@joko/core";
import { expect, it } from "vitest";
import { claudeHostedSettings } from "./hosted-execution.js";

it("adopts only Source-owned native permission lists and retains the isolated host settings", () => {
  const root = join(tmpdir(), "joko-source-native-permissions"), hosted: HostedExecution = {
    workspace: { root, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false,
      contextFiles: [{ path: join(root, ".claude", "settings.json"), content: JSON.stringify({ permissions: { allow: ["Read(src/**)"], deny: ["Agent"] }, env: { API_KEY: "never-adopt" }, hooks: {} }) },
        { path: join(root, ".claude", "settings.local.json"), content: JSON.stringify({ permissions: { allow: ["Read(src/**)", "WebSearch"], deny: ["WebFetch"], ask: ["Write"] }, autoMemoryEnabled: true }) },
        { path: join(root, "other", ".claude", "settings.local.json"), content: JSON.stringify({ permissions: { allow: ["WRONG_SCOPE"] } }) }] },
    channel: { endpoint: "http://127.0.0.1:1234/source", bearer: "a".repeat(64) }, source: { sessionId: "task", targetId: "project", generation: 2 },
    trust: "owner", assertCurrent: () => {}
  };
  const settings = claudeHostedSettings(hosted);
  expect(settings).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false, autoDreamEnabled: false,
    permissions: { allow: ["Read(src/**)", "WebSearch"], deny: ["Agent", "WebFetch"], ask: ["Write"] } });
  expect(JSON.stringify(settings)).not.toMatch(/never-adopt|WRONG_SCOPE/u);
  expect(() => claudeHostedSettings({ ...hosted, assertCurrent: () => { throw new Error("Source revoked."); } })).toThrow(/revoked/u);
  expect(() => claudeHostedSettings({ ...hosted, workspace: { ...hosted.workspace, contextFiles: [{ path: join(root, ".claude", "settings.json"),
    content: JSON.stringify({ permissions: { deny: [42] } }) }] } })).toThrow(/permission snapshot/u);
});
