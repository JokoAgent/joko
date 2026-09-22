// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "./controller.js";
import { ContactsSettings } from "./components/ContactsSettings.js";
import { translate } from "./i18n.js";
import type { ContactDirectoryView, ContactSyncStatusView } from "./model.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Contacts device sync settings", () => {
  it("renders trusted and nearby devices and wires every explicit sync action", async () => {
    const status = contactSyncStatus();
    const controller = contactController(status);
    const { container } = await render(
      <ContactsSettings controller={controller as unknown as AppController} locale="en" t={(key, values) => translate("en", key, values)} />
    );

    expect(container.textContent).toContain("Device sync");
    expect(container.textContent).toContain("Up to date");
    expect(container.textContent).toContain("Trusted Joko");
    expect(container.textContent).toContain("Nearby Joko");
    expect(container.textContent).toContain("AAAA AAAA");

    const sync = button(container, "Sync now");
    await act(async () => { sync.click(); });
    expect(controller.syncContactsNow).toHaveBeenCalledWith();

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable Contacts device sync"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    await act(async () => { toggle?.click(); });
    expect(controller.setContactSyncEnabled).toHaveBeenCalledWith(9n, false);

    await act(async () => { button(container, "Trust device").click(); });
    let dialog = alertDialog();
    expect(dialog.textContent).toContain("CCCC CCCC");
    await act(async () => { button(dialog, "Trust device").click(); });
    expect(controller.grantContactSyncPeer).toHaveBeenCalledWith("node-new", "c".repeat(64));

    await act(async () => { button(container, "Revoke").click(); });
    dialog = alertDialog();
    expect(dialog.textContent).toContain("Trusted Joko");
    await act(async () => { button(dialog, "Revoke").click(); });
    expect(controller.revokeContactSyncPeer).toHaveBeenCalledWith("node-peer", 3n);
  });

  it("keeps key changes untrusted and exposes a localized unavailable state", async () => {
    const status: ContactSyncStatusView = {
      ...contactSyncStatus(),
      available: false,
      phase: "error",
      errorCode: "identityUnavailable",
      candidates: [{
        nodeId: "node-new",
        displayName: "Changed Joko",
        fingerprint: "d".repeat(64),
        seenAt: 5_000,
        granted: true,
        keyChanged: true
      }]
    };
    const controller = contactController(status);
    const { container } = await render(
      <ContactsSettings controller={controller as unknown as AppController} locale="en" t={(key, values) => translate("en", key, values)} />
    );

    expect(container.textContent).toContain("The protected device identity could not be opened. Sync remains stopped.");
    expect(container.textContent).toContain("The advertised key differs from the trusted key. Revoke the old grant before reviewing a replacement.");
    expect(button(container, "Trust device").disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable Contacts device sync"]')?.disabled).toBe(true);
  });

  it("keeps manual retry available after a transport failure with no reachable peer", async () => {
    const status: ContactSyncStatusView = {
      ...contactSyncStatus(),
      phase: "error",
      errorCode: "syncFailed",
      onlinePeerCount: 0,
      peers: contactSyncStatus().peers.map((peer) => ({ ...peer, online: false }))
    };
    const controller = contactController(status);
    const { container } = await render(
      <ContactsSettings controller={controller as unknown as AppController} locale="en" t={(key, values) => translate("en", key, values)} />
    );

    const retry = button(container, "Retry");
    expect(retry.disabled).toBe(false);
    await act(async () => { retry.click(); });
    expect(controller.syncContactsNow).toHaveBeenCalledWith();
  });
});

function contactController(status: ContactSyncStatusView) {
  const directory: ContactDirectoryView = {
    format: 1,
    revision: 7n,
    enabled: true,
    people: 0,
    organizations: 0,
    pending: 0,
    groups: 0
  };
  return {
    state: { activeProfile: { id: "profile" } },
    getContactDirectory: vi.fn(async () => directory),
    listContactGroups: vi.fn(async () => []),
    listContacts: vi.fn(async () => ({ contacts: [], total: 0 })),
    getContactSyncStatus: vi.fn(async () => status),
    setContactSyncEnabled: vi.fn(async () => status),
    grantContactSyncPeer: vi.fn(async () => status),
    revokeContactSyncPeer: vi.fn(async () => status),
    syncContactsNow: vi.fn(async () => status)
  };
}

function contactSyncStatus(): ContactSyncStatusView {
  return {
    available: true,
    configurationRevision: 9n,
    nodeId: "node-local",
    fingerprint: "a".repeat(64),
    enabled: true,
    phase: "upToDate",
    onlinePeerCount: 1,
    lastSyncAt: 4_000,
    lastSyncPeerId: "node-peer",
    lastSyncPeerName: "Trusted Joko",
    lastRoute: "lan",
    peers: [{
      peerId: "node-peer",
      revision: 3n,
      displayName: "Trusted Joko",
      fingerprint: "b".repeat(64),
      online: true,
      state: "active",
      grantedAt: 2_000,
      lastSyncAt: 4_000,
      lastRoute: "lan"
    }],
    candidates: [{
      nodeId: "node-new",
      displayName: "Nearby Joko",
      fingerprint: "c".repeat(64),
      seenAt: 5_000,
      granted: false,
      keyChanged: false
    }]
  };
}

async function render(element: JSX.Element): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  return { container, root };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label);
  if (match === undefined) throw new Error(`missing ${label} button`);
  return match;
}

function alertDialog(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error("missing confirmation dialog");
  return dialog;
}
