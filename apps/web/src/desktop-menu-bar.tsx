import { useEffect, useMemo, useRef, useState } from "react";
import { buildMenubarView, capabilityNames, MENU_BAR_MESSAGES, type MenubarSettings, type MenubarView, type MenubarSourceInput,
  type MenubarSubscriptionInput, type MenubarTaskInput, type MenubarUsageScopeInput, type MenubarHarness } from "@joko/contracts";
import type { AppController, ControllerState } from "./controller.js";
import type { AppSnapshot, ConnectionProfile, OperationApi, ProviderRuntimeView, UsageHistoryView, UsageReportEntryView,
  UsageHistorySummaryView, ProviderAccountUsageWindowView } from "./model.js";
import { selectedMachineProfileIds } from "./machine-federation.js";
import { newSessionProviderModel } from "./new-session-provider-model.js";
import { randomUuid, sha256Hex } from "./web-crypto.js";

export interface DesktopMenuBarSource {
  readonly profile: ConnectionProfile;
  readonly snapshot: AppSnapshot;
  readonly selected: boolean;
  readonly connectionGeneration?: number;
  readonly epoch?: number;
}
export interface DesktopMenuBarUsage { readonly history: UsageHistoryView; readonly tasks: readonly UsageReportEntryView[]; readonly accountRefreshFailed?: boolean }
interface UsageReading { readonly value?: DesktopMenuBarUsage; readonly failed?: boolean }
export interface DesktopMenuBarRoute { readonly source: DesktopMenuBarSource; readonly sessionId: string; readonly generation: bigint }
export interface DesktopMenuBarProviderRoute { readonly source: DesktopMenuBarSource; readonly backendId: string; readonly providerId: string; readonly modelId: string }
export interface DesktopMenuBarProjection { readonly view: MenubarView; readonly routes: ReadonlyMap<string, DesktopMenuBarRoute>;
  readonly providerRoutes: ReadonlyMap<string, DesktopMenuBarProviderRoute>; readonly sourceKeys: ReadonlySet<string> }
const MARK = "joko:mark";
const text = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 4096);
const positive = (value: number | undefined): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const dayKey = (time: number): string => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const profileKey = (profile: ConnectionProfile): readonly string[] => [profile.id, profile.serverId, profile.deviceId, profile.origin];
export const desktopMenuBarSourceKey = (source: DesktopMenuBarSource): string => JSON.stringify([
  ...profileKey(source.profile), source.snapshot.generation.toString(), source.epoch ?? null, source.connectionGeneration ?? null
]);

/** Only authenticated live snapshots participate; cached/offline machine cards never supply usage or actions. */
export function desktopMenuBarSources(state: ControllerState): readonly DesktopMenuBarSource[] {
  if (state.connectionState !== "connected" || !state.activeProfile) return [];
  const selected = new Set(selectedMachineProfileIds(state.preferences.machineSelection, state.profiles));
  const primary: DesktopMenuBarSource = { profile: state.activeProfile, snapshot: state.snapshot,
    connectionGeneration: state.connectionGeneration, selected: selected.has(state.activeProfile.id) };
  const keys = new Set([primary.profile.id]);
  return [primary, ...(state.nativeTaskStatusLiveSources ?? []).flatMap(source => {
    const saved = state.profiles.find(profile => profile.id === source.profile.id);
    if (!saved || !selected.has(saved.id) || keys.has(saved.id) || JSON.stringify(profileKey(saved)) !== JSON.stringify(profileKey(source.profile))) return [];
    keys.add(saved.id);
    return [{ profile: saved, snapshot: source.snapshot, epoch: source.epoch, selected: true }];
  })];
}

