// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityNames } from "@joko/contracts";
import { useAppController, type AppController } from "./controller.js";
import { createOrchestratorGateway, probeOrchestratorOrigin, type OrchestratorGateway } from "./gateway.js";
import { DEFAULT_UI_PREFERENCES, LocalState } from "./local-state.js";
import { emptySnapshot, type ConnectionProfile, type ProviderRuntimeView, type SessionView, type UsageHistoryView } from "./model.js";
import { desktopMenuBarRouteCurrent, desktopMenuBarSources, type DesktopMenuBarRoute } from "./desktop-menu-bar.js";

vi.mock("./gateway.js", async original => ({ ...await original<typeof import("./gateway.js")>(),
  createOrchestratorGateway: vi.fn(), probeOrchestratorOrigin: vi.fn() }));
const first: ConnectionProfile = { id: "first", serverId: "node-first", deviceId: "device-first", origin: "https://first.example", name: "First" };
const second: ConnectionProfile = { id: "second", serverId: "node-second", deviceId: "device-second", origin: "https://second.example", name: "Second" };
const session: SessionView = { id: "same-task", backendId: "backend", targetId: "project", name: "Task", state: "running", pinned: false,
  archived: false, generation: 5n, permissionMode: "ask", planMode: false, fastMode: false, updatedAt: 1 };
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear(); window.history.replaceState(null, "", "#/settings");
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities: ["native.taskStatus", "native.menuBar"], window: {} } });
  vi.mocked(probeOrchestratorOrigin).mockImplementation(async origin => ({ serverId: origin === first.origin ? first.serverId : second.serverId,
    displayName: "Node", version: "1", apiVersion: "1", pairingEnabled: false }));
  vi.spyOn(LocalState, "open").mockResolvedValue({ listProfiles: async () => [first, second], listMachineCaches: async () => [],
    readPreferences: async () => DEFAULT_UI_PREFERENCES, readAuthKey: async () => "fixture-auth", saveProfile: async () => undefined,
    loadEndpointTransport: LocalState.prototype.loadEndpointTransport,
    saveMachineCache: async () => undefined, deleteMachineCache: async () => undefined } as unknown as LocalState);
  const histories = new Map<string, Promise<UsageHistoryView>>(), report = vi.fn(async () => ({ entries: [], nextPageToken: "" }));
  const refreshes: Array<{ profileId: string; backendId: string; providerId: string }> = [], refreshWaits = new Map<string, Promise<void>>();
  const provider: ProviderRuntimeView = { backendId: "backend", id: "account", name: "Account", kind: "subscription", compatibility: "native",
    authenticationState: "authenticated", endpoint: "", ownerManaged: true, supportsLogin: false, loginMethods: [], supportsLogout: true,
    supportsRefresh: true, credentialSurfaces: [], capabilities: new Set([capabilityNames.providerAccountUsage]),
    accountUsage: { observedAt: 1, primaryWindow: { usedPercent: 80, windowMinutes: 300 } } };
  const totals = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costMicros: 0, currencyCode: "USD" },
    currencyTotals: [], costComplete: true, estimated: false };
  const emptyHistory: UsageHistoryView = { days: [], modelDaily: [], models: [], today: totals, last30Days: totals,
    currentStreakDays: 0, longestStreakDays: 0, todayAnomalous: false, generatedAt: 1, estimated: false };
  const snapshots = { ...emptySnapshot(), generation: 3n, sessions: [session], providers: [provider] }, activeConnections: string[] = [];
  vi.mocked(createOrchestratorGateway).mockImplementation((profile, _key, callbacks) => {
    const owner = profile!, active = callbacks.onExtensionUiEffect !== undefined;
    return { connect: async () => { if (active) activeConnections.push(owner.id); callbacks.onSnapshot?.(snapshots);
      callbacks.onState?.("connected"); callbacks.onLiveSnapshot?.(snapshots); },
      disconnect: () => callbacks.onLiveSnapshot?.(undefined), refresh: async () => callbacks.onSnapshot?.(snapshots),
      taskSharingApi: () => undefined, inputHandoffApi: () => undefined, providerSharingApi: () => undefined, partnerNetworkApi: () => undefined,
      partnerIdentityApi: () => undefined, providerGroupSettingsApi: () => undefined, listPartners: async () => ({ partners: [] }),
      refreshProviderAccountUsage: async (backendId: string, providerId: string) => {
        refreshes.push({ profileId: owner.id, backendId, providerId }); await refreshWaits.get(owner.id);
        const refreshed = { ...snapshots, providers: [{ ...provider, accountUsage: { observedAt: 2,
          primaryWindow: { usedPercent: 10, windowMinutes: 300 } } }] };
        callbacks.onSnapshot?.(refreshed); callbacks.onLiveSnapshot?.(refreshed);
      },
      getUsageHistory: async () => histories.get(owner.id) ?? emptyHistory, getUsageReport: report
    } as unknown as OrchestratorGateway;
  });
  let app!: AppController; function Probe() { app = useAppController(); return null; }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(<Probe />));
  await vi.waitFor(() => expect(app.state.ready).toBe(true));
  await act(async () => app.connect(first));
  return { app: () => app, histories, report, activeConnections, refreshes, refreshWaits };
}
it("the real controller retains the original usage gateway across a node switch and rejects its late history before task paging", async () => {
  const view = await mount(); let finish!: (value: UsageHistoryView) => void;
  view.histories.set(first.id, new Promise(resolve => { finish = resolve; }));
  const original = desktopMenuBarSources(view.app().state).find(source => source.epoch === undefined)!;
  const pending = view.app().readDesktopMenuBarUsage!(original, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow("owner changed");
  await act(async () => view.app().connect(second));
  await act(async () => finish({ days: [], generatedAt: 1 } as unknown as UsageHistoryView));
  await rejected; expect(view.report).not.toHaveBeenCalled();
});
it("a menu action completes its own connection handoff but keeps the exact Session generation and navigation ownership", async () => {
  const view = await mount();
  await vi.waitFor(() => expect(view.app().state.nativeTaskStatusLiveSources?.some(source => source.profile.id === second.id)).toBe(true));
  const remote = desktopMenuBarSources(view.app().state).find(source => source.profile.id === second.id)!;
  const route: DesktopMenuBarRoute = { source: remote, sessionId: session.id, generation: session.generation };
  expect(desktopMenuBarRouteCurrent(route, view.app().state)).toBe(true);
  await act(async () => view.app().openMachineSession(second.id, session.id, { expectedGeneration: session.generation,
    isCurrent: () => desktopMenuBarRouteCurrent(route, view.app().state) }));
  expect(view.app().state.activeProfile?.id).toBe(second.id);
  await vi.waitFor(() => expect(view.app().state.route).toMatchObject({ kind: "session", profileId: second.id, sessionId: session.id }));
  expect(view.activeConnections).toEqual([first.id, second.id]);
  await expect(view.app().openMachineSession(second.id, session.id, { expectedGeneration: 99n })).rejects.toThrow("no longer exists");
  expect(view.activeConnections).toEqual([first.id, second.id]);
});

it("native refresh updates the exact remote account snapshot without selecting it and retires a delayed original-node refresh", async () => {
  const view = await mount();
  await vi.waitFor(() => expect(view.app().state.nativeTaskStatusLiveSources?.some(source => source.profile.id === second.id)).toBe(true));
  const remote = desktopMenuBarSources(view.app().state).find(source => source.profile.id === second.id)!;
  await act(async () => { await view.app().readDesktopMenuBarUsage!(remote, new AbortController().signal, true); });
  expect(view.refreshes).toEqual([{ profileId: second.id, backendId: "backend", providerId: "account" }]);
  expect(view.app().state.activeProfile?.id).toBe(first.id);
  expect(view.app().state.nativeTaskStatusLiveSources?.find(source => source.profile.id === second.id)?.snapshot.providers[0]?.accountUsage?.primaryWindow?.usedPercent).toBe(10);
  const original = desktopMenuBarSources(view.app().state).find(source => source.epoch === undefined)!;
  let finish!: () => void; view.refreshWaits.set(first.id, new Promise(resolve => { finish = resolve; }));
  const pending = view.app().readDesktopMenuBarUsage!(original, new AbortController().signal, true), rejected = expect(pending).rejects.toThrow("owner changed");
  const reportCalls = view.report.mock.calls.length;
  await act(async () => view.app().connect(second)); await act(async () => finish()); await rejected;
  expect(view.report).toHaveBeenCalledTimes(reportCalls);
  expect(view.refreshes.at(-1)).toEqual({ profileId: first.id, backendId: "backend", providerId: "account" });
});
