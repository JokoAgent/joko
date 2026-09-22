// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController, ToolsTab } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { ToolsPage } from "./ToolsPage.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);

beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Tools route tabs", () => {
  it("opens the actual Skills panel and follows manual selection, history, and extension deep links", async () => {
    const controller = {
      state: { preferences: { navigationOpen: true } },
      listSkills: vi.fn(async () => ({ revision: 1n, skills: [] })),
      listSkillRecoveries: vi.fn(async () => []),
      listExtensions: vi.fn(async () => ({ revision: 0n, extensions: [], recoveredFromCorruption: false })),
      getExtension: vi.fn(async () => ({ revision: 0n, extensions: [], recoveredFromCorruption: false }))
    } as unknown as AppController;
    const onSelectTab = vi.fn<(tab: ToolsTab) => void>();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container); roots.push(root);
    const render = async (selectedTab?: ToolsTab, selectedExtensionId?: string): Promise<void> => {
      await act(async () => root.render(<ToolsPage
        controller={controller}
        snapshot={emptySnapshot()}
        selectedTab={selectedTab}
        selectedExtensionId={selectedExtensionId}
        locale="en"
        t={t}
        runAction={(_key, action) => { void action(); }}
        onSelectTab={onSelectTab}
        onOpenNavigation={() => undefined}
      />));
    };

    await render("skills");
    expect(container.querySelector("#tools-tab-skills")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".skill-hub")).not.toBeNull();
    await render("resources");
    expect(container.querySelector("#tools-tab-resources")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".skill-hub")).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>("#tools-tab-skills")?.click());
    expect(onSelectTab).toHaveBeenCalledWith("skills");
    await render("skills");
    expect(container.querySelector(".skill-hub")).not.toBeNull();
    await render("skills", "extension_0123456789abcdef0123456789abcdef");
    expect(container.querySelector("#tools-tab-extensions")?.getAttribute("aria-selected")).toBe("true");
    await render("skills");
    expect(container.querySelector("#tools-tab-skills")?.getAttribute("aria-selected")).toBe("true");
  });
});
