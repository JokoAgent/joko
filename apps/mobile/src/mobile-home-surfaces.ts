import { useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SessionState, type ProviderAccountUsageSnapshot, type ProviderDescriptor, type UsageHistory } from "@joko/contracts";
import { mobileAccountUsageStale, mobileAccountUsageWindows, mobileUsageTimestamp } from "./mobile-account-usage";
import type { MobileClient, MobileState } from "./mobile-client";
import { parseMobileNativeIntent } from "./mobile-native-intent";

export interface HomeSurfaceUsageSource {
  readonly key: string;
  readonly catalog: string;
  readonly providers: readonly ProviderDescriptor[];
  readQuota(provider: ProviderDescriptor, signal: AbortSignal): Promise<ProviderAccountUsageSnapshot | undefined>;
  readUsage(signal: AbortSignal): Promise<UsageHistory | undefined>;
}

interface HomeSurfacesNative {
  apply(sequence: number, owner: string | null, usage: string | null, activity: string | null, mayStart: boolean): Promise<void>;
  pendingWidgetRefresh?(): Promise<string | null>;
  completeWidgetRefresh?(id: string, sequence: number, owner: string | null, usage: string | null): Promise<void>;
  addListener?(event: "onWidgetRefresh", listener: (value: { id: string; expired: boolean }) => void): { remove(): void };
}

const QUOTA_REFRESH = 5 * 60_000;
const ACTIVITY_REFRESH = 60_000;
let nextSequence = 0;

function nativeHomeSurfaces(): HomeSurfacesNative | undefined {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return undefined;
  try {
    const native = requireOptionalNativeModule<HomeSurfacesNative>("JokoHomeSurfaces");
    return typeof native?.apply === "function" ? native : undefined;
  }
  catch { return undefined; }
}

export function homeSurfaceOwner(state: MobileState): string | undefined {
  if (state.status === "unpaired" || state.status === "revoked") return undefined;
  const active = state.activeProfileId ?? (state.status === "connecting" ? state.automaticProfileId : undefined);
  const profile = state.saved.find(item => item.profileId === active);
  if (profile === undefined || ["missing", "unreadable", "identity-conflict"].includes(profile.credentialState)) return undefined;
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([profile.profileId, profile.serverId, profile.connectionId, profile.deviceId]))));
}

export function homeSurfaceActivity(state: MobileState, locale: string, now: number) {
  const profile = state.saved.find(item => item.profileId === state.activeProfileId);
  if (state.status !== "connected" || !profile || state.owner?.server?.serverId !== profile.serverId) return undefined;
  const sessions = state.owner.sessions.filter(session => !session.archived && !session.hidden && session.provisionalDraftId === ""
    && session.derivationOrigin?.sideChat !== true && session.nativeBinding?.runtimeAttached === true
    && (session.state === SessionState.RUNNING || session.state === SessionState.WAITING));
  const priority = (phase: SessionState): number => phase === SessionState.WAITING ? 1 : 0;
  sessions.sort((left, right) => priority(right.state) - priority(left.state)
    || (mobileUsageTimestamp(right.lastActivityAt) ?? 0) - (mobileUsageTimestamp(left.lastActivityAt) ?? 0)
    || left.sessionId.localeCompare(right.sessionId));
  const session = sessions[0];
  if (!session) return undefined;
  const query = new URLSearchParams({ profile: profile.profileId, server: profile.serverId });
  const link = `joko://task/${encodeURIComponent(session.sessionId)}?${query}`;
  const destination = parseMobileNativeIntent(link);
  if (destination?.kind !== "session" || destination.sessionId !== session.sessionId || destination.profileId !== profile.profileId
    || destination.serverId !== profile.serverId) return undefined;
  return {
    title: presentationText(session.displayName, 120) || (locale === "zh-CN" ? "任务" : "Task"),
    phase: session.state === SessionState.WAITING ? "waiting" as const : "running" as const, locale, link, expiresAt: now + 4 * 60_000
  };
}

export async function readHomeSurfaceUsage(source: HomeSurfaceUsageSource, owner: string, locale: string, signal: AbortSignal) {
  const [dailyRead, quotaReads] = await Promise.all([
    source.readUsage(signal).catch(() => undefined),
    Promise.allSettled(source.providers.map(async provider => ({ provider, quota: await source.readQuota(provider, signal) })))
  ]);
  signal.throwIfAborted();
  const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const daily = dailyRead?.days.find(entry => entry.day === day);
  const usDollars = daily?.currencyTotals.find(entry => entry.currencyCode === "USD" && entry.costComplete);
  const usage = daily?.usage === undefined ? undefined : {
    day, totalTokens: daily.usage.totalTokens.toString(),
    ...(usDollars?.usage !== undefined && daily.costComplete && daily.currencyTotals.length === 1 && usDollars.usage.costMicros >= 0n
      ? { costUsd: Number(usDollars.usage.costMicros) / 1_000_000, estimated: daily.estimated || usDollars.estimated } : {})
  };
  const quotas = quotaReads.flatMap(read => {
    if (read.status !== "fulfilled" || read.value.quota === undefined
      || mobileAccountUsageStale(read.value.quota, now)) return [];
    const { quota, provider } = read.value;
    const label = provider.displayName || provider.providerId;
    return mobileAccountUsageWindows(quota, undefined, now).filter(window => !window.model).slice(0, 2).map(window => ({
      title: presentationText(window.minutes === undefined ? label : `${label} · ${durationLabel(window.minutes, locale)}`, 100),
      remaining: Math.round(window.remainingPercent), resetsAt: window.resetAt
    }));
  }).filter(row => row.title !== "").slice(0, 12);
  const endOfDay = Date.parse(day + "T00:00:00.000Z") + 86_400_000;
  return { owner, locale, usage, quotas, expiresAt: Math.min(now + 15 * 60_000, endOfDay) };
}

