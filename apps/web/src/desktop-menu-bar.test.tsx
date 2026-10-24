// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityNames, DEFAULT_MENUBAR_SETTINGS, type DesktopMenubarAction, type DesktopMenubarSnapshot, type MenubarSettings } from "@joko/contracts";
import type { AppController, ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot, type ConnectionProfile, type ProviderRuntimeView, type SessionView, type UsageHistorySummaryView, type UsageHistoryView } from "./model.js";
import { desktopMenuBarProviderRouteCurrent, desktopMenuBarRouteCurrent, desktopMenuBarSourceKey, desktopMenuBarSources, projectDesktopMenuBar,
  readDesktopMenuBarUsage, useDesktopMenuBar, type DesktopMenuBarSource, type DesktopMenuBarUsage } from "./desktop-menu-bar.js";

const now = Date.parse("2026-10-25T08:00:00Z"), today = "2026-10-25";
const profile: ConnectionProfile = { id: "profile", serverId: "node", deviceId: "device", name: "Office", origin: "https://node.example" };
const task: SessionView = { id: "same-task", backendId: "unrelated-id", targetId: "target", name: "Task", state: "running", pinned: false,
  archived: false, generation: 3n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: now, activeRunStartedAt: now - 10_000 };
const provider: ProviderRuntimeView = { backendId: task.backendId, id: "same-provider", name: "Subscription", kind: "subscription",
  compatibility: "native", authenticationState: "authenticated", endpoint: "", ownerManaged: true,
  supportsLogin: false, loginMethods: [], supportsLogout: true, supportsRefresh: true, credentialSurfaces: [],
  capabilities: new Set([capabilityNames.providerAccountUsage]),
  accountUsage: { primaryWindow: { usedPercent: 80, windowMinutes: 300 }, secondaryWindow: { usedPercent: 90, windowMinutes: 10080 }, observedAt: now } };
