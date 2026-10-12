// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionWorkingStatus } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot, type Locale, type PartnerProfileView, type SessionView } from "../model.js";
import { PartnerConversationProvider } from "./PartnerConversation.js";
import { PartnerWorkingStatus } from "./PartnerWorkingStatus.js";
import { PartnerWorkingStatusText } from "./PartnerWorkingStatusText.js";

const roots: Root[] = [];
let reduced = false;
let preferenceChange: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  reduced = false; preferenceChange = undefined;
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; }, addEventListener: (_: string, listener: () => void) => { preferenceChange = listener; }, removeEventListener: vi.fn() }));
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Partner current working display", () => {
  it("uses current Host facts while history is elsewhere and immediately retires an old Attempt or terminal turn", async () => {
    const pending = deferred<string | undefined>();
    const read = vi.fn(() => pending.promise);
    const app = controller({ readPartnerWorkingStatus: read });
    const view = await mount(app);
    expect(view.host.textContent).toContain("Reading files…");
    expect(view.host.querySelector(".partner-working-status .partner-avatar--orbit")).not.toBeNull();
    expect(read).toHaveBeenCalledExactlyOnceWith("partner", facts(), "en", expect.any(AbortSignal));
    await act(async () => { pending.resolve("Considering file structure"); await settle(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.host.textContent).toContain("Considering file structure");
    expect(view.host.querySelector(".partner-working-label")?.getAttribute("data-working-copy-source")).toBe("generated");
    const next = session({ activeAttemptId: "attempt-next" });
    await view.render(withSession(app, next), next);
    expect(view.host.textContent).toContain("Working…");
    expect(view.host.textContent).not.toContain("Considering");
    expect(read).toHaveBeenCalledOnce();
    const idle = session({ state: "idle", activeRunId: undefined, activeAttemptId: undefined });
    await view.render(withSession(app, idle), idle);
    expect(view.host.querySelector(".partner-working-status")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a previous language or document owner and keeps the factual fallback after failed copy", async () => {
    const english = deferred<string | undefined>();
    const chinese = deferred<string | undefined>();
    const read = vi.fn((_id: string, _status: SessionWorkingStatus, locale: "en" | "zh-CN", _signal: AbortSignal) => locale === "en" ? english.promise : chinese.promise);
    const app = controller({ readPartnerWorkingStatus: read });
    const view = await mount(app);
    const englishSignal = read.mock.calls[0]?.[3] as AbortSignal | undefined;
    const zh = { ...app, state: { ...app.state, effectiveLocale: "zh-CN" as const } };
    await view.render(zh);
    expect(englishSignal?.aborted).toBe(true);
    await act(async () => { english.resolve("Considering old files"); chinese.reject(new Error("unavailable")); await settle(); await vi.advanceTimersByTimeAsync(1000); });
    expect(view.host.textContent).toContain("正在读取文件…");
    expect(view.host.textContent).not.toContain("old files");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(view.host.querySelector(".partner-working-status")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const offline = { ...zh, state: { ...zh.state, connectionState: "disconnected" as const } };
    await view.render(offline);
    expect(view.host.querySelector(".partner-working-status")).toBeNull();
  });

  it("shows a generic background label and typed waiting without requesting subject copy", async () => {
    const read = vi.fn(async () => "Unexpected"); const getPartner = vi.fn(async () => partner());
    const idle = session({ state: "idle", activeRunId: undefined, activeAttemptId: undefined });
    const app = withSession(controller({ readPartnerWorkingStatus: read, getPartner }), idle);
    const view = await mount(app, idle, ["background"]);
    expect(view.host.textContent).toContain("Working…");
    expect(read).not.toHaveBeenCalled(); expect(getPartner).not.toHaveBeenCalled();
    const waiting = session({ state: "waiting" });
    await view.render(withSession(app, waiting), waiting, [], true);
    expect(view.host.textContent).toBe(translate("en", "session.waiting"));
    expect(read).not.toHaveBeenCalled();
    await view.render(withSession(app, waiting), waiting, [], true, true);
    expect(view.host.querySelector(".partner-working-status")).toBeNull();
  });

  it("retires a Host-confirmed terminal status even before the live Snapshot catches up", async () => {
    const done = partner(); const { workingStatus: _working, ...activity } = done.activity;
    const getPartner = vi.fn().mockResolvedValueOnce(partner()).mockResolvedValue({ ...done, activity });
    const app = controller({ getPartner }); const view = await mount(app);
    expect(view.host.querySelector(".partner-working-status")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.host.querySelector(".partner-working-status")).toBeNull();
    expect(app.state.snapshot.sessions[0]?.state).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Partner working caption cadence", () => {
  it("keeps the minimum interval, adopts the latest text during a fade, and cancels on unmount", async () => {
    const view = await mountText("First");
    view.host.querySelector<HTMLElement>("span")!.style.setProperty("--partner-working-fade", "150ms");
    await view.render("Second");
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(view.host.textContent).toBe("First");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(view.host.querySelector<HTMLElement>("span")!.style.opacity).toBe("0");
    await view.render("Latest");
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(view.host.textContent).toBe("Latest");
    await view.render("Pending");
    await act(async () => view.root.unmount()); roots.splice(roots.indexOf(view.root), 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("commits the latest caption when live reduced motion interrupts a fade and remains static when preference is unknown", async () => {
    const view = await mountText("First");
    view.host.querySelector<HTMLElement>("span")!.style.setProperty("--partner-working-fade", "150ms");
    await view.render("Second");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.host.querySelector<HTMLElement>("span")!.style.opacity).toBe("0");
    reduced = true; await act(async () => preferenceChange?.());
    expect(view.host.textContent).toBe("Second"); expect(view.host.querySelector<HTMLElement>("span")!.style.opacity).toBe("1");
    vi.stubGlobal("matchMedia", undefined);
    const unknown = await mountText("Unknown");
    unknown.host.querySelector<HTMLElement>("span")!.style.setProperty("--partner-working-fade", "150ms");
    await unknown.render("Static"); await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(unknown.host.textContent).toBe("Static"); expect(unknown.host.querySelector<HTMLElement>("span")!.style.opacity).toBe("1");
  });
});

async function mount(app: AppController, initialSession = session(), background: readonly string[] = []) {
  const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root);
  const render = async (current: AppController, task = initialSession, tasks: readonly string[] = background, waiting = false, suppressed = false): Promise<void> => act(async () => {
    const t = (key: Parameters<typeof translate>[1]) => translate(current.state.effectiveLocale ?? "en", key);
    root.render(<PartnerConversationProvider controller={current} session={task} active t={t}>
      <PartnerWorkingStatus controller={current} session={task} backgroundTaskIds={tasks} waiting={waiting} suppressed={suppressed} t={t} />
    </PartnerConversationProvider>); await settle();
  });
  await render(app); return { host, render, root };
}
async function mountText(text: string) {
  const host = document.body.appendChild(document.createElement("div")); const root = createRoot(host); roots.push(root);
  const render = (value: string): Promise<void> => act(async () => { root.render(<PartnerWorkingStatusText text={value} />); });
  await render(text); return { host, render, root };
}
function controller(overrides: Partial<AppController> = {}): AppController {
  return { state: { ready: true, connectionState: "connected", connectionGeneration: 1, effectiveLocale: "en" as Locale,
    activeProfile: { id: "owner", serverId: "node", deviceId: "device", origin: "https://node.invalid" }, snapshot: snapshot(session()) },
    listPartners: vi.fn(async () => ({ directory: { revision: 1n }, partners: [partner()] })),
    listPartnerSessions: vi.fn(async () => [{ partnerId: "partner", sessionId: "session", role: "canonical", available: true, deleted: false, profileVersion: 1n }]),
    getPartner: vi.fn(async () => partner()), readPartnerWorkingStatus: vi.fn(async () => undefined), ...overrides } as unknown as AppController;
}
function withSession(app: AppController, task: SessionView): AppController { return { ...app, state: { ...app.state, snapshot: snapshot(task) } }; }
function snapshot(task: SessionView): AppSnapshot {
  return { ...emptySnapshot(), generation: 1n, sessions: [task], targets: [{ id: "home", backendId: "backend", name: "Home", revision: 1n,
    workspaceId: "home", workspaceName: "Home", trusted: true, pinned: false, archived: false }],
    backends: [{ id: "backend", name: "Backend", health: "healthy", version: "1", capabilities: new Map() }] };
}
function session(overrides: Partial<SessionView> = {}): SessionView {
  return { id: "session", targetId: "home", backendId: "backend", generation: 3n, state: "running", activeRunId: "run", activeAttemptId: "attempt",
    name: "Current", pinned: false, archived: false, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 0, ...overrides };
}
function facts(): SessionWorkingStatus { return { sessionId: "session", targetId: "home", backendId: "backend", generation: 3n,
  runId: "run", attemptId: "attempt", phase: "reading-file" }; }
function partner(): PartnerProfileView {
  return { id: "partner", revision: 1n, profileVersion: 1n, displayName: "Aster", description: "", avatar: "orbit", identitySource: "Work", templateId: "general",
    lifecycle: "active", initializationState: "ready", invitationStage: "ready", homeTargetId: "home", canonicalSessionId: "session",
    capabilities: { modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }], permissionMode: "ask", planMode: false },
    usesDirectoryDefaults: true, createdAt: 0, updatedAt: 0, activity: { partnerId: "partner", unreadReplyCount: 0, artifactCount: 0,
      activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 0, workingStatus: facts() } };
}
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
