// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type PartnerActivityView, type PartnerPrivateThreadView, type PartnerProfileView, type SessionView, type TimelineItemView } from "../model.js";
import { PartnerConversationProvider } from "./PartnerConversation.js";
import { Timeline } from "./Timeline.js";

vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: getItemKey?.(index) ?? index, start: index * 80, size: 80, end: (index + 1) * 80 })),
    getTotalSize: () => count * 80, measureElement: () => undefined, measurementsCache: [],
    getOffsetForIndex: () => [0], scrollToOffset: () => undefined
  })
}));

const roots: Root[] = [];
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
let focused = true;
let foreground = true;
let replyVisible = true;
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  frames = new Map(); focused = foreground = replyVisible = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => foreground ? "visible" : "hidden");
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = !replyVisible && this.dataset.timelineItemId === "answer" ? 1_000 : 0;
    return { top, bottom: top + 600, height: 600, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) };
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement) { this.scrollTop = 0; } });
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); document.body.className = "";
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalScrollTo === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  else Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
});

describe("mounted Partner conversation", () => {
  it("renders the canonical avatar, frozen unread boundary and Reply while retaining ordinary message actions", async () => {
    const view = await mount();
    expect(view.host.querySelector(".partner-message-avatar .partner-avatar--orbit")).not.toBeNull();
    expect(view.host.querySelector(".partner-time-group")).not.toBeNull();
    expect(view.host.querySelector(".partner-unread-divider")?.textContent).toBe("partners.unreadDivider");
    expect(view.host.querySelector("[aria-label='timeline.forkFromHere']")).toBeNull();
    expect(view.host.querySelector(".message-usage")).toBeNull();
    expect(view.host.querySelector("[aria-label='timeline.copy']")).not.toBeNull();
    await act(async () => view.host.querySelector<HTMLButtonElement>(".message-assistant [aria-label='timeline.reply']")!.click());
    expect(view.reply).toHaveBeenCalledWith(expect.objectContaining({ id: "answer", text: "A useful answer." }));
    await flushFrames();
    expect(view.app.markPartnerRead).toHaveBeenCalledExactlyOnceWith("partner", 91n, expect.any(AbortSignal));
    expect(view.host.querySelector(".partner-unread-divider")).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus"))); await flushFrames();
    expect(view.app.markPartnerRead).toHaveBeenCalledOnce();
  });

  it.each(["focus", "foreground", "viewport", "streaming", "selection"])("does not read a reply outside its %s owner", async (condition) => {
    focused = condition !== "focus"; foreground = condition !== "foreground"; replyVisible = condition !== "viewport";
    const view = await mount(undefined, condition !== "selection", condition === "streaming");
    await flushFrames();
    expect(view.app.markPartnerRead).not.toHaveBeenCalled();
    if (["focus", "foreground", "viewport"].includes(condition)) {
      focused = foreground = replyVisible = true;
      await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flushFrames();
      expect(view.app.markPartnerRead).toHaveBeenCalledOnce();
    }
  });

  it("retires a delayed read revalidation on pagehide and preserves the reply for later viewing", async () => {
    const pending = deferred<PartnerProfileView>();
    const app = controller({ getPartner: vi.fn(() => pending.promise) });
    await mount(app); await flushFrames();
    expect(app.getPartner).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await act(async () => { pending.resolve(partner()); await settle(); });
    expect(app.markPartnerRead).not.toHaveBeenCalled();
  });

  it("revalidates the exact canonical link before acknowledging the visible tail", async () => {
    const app = controller({ listPartnerSessions: vi.fn(async () => [{ partnerId: "partner", sessionId: "session", role: "canonical", available: false, deleted: true, profileVersion: 1n }])
      .mockResolvedValueOnce([{ partnerId: "partner", sessionId: "session", role: "canonical", available: true, deleted: false, profileVersion: 1n }]) } as unknown as Partial<AppController>);
    const view = await mount(app); await flushFrames();
    expect(app.markPartnerRead).not.toHaveBeenCalled();
    expect(view.host.querySelector(".partner-read-error")).not.toBeNull();
  });

  it("serializes monotonic reads while a newer visible reply arrives", async () => {
    const first = deferred<PartnerActivityView>();
    const app = controller({ markPartnerRead: vi.fn(async () => ({ ...partner().activity, readThroughCursor: 100n })).mockImplementationOnce(() => first.promise) });
    const view = await mount(app); await flushFrames();
    expect(app.markPartnerRead).toHaveBeenCalledOnce();
    await view.render([message("prompt", "user", { text: "Question", inputDelivery: "prompt" }),
      message("answer", "assistant", { text: "Answer", completionCursor: 91n }), message("new-answer", "assistant", { text: "More answer", completionCursor: 100n }),
      message("seal", "status", { runTerminal: "completed" })]);
    await flushFrames();
    expect(app.markPartnerRead).toHaveBeenCalledOnce();
    await act(async () => { first.resolve({ ...partner().activity, readThroughCursor: 91n }); await settle(); }); await flushFrames();
    expect(app.markPartnerRead).toHaveBeenCalledTimes(2);
    expect(app.markPartnerRead).toHaveBeenLastCalledWith("partner", 100n, expect.any(AbortSignal));
    await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flushFrames();
    expect(app.markPartnerRead).toHaveBeenCalledTimes(2);
  });

  it("shows a failed read and retries only after a fresh visible tail check", async () => {
    const app = controller({ markPartnerRead: vi.fn(async () => ({ ...partner().activity, readThroughCursor: 91n })).mockRejectedValueOnce(new Error("offline")) });
    const view = await mount(app); await flushFrames();
    expect(view.host.querySelector(".partner-read-error")?.textContent).toContain("partners.markReadFailed");
    replyVisible = false;
    await act(async () => view.host.querySelector<HTMLButtonElement>(".partner-read-error button")!.click()); await flushFrames();
    expect(app.markPartnerRead).toHaveBeenCalledOnce();
    replyVisible = true;
    await act(async () => window.dispatchEvent(new Event("focus"))); await flushFrames();
    expect(app.markPartnerRead).toHaveBeenCalledTimes(2);
    expect(view.host.querySelector(".partner-read-error")).toBeNull();
  });

  it("excludes typed private replies from read-through and hides the internal incoming prompt", async () => {
    const origin = { messageId: "private", threadId: "thread", senderPartnerId: "sender", recipientPartnerId: "partner", senderDisplayName: "Sender" };
    const view = await mount(undefined, true, false, [message("incoming", "user", { partnerPrivateOrigin: origin, text: "Internal service instruction" }),
      message("answer", "assistant", { partnerPrivateOrigin: origin, text: "Private useful answer", completionCursor: 91n }), message("seal", "status", { runTerminal: "completed" })]);
    await flushFrames();
    expect(view.host.textContent).not.toContain("Internal service instruction");
    expect(view.host.querySelector(".partner-private-receipt")?.textContent).toBe("partners.privateMessageFrom");
    expect(view.host.querySelector(".partner-private-reply")?.textContent).toBe("partners.privateReply");
    expect(view.host.querySelector(".partner-unread-divider")).toBeNull();
    expect(view.app.markPartnerRead).not.toHaveBeenCalled();
  });

  it.each([false, true])("opens the exact receipt thread without substituting another conversation (missing: %s)", async (missing) => {
    const thread: PartnerPrivateThreadView = { id: "receipt-thread", firstPartnerId: "sender", secondPartnerId: "partner", status: "active",
      messageCount: 0, maxMessages: 12, expiresAt: 60_000, createdAt: 1_000, updatedAt: 1_000 };
    const getThread = vi.fn(async () => {
      if (missing) throw new Error("Receipt thread is unavailable.");
      return { thread, messages: [] };
    });
    const app = controller({ getPartnerPrivateThread: getThread,
      listPartnerPrivateThreads: vi.fn(async () => missing ? [] : [{ ...thread, id: "unrelated-thread" }, thread]),
      listPartnerDelegations: vi.fn(async () => []), listSessionArtifacts: vi.fn(async () => []) });
    const origin = { messageId: "private", threadId: thread.id, senderPartnerId: "sender", recipientPartnerId: "partner", senderDisplayName: "Sender" };
    const view = await mount(app, true, false, [message("incoming", "user", { partnerPrivateOrigin: origin, text: "Internal service instruction" })]);
    await act(async () => { view.host.querySelector<HTMLButtonElement>(".partner-private-receipt button")!.click(); await settle(); });
    expect(getThread).toHaveBeenCalledExactlyOnceWith("partner", thread.id, expect.any(AbortSignal));
    const dialog = document.body.querySelector<HTMLElement>("[role='dialog']")!;
    if (missing) expect(dialog.querySelector(".partner-private-thread [role='alert']")?.textContent).toContain("Receipt thread is unavailable.");
    else expect(dialog.querySelectorAll(".partner-private-list button")[1]?.classList.contains("is-selected")).toBe(true);
    expect(view.app.markPartnerRead).not.toHaveBeenCalled();
  });
});