/** The caller binds one original gateway and checks its identity after every await and before every page. */
export async function readDesktopMenuBarUsage(api: Pick<OperationApi, "getUsageHistory" | "getUsageReport"> & Partial<Pick<OperationApi, "refreshProviderAccountUsage">>,
  signal: AbortSignal, isCurrent: () => boolean, refreshProviders: readonly ProviderRuntimeView[] = []): Promise<DesktopMenuBarUsage> {
  const check = (): void => { signal.throwIfAborted(); if (!isCurrent()) throw new Error("The menu bar usage owner changed."); };
  let accountRefreshFailed = false;
  for (const provider of refreshProviders) {
    if (provider.authenticationState !== "authenticated" || !provider.capabilities.has(capabilityNames.providerAccountUsage)) continue;
    check();
    try { await api.refreshProviderAccountUsage!(provider.backendId, provider.id); }
    catch { check(); accountRefreshFailed = true; }
    check();
  }
  check(); const history = await api.getUsageHistory(90, undefined, undefined, signal); check();
  const today = history.days.at(-1)?.day ?? dayKey(history.generatedAt);
  const tasks: UsageReportEntryView[] = [], pages = new Set<string>(), keys = new Set<string>();
  let pageToken = "";
  do {
    check();
    if (pages.has(pageToken) || pages.size >= 400) throw new Error("The menu bar task report exceeded its bounded pagination.");
    pages.add(pageToken);
    const page = await api.getUsageReport({ group: "task", fromDay: today, throughDay: today, pageToken }, signal); check();
    for (const entry of page.entries) {
      if (keys.has(entry.key)) throw new Error("The menu bar task report repeated a group.");
      keys.add(entry.key); tasks.push(entry);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { history, tasks, ...(accountRefreshFailed ? { accountRefreshFailed } : {}) };
}

async function opaque(kind: string, parts: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, ...parts]));
  return `menu-${kind}:${await sha256Hex(bytes.buffer as ArrayBuffer)}`;
}
function quotaWindow(window: ProviderAccountUsageWindowView | undefined, kind: "session" | "week" | "scoped", label?: string) {
  return window && Number.isFinite(window.usedPercent) ? [{ kind, ...(label ? { label: text(label) } : {}),
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)), resetsAtMs: window.resetAt ?? null,
    windowMinutes: positive(window.windowMinutes) }] : [];
}
const amount = (summary: UsageHistorySummaryView, currency: string): number => summary.currencyTotals
  .filter(total => total.currencyCode === currency).reduce((sum, total) => sum + positive(total.usage.costMicros) / 1_000_000, 0);

