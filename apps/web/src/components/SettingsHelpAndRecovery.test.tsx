// @vitest-environment jsdom
import { act, type JSX } from "react";
import { create } from "@bufbuild/protobuf";
import { PersonalDevelopmentDoctorRunSchema, PersonalDevelopmentStateSchema, PersonalDevelopmentTaskSchema, PersonalDevelopmentToolCheckSchema, type PersonalDevelopmentState } from "@joko/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type HelpAnswerView, type WorktreeRecycleRecordView } from "../model.js";
import { HelpAssistant } from "./HelpAssistant.js";
import { WorktreeRecycleSettings } from "./WorktreeRecycleSettings.js";
import { SettingsPage } from "./SettingsPage.js";
import { PersonalDevelopmentSettings } from "./PersonalDevelopmentSettings.js";
import { PersonalDevelopmentReport, PersonalDevelopmentReportActions, mergePersonalDevelopmentReports, usePersonalDevelopmentReports } from "./PersonalDevelopmentReport.js";

const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
const roots: Root[] = [];
beforeEach(() => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); window.history.replaceState(null, "", "#/settings/general"); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); vi.restoreAllMocks(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });

describe("Settings help and local worktree recovery", () => {
  it("keeps a personal report at its transcript position and recovers the same explicit decision receipt", async () => {
    const controller = fixture(), receipt = deferred<any>();
    const report = create(PersonalDevelopmentDoctorRunSchema, { runId: "doctor-run", sessionId: "origin", mode: "prepare", request: "Improve scrolling", status: "completed", createdAtMs: 20n,
      upstream: { status: "found", items: [{ number: 1, title: "Related change", htmlUrl: "https://github.com/JokoAgent/joko/pull/1" }, { number: 2, title: "Unsafe link", htmlUrl: "https://unrelated.example/pull/2" }] } });
    const control = vi.fn().mockImplementationOnce(() => receipt.promise).mockResolvedValueOnce({ ...report, codeSessionId: "personal-task" });
    controller.controlPersonalDevelopmentDoctor = control;
    const view = await mount(<PersonalDevelopmentReportActions.Provider value={controller}><PersonalDevelopmentReport report={report} t={t} /></PersonalDevelopmentReportActions.Provider>);
    expect(view.host.textContent).not.toContain("Unsafe link");
    await act(async () => { button(view.host, "Develop a personal version").click(); button(view.host, "Develop a personal version").click(); });
    expect(control).toHaveBeenCalledTimes(1);
    await act(async () => receipt.reject(new Error("lost receipt")));
    await click(view.host, "Recover action receipt");
    expect(control.mock.calls[1]!.slice(0, 3)).toEqual(control.mock.calls[0]!.slice(0, 3));
    expect(controller.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "personal-task" });
    const projected = mergePersonalDevelopmentReports([
      { id: "before", kind: "assistant", createdAt: 10, sequence: 3n }, { id: "after", kind: "assistant", createdAt: 30, sequence: 4n }
    ], [report]);
    expect(projected.map(item => item.id)).toEqual(["before", "personal-report:doctor-run", "after"]);
    expect(projected[1]!.sequence).toBe(3n);
  });
  it("recovers the same personal action after a lost receipt without replaying on remount", async () => {
    const controller = fixture(), value = personalState();
    controller.getPersonalDevelopment = vi.fn(async () => ({ available: true, unavailableReason: "", state: value }));
    controller.watchPersonalDevelopment = vi.fn(async () => { await new Promise<void>(() => undefined); });
    const action = vi.fn().mockRejectedValueOnce(new Error("receipt lost")).mockResolvedValue(value);
    controller.runPersonalDevelopmentAction = action;
    const element = () => <PersonalDevelopmentSettings controller={controller} snapshot={emptySnapshot()} t={t} />;
    const view = await mount(element());
    expect(action).toHaveBeenCalledTimes(1);
    expect(button(view.host, "Prepare environment").disabled).toBe(true);
    const request = action.mock.calls[0]!.slice(0, 2);
    await act(async () => view.root.unmount()); roots.splice(roots.indexOf(view.root), 1);
    Reflect.set(controller, "state", { ...controller.state, activeProfile: { ...controller.state.activeProfile!, id: "reconnected-profile" } });
    const reopened = await mount(element());
    expect(action).toHaveBeenCalledTimes(1);
    await click(reopened.host, "Recover action receipt");
    expect(action.mock.calls[1]!.slice(0, 2)).toEqual(request);
    expect(button(reopened.host, "Prepare environment").disabled).toBe(false);
  });

  it("requires explicit confirmation before managed source reset or update effects", async () => {
    const value = personalState(); value.source!.commit = "a".repeat(40);
    const controller = fixture(value), snapshot = emptySnapshot();
    Object.assign(snapshot, { targets: [{ id: "local-target", backendId: "local-backend", name: "Local route", archived: false }] });
    const view = await mount(<PersonalDevelopmentSettings controller={controller} snapshot={snapshot} t={t} />);
    const action = vi.mocked(controller.runPersonalDevelopmentAction); action.mockClear();
    await click(view.host, t("personalDevelopment.resetSource"));
    expect(document.body.textContent).toContain(t("personalDevelopment.resetConfirm")); expect(action).not.toHaveBeenCalled();
    await click(document.body, t("common.cancel")); expect(action).not.toHaveBeenCalled();
    await click(view.host, t("personalDevelopment.resetSource")); await click(document.body, t("personalDevelopment.confirmReset"));
    expect(action).toHaveBeenCalledTimes(1); expect(action.mock.calls[0]![0]).toMatchObject({ case: "clearSource" }); action.mockClear();
    await click(view.host, t("personalDevelopment.updateSource"));
    expect(document.body.textContent).toContain(t("personalDevelopment.updateConfirm")); expect(action).not.toHaveBeenCalled();
    await click(document.body, t("personalDevelopment.confirmUpdate"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0]![0]).toEqual({ case: "mergeSource", value: { action: "start", targetId: "local-target" } });
  });

  it("checks the full local environment once on mount and renders native prerequisites with managed tool progress", async () => {
    const value = personalState(); Object.assign(value.environment!, { status: "failed", platform: "win32", arch: "x64", checks: [
      { id: "platform", status: "ready", version: "Windows x64" }, { id: "native", status: "missing", reason: "nativeWindowsRust" },
      { id: "storage", status: "ready", freeGib: 32 }, { id: "git", status: "ready", version: "2.50", source: "system" },
      { id: "gitLfs", status: "ready", version: "3.7", source: "managed" }, { id: "node", status: "extracting", source: "managed", progress: { loaded: 1_048_576n } },
      { id: "pnpm", status: "ready", version: "10.0", source: "managed" }, { id: "python", status: "ready", version: "3.12", source: "system" }
    ].map(check => create(PersonalDevelopmentToolCheckSchema, check)) });
    const controller = fixture(value), element = () => <PersonalDevelopmentSettings controller={controller} snapshot={emptySnapshot()} t={t} />;
    const view = await mount(element());
    const action = vi.mocked(controller.runPersonalDevelopmentAction);
    expect(action).toHaveBeenCalledTimes(1); expect(action.mock.calls[0]![0]).toEqual({ case: "checkEnvironment", value: {} });
    expect(view.host.querySelectorAll(".personal-development-checks li")).toHaveLength(8);
    for (const text of ["win32 x64", "Windows x64", "Node.js", "Git LFS", "pnpm", "python", "32 GiB", t("personalDevelopment.nativeWindows"), t("personalDevelopment.nativeRust")]) {
      expect(view.host.textContent).toContain(text);
    }
    expect(view.host.textContent).toContain("1.0 / ? MiB downloaded"); expect(view.host.textContent).toContain(t("personalDevelopment.toolSource.managed"));
    await act(async () => view.root.render(element())); await click(view.host, t("common.refresh"));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("joins a failed task into its code Session report and recovers the same preparation retry receipt", async () => {
    const value = personalState(), report = create(PersonalDevelopmentDoctorRunSchema, { runId: "task-report", sessionId: "doctor-container", codeSessionId: "code-session",
      taskId: "personal-task", mode: "prepare", status: "completed", decision: "personal" });
    value.doctorRuns = [report]; value.tasks = [create(PersonalDevelopmentTaskSchema, { taskId: "personal-task", sessionId: "code-session", title: "Personal change",
      status: "failed", stage: "preparation-failed", error: "COMMAND_FAILED", operation: { id: "exact-preparation", kind: "task-prepare", status: "failed", stage: "installing-task-dependencies",
        dependencyProgress: { resolved: 12n, reused: 9n, downloaded: 2n, added: 1n } } })];
    const controller = fixture(value), receipt = deferred<PersonalDevelopmentState>();
    const control = vi.fn().mockImplementationOnce(() => receipt.promise).mockResolvedValueOnce(value); controller.controlPersonalDevelopmentTask = control;
    const view = await mount(<CodeSessionReports controller={controller} />);
    expect(view.host.textContent).toContain(t("personalDevelopment.taskPreparation"));
    expect(view.host.textContent).toContain("Resolved 12 · Reused 9 · Downloaded 2 · Added 1");
    await act(async () => { button(view.host, t("personalDevelopment.retryPreparation")).click(); button(view.host, t("personalDevelopment.retryPreparation")).click(); });
    expect(control).toHaveBeenCalledTimes(1);
    await act(async () => receipt.reject(new Error("lost retry receipt")));
    await click(view.host, t("personalDevelopment.retryReceipt"));
    expect(control.mock.calls[1]!.slice(0, 4)).toEqual(control.mock.calls[0]!.slice(0, 4));
    expect(control.mock.calls[0]!.slice(0, 3)).toEqual(["personal-task", "retry_preparation", ""]);
    expect(controller.startPersonalDevelopmentTask).not.toHaveBeenCalled(); expect(controller.startPersonalDevelopmentDoctor).not.toHaveBeenCalled();
    expect(controller.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "code-session" });
  });

  it("ignores older personal generations and late state from a retired source", async () => {
    const controller = fixture(), oldCallbacks: Array<(value: any) => void> = [], scopes: AbortSignal[] = [];
    controller.getPersonalDevelopment = vi.fn(async () => ({ available: true, unavailableReason: "", state: personalState(5n) }));
    controller.watchPersonalDevelopment = vi.fn(async (_after, onUpdate, signal) => { oldCallbacks.push(onUpdate); scopes.push(signal); await new Promise<void>(() => undefined); });
    const element = () => <PersonalDevelopmentSettings controller={controller} snapshot={emptySnapshot()} t={t} />;
    const view = await mount(element());
    await act(async () => oldCallbacks[0]!({ available: true, state: personalState(4n, "wrong-old-version") }));
    expect(view.host.textContent).not.toContain("wrong-old-version");
    Reflect.set(controller, "state", { ...controller.state, activeProfile: { ...controller.state.activeProfile!, serverId: "other-node" } });
    await act(async () => view.root.render(element()));
    await act(async () => oldCallbacks[0]!({ available: true, state: personalState(9n, "wrong-source-version") }));
    expect(view.host.textContent).not.toContain("wrong-source-version");
    expect(scopes[0]!.aborted).toBe(true);
    Reflect.set(controller, "state", { ...controller.state, activeProfile: { ...controller.state.activeProfile!, origin: "https://changed.example" } });
    await act(async () => view.root.render(element()));
    await act(async () => oldCallbacks[1]!({ available: true, state: personalState(9n, "wrong-origin-version") }));
    expect(scopes[1]!.aborted).toBe(true); expect(view.host.textContent).not.toContain("wrong-origin-version");
    Reflect.set(controller, "state", { ...controller.state, connectionGeneration: (controller.state.connectionGeneration ?? 0) + 1 });
    await act(async () => view.root.render(element()));
    await act(async () => oldCallbacks[2]!({ available: true, state: personalState(9n, "wrong-generation-version") }));
    expect(scopes[2]!.aborted).toBe(true); expect(view.host.textContent).not.toContain("wrong-generation-version");
  });

  it("discovers reports in an initially empty pane and clears unavailable, changed-origin and page-hidden owners", async () => {
    const controller = fixture(), watchers: Array<{ accept: (value: any) => void; signal: AbortSignal }> = [];
    controller.watchPersonalDevelopment = vi.fn(async (_after, accept, signal) => { watchers.push({ accept, signal }); await new Promise<void>(() => undefined); });
    const element = () => <CodeSessionReports controller={controller} />;
    const view = await mount(element());
    expect(view.host.querySelector(".personal-development-report")).toBeNull();
    const withReport = (generation: bigint, request: string) => {
      const state = personalState(generation);
      state.doctorRuns = [create(PersonalDevelopmentDoctorRunSchema, { runId: "later-report", sessionId: "doctor-container", codeSessionId: "code-session", mode: "check", request, status: "completed" }),
        create(PersonalDevelopmentDoctorRunSchema, { runId: "foreign-report", sessionId: "another-session", mode: "check", request: "Foreign report", status: "completed" })];
      return { available: true, unavailableReason: "", state };
    };
    await act(async () => watchers[0]!.accept(withReport(2n, "Later report")));
    expect(view.host.querySelectorAll(".personal-development-report")).toHaveLength(1); expect(view.host.textContent).toContain("Later report");
    expect(view.host.textContent).not.toContain("Foreign report");
    await act(async () => watchers[0]!.accept({ available: false, unavailableReason: "native-host-unavailable" }));
    expect(watchers[0]!.signal.aborted).toBe(true); expect(view.host.querySelector(".personal-development-report")).toBeNull();
    await act(async () => watchers[0]!.accept(withReport(99n, "Retired report")));
    expect(view.host.textContent).not.toContain("Retired report");
    const nextRead = deferred<any>(); controller.getPersonalDevelopment = vi.fn(() => nextRead.promise);
    Reflect.set(controller, "state", { ...controller.state, activeProfile: { ...controller.state.activeProfile!, origin: "https://other.example" } });
    await act(async () => view.root.render(element()));
    expect(view.host.querySelector(".personal-development-report")).toBeNull();
    await act(async () => nextRead.resolve(withReport(1n, "New source report")));
    expect(view.host.textContent).toContain("New source report");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(watchers[1]!.signal.aborted).toBe(true); expect(view.host.querySelector(".personal-development-report")).toBeNull();
    await act(async () => watchers[1]!.accept(withReport(100n, "Hidden late report")));
    expect(view.host.textContent).not.toContain("Hidden late report");
    expect(controller.startPersonalDevelopmentTask).not.toHaveBeenCalled(); expect(controller.runPersonalDevelopmentAction).not.toHaveBeenCalled();
  });
  it("opens from mounted Settings, renders model markdown, navigates only approved settings and starts a new conversation", async () => {
    const controller = fixture();
    controller.askHelp = vi.fn<AppController["askHelp"]>(async () => ({ kind: "answer", text: "Use **Providers** to choose a model.", settingsSection: "providers" }));
    const view = await mount(<SettingsPage controller={controller} snapshot={emptySnapshot()} locale="en" t={t} runAction={(_key, action) => { void action(); }} />);
    await click(view.host, "Help");
    await ask(view.host, "How do I choose a model?");
    expect(view.host.querySelector(".help-assistant strong")?.textContent).toBe("Providers");
    await click(view.host, t("help.openSettings", { section: t("settings.providers") }));
    expect(window.location.hash).toBe("#/settings/providers");
    await click(view.host, "New conversation");
    expect(view.host.textContent).toContain("What would you like to know?");
    await click(view.host, "Close");
    await act(async () => window.dispatchEvent(new Event("joko:open-help")));
    expect(view.host.querySelector("#settings-help-panel")).not.toBeNull();
    expect(controller.askHelp).toHaveBeenCalledTimes(1);
  });

  it("keeps no-answer turns and immutable feedback retry identity across panel close, and retires late replies on reset and source replacement", async () => {
    const controller = fixture(), first = deferred<HelpAnswerView>();
    const askHelp = vi.fn().mockResolvedValueOnce({ kind: "noAnswer" }).mockImplementationOnce(() => first.promise);
    controller.askHelp = askHelp;
    const feedback = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce("draft-1");
    controller.createHelpFeedbackDraft = feedback;
    const navigate = vi.fn();
    const element = () => <HelpAssistant controller={controller} locale="en" t={t} onNavigate={navigate} />;
    const view = await mount(element());
    await click(view.host, "Help"); await ask(view.host, "Where is a setting?");
    expect(view.host.textContent).toContain("couldn't find an answer");
    await click(view.host, "Report this answer"); await click(view.host, "Save");
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("same draft");
    const firstDraft = feedback.mock.calls[0]![0];
    await click(view.host, "Close"); await click(view.host, "Help");
    await click(view.host, "Report this answer"); await click(view.host, "Save");
    expect(feedback.mock.calls[1]![0]).toEqual(firstDraft);
    expect(view.host.textContent).toContain("Feedback recorded locally");
    await ask(view.host, "Please explain further");
    expect(askHelp.mock.calls[1]![0]).toEqual([
      { role: "user", content: "Where is a setting?" }, { role: "assistant", content: "" }, { role: "user", content: "Please explain further" }
    ]);
    await click(view.host, "New conversation");
    await act(async () => first.resolve({ kind: "answer", text: "Retired answer", settingsSection: "https://example.com" }));
    expect(view.host.textContent).not.toContain("Retired answer");
    const late = deferred<HelpAnswerView>(); askHelp.mockImplementationOnce(() => late.promise);
    await ask(view.host, "Old node question");
    const originalProfile = controller.state.activeProfile!;
    Reflect.set(controller, "state", { ...controller.state, activeProfile: { ...originalProfile, id: "another", serverId: "server-2" } });
    await act(async () => view.root.render(element()));
    await act(async () => late.resolve({ kind: "answer", text: "Wrong node answer" }));
    await click(view.host, "Help");
    expect(view.host.textContent).not.toContain("Wrong node answer");
    expect(view.host.textContent).not.toContain("Old node question");
  });

  it("restores only the current node's stable recent conversation after remount", async () => {
    const controller = fixture(); controller.askHelp = vi.fn<AppController["askHelp"]>(async () => ({ kind: "answer", text: "A useful answer" }));
    const view = await mount(<HelpAssistant controller={controller} locale="en" t={t} onNavigate={vi.fn()} />);
    await click(view.host, "Help");
    for (let turn = 0; turn < 8; turn += 1) await ask(view.host, `Question ${turn}`);
    const calls = vi.mocked(controller.askHelp).mock.calls;
    expect(calls[7]![0].length).toBeLessThanOrEqual(12);
    expect(calls[7]![0][0]?.role).toBe("user");
    await act(async () => view.root.unmount()); roots.splice(roots.indexOf(view.root), 1);
    const reopened = await mount(<HelpAssistant controller={controller} locale="en" t={t} onNavigate={vi.fn()} />);
    await click(reopened.host, "Help");
    expect(reopened.host.textContent).toContain("Question 7");
    expect(reopened.host.textContent).not.toContain("Question 0");
  });

  it("uses exact current recycle generations, keeps failed actions visible and rejects late source results", async () => {
    const controller = fixture(), old = deferred<readonly WorktreeRecycleRecordView[]>();
    const row: WorktreeRecycleRecordView = { id: "lease", generation: "generation-1", sessionId: "task", displayName: "Task", pathDisplay: "D:/private/tree", state: "paused", reason: "failed", failures: 3, nextAttemptAt: 0 };
    const kept = { ...row, generation: "generation-2", state: "kept", reason: "kept" } as const;
    controller.listWorktreeRecycleStatus = vi.fn().mockResolvedValueOnce([row]).mockResolvedValueOnce([kept]).mockImplementationOnce(() => old.promise).mockResolvedValue([]);
    const control = vi.fn().mockResolvedValueOnce(kept).mockRejectedValueOnce(new Error("stale")); controller.controlWorktreeRecycle = control;
    const element = () => <WorktreeRecycleSettings controller={controller} t={t} />;
    const view = await mount(element());
    await click(view.host, "Keep worktree");
    expect(control.mock.calls[0]!.slice(0, 2)).toEqual([{ id: "lease", generation: "generation-1" }, "keep"]);
    expect(button(view.host, "Keep worktree").disabled).toBe(true);
    await click(view.host, "Retry cleanup");
    expect(control.mock.calls[1]![0]).toEqual({ id: "lease", generation: "generation-2" });
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Refresh");
    await click(view.host, "Refresh");
    Reflect.set(controller, "state", { ...controller.state, activeProfile: { ...controller.state.activeProfile!, id: "another", serverId: "other" } });
    await act(async () => view.root.render(element()));
    await act(async () => old.resolve([row]));
    expect(view.host.textContent).not.toContain("D:/private/tree");
    expect(view.host.textContent).toContain("No worktrees");
  });
});

