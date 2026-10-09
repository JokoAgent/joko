// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { emptySnapshot, type PartnerListView, type PartnerProfileView, type PartnerSessionView, type SessionView } from "../model.js";
import { PartnerConversationHeader } from "./PartnerConversationHeader.js";
import { PartnerConversationProvider } from "./PartnerConversation.js";

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("canonical Partner conversation header", () => {
  it("opens the same profile settings from name and gear, saves authoritative identity, and preserves the conversation", async () => {
    vi.useFakeTimers();
    const updated = partner({ displayName: "Aster updated", avatar: "spark", revision: 9n, profileVersion: 3n });
    const updatePartner = vi.fn(async () => ({ partner: updated, directory: catalog().directory }));
    const view = await mount(controller({ updatePartner }));
    const message = required(view.host.querySelector<HTMLInputElement>("input[data-composer]"));
    message.value = "Unsent message";
    const name = required(view.host.querySelector<HTMLButtonElement>(".partner-conversation-identity"));
    expect(name.textContent).toBe("Aster");
    expect(view.host.querySelector("[data-task-controls]")).toBeNull();
    await act(async () => { name.focus(); name.click(); });
    const dialog = required(document.querySelector<HTMLElement>("[role='dialog']"));
    expect(dialog.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("partners.profileSettings");
    const input = required(dialog.querySelector<HTMLInputElement>("input[required]"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Aster updated");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      required(dialog.querySelector<HTMLButtonElement>("[aria-label='partners.avatarOption:spark']")).click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(updatePartner).toHaveBeenCalledExactlyOnceWith("partner-one", 8n, expect.objectContaining({ displayName: "Aster updated", avatar: "spark" }));
    expect(name.textContent).toBe("Aster updated");
    expect(name.querySelector(".partner-avatar--spark")).not.toBeNull();
    await act(async () => required(dialog.querySelector<HTMLButtonElement>("[aria-label='common.close']")).click());
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(name);
    const gear = required(view.host.querySelector<HTMLButtonElement>("[aria-label='partners.profileSettings']"));
    await act(async () => { gear.focus(); gear.click(); });
    expect(required(document.querySelector<HTMLInputElement>("[role='dialog'] input[required]")).value).toBe("Aster updated");
    await act(async () => required(document.querySelector<HTMLElement>("[role='dialog']")).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(gear);
    expect(view.host.querySelector("input[data-composer]")).toBe(message);
    expect(message.value).toBe("Unsent message");
  });

  it("keeps ordinary and historical tasks on their normal controls", async () => {
    const listPartnerSessions = vi.fn(async () => [link()]);
    const app = controller({ listPartnerSessions });
    const view = await mount(app, session({ id: "history-one" }));
    expect(view.host.querySelector("[data-task-controls]")).not.toBeNull();
    expect(listPartnerSessions).not.toHaveBeenCalled();
    expect(view.host.querySelector(".partner-conversation-identity")).toBeNull();
    await view.render({ ...app, state: { ...app.state, connectionState: "disconnected" } });
    expect(view.host.querySelector("[data-task-controls]")).not.toBeNull();
  });

  it("preserves settings drafts across a visibility refresh and keeps a newer save over a stale directory reply", async () => {
    vi.useFakeTimers();
    const reload = deferred<PartnerListView>();
    const updatePartner = vi.fn(async () => ({ partner: partner({ displayName: "New profile", revision: 9n }), directory: catalog().directory }));
    const listPartners = vi.fn(async () => catalog()).mockImplementationOnce(async () => catalog()).mockImplementationOnce(() => reload.promise);
    const view = await mount(controller({ listPartners, updatePartner }));
    await act(async () => required(view.host.querySelector<HTMLButtonElement>("[aria-label='partners.profileSettings']")).click());
    const input = required(document.querySelector<HTMLInputElement>("[role='dialog'] input[required]"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "New profile");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(listPartners).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[role='dialog'] input[required]")).toBe(input);
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(updatePartner).toHaveBeenCalledOnce();
    await act(async () => { reload.resolve(catalog()); await settle(); });
    expect(view.host.querySelector(".partner-conversation-identity")?.textContent).toBe("New profile");
    expect(input.value).toBe("New profile");
  });

  it.each(["target", "link"])("requires exact canonical %s ownership and recovers through an explicit retry", async (mismatch) => {
    let bad = true;
    const app = controller({
      listPartners: vi.fn(async () => catalog([partner({ ...(mismatch === "target" && bad ? { homeTargetId: "another-target" } : {}) })])),
      listPartnerSessions: vi.fn(async () => [link({ ...(mismatch === "link" && bad ? { role: "history" } : {}) })])
    });
    const view = await mount(app);
    expect(view.host.querySelector("[data-task-controls]")).toBeNull();
    expect(view.host.querySelector("[role='status']")?.textContent).toBe("partners.reloadFailed");
    bad = false;
    await act(async () => { required(view.host.querySelector<HTMLButtonElement>("[aria-label='common.retry']")).click(); await settle(); });
    expect(view.host.querySelector(".partner-conversation-identity")?.textContent).toBe("Aster");
  });

  it("retires directory and canonical-link replies with their connection and Session owners", async () => {
    const old = deferred<PartnerListView>();
    let oldSignal: AbortSignal | undefined;
    const first = controller({ listPartners: vi.fn((_lifecycle, signal) => { oldSignal = signal; return old.promise; }) }, "old");
    const view = await mount(first);
    expect(view.host.textContent).toContain("partners.loading");
    const pendingLink = deferred<readonly PartnerSessionView[]>();
    const next = controller({ listPartners: vi.fn(async () => catalog([partner({ displayName: "Current owner" })])), listPartnerSessions: vi.fn(() => pendingLink.promise) }, "current");
    await view.render(next);
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { old.resolve(catalog([partner({ displayName: "Old owner" })])); await settle(); });
    expect(view.host.textContent).not.toContain("Old owner");
    await view.render(next, session({ id: "other-task" }));
    await act(async () => { pendingLink.resolve([link()]); await settle(); });
    expect(view.host.querySelector("[data-task-controls]")).not.toBeNull();
    expect(view.host.textContent).not.toContain("Current owner");
  });

  it.each(["disconnect", "pagehide"])("closes settings on %s, ignores the late save, and requires fresh ownership before reopening", async (retirement) => {
    vi.useFakeTimers();
    const pending = deferred<{ readonly partner: PartnerProfileView; readonly directory: PartnerListView["directory"] }>();
    const app = controller({ updatePartner: vi.fn(() => pending.promise) });
    const view = await mount(app);
    await act(async () => required(view.host.querySelector<HTMLButtonElement>("[aria-label='partners.profileSettings']")).click());
    const input = required(document.querySelector<HTMLInputElement>("[role='dialog'] input[required]"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Late save");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    const disconnected = { ...app, state: { ...app.state, connectionState: "disconnected" as const } };
    if (retirement === "disconnect") await view.render(disconnected);
    else await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      pending.resolve({ partner: partner({ displayName: "Late save", revision: 9n }), directory: catalog().directory });
      await settle();
    });
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(required(view.host.querySelector<HTMLButtonElement>("[aria-label='partners.profileSettings']")).disabled).toBe(true);
    await act(async () => { pending.resolve({ partner: partner({ displayName: "Late save", revision: 9n }), directory: catalog().directory }); await settle(); });
    expect(view.host.textContent).not.toContain("Late save");
    if (retirement === "disconnect") await view.render(app);
    else await act(async () => { window.dispatchEvent(new Event("pageshow")); await settle(); });
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(required(view.host.querySelector<HTMLButtonElement>("[aria-label='partners.profileSettings']")).disabled).toBe(false);
  });

  it("keeps a newer authoritative profile when a prior successful save returns late", async () => {
    vi.useFakeTimers();
    const save = deferred<{ readonly partner: PartnerProfileView; readonly directory: PartnerListView["directory"] }>();
    const listPartners = vi.fn(async () => catalog()).mockImplementationOnce(async () => catalog())
      .mockImplementationOnce(async () => catalog([partner({ displayName: "Latest profile", revision: 10n })]));
    const view = await mount(controller({ listPartners, updatePartner: vi.fn(() => save.promise) }));
    await act(async () => required(view.host.querySelector<HTMLButtonElement>("[aria-label='partners.profileSettings']")).click());
    const input = required(document.querySelector<HTMLInputElement>("[role='dialog'] input[required]"));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Earlier save");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); });
    expect(view.host.querySelector(".partner-conversation-identity")?.textContent).toBe("Latest profile");
    await act(async () => { save.resolve({ partner: partner({ displayName: "Earlier save", revision: 9n }), directory: catalog().directory }); await settle(); });
    expect(view.host.querySelector(".partner-conversation-identity")?.textContent).toBe("Latest profile");
  });
});

async function mount(app: AppController, initialSession = session()) {
  const host = document.body.appendChild(document.createElement("main"));
  const root = createRoot(host); roots.push(root);
  const render = async (current: AppController, task = initialSession): Promise<void> => act(async () => {
    root.render(<PartnerConversationProvider controller={current} session={task} active t={translate}><PartnerConversationHeader session={task} navigationOpen onOpenNavigation={() => undefined} t={translate}>
      <header data-task-controls>Rename · Pin · Archive · Export</header>
    </PartnerConversationHeader><input data-composer /></PartnerConversationProvider>);
    await settle();
  });
  await render(app);
  return { host, render };
}

function controller(overrides: Partial<AppController> = {}, ownerId = "owner-one"): AppController {
  const snapshot = emptySnapshot();
  return {
    state: { ready: true, connectionState: "connected", activeProfile: { id: ownerId, serverId: ownerId, origin: "https://node.invalid" }, snapshot },
    listPartners: vi.fn(async () => catalog()), listPartnerSessions: vi.fn(async () => [link()]),
    getPartner: vi.fn(async () => partner()), updatePartner: vi.fn(), navigate: vi.fn(),
    ...overrides
  } as unknown as AppController;
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return { id: "session-one", backendId: "backend-one", targetId: "home-one", name: "Canonical task", state: "idle", pinned: false, archived: false,
    generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1_000, ...overrides };
}

function partner(overrides: Partial<PartnerProfileView> = {}): PartnerProfileView {
  return { id: "partner-one", revision: 8n, profileVersion: 2n, displayName: "Aster", avatar: "orbit", identitySource: "You are Aster.", templateId: "general",
    lifecycle: "active", initializationState: "ready", invitationStage: "ready", homeTargetId: "home-one", canonicalSessionId: "session-one",
    capabilities: { modelChain: [{ backendId: "backend-one", providerId: "provider-one", modelId: "model-one", fastMode: false }], permissionMode: "ask", planMode: false },
    usesDirectoryDefaults: true, createdAt: 1_000, updatedAt: 2_000,
    activity: { partnerId: "partner-one", unreadReplyCount: 0, artifactCount: 0, activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 0 }, ...overrides };
}

function catalog(partners = [partner()]): PartnerListView {
  return { partners, directory: { revision: 4n, activeCount: 1, archivedCount: 0, errorCount: 0, updatedAt: 2_000,
    templates: [{ id: "general", displayName: "General", description: "General work", identitySource: "You are a partner." }], avatarPresets: ["orbit", "spark"], defaultCapabilities: partner().capabilities } };
}

function link(overrides: Partial<PartnerSessionView> = {}): PartnerSessionView {
  return { sessionId: "session-one", partnerId: "partner-one", role: "canonical", profileVersion: 1n, displayName: "Canonical", available: true, readOnly: false,
    archived: false, deleted: false, createdAt: 1_000, ...overrides };
}

function translate(key: string, values?: Readonly<Record<string, string | number>>): string {
  return values?.name === undefined ? key : `${key}:${values.name}`;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected conversation element.");
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function settle(): Promise<void> { for (let index = 0; index < 5; index += 1) await Promise.resolve(); }