/** Pure service-fact mapping apart from stable SHA-256 route identities; no Provider/runtime or credential I/O. */
export async function projectDesktopMenuBar(input: { readonly sources: readonly DesktopMenuBarSource[]; readonly readings: ReadonlyMap<string, UsageReading>;
  readonly settings: MenubarSettings; readonly locale: string; readonly now: number }): Promise<DesktopMenuBarProjection> {
  const locale = input.locale === "zh-CN" ? "zh-CN" : "en", messages = MENU_BAR_MESSAGES[locale];
  const names = [...new Set(input.sources.flatMap(source => source.snapshot.backends.map(backend => backend.name)))].sort((a, b) => a.localeCompare(b));
  const labels: Record<MenubarHarness, string> = { first: text(names[0] ?? "Backend 1"), second: text(names[1] ?? "Backend 2"), other: locale === "zh-CN" ? "其他" : "Other" };
  const harness = (source: DesktopMenuBarSource, id: string): MenubarHarness => {
    const name = source.snapshot.backends.find(backend => backend.id === id)?.name;
    return name === names[0] ? "first" : name === names[1] ? "second" : "other";
  };
  const t = (key: string, vars?: Record<string, string | number>): string => {
    if (key.startsWith("harness.")) return labels[key.slice(8) as MenubarHarness] ?? labels.other;
    const plural = typeof vars?.count === "number" ? new Intl.PluralRules(locale).select(vars.count) : undefined;
    return (messages[`${key}_${plural}`] ?? messages[key] ?? messages[`${key}_other`] ?? key)
      .replace(/\{\{(\w+)\}\}/gu, (match, name: string) => vars?.[name] === undefined ? match : String(vars[name]));
  };
  const uiStrings = Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith("ui.")).map(([key, value]) => [key.slice(3), value]));
  for (const key of ["first", "second", "other"] as const) uiStrings[`harness.${key}`] = labels[key];
  const today = input.sources.map(source => input.readings.get(desktopMenuBarSourceKey(source))?.value?.history.days.at(-1)?.day).find(Boolean) ?? dayKey(input.now);
  const end = Date.parse(`${today}T00:00:00Z`);
  const days = Array.from({ length: 90 }, (_, index) => new Date(end - (89 - index) * 86_400_000).toISOString().slice(0, 10));
  const currencies = new Set(input.sources.flatMap(source => {
    const reading = input.readings.get(desktopMenuBarSourceKey(source))?.value;
    return reading ? [...reading.history.days, ...reading.tasks.map(task => task.summary)].flatMap(summary => summary.currencyTotals
      .filter(total => total.usage.costMicros !== 0).map(total => total.currencyCode)) : [];
  }));
  const currency = currencies.size <= 1 ? [...currencies][0] ?? "USD" : "";
  const moneySymbol = (currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency ? `${currency} ` : "").slice(0, 32);
  const makeScope = (sources: readonly DesktopMenuBarSource[]): MenubarUsageScopeInput => {
    const daily = days.map(() => ({ money: [0, 0, 0] as [number, number, number], paid: 0, tokens: [0, 0, 0] as [number, number, number] }));
    const models: MenubarUsageScopeInput["models"] = { "7": [], "30": [], "90": [] };
    for (const range of [7, 30, 90] as const) {
      const byModel = new Map<string, { name: string; harness: MenubarHarness; money: number; tokens: number }>();
      for (const source of sources) {
        const history = input.readings.get(desktopMenuBarSourceKey(source))?.value?.history;
        for (const entry of history?.modelDaily ?? []) {
          const index = days.indexOf(entry.day); if (index < 0 || index < days.length - range) continue;
          const group = harness(source, entry.backendId), slot = group === "first" ? 0 : group === "second" ? 1 : 2;
          const value = currency ? amount(entry, currency) : 0;
          if (range === 90) {
            daily[index]!.money[slot] += value; daily[index]!.tokens[slot] += positive(entry.usage.totalTokens);
            const provider = source.snapshot.providers.find(provider => provider.backendId === entry.backendId && provider.id === entry.providerId);
            if (provider?.kind === "apiKey" && !entry.estimated && entry.costComplete) daily[index]!.paid += value;
          }
          const name = text(source.snapshot.models.find(model => model.backendId === entry.backendId && model.providerId === entry.providerId && model.modelId === entry.modelId)?.name ?? entry.modelId);
          const key = JSON.stringify([group, entry.modelId, name]), row = byModel.get(key) ?? { name, harness: group, money: 0, tokens: 0 };
          row.money += value; row.tokens += positive(entry.usage.totalTokens); byModel.set(key, row);
        }
      }
      models[String(range) as "7" | "30" | "90"] = [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 500);
    }
    return { daily, models, devices: sources.slice(0, 500).map(source => ({ name: text(source.profile.name), isSelf: source.epoch === undefined,
      syncedAtMs: input.readings.get(desktopMenuBarSourceKey(source))?.value?.history.generatedAt ?? null })) };
  };
  const selected = input.sources.filter(source => source.selected), local = input.sources.filter(source => source.epoch === undefined);
  const displayed = input.settings.scope === "local" ? local : selected;
  const sources: MenubarSourceInput[] = [], tasks: MenubarTaskInput[] = [], routes = new Map<string, DesktopMenuBarRoute>(),
    providerRoutes = new Map<string, DesktopMenuBarProviderRoute>(), detailActions = new Map<string, { id: string; name: string }>();
  for (const source of displayed) {
    const reading = input.readings.get(desktopMenuBarSourceKey(source))?.value;
    for (const provider of source.snapshot.providers.filter(provider => provider.routingEnabled !== false)) {
      const usage = provider.accountUsage, buckets = usage?.buckets ?? [];
      const model = source.epoch === undefined && source.connectionGeneration !== undefined ? newSessionProviderModel(source.snapshot, provider.backendId, provider.id) : undefined;
      // Layout source IDs survive reconnects; native action IDs retain the exact live authority.
      const actionId = model ? await opaque("provider-action", [desktopMenuBarSourceKey(source), provider.backendId, provider.id, model.modelId]) : undefined;
      if (actionId && model) providerRoutes.set(actionId, { source, backendId: provider.backendId, providerId: provider.id, modelId: model.modelId });
      const rows = buckets.length > 0 ? buckets.map(bucket => ({ ...bucket, observedAt: usage?.observedAt })) : [usage];
      for (let index = 0; index < rows.length && sources.length < 500; index++) {
        const row = rows[index], id = await opaque("source", [...profileKey(source.profile), provider.backendId, provider.id,
          buckets[index]?.id ?? ""]);
        if (actionId) detailActions.set(id, { id: actionId, name: provider.name });
        const consuming = source.snapshot.sessions.some(session => ["running", "waiting", "retrying"].includes(session.state)
          && session.backendId === provider.backendId && session.model?.providerId === provider.id);
        if (!row) {
          sources.push({ kind: "payg", id, providerId: actionId ?? id, logoSvg: MARK, name: text(provider.name), billing: provider.kind === "subscription" ? "subscription" : "api", consuming });
          continue;
        }
        const windowKind = (window: ProviderAccountUsageWindowView | undefined): "session" | "week" => (window?.windowMinutes ?? 0) >= 1440 ? "week" : "session";
        const windows = [...quotaWindow(row.primaryWindow, windowKind(row.primaryWindow)), ...quotaWindow(row.secondaryWindow, "week"),
          ...(buckets.length ? [] : usage?.modelWindows?.slice(0, 80).flatMap(window => quotaWindow(window.window, "scoped", window.displayName)) ?? [])];
        const balance = row.credits?.balance;
        const credits = balance !== undefined && /^\d+(?:\.\d+)?$/u.test(balance) && Number.isFinite(Number(balance)) ? Number(balance) : null;
        const value: MenubarSubscriptionInput = { kind: "subscription", id, providerId: actionId ?? id, family: "generic", logoSvg: MARK,
          brand: text(`${provider.name}${buckets[index]?.displayName ? ` · ${buckets[index]!.displayName}` : ""}`), account: null,
          plan: row.planType ? text(row.planType) : null, windows, credits, creditsUnlimited: row.credits?.unlimited === true,
          prepaidUsd: null, updatedAtMs: row.observedAt ?? null, consuming,
          ...(usage?.resetCredits ? { resetCredits: { count: Math.floor(positive(usage.resetCredits.availableCount)),
            earliestExpiryMs: usage.resetCredits.earliestExpiryAt ?? null } } : {}),
          ...(source.epoch === undefined ? {} : { device: { id: source.profile.id, name: text(source.profile.name) } }) };
        sources.push(value);
      }
    }
    const report = new Map((reading?.tasks ?? []).filter(entry => entry.sessionId).map(entry => [entry.sessionId, entry]));
    const visible = source.snapshot.sessions.filter(session => !session.hidden && (report.has(session.id) || ["running", "waiting", "retrying"].includes(session.state)));
    for (const session of visible) {
      const entry = report.get(session.id), id = await opaque("task", [...profileKey(source.profile), source.snapshot.generation.toString(),
        source.epoch ?? null, source.connectionGeneration ?? null, session.id, session.generation.toString()]);
      const running = ["running", "waiting", "retrying"].includes(session.state);
      tasks.push({ sessionId: id, title: text(`${session.name}${source.epoch === undefined ? "" : ` · ${source.profile.name}`}`),
        harness: harness(source, session.backendId), model: text(session.model?.name ?? entry?.modelId ?? ""), tokensToday: positive(entry?.summary.usage.totalTokens),
        valueToday: entry && currency ? amount(entry.summary, currency) : 0, contextPercent: session.context ? session.context.utilizationRatio * 100 : null,
        running, startedAtMs: session.activeRunStartedAt ?? null, lastActiveAtMs: session.updatedAt });
      routes.set(id, { source, sessionId: session.id, generation: session.generation });
    }
    // History can include deleted/archived groups absent from the live directory. Keep their accounting,
    // while the missing native generation deliberately grants no navigation action.
    for (const entry of reading?.tasks ?? []) {
      if (visible.some(session => session.id === entry.sessionId) || source.snapshot.sessions.some(session => session.id === entry.sessionId && session.hidden)) continue;
      const id = await opaque("history-task", [...profileKey(source.profile), source.snapshot.generation.toString(), entry.key]);
      tasks.push({ sessionId: id, title: text(entry.title), harness: harness(source, entry.backendId), model: text(entry.modelId),
        tokensToday: positive(entry.summary.usage.totalTokens), valueToday: currency ? amount(entry.summary, currency) : 0,
        contextPercent: null, running: false, startedAtMs: null, lastActiveAtMs: entry.measuredAt });
    }
  }
  tasks.sort((a, b) => Number(b.running) - Number(a.running) || b.tokensToday - a.tokensToday);
  const view = buildMenubarView({ nowMs: input.now, locale, moneySymbol, settings: input.settings, sources, tasks: tasks.slice(0, 500),
    usage: { days, scopes: { local: makeScope(local), all: makeScope(selected) } },
    updatedAtMs: displayed.reduce<number | null>((at, source) => {
      const generated = input.readings.get(desktopMenuBarSourceKey(source))?.value?.history.generatedAt;
      return generated === undefined ? at : at === null ? generated : Math.min(at, generated);
    }, null), harnessLogos: { first: MARK, second: MARK, other: MARK }, uiStrings, t,
    ...(local.length === 0 ? { gate: "connection" as const } : {}) });
  for (const detail of Object.values(view.details)) {
    const action = detailActions.get(detail.id);
    detail.action = action ? { kind: "new-task", providerId: action.id } : { kind: "open-app" };
    detail.actionLabel = action ? t("action.newTask", { name: text(action.name) }) : uiStrings.openApp!;
  }
  for (const scope of ["local", "all"] as const) {
    // Leave room for failure/currency/omission notices after a long node list.
    const note = view.usage.scopes[scope].note;
    if (note.length > 2048) view.usage.scopes[scope].note = note.slice(0, 2047) + "…";
    const missing = (scope === "local" ? local : selected).some(source => !input.readings.get(desktopMenuBarSourceKey(source))?.value
      || input.readings.get(desktopMenuBarSourceKey(source))?.failed);
    if (missing) view.usage.scopes[scope].note += locale === "zh-CN" ? "\n部分节点用量读取失败或尚未完成；不代表零用量。" : "\nSome node usage is unavailable or still loading; this does not mean zero usage.";
    if ((scope === "local" ? local : selected).some(source => input.readings.get(desktopMenuBarSourceKey(source))?.value?.accountRefreshFailed)) {
      view.usage.scopes[scope].note += locale === "zh-CN" ? "\n部分订阅额度刷新失败，保留原观测时间。" : "\nSome subscription quotas could not refresh; their original observation times are retained.";
    }
    for (const source of scope === "local" ? local : selected) {
      const reading = input.readings.get(desktopMenuBarSourceKey(source));
      if (reading?.failed && reading.value) view.usage.scopes[scope].note += locale === "zh-CN"
        ? `\n${text(source.profile.name)} 上次成功读取：${new Date(reading.value.history.generatedAt).toLocaleString(locale)}。`
        : `\n${text(source.profile.name)} last successful read: ${new Date(reading.value.history.generatedAt).toLocaleString(locale)}.`;
    }
    if (!currency) view.usage.scopes[scope].note += locale === "zh-CN" ? "\n多币种金额不可比较，未合并金额。" : "\nAmounts in different currencies are not comparable; monetary totals are unavailable.";
  }
  if (!currency) { view.statusTextByMode.today = null; view.statusTextByMode.task = null; }
  if (displayed.some(source => !input.readings.get(desktopMenuBarSourceKey(source))?.value || input.readings.get(desktopMenuBarSourceKey(source))?.failed)) {
    view.moneySymbol = ""; view.statusTextByMode.today = null; view.statusTextByMode.task = null;
  }
  // The private native boundary has one shared byte budget. Preserve settings and quota before
  // dropping the least active task/model rows, then bound exceptional large Provider catalogs.
  let omitted = tasks.length > 500 || input.sources.length > 500 || displayed.some(source => source.snapshot.providers.length > 500
    || source.snapshot.providers.some(provider => (provider.accountUsage?.modelWindows?.length ?? 0) > 80));
  const boundDisplay = (value: unknown): void => {
    if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") (value as Record<string, unknown>)[key] = text(child);
      else boundDisplay(child);
    }
  };
  boundDisplay(view);
  const withinBudget = (): boolean => {
    let nodes = 0;
    const visit = (value: unknown): boolean => {
      if (++nodes > 35_000) return false;
      return value === null || typeof value !== "object" || Object.values(value).every(visit);
    };
    return visit(view) && JSON.stringify(view).length <= 475_000;
  };
  while (!withinBudget()) {
    if (view.tasks.length) { view.tasks.splice(Math.floor(view.tasks.length * 0.8)); omitted = true; continue; }
    const scope = view.usage.scopes;
    const rows = [scope.local.models["90"], scope.local.models["30"], scope.local.models["7"],
      scope.all.models["90"], scope.all.models["30"], scope.all.models["7"]].find(rows => rows.length > 0);
    if (rows) { rows.splice(Math.floor(rows.length * 0.8)); omitted = true; continue; }
    if (!view.manage.length) break;
    // Each tail row removes the same source/detail identities. Find the largest
    // fitting prefix without serializing the entire large catalog once per row.
    const manage = view.manage, sourceCells = view.sources, details = view.details;
    const keep = (count: number): void => {
      const removed = new Set(manage.slice(count).map(row => row.id));
      view.manage = manage.slice(0, count);
      view.sources = sourceCells.filter(source => !removed.has(source.id));
      view.details = Object.fromEntries(Object.entries(details).filter(([id]) => !removed.has(id)));
    };
    let fitting = 0, oversized = manage.length;
    while (fitting + 1 < oversized) {
      const count = Math.floor((fitting + oversized) / 2);
      keep(count);
      if (withinBudget()) fitting = count; else oversized = count;
    }
    keep(fitting); omitted = true;
    break;
  }
  if (omitted) for (const scope of ["local", "all"] as const) view.usage.scopes[scope].note += locale === "zh-CN"
    ? "\n部分条目超过菜单栏显示预算，请在应用中查看完整用量。" : "\nSome entries exceed the menu bar display budget; open the app for the complete usage report.";
  boundDisplay(view);
  return { view, routes: new Map([...routes].filter(([id]) => view.tasks.some(task => task.sessionId === id))),
    providerRoutes: new Map([...providerRoutes].filter(([id]) => Object.values(view.details).some(detail => detail.action.kind === "new-task" && detail.action.providerId === id))),
    sourceKeys: new Set(input.sources.map(desktopMenuBarSourceKey)) };
}