function fixture(value = personalState()): AppController {
  return { state: { ready: true, connectionState: "connected", snapshot: emptySnapshot(), activeProfile: { id: "profile", deviceId: "device", serverId: "server", origin: "https://node.example", name: "Node" }, preferences: DEFAULT_UI_PREFERENCES,
    systemLocale: "en", effectiveLocale: "en", profiles: [], automaticConnectionAvailable: false }, askHelp: vi.fn(), createHelpFeedbackDraft: vi.fn(), listWorktreeRecycleStatus: vi.fn(async () => []), controlWorktreeRecycle: vi.fn(),
    getPersonalDevelopment: vi.fn(async () => ({ available: true, unavailableReason: "", state: value })),
    watchPersonalDevelopment: vi.fn(async () => { await new Promise<void>(() => undefined); }), runPersonalDevelopmentAction: vi.fn(async () => value),
    startPersonalDevelopmentTask: vi.fn(), startPersonalDevelopmentDoctor: vi.fn(), controlPersonalDevelopmentTask: vi.fn(), openHttpLink: vi.fn(),
    navigate: vi.fn(), getArtifactUrl: vi.fn() } as unknown as AppController;
}
function CodeSessionReports({ controller }: { readonly controller: AppController }): JSX.Element {
  const reports = usePersonalDevelopmentReports(controller, "code-session", true);
  return <PersonalDevelopmentReportActions.Provider value={controller}>{reports.map(report => <PersonalDevelopmentReport key={report.runId} report={report} task={report.task} t={t} />)}</PersonalDevelopmentReportActions.Provider>;
}
function personalState(generation = 1n, originalVersion = "0.1.0"): PersonalDevelopmentState {
  return create(PersonalDevelopmentStateSchema, { generation, environment: { status: "ready", checks: [] },
    source: { status: "ready", targetChannel: "dev", targetVersion: "0.1.0" }, versions: { selected: "original", currentId: "original", originalVersion } });
}
async function mount(element: JSX.Element) { const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root); await act(async () => root.render(element)); return { host, root }; }
function button(host: HTMLElement, text: string) { const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text || candidate.getAttribute("aria-label") === text); if (!result) throw new Error(`Missing button: ${text}`); return result; }
async function click(host: HTMLElement, text: string) { await act(async () => button(host, text).click()); }
async function ask(host: HTMLElement, text: string) { const input = host.querySelector<HTMLInputElement>('[aria-label="Your question"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); }); await click(host, "Send"); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
