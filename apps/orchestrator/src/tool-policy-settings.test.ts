import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolPolicyEffectiveSource } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeToolPolicyDeclaration } from "./mcp-router.js";
import { ToolPolicySettingsRepository } from "./tool-policy-settings.js";

const POLICY: BridgeToolPolicyDeclaration = {
  id: "joko-test-tools",
  displayName: "Test tools",
  description: "A testable ordinary Tool Provider.",
  productDefaultEnabled: true,
  localizations: {
    "zh-CN": { displayName: "测试工具", description: "可测试的普通工具。" }
  }
};
const cleanups: Array<() => void> = [];

afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("ToolPolicySettingsRepository", () => {
  it("resolves product, user, and project scopes with explicit reset state", () => {
    const fixture = createFixture();
    try {
      const initial = fixture.repository.snapshot()[0]!;
      expect(initial.userEffectiveEnabled).toBe(true);
      expect(initial.userEffectiveSource).toBe(ToolPolicyEffectiveSource.PRODUCT_DEFAULT);
      expect(initial.targetSettings[0]?.targetId).toBe("target-a");
      expect(initial.targetSettings[0]?.effectiveEnabled).toBe(true);
      expect(initial.targetSettings[0]?.effectiveSource).toBe(ToolPolicyEffectiveSource.PRODUCT_DEFAULT);
      expect(fixture.repository.snapshot("zh-CN")[0]).toMatchObject({
        displayName: "测试工具",
        description: "可测试的普通工具。"
      });
      expect(initial).not.toHaveProperty("userOverride");
      expect(initial.targetSettings[0]).not.toHaveProperty("projectOverride");

      fixture.repository.apply({ toolProviderId: POLICY.id, enabled: false, reset: false });
      fixture.repository.apply({ toolProviderId: POLICY.id, targetId: "target-a", enabled: true, reset: false });
      const configured = fixture.repository.snapshot()[0]!;
      expect(configured.userEffectiveEnabled).toBe(false);
      expect(configured.userEffectiveSource).toBe(ToolPolicyEffectiveSource.USER_DEFAULT);
      expect(configured.userOverride?.enabled).toBe(false);
      expect(configured.targetSettings[0]?.effectiveEnabled).toBe(true);
      expect(configured.targetSettings[0]?.effectiveSource).toBe(ToolPolicyEffectiveSource.PROJECT_OVERRIDE);
      expect(configured.targetSettings[0]?.projectOverride?.enabled).toBe(true);

      fixture.repository.apply({ toolProviderId: POLICY.id, targetId: "target-a", reset: true });
      fixture.repository.apply({ toolProviderId: POLICY.id, reset: true });
      const reset = fixture.repository.snapshot()[0]!;
      expect(reset.userEffectiveEnabled).toBe(true);
      expect(reset.userEffectiveSource).toBe(ToolPolicyEffectiveSource.PRODUCT_DEFAULT);
      expect(reset).not.toHaveProperty("userOverride");
      expect(reset.targetSettings[0]).not.toHaveProperty("projectOverride");
    } finally {
      fixture.store.close();
    }
  });

  it("freezes ordinary Tool availability for the lifetime of a Session", () => {
    const fixture = createFixture();
    fixture.repository.apply({ toolProviderId: POLICY.id, targetId: "target-a", enabled: false, reset: false });
    expect(fixture.repository.enabledForSession("session-old", "target-a", POLICY.id)).toBe(false);

    fixture.repository.apply({ toolProviderId: POLICY.id, targetId: "target-a", reset: true });
    expect(fixture.repository.enabledForSession("session-old", "target-a", POLICY.id)).toBe(false);
    expect(fixture.repository.enabledForSession("session-new", "target-a", POLICY.id)).toBe(true);

    fixture.store.close();
    const reopened = new OperationalStore(fixture.path);
    const repository = new ToolPolicySettingsRepository({ store: reopened, catalog: () => [POLICY] });
    expect(repository.enabledForSession("session-old", "target-a", POLICY.id)).toBe(false);
    expect(repository.enabledForSession("session-new", "target-a", POLICY.id)).toBe(true);
    reopened.close();
  });
});

function createFixture(): {
  readonly path: string;
  readonly store: OperationalStore;
  readonly repository: ToolPolicySettingsRepository;
} {
  const root = mkdtempSync(join(tmpdir(), "joko-tool-policy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operational.sqlite");
  const store = new OperationalStore(path);
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-a",
    backendId: "pi",
    displayName: "Target A",
    workspaceRoot: "D:/target-a",
    managed: false,
    trusted: true
  });
  return {
    path,
    store,
    repository: new ToolPolicySettingsRepository({ store, catalog: () => [POLICY], now: () => 1_000 })
  };
}
