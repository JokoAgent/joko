// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "./controller.js";
import { ContactsSettings } from "./components/ContactsSettings.js";
import { translate } from "./i18n.js";
import type {
  ContactDirectoryView, ContactListOptionsView, ContactProfileView, ContactSyncStatusView, ContactVCardImportPreviewView
} from "./model.js";

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
  it("opens macOS Contacts only by request, cancels its read, and commits the reviewed native preview", async () => {
    const base = contactController(contactSyncStatus());
    const preview: ContactVCardImportPreviewView = {
      previewId: "native-preview", directoryRevision: 7n, expiresAt: 50_000,
      entries: [{ entryId: "card-one", disposition: "create",
        contact: { kind: "person", displayName: "Ada Lovelace", source: "import", status: "confirmed",
          aliases: [], summary: "", narrative: "", agentNotes: "", identities: [] },
        candidates: [], similarEntryIds: [], groups: [], organizationCandidates: [] }]
    };
    const controller = {
      ...base,
      getContactDirectory: async () => ({ ...await base.getContactDirectory(), systemImportAvailable: true }),
      previewSystemContactImport: vi.fn<AppController["previewSystemContactImport"]>()
        .mockImplementationOnce(signal => new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        }))
        .mockResolvedValueOnce(preview),
      commitSystemContactImport: vi.fn(async () => ({ created: 1, enriched: 0, skipped: 0,
        contactIds: [], entries: [], directory: await base.getContactDirectory() })),
      commitContactVCardImport: vi.fn()
    };
    const { container } = await render(
      <ContactsSettings controller={controller as unknown as AppController} locale="en" t={(key, values) => translate("en", key, values)} />
    );
    const open = button(container, "Import from macOS Contacts");
    expect(controller.previewSystemContactImport).not.toHaveBeenCalled();
    await act(async () => { open.click(); });
    const first = controller.previewSystemContactImport.mock.calls[0]?.[0];
    const pending = document.querySelector('[role="dialog"]')!;
    expect(pending.textContent).toContain("Reading your contacts");
    await act(async () => { button(pending, "Cancel").click(); });
    expect(first?.aborted).toBe(true);
    expect(controller.commitSystemContactImport).not.toHaveBeenCalled();

    await act(async () => { open.click(); });
    const review = document.querySelector('[role="dialog"]')!;
    expect(review.textContent).toContain("Review macOS Contacts import");
    expect(review.textContent).toContain("Ada Lovelace");
    await act(async () => { button(review, "Import contacts").click(); });
    expect(controller.commitSystemContactImport).toHaveBeenCalledWith("native-preview", 7n, [
      expect.objectContaining({ entryId: "card-one", decision: "create" })
    ], expect.any(AbortSignal));
    expect(controller.commitContactVCardImport).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("macOS Contacts import complete");
  });

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

  it("reloads the selected profile and retains loaded pages after manual sync", async () => {
    const status = contactSyncStatus();
    const base = contactController(status);
    const profiles: ContactProfileView[] = ["First", "Second"].map(displayName => ({
      id: displayName, displayName, revision: 7n, kind: "person", status: "confirmed", source: "manual",
      aliases: [], summary: "Before sync", identityCount: 0, createdAt: 1, updatedAt: 1,
      narrative: "", agentNotes: "", identities: [], events: [], groups: [], relations: []
    }));
    const controller = {
      ...base,
      getContactDirectory: async () => ({ ...await base.getContactDirectory(), revision: profiles[1]!.revision }),
      listContacts: async ({ pageOffset }: ContactListOptionsView) => pageOffset === 1
        ? { contacts: [profiles[1]!], total: 2 } : { contacts: [profiles[0]!], total: 2, nextPageOffset: 1 },
      getContact: async (id: string) => profiles.find(profile => profile.id === id)!,
      syncContactsNow: async () => {
        profiles[1] = { ...profiles[1]!, summary: "After sync", revision: 8n };
        return status;
      }
    };
    const { container } = await render(
      <ContactsSettings controller={controller as unknown as AppController} locale="en" t={(key, values) => translate("en", key, values)} />
    );
    await act(async () => { button(container, "Load more").click(); });
    const second = container.querySelectorAll<HTMLButtonElement>(".contacts-list__item")[1]!;
    await act(async () => { second.click(); });
    expect(container.querySelector(".contact-detail__header h3")?.textContent).toBe("Second");
    expect(container.querySelector(".contact-detail__header p")?.textContent).toBe("Before sync");

    await act(async () => { button(container, "Sync now").click(); });
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(second.textContent).toContain("After sync");
    expect(container.querySelector(".contact-detail__header p")?.textContent).toBe("After sync");
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