async function mount(app = controller(), active = true, streaming = false, items: readonly TimelineItemView[] = [
  message("prompt", "user", { text: "A question", inputDelivery: "prompt" }),
  message("answer", "assistant", { text: "A useful answer.", completionCursor: 91n }), message("seal", "status", { runTerminal: "completed" })
]) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const reply = vi.fn();
  const session: SessionView = { id: "session", targetId: "home", backendId: "backend", name: "Task", state: streaming ? "running" : "idle", generation: 1n,
    pinned: false, archived: false, fastMode: false, planMode: false, permissionMode: "ask", updatedAt: 1 };
  const ownerKey = `mounted-partner-${frameId}`;
  const render = async (currentItems: readonly TimelineItemView[] = items) => act(async () => {
    root.render(<PartnerConversationProvider controller={app} session={session} active={active} t={(key) => key}><Timeline
      ownerKey={ownerKey} viewportOwnerKey={ownerKey} sessionId={session.id} sessionName={session.name}
      sessionActive={streaming} items={currentItems} hasEarlier={false} historyLoading={false} locale="en" streamFadeEnabled={false} messageNavRailEnabled={false}
      t={(key) => key} onLoadEarlier={async () => undefined} onArtifactUrl={async () => ""} onArtifactUrlRelease={vi.fn()} onArtifactDownload={vi.fn()}
      onAddMessageToComposer={reply} onForkMessage={vi.fn()} />
    </PartnerConversationProvider>); await settle();
  });
  await render();
  return { host, app, reply, render };
}
function controller(overrides: Partial<AppController> = {}): AppController {
  return { state: { ready: true, connectionState: "connected", activeProfile: { id: "profile", serverId: "node", origin: "https://node.invalid" }, snapshot: emptySnapshot() },
    listPartners: vi.fn(async () => ({ partners: [partner()], directory: { revision: 1n, activeCount: 1, archivedCount: 0, errorCount: 0, updatedAt: 1, templates: [], avatarPresets: ["orbit"] } })),
    listPartnerSessions: vi.fn(async () => [{ partnerId: "partner", sessionId: "session", role: "canonical", available: true, deleted: false, profileVersion: 1n }]),
    getPartner: vi.fn(async () => partner()), markPartnerRead: vi.fn(async () => ({ ...partner().activity, readThroughCursor: 91n })), ...overrides
  } as unknown as AppController;
}
function partner(): PartnerProfileView {
  return { id: "partner", canonicalSessionId: "session", homeTargetId: "home", displayName: "Aster", avatar: "orbit", revision: 1n, profileVersion: 1n,
    lifecycle: "active", initializationState: "ready", invitationStage: "ready", identitySource: "Aster", templateId: "general", usesDirectoryDefaults: true,
    capabilities: { modelChain: [], permissionMode: "ask", planMode: false }, createdAt: 1, updatedAt: 1,
    activity: { partnerId: "partner", readThroughCursor: 10n, readUpdatedAt: 1, unreadReplyCount: 1, artifactCount: 0, activeDelegationCount: 0 } };
}
function message(id: string, kind: TimelineItemView["kind"], extra: Partial<TimelineItemView> = {}): TimelineItemView {
  return { id, kind, createdAt: 1_000, sequence: 2n, sourceEventId: `event-${id}`, runId: "run", streaming: false, ...extra };
}
async function settle() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }
async function flushFrames() {
  for (let pass = 0; pass < 5; pass += 1) await act(async () => { const batch = [...frames]; frames.clear(); batch.forEach(([, callback]) => callback(0)); await settle(); });
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done; }), resolve }; }