function currentSource(source: DesktopMenuBarSource, state: ControllerState): AppSnapshot | undefined {
  const saved = state.profiles.find(profile => profile.id === source.profile.id);
  if (!saved || JSON.stringify(profileKey(saved)) !== JSON.stringify(profileKey(source.profile))) return undefined;
  const active = state.connectionState === "connected" && state.activeProfile?.id === saved.id;
  if (active && JSON.stringify(profileKey(state.activeProfile!)) !== JSON.stringify(profileKey(saved))) return undefined;
  if (source.epoch === undefined && (!active || state.connectionGeneration !== source.connectionGeneration)) return undefined;
  const snapshot = active ? state.snapshot : state.nativeTaskStatusLiveSources?.find(row => row.profile.id === saved.id
    && row.epoch === source.epoch && JSON.stringify(profileKey(row.profile)) === JSON.stringify(profileKey(saved)))?.snapshot;
  return snapshot?.generation === source.snapshot.generation ? snapshot : undefined;
}
export function desktopMenuBarRouteCurrent(route: DesktopMenuBarRoute, state: ControllerState): boolean {
  return currentSource(route.source, state)?.sessions.some(session => session.id === route.sessionId
    && session.generation === route.generation && !session.hidden) === true;
}
export function desktopMenuBarProviderRouteCurrent(route: DesktopMenuBarProviderRoute, state: ControllerState): boolean {
  const snapshot = route.source.epoch === undefined ? currentSource(route.source, state) : undefined;
  return !!snapshot && newSessionProviderModel(snapshot, route.backendId, route.providerId, route.modelId) !== undefined;
}