function source(remote = false, backendName = "Unfamiliar Backend"): DesktopMenuBarSource {
  return { profile: remote ? { ...profile, id: "other-profile", serverId: "other-node", origin: "https://other.example" } : profile,
    selected: true, ...(remote ? { epoch: 8 } : { connectionGeneration: 4 }), snapshot: { ...emptySnapshot(), generation: 2n,
      providers: [provider], sessions: [task], backends: [{ id: task.backendId, name: backendName, version: "1", health: "healthy", capabilities: new Map() }] } };
}
function actionableSource(remote = false): DesktopMenuBarSource {
  const current = source(remote), backend = current.snapshot.backends[0]!;
  return { ...current, snapshot: { ...current.snapshot,
    backends: [{ ...backend, capabilities: new Map(["input.text", "model.switch"].map(name => [name, { name, supported: true, options: [] }])) }],
    models: [{ backendId: backend.id, providerId: provider.id, providerName: provider.name, modelId: "exact-model", name: "Exact model",
      available: true, supportsImages: false, inputModalities: ["text"], outputModalities: ["text"], supportsFast: false, efforts: [],
      contextWindow: 100, maximumOutputTokens: 10, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" }] } };
}
function summary(currency = "USD", cost = 2): UsageHistorySummaryView {
  const usage = { inputTokens: 50, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 100, costMicros: cost * 1_000_000, currencyCode: currency };
  return { usage, currencyTotals: [{ currencyCode: currency, usage, costComplete: true, estimated: false }], costComplete: true, estimated: false };
}
function usage(currency = "USD", cost = 2): DesktopMenuBarUsage {
  const value = summary(currency, cost);
  const history: UsageHistoryView = { days: [{ day: today, ...value }], modelDaily: [{ day: today, backendId: task.backendId, providerId: provider.id, modelId: "model", ...value }],
    models: [], today: value, last30Days: value, currentStreakDays: 1, longestStreakDays: 1, todayAnomalous: false, generatedAt: now, estimated: false };
  return { history, tasks: [{ key: "group", sessionId: task.id, backendId: task.backendId, providerId: provider.id, modelId: "model", title: task.name,
    referenceAvailable: true, summary: value, measuredAt: now }] };
}
function state(sources = [source()]): ControllerState {
  const current = sources.find(source => source.epoch === undefined)!;
  return { ready: true, connectionState: "connected", connectionGeneration: current.connectionGeneration, profiles: sources.map(source => source.profile),
    activeProfile: current.profile, snapshot: current.snapshot, nativeTaskStatusLiveSources: sources.filter(source => source.epoch !== undefined).map(source => ({
      profile: source.profile, snapshot: source.snapshot, epoch: source.epoch!, partners: [] })), machineCaches: [], machinePresenceByProfile: {},
    discoveredNodes: [], discoveryState: "idle", managedOrchestratorStatus: undefined, automaticConnectionAvailable: false,
    route: { kind: "session" }, preferences: DEFAULT_UI_PREFERENCES, systemLocale: "en", effectiveLocale: "en", extensionNotifications: [] };
}

it("reads every current task report page for the history's day and never continues a retired gateway", async () => {
  const value = usage(), api = { getUsageHistory: vi.fn(async () => value.history), getUsageReport: vi.fn(async (query: { pageToken?: string }) => ({
    entries: [{ ...value.tasks[0]!, key: query.pageToken || "first", sessionId: query.pageToken || "first" }], summary: summary(), totalGroups: 2, nextPageToken: query.pageToken ? "" : "page-two" })) };
  const result = await readDesktopMenuBarUsage(api, new AbortController().signal, () => true);
  expect(result.tasks).toHaveLength(2); expect(api.getUsageHistory).toHaveBeenCalledWith(90, undefined, undefined, expect.any(AbortSignal));
  expect(api.getUsageReport.mock.calls.map(([query]) => query)).toEqual([
    { group: "task", fromDay: today, throughDay: today, pageToken: "" }, { group: "task", fromDay: today, throughDay: today, pageToken: "page-two" }]);
  let current = true;
  api.getUsageHistory.mockImplementationOnce(async () => { current = false; return value.history; });
  await expect(readDesktopMenuBarUsage(api, new AbortController().signal, () => current)).rejects.toThrow("owner changed");
  expect(api.getUsageReport).toHaveBeenCalledTimes(2);
});

it("refreshes only authenticated advertised account-usage routes and rechecks ownership before another refresh", async () => {
  const value = usage(); let current = true;
  const api = { getUsageHistory: vi.fn(async () => value.history), getUsageReport: vi.fn(async () => ({ entries: [], summary: summary(), totalGroups: 0, nextPageToken: "" })),
    refreshProviderAccountUsage: vi.fn(async (_backend: string, _provider: string) => undefined) };
  await readDesktopMenuBarUsage(api, new AbortController().signal, () => current, [provider,
    { ...provider, id: "no-capability", capabilities: new Set() }, { ...provider, id: "signed-out", authenticationState: "signedOut" }]);
  expect(api.refreshProviderAccountUsage.mock.calls).toEqual([[provider.backendId, provider.id]]);
  api.refreshProviderAccountUsage.mockImplementationOnce(async () => { current = false; });
  await expect(readDesktopMenuBarUsage(api, new AbortController().signal, () => current, [provider, { ...provider, id: "next" }])).rejects.toThrow("owner changed");
  expect(api.refreshProviderAccountUsage).toHaveBeenCalledTimes(2); expect(api.getUsageHistory).toHaveBeenCalledOnce();
});

it("maps actual Backend names, opaque node/task identities, quota and local/selected histories without guessing Backend IDs", async () => {
  const first = source(false, "Zulu"), second = source(true, "Alpha"), sources = [first, second];
  const readings = new Map(sources.map(source => [desktopMenuBarSourceKey(source), { value: usage() }]));
  const projected = await projectDesktopMenuBar({ sources, readings, settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
  expect(projected.view.tasks.map(task => task.harness).sort()).toEqual(["first", "second"]);
  expect(projected.view.strings["harness.first"]).toBe("Alpha"); expect(projected.view.strings["harness.second"]).toBe("Zulu");
  expect(new Set(projected.view.tasks.map(task => task.sessionId)).size).toBe(2);
  expect(projected.view.sources).toHaveLength(2); expect(projected.view.sources[0]?.value).toBe("10");
  expect(projected.view.sources.every(source => source.logoSvg === "joko:mark" && source.id.startsWith("menu-source:"))).toBe(true);
  expect(Object.values(projected.view.details).every(detail => detail.action.kind === "open-app")).toBe(true);
  expect(projected.view.usage.scopes.local.daily.at(-1)?.money).toEqual([0, 2, 0]);
  expect(projected.view.usage.scopes.all.daily.at(-1)?.money).toEqual([2, 2, 0]);
  expect(projected.routes.size).toBe(2);
  const restarted = { ...first, snapshot: { ...first.snapshot, generation: 9n } };
  const next = await projectDesktopMenuBar({ sources: [restarted], readings: new Map(), settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
  expect(next.view.sources[0]?.id).toBe(projected.view.sources[0]?.id);
  expect(next.view.tasks[0]?.sessionId).not.toBe(projected.view.tasks.find(task => projected.routes.get(task.sessionId)?.source === first)?.sessionId);
  const local = await projectDesktopMenuBar({ sources, readings, settings: { ...DEFAULT_MENUBAR_SETTINGS, scope: "local" }, locale: "en", now });
  expect(local.view.tasks).toHaveLength(1); expect(local.view.sources).toHaveLength(1);
});

it("does not add different currencies and marks unavailable or stale evidence in both languages", async () => {
  const first = source(), second = source(true), sources = [first, second];
  for (const locale of ["en", "zh-CN"]) {
    const readings = new Map([[desktopMenuBarSourceKey(first), { value: usage("USD") }], [desktopMenuBarSourceKey(second), { value: usage("CNY", 100), failed: true }]]);
    const projected = await projectDesktopMenuBar({ sources, readings, settings: DEFAULT_MENUBAR_SETTINGS, locale, now });
    expect(projected.view.moneySymbol).toBe(""); expect(projected.view.statusTextByMode.today).toBeNull();
    expect(projected.view.usage.scopes.all.daily.at(-1)?.money).toEqual([0, 0, 0]);
    expect(projected.view.usage.scopes.all.note).toContain(locale === "en" ? "different currencies" : "多币种");
    expect(projected.view.usage.scopes.all.note).toContain(locale === "en" ? "last successful read" : "上次成功读取");
  }
});

it("offers the exact admitted local Provider model, keeps layout IDs stable and retires action IDs with their authority", async () => {
  const initial = actionableSource(), remote = actionableSource(true), local = { ...initial, snapshot: { ...initial.snapshot,
    providers: [{ ...provider, accountUsage: { ...provider.accountUsage!, resetCredits: { availableCount: 2, earliestExpiryAt: now + 86_400_000 } } }] } };
  const projected = await projectDesktopMenuBar({ sources: [local, remote], readings: new Map(), settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
  expect(projected.providerRoutes.size).toBe(1);
  const [id, route] = [...projected.providerRoutes][0]!;
  expect(route).toMatchObject({ backendId: task.backendId, providerId: provider.id, modelId: "exact-model" });
  const detail = Object.values(projected.view.details).find(value => value.action.kind === "new-task")!;
  expect(detail.action).toEqual({ kind: "new-task", providerId: id });
  expect(detail.facts).toContainEqual(expect.objectContaining({ label: "Usage limit resets", value: "2 resets" }));
  expect(Object.values(projected.view.details).filter(value => value.action.kind === "open-app")).toHaveLength(1);
  const owner = state([local, remote]);
  expect(desktopMenuBarProviderRouteCurrent(route, owner)).toBe(true);
  expect(desktopMenuBarProviderRouteCurrent(route, { ...owner, connectionGeneration: 99 })).toBe(false);
  expect(desktopMenuBarProviderRouteCurrent(route, { ...owner, snapshot: { ...owner.snapshot, generation: 99n } })).toBe(false);
  expect(desktopMenuBarProviderRouteCurrent(route, { ...owner, snapshot: { ...owner.snapshot, models: [] } })).toBe(false);
  const restarted = { ...local, snapshot: { ...local.snapshot, generation: 99n } };
  const next = await projectDesktopMenuBar({ sources: [restarted], readings: new Map(), settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
  expect(next.view.manage[0]?.id).toBe(projected.view.manage.find(row => row.id === detail.id)?.id);
  expect([...next.providerRoutes.keys()]).not.toContain(id);
  for (const snapshot of [{ ...local.snapshot, models: [] }, { ...local.snapshot, backends: [{ ...local.snapshot.backends[0]!, capabilities: new Map() }] }]) {
    const disabled = await projectDesktopMenuBar({ sources: [{ ...local, snapshot }], readings: new Map(), settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
    expect(disabled.providerRoutes.size).toBe(0); expect(Object.values(disabled.view.details).every(value => value.action.kind === "open-app")).toBe(true);
  }
});

it("bounds a large Provider catalog to the native node and byte budgets and reports omitted rows", async () => {
  const initial = source(), snapshot = { ...initial.snapshot, providers: Array.from({ length: 550 }, (_, index) => ({ ...provider, id: `provider-${index}`, name: "x".repeat(4096) })) };
  const result = await projectDesktopMenuBar({ sources: [{ ...initial, snapshot }], readings: new Map(), settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
  let nodes = 0;
  const visit = (value: unknown): void => { nodes++; if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(4096);
    if (value && typeof value === "object") { if (Array.isArray(value)) expect(value.length).toBeLessThanOrEqual(500); Object.values(value).forEach(visit); } };
  visit(result.view);
  expect(nodes).toBeLessThan(40_000); expect(JSON.stringify(result.view).length).toBeLessThan(512_000);
  expect(result.view.usage.scopes.all.note).toContain("display budget");
});

it("accepts only current saved identities and live route generations, never offline machine caches", async () => {
  const sources = [source(), source(true)], controller = state(sources), sourceRows = desktopMenuBarSources(controller);
  expect(sourceRows).toHaveLength(2);
  const result = await projectDesktopMenuBar({ sources, readings: new Map(), settings: DEFAULT_MENUBAR_SETTINGS, locale: "en", now });
  const route = [...result.routes.values()].find(route => route.source.epoch === undefined)!;
  expect(desktopMenuBarRouteCurrent(route, controller)).toBe(true);
  expect(desktopMenuBarRouteCurrent(route, { ...controller, connectionGeneration: 99 })).toBe(false);
  expect(desktopMenuBarRouteCurrent(route, { ...controller, snapshot: { ...controller.snapshot, sessions: [{ ...task, generation: 99n }] } })).toBe(false);
  expect(desktopMenuBarSources({ ...controller, connectionState: "offline" })).toEqual([]);
  expect(desktopMenuBarSources({ ...controller, profiles: [profile, { ...sources[1]!.profile, origin: "https://replaced.example" }] })).toHaveLength(1);
});

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); Reflect.deleteProperty(window, "jokoDesktop"); vi.unstubAllGlobals(); });
function Harness({ controller, owns = true }: { controller: AppController; owns?: boolean }) { useDesktopMenuBar(controller, owns); return null; }
function nativeFixture() {
  let action!: (value: DesktopMenubarAction) => void, settings!: (value: MenubarSettings) => void;
  const api = { get: vi.fn(async () => ({ available: true, enabled: true, settings: DEFAULT_MENUBAR_SETTINGS })),
    publish: vi.fn<(value: DesktopMenubarSnapshot) => Promise<void>>().mockResolvedValue(undefined),
    onSettings: vi.fn((value: typeof settings) => { settings = value; return vi.fn(); }),
    onAction: vi.fn((value: typeof action) => { action = value; return vi.fn(); }) };
  const notify = vi.fn(async () => undefined);
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["native.menuBar", "notifications.session"], menuBar: api, notify } });
  return { api, notify, act: (value: DesktopMenubarAction) => action(value), settings: (value: MenubarSettings) => settings(value) };
}
it("publishes from the main window, ignores stale native actions and preserves an in-flight usage read across event snapshots", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const native = nativeFixture(); let finish!: (value: DesktopMenuBarUsage) => void;
  const read = vi.fn<NonNullable<AppController["readDesktopMenuBarUsage"]>>(() => new Promise<DesktopMenuBarUsage>(resolve => { finish = resolve; })), navigate = vi.fn(), openMachineSession = vi.fn();
  let controller = { state: state(), readDesktopMenuBarUsage: read, navigate, openMachineSession } as unknown as AppController;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness controller={controller} />));
  expect(read).toHaveBeenCalledOnce(); const originalSignal = read.mock.calls[0]![1] as AbortSignal;
  controller = { ...controller, state: { ...controller.state, snapshot: { ...controller.state.snapshot, revision: 10n } },
    readDesktopMenuBarUsage: (...args) => read(...args) };
  await act(async () => root!.render(<Harness controller={controller} />));
  expect(originalSignal.aborted).toBe(false); expect(read).toHaveBeenCalledOnce();
  await act(async () => finish(usage()));
  await vi.waitFor(() => expect(native.api.publish).toHaveBeenCalled());
  const snapshot = native.api.publish.mock.calls.at(-1)![0], id = snapshot.view.tasks[0]!.sessionId;
  await act(async () => native.act({ type: "open-session", id })); expect(navigate).toHaveBeenCalledOnce();
  await act(async () => native.act({ type: "low-alert" })); expect(native.notify).toHaveBeenCalledOnce();
  controller = { ...controller, state: { ...controller.state, connectionGeneration: 99,
    preferences: { ...controller.state.preferences, sessionNotificationsEnabled: false } } };
  await act(async () => root!.render(<Harness controller={controller} />));
  await act(async () => { native.act({ type: "open-session", id }); native.act({ type: "low-alert" }); });
  expect(navigate).toHaveBeenCalledOnce(); expect(native.notify).toHaveBeenCalledOnce();
  await act(async () => root!.render(<Harness controller={controller} owns={false} />));
  const count = native.api.publish.mock.calls.length;
  await act(async () => finish(usage())); expect(native.api.publish).toHaveBeenCalledTimes(count);
});

it("refreshes on native request and seeds only the latest local Provider action through guarded navigation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const native = nativeFixture(), local = actionableSource(), read = vi.fn<NonNullable<AppController["readDesktopMenuBarUsage"]>>(async () => usage()), navigate = vi.fn();
  let controller = { state: state([local]), readDesktopMenuBarUsage: read, navigate } as unknown as AppController;
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Harness controller={controller} />));
  await vi.waitFor(() => expect(native.api.publish.mock.calls.at(-1)?.[0].view.details).toBeDefined());
  const action = Object.values(native.api.publish.mock.calls.at(-1)![0].view.details).find(detail => detail.action.kind === "new-task")!.action;
  if (action.kind !== "new-task") throw new Error("Missing new task action");
  await act(async () => native.act({ type: "new-task", id: action.providerId }));
  expect(navigate).toHaveBeenCalledWith({ kind: "newSession", initialModel: expect.objectContaining({ backendId: task.backendId,
    providerId: provider.id, modelId: "exact-model", connectionGeneration: 4, snapshotGeneration: "2" }) }, { replace: true, isCurrent: expect.any(Function) });
  const guard = navigate.mock.calls[0]![1].isCurrent as () => boolean;
  expect(guard()).toBe(true); expect(read.mock.calls[0]![2]).toBe(true);
  await act(async () => native.act({ type: "refresh" }));
  expect(read.mock.calls.at(-1)![2]).toBe(true); expect(read).toHaveBeenCalledTimes(2);
  controller = { ...controller, state: { ...controller.state, snapshot: { ...controller.state.snapshot, generation: 88n } } };
  await act(async () => root!.render(<Harness controller={controller} />));
  expect(guard()).toBe(false);
  await act(async () => native.act({ type: "new-task", id: action.providerId }));
  expect(navigate).toHaveBeenCalledOnce();
});
