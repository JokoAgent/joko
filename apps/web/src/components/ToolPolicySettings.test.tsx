// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { ToolPolicySettings } from "./ToolPolicySettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ToolPolicySettings", () => {
  it("shows effective source and submits project reset or user override without Provider ID branches", async () => {
    const updateToolPolicySettings = vi.fn(async () => undefined);
    const snapshot = emptySnapshot();
    const configured = {
      ...snapshot,
      targets: [{
        id: "target-a",
        backendId: "pi",
        name: "Project A",
        workspaceId: "workspace-a",
        workspaceName: "Project A",
        trusted: true,
        pinned: false,
        archived: false
      }],
      settings: {
        ...snapshot.settings,
        toolPolicies: [{
          toolProviderId: "joko-ordinary-tools",
          displayName: "Ordinary tools",
          description: "Provider-owned description.",
          productDefaultEnabled: true,
          userEffectiveEnabled: false,
          userEffectiveSource: "userDefault" as const,
          userOverride: { enabled: false },
          targetSettings: [{
            targetId: "target-a",
            effectiveEnabled: true,
            effectiveSource: "projectOverride" as const,
            projectOverride: { enabled: true }
          }]
        }]
      }
    };
    const work: Promise<void>[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ToolPolicySettings
      controller={{ updateToolPolicySettings } as unknown as AppController}
      snapshot={configured}
      activeTargetId="target-a"
      runAction={(_key, action) => { work.push(action()); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.textContent).toContain("Project override");
    expect(container.textContent).toContain("Changes apply to new tasks");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Ordinary tools"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    const reset = [...container.querySelectorAll("button")].find((button) => button.textContent === "Reset")!;
    await act(async () => reset.click());
    await act(async () => Promise.all(work.splice(0)));
    expect(updateToolPolicySettings).toHaveBeenCalledWith("joko-ordinary-tools", "target-a", { reset: true });

    const scope = container.querySelector<HTMLButtonElement>('button[role="combobox"]')!;
    await act(async () => scope.click());
    const userDefault = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "User default")!;
    await act(async () => userDefault.click());
    expect(container.textContent).toContain("User default");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    await act(async () => Promise.all(work.splice(0)));
    expect(updateToolPolicySettings).toHaveBeenCalledWith("joko-ordinary-tools", undefined, { enabled: true });
  });

  it("provides the new-task policy explanation in Chinese", () => {
    expect(translate("zh-CN", "settings.toolPolicies.newTasksOnly")).toContain("现有任务");
    expect(translate("zh-CN", "settings.toolPolicies.source.project")).toBe("项目覆盖");
  });
});