/** Main-window only bridge. Data reads never change the active node, and auxiliary windows never publish. */
export function useDesktopMenuBar(controller: AppController, ownsProjection: boolean): void {
  const latest = useRef(controller); latest.current = controller;
  const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
  const api = desktop?.capabilities.includes("native.menuBar") ? desktop.menuBar : undefined;
  const owner = useRef(`renderer:${randomUuid()}`), revision = useRef(0n), projection = useRef<DesktopMenuBarProjection | undefined>(undefined);
  const [settings, setSettings] = useState<MenubarSettings>(), [available, setAvailable] = useState(false), [refresh, setRefresh] = useState(0),
    [readings, setReadings] = useState<ReadonlyMap<string, UsageReading>>(new Map());
  const sources = useMemo(() => desktopMenuBarSources(controller.state), [controller.state.activeProfile, controller.state.connectionState,
    controller.state.connectionGeneration, controller.state.snapshot, controller.state.profiles, controller.state.nativeTaskStatusLiveSources,
    controller.state.preferences.machineSelection]);
  const sourcesRef = useRef(sources); sourcesRef.current = sources;
  const key = sources.map(desktopMenuBarSourceKey).sort().join("\n");
  useEffect(() => {
    if (!api || !ownsProjection) return;
    let current = true, settingsChanged = false;
    const unsubscribe = api.onSettings(value => { settingsChanged = true; if (current) setSettings(value); });
    void api.get().then(value => { if (current) { setAvailable(value.available); if (!settingsChanged) setSettings(value.settings); } }).catch(() => undefined);
    return () => { current = false; unsubscribe(); };
  }, [api, ownsProjection, refresh]);
  useEffect(() => {
    if (!api || !ownsProjection || !available || !settings?.enabled || !controller.readDesktopMenuBarUsage) return;
    const abort = new AbortController(); let timer: number | undefined, refreshAccounts = true;
    const round = async (): Promise<void> => {
      const captured = sourcesRef.current;
      const results = await Promise.allSettled(captured.map(source => latest.current.readDesktopMenuBarUsage!(source, abort.signal, refreshAccounts)));
      refreshAccounts = false;
      if (abort.signal.aborted) return;
      setReadings(previous => new Map(captured.map((source, index) => {
        const id = desktopMenuBarSourceKey(source), result = results[index]!;
        return [id, result.status === "fulfilled" ? { value: result.value } : { ...previous.get(id), failed: true }] as const;
      })));
      timer = window.setTimeout(() => { void round(); }, 30_000);
    };
    void round(); return () => { abort.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [api, ownsProjection, available, key, settings?.enabled, refresh]);
  useEffect(() => {
    if (!api || !ownsProjection || !available || !settings) return;
    let current = true;
    const publish = (value: DesktopMenuBarProjection): void => {
      if (!current) return; projection.current = value;
      void api.publish({ ownerId: owner.current, revision: (++revision.current).toString(), view: value.view }).catch(() => undefined);
    };
    void projectDesktopMenuBar({ sources, readings, settings, locale: controller.state.effectiveLocale, now: Date.now() }).then(publish).catch(() => {
      if (current) void projectDesktopMenuBar({ sources: [], readings: new Map(), settings,
        locale: controller.state.effectiveLocale, now: Date.now() }).then(publish).catch(() => undefined);
    });
    return () => { current = false; projection.current = undefined; };
  }, [api, ownsProjection, available, settings, sources, readings, controller.state.effectiveLocale]);
  useEffect(() => {
    if (!api || !ownsProjection) return;
    return api.onAction(action => {
      if (action.type === "refresh") { setRefresh(value => value + 1); return; }
      const current = latest.current, view = projection.current?.view;
      if (action.type === "open-provider-settings") { current.navigate({ kind: "settings" }, { exactHash: "#/settings/providers" }); return; }
      if (action.type === "low-alert") {
        const desktop = window.jokoDesktop;
        const currentKeys = new Set(desktopMenuBarSources(current.state).map(desktopMenuBarSourceKey));
        if (view && !view.gate && [...projection.current!.sourceKeys].every(key => currentKeys.has(key))
          && view.settings.lowAlert && current.state.preferences.sessionNotificationsEnabled
          && desktop?.capabilities.includes("notifications.session")) {
          void desktop.notify({ title: text(view.headlinePrimary).slice(0, 160),
            body: text(view.headlineSecondary ?? MENU_BAR_MESSAGES[current.state.effectiveLocale === "zh-CN" ? "zh-CN" : "en"]["notify.lowBody"]!).slice(0, 1024) }).catch(() => undefined);
        }
        return;
      }
      if (action.type === "new-task") {
        const route = projection.current?.providerRoutes.get(action.id);
        if (!route || !desktopMenuBarProviderRouteCurrent(route, current.state)) return;
        const isCurrent = () => desktopMenuBarProviderRouteCurrent(route, latest.current.state);
        // The seed stays in memory; replace keeps it in the guarded controller route without
        // serializing connection identity into a link that could replay against another node.
        current.navigate({ kind: "newSession", initialModel: { requestId: randomUuid(), profile: route.source.profile,
          connectionGeneration: route.source.connectionGeneration!, snapshotGeneration: route.source.snapshot.generation.toString(),
          backendId: route.backendId, providerId: route.providerId, modelId: route.modelId } }, { replace: true, isCurrent });
        return;
      }
      if (action.type !== "open-session") return;
      const route = projection.current?.routes.get(action.id);
      if (!route || !desktopMenuBarRouteCurrent(route, current.state)) return;
      const isCurrent = () => desktopMenuBarRouteCurrent(route, latest.current.state);
      if (route.source.epoch === undefined) current.navigate({ kind: "session", sessionId: route.sessionId }, { isCurrent });
      else void current.openMachineSession(route.source.profile.id, route.sessionId, { expectedGeneration: route.generation, isCurrent }).catch(() => undefined);
    });
  }, [api, ownsProjection]);
}
