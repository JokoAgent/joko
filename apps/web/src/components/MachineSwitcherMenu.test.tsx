// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { translate } from "../i18n.js";
import type { ConnectionProfile, MachineCacheView, MachinePresenceView } from "../model.js";
import { MachineSwitcherMenu, type MachineSwitcherMenuProps } from "./MachineSwitcherMenu.js";

const roots: Root[] = [];
const local = profile("local", "Local", "http://127.0.0.1:4319", true);
const alpha = profile("remote-a", "Alpha", "https://alpha.example.test");
const beta = profile("remote-b", "Beta", "https://beta.example.test");

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("MachineSwitcherMenu", () => {
  it("uses the full machine row for a single-machine switch", async () => {
    const fixture = await renderMenu({ selection: "all" });
    const row = machineRow(fixture.container, "Alpha");

    await act(async () => mainButton(row).click());

    expect(fixture.onSelectionChange).toHaveBeenCalledTimes(1);
    expect(fixture.onSelectionChange).toHaveBeenCalledWith(["remote-a"]);
    expect(fixture.onSwitch).toHaveBeenCalledTimes(1);
    expect(fixture.onSwitch).toHaveBeenCalledWith(alpha);
  });

  it("uses the trailing checkbox to extend a multi-machine scope without switching", async () => {
    const fixture = await renderMenu({ selection: ["local"] });
    const row = machineRow(fixture.container, "Alpha");

    await act(async () => checkButton(row).click());

    expect(fixture.onSelectionChange).toHaveBeenCalledWith(["local", "remote-a"]);
    expect(fixture.onSwitch).not.toHaveBeenCalled();
  });

  it("keeps an access-revoked machine fenced and offers repair without attempting a switch", async () => {
    const fixture = await renderMenu({
      selection: ["local"],
      presenceByProfile: { local: "current", "remote-a": "accessDenied", "remote-b": "online" }
    });
    const row = machineRow(fixture.container, "Alpha");
    const main = mainButton(row);
    const check = checkButton(row);

    expect(main.getAttribute("aria-disabled")).toBeNull();
    expect(row.querySelector('[role="img"][aria-label="Access revoked"]')).not.toBeNull();
    expect(check.disabled).toBe(true);

    await act(async () => check.click());
    expect(fixture.onSelectionChange).not.toHaveBeenCalled();
    await act(async () => main.click());
    expect(fixture.onSwitch).not.toHaveBeenCalled();
    expect(fixture.container.querySelector('[role="alert"]')?.textContent).toContain("Alpha");
    const repair = [...fixture.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Repair connection"));
    expect(repair).toBeDefined();
    await act(async () => repair?.click());
    expect(fixture.onRepair).toHaveBeenCalledWith(alpha);
  });

  it("retains an offline machine when a bounded cached task projection exists", async () => {
    const offlineCache: MachineCacheView = {
      profileId: "remote-a",
      serverId: "server-remote-a",
      name: "Alpha cached",
      origin: alpha.origin,
      updatedAt: Date.now() - 5_000,
      sessions: [{
        id: "cached-task",
        name: "Offline task",
        state: "idle",
        targetName: "Offline workspace",
        pinned: false,
        archived: false,
        lastActivityAt: Date.now() - 10_000
      }]
    };
    const fixture = await renderMenu({
      selection: "all",
      presenceByProfile: { local: "current", "remote-a": "offline", "remote-b": "online" },
      caches: [offlineCache]
    });
    const row = machineRow(fixture.container, "Alpha");

    expect(row.querySelector('[role="img"][aria-label="Offline"]')).not.toBeNull();
  });
});

interface MenuFixture {
  readonly container: HTMLDivElement;
  readonly onSelectionChange: Mock;
  readonly onSwitch: Mock;
  readonly onRepair: Mock;
}

async function renderMenu(overrides: Partial<MachineSwitcherMenuProps> = {}): Promise<MenuFixture> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onSelectionChange = vi.fn();
  const onSwitch = vi.fn();
  const onRepair = vi.fn();
  const props: MachineSwitcherMenuProps = {
    profiles: [local, alpha, beta],
    activeProfile: local,
    presenceByProfile: { local: "current", "remote-a": "online", "remote-b": "online" },
    caches: [],
    selection: "all",
    locale: "en",
    t: (key, values) => translate("en", key, values),
    onSelectionChange,
    onRefresh: vi.fn(),
    onSwitch,
    onRepair,
    ...overrides
  };
  await act(async () => root.render(<MachineSwitcherMenu {...props} />));
  return { container, onSelectionChange, onSwitch, onRepair };
}

function profile(id: string, name: string, origin: string, managedLocal = false): ConnectionProfile {
  return {
    id,
    deviceId: `device-${id}`,
    name,
    origin,
    serverId: `server-${id}`,
    ...(managedLocal ? { managedLocal: true } : {})
  };
}

function machineRow(container: HTMLElement, name: string): HTMLDivElement {
  const row = [...container.querySelectorAll<HTMLDivElement>(".machine-switcher__profile")]
    .find((candidate) => mainButton(candidate).textContent?.includes(name));
  if (row === undefined) throw new Error(`Machine row not found: ${name}`);
  return row;
}

function mainButton(row: Element): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>(".machine-switcher__profile-main");
  if (button === null) throw new Error("Machine main button not found.");
  return button;
}

function checkButton(row: Element): HTMLButtonElement {
  const button = row.querySelector<HTMLButtonElement>(".machine-switcher__profile-check");
  if (button === null) throw new Error("Machine checkbox button not found.");
  return button;
}
