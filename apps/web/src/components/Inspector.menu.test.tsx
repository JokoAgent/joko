// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type BrowserView, type SessionView } from "../model.js";
import { Inspector } from "./Inspector.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--inspector-width");
});

describe("Inspector menus", () => {
  it("focuses menu items, supports arrow navigation, and restores focus on Escape", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const base = emptySnapshot();
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES },
      releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    await act(async () => root.render(<Inspector
      controller={controller}
      snapshot={{ ...base, browsers: [browser()] }}
      session={session()}
      timeline={[]}
      open
      t={t}
      runAction={(_key, action) => { void action(); }}
      onClose={vi.fn()}
      onSelectionQuote={vi.fn()}
    />));

    const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`);
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    await settle();

    const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    expect(items.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[1]);

    await act(async () => items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers the runtime shell only while the owning Backend advertises it", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const base = emptySnapshot();
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES },
      releaseArtifactUrl: vi.fn(),
      executeUserShell: vi.fn(),
      abortUserShell: vi.fn()
    } as unknown as AppController;
    const render = async (supported: boolean): Promise<void> => act(async () => root.render(<Inspector
      controller={controller}
      snapshot={{ ...base, backends: [backend(supported)] }}
      session={session()}
      timeline={[]}
      open
      t={t}
      runAction={(_key, action) => { void action(); }}
      onClose={vi.fn()}
      onSelectionQuote={vi.fn()}
    />));

    await render(true);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)?.click());
    const shellItem = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((candidate) => candidate.textContent?.includes(t("composer.shell")));
    expect(shellItem).not.toBeUndefined();
    await act(async () => shellItem?.click());
    expect(host.querySelector(".inspector-shell-panel textarea")).not.toBeNull();

    await render(false);
    expect(host.querySelector(".inspector-shell-panel textarea")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)?.click());
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .some((candidate) => candidate.textContent?.includes(t("composer.shell")))).toBe(false);
  });
});

function session(): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

function browser(): BrowserView {
  return {
    id: "browser-one",
    name: "Browser",
    state: "ready",
    generation: 1n,
    pages: []
  };
}

function backend(shellSupported: boolean): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["runtime.user_shell", { name: "runtime.user_shell", supported: shellSupported, options: [] }]
    ])
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}