export function useMobileHomeSurfaces(client: MobileClient, state: MobileState, locale: string, foreground: boolean): void {
  const native = useMemo(nativeHomeSurfaces, []);
  const owner = native === undefined ? undefined : homeSurfaceOwner(state);
  const source = native !== undefined && foreground && owner !== undefined ? client.homeSurfaceUsage?.() : undefined;
  const language = locale === "zh-CN" ? "zh-CN" : "en";
  const hydrated = state.status !== "starting";
  const task = source === undefined || Platform.OS !== "ios" ? undefined : homeSurfaceActivity(state, language, 0);
  const taskKey = task === undefined ? undefined : JSON.stringify(task);
  const current = useRef({ owner, source, task, foreground, language });
  current.current = { owner, source, task, foreground, language };
  const catalog = useRef<{ owner: string; key: string } | undefined>(undefined);
  const requestedRefresh = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!native || !hydrated) return;
    const apply = (usage: string | null = null): Promise<void> => {
      const live = current.current;
      const activity = live.task === undefined ? null : JSON.stringify({ ...live.task, expiresAt: Date.now() + 4 * 60_000 });
      return native.apply(++nextSequence, live.owner ?? null, usage, activity, live.foreground && live.source !== undefined);
    };
    const syncActivity = () => { void apply().catch(() => undefined); };
    syncActivity();
    if (!foreground || taskKey === undefined) return;
    const timer = setInterval(syncActivity, ACTIVITY_REFRESH);
    return () => clearInterval(timer);
  }, [native, hydrated, owner, source !== undefined, foreground, taskKey]);

  useEffect(() => {
    const original = current.current;
    if (!native || !owner || !foreground || !original.source) return;
    const source = original.source;
    const abort = new AbortController();
    const previous = catalog.current;
    catalog.current = { owner, key: source.catalog };
    if (previous?.owner === owner && previous.key !== source.catalog) {
      const live = current.current;
      const activity = live.task === undefined ? null : JSON.stringify({ ...live.task, expiresAt: Date.now() + 4 * 60_000 });
      void native.apply(++nextSequence, owner, "", activity, true).catch(() => undefined);
    }
    let pending = false;
    const read = async (): Promise<void> => {
      if (pending || abort.signal.aborted) return;
      pending = true;
      try {
        const projection = await readHomeSurfaceUsage(source, owner, language, AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]));
        const live = current.current;
        if (abort.signal.aborted || live.owner !== owner || live.source?.key !== source.key || live.language !== language || !live.foreground) return;
        const activity = live.task === undefined ? null : JSON.stringify({ ...live.task, expiresAt: Date.now() + 4 * 60_000 });
        await native.apply(++nextSequence, owner, JSON.stringify(projection), activity, true);
      } catch {
        // The stored projection already has a bounded expiration.
      } finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => void read(), QUOTA_REFRESH);
    return () => { abort.abort(); clearInterval(timer); };
  }, [native, owner, source?.key, foreground, language]);

  useEffect(() => {
    if (Platform.OS !== "ios" || !native?.pendingWidgetRefresh || !native.completeWidgetRefresh || !native.addListener || !owner || foreground) return;
    const complete = native.completeWidgetRefresh.bind(native);
    const abort = new AbortController();
    const refresh = async (id: string): Promise<void> => {
      if (abort.signal.aborted || requestedRefresh.current === id) return;
      requestedRefresh.current = id;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]);
      let data: string | null = null;
      try {
        const { source, verify } = await client.homeSurfaceBackgroundUsage(signal);
        const projection = await readHomeSurfaceUsage(source, owner, language, signal);
        await verify();
        signal.throwIfAborted();
        if (current.current.owner === owner && !current.current.foreground && current.current.language === language) {
          data = JSON.stringify(projection);
        }
      } catch {
        // The last authorized projection expires independently of this refresh.
      } finally {
        await complete(id, ++nextSequence, data === null ? null : owner, data).catch(() => undefined);
      }
    };
    const subscription = native.addListener("onWidgetRefresh", event => {
      if (event.expired) {
        if (requestedRefresh.current === event.id) abort.abort();
      } else void refresh(event.id);
    });
    void native.pendingWidgetRefresh().then(id => { if (id) void refresh(id); }).catch(() => undefined);
    return () => { abort.abort(); subscription.remove(); };
  }, [native, client, owner, foreground, language]);
}

function presentationText(value: string, length: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, length);
}

function durationLabel(minutes: number, locale: string): string {
  const chinese = locale === "zh-CN";
  if (minutes % 1440 === 0) return `${minutes / 1440}${chinese ? " 天" : "d"}`;
  if (minutes % 60 === 0) return `${minutes / 60}${chinese ? " 小时" : "h"}`;
  return `${minutes}${chinese ? " 分钟" : "m"}`;
}
