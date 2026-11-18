import { createContext, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { ChevronDown, MonitorSmartphone } from "lucide-react";
import { taskActivityMessages, type TaskActivityDevice, type TaskActivityState } from "@joko/contracts";
import { followTaskActivity, type TaskActivityPort } from "@joko/connection-transport";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Modal } from "./ui.js";
import "./task-activity.css";

interface ActivityContext {
  readonly view?: (sessionId: string) => () => void;
  readonly preferenceKey: string;
  readonly devices: readonly TaskActivityDevice[];
  readonly inlineCount: number;
  readonly inline: (delta: number) => void;
  readonly locale: string;
  readonly manage: () => void;
  readonly confirm: (device: TaskActivityDevice) => void;
}
const Activity = createContext<ActivityContext | undefined>(undefined);
const collapsed = new Map<string, boolean>();
const empty: readonly TaskActivityDevice[] = Object.freeze([]);

export function TaskActivityProvider({ controller, t, children }: PropsWithChildren<{ readonly controller: AppController; readonly t: Translator }>) {
  const { state } = controller, profile = state.activeProfile;
  const preferenceKey = JSON.stringify([profile?.serverId, profile?.origin, profile?.id, profile?.endpointPublicKey]);
  const owner = state.connectionState === "connected" && profile && state.sessionAccess?.role !== "guest"
    ? JSON.stringify([preferenceKey, state.connectionGeneration, state.snapshot.generation.toString()]) : undefined;
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const port = useMemo(() => { if (!owner) return undefined; try { return controller.taskActivity?.(); } catch { return undefined; } }, [owner, controller.taskActivity]);
  const [views, setViews] = useState<ReadonlyMap<symbol, { readonly owner: string; readonly sessionId: string }>>(() => new Map());
  const view = useMemo(() => !owner || !port ? undefined : (sessionId: string) => {
    const lease = Symbol();
    setViews(current => new Map(current).set(lease, { owner, sessionId }));
    return () => setViews(current => {
      const next = new Map(current);
      next.delete(lease);
      return next;
    });
  }, [owner, port]);
  const scope = useMemo(() => {
    const ids = new Set<string>();
    for (const view of views.values()) {
      if (view.owner === owner && state.snapshot.sessions.some(session => session.id === view.sessionId)) ids.add(view.sessionId);
    }
    return JSON.stringify([...ids].sort());
  }, [owner, views, state.snapshot.sessions]);
  const [projection, setProjection] = useState<{ readonly owner: string; readonly value?: TaskActivityState; readonly revision?: bigint }>();
  const [inlineCount, setInlineCount] = useState(0);
  const inline = useMemo(() => (delta: number) => setInlineCount(count => count + delta), []);
  const [confirmation, setConfirmation] = useState<{ readonly owner: string; readonly port: TaskActivityPort; readonly device: TaskActivityDevice }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const flight = useRef<object | undefined>(undefined);
  useEffect(() => {
    if (!port || !owner) return;
    const abort = new AbortController();
    const scopedPort: TaskActivityPort = {
      ...port,
      async *watch(ids, signal) {
        try { yield* port.watch(ids, signal); }
        catch (error) {
          if (!ids.length || !(error instanceof ConnectError) || error.code !== Code.NotFound) throw error;
          // An already-mounted task can disappear before the catalog observes its deletion.
          signal.throwIfAborted();
          yield* port.watch([], signal);
        }
      }
    };
    // Each Document uses one connection to both observe peers and report its mounted panes.
    void followTaskActivity(scopedPort, JSON.parse(scope) as string[], state.snapshot.generation, abort.signal, value => {
      if (abort.signal.aborted || ownerRef.current !== owner) return;
      setProjection(previous => {
        const revision = previous?.owner === owner ? previous.revision : undefined;
        return value && revision !== undefined && value.revision < revision ? previous : { owner, value, revision: value?.revision ?? revision };
      });
    });
    return () => abort.abort();
  }, [owner, port, scope, state.snapshot.generation]);
  useEffect(() => { setProjection(undefined); }, [owner, port]);
  useEffect(() => { setConfirmation(undefined); setBusy(false); setError(false); flight.current = undefined; }, [owner]);
  useEffect(() => { ownerRef.current = owner; return () => { ownerRef.current = undefined; }; }, [owner]);
  const devices = port && projection?.owner === owner ? projection?.value?.activeDevices.filter(device => device.deviceId !== profile?.deviceId) ?? empty : empty;
  const m = taskActivityMessages(state.effectiveLocale);
  const currentConfirmation = confirmation?.owner === owner ? confirmation : undefined;
  const revoke = async () => {
    const target = currentConfirmation;
    if (!target || busy || flight.current || ownerRef.current !== target.owner) return;
    const token = {}; flight.current = token; setBusy(true); setError(false);
    try {
      await target.port.revoke(target.device.deviceId);
      if (ownerRef.current === target.owner && flight.current === token) setConfirmation(undefined);
    } catch { if (ownerRef.current === target.owner && flight.current === token) setError(true); }
    finally { if (ownerRef.current === target.owner && flight.current === token) { flight.current = undefined; setBusy(false); } }
  };
  return <Activity.Provider value={{ view, preferenceKey, devices, inlineCount, inline,
    locale: state.effectiveLocale, manage: () => controller.navigate({ kind: "settings" }, { exactHash: "#/settings/connections" }),
    confirm: device => { if (port && owner) { setConfirmation({ owner, port, device: { ...device } }); setError(false); } } }}>
    {children}
    <Modal open={currentConfirmation !== undefined} title={m.title} description={m.body(currentConfirmation?.device.displayName ?? "")}
      onClose={() => { if (!busy) setConfirmation(undefined); }} dialogRole="alertdialog" size="small">
      {error && <p role="alert">{m.failed}</p>}
      <div className="task-activity-confirm-actions"><Button disabled={busy} onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button>
        <Button tone="danger" disabled={busy} onClick={() => { void revoke(); }}>{m.revoke}</Button></div>
    </Modal>
  </Activity.Provider>;
}

/** Split panes independently contribute to their own Document's activity scope. */
export function useTaskActivityView(sessionId: string | undefined): void {
  const view = useContext(Activity)?.view;
  useEffect(() => {
    if (view && sessionId) return view(sessionId);
  }, [view, sessionId]);
}

export function TaskActivityBanner({ sessionId }: { readonly sessionId?: string }) {
  const context = useContext(Activity);
  const [folded, setFolded] = useState<{ readonly key: string; readonly value: boolean }>();
  const inline = context?.inline;
  useEffect(() => { if (!sessionId || !inline) return; inline(1); return () => inline(-1); }, [sessionId, inline]);
  if (!context || !context.devices.length || !sessionId && context.inlineCount > 0) return null;
  const m = taskActivityMessages(context.locale), first = context.devices[0]!;
  const label = m.label(first.displayName, context.devices.length);
  const key = JSON.stringify([context.preferenceKey, sessionId]);
  const isCollapsed = sessionId !== undefined && (folded?.key === key ? folded.value : collapsed.get(key) === true);
  const fold = (value: boolean) => {
    collapsed.delete(key); collapsed.set(key, value);
    if (collapsed.size > 512) collapsed.delete(collapsed.keys().next().value!);
    setFolded({ key, value });
  };
  return <aside className={`task-activity ${sessionId ? "task-activity--inline" : "task-activity--floating"}`} aria-label={label}>
    {isCollapsed ? <IconButton label={`${m.expand}: ${label}`} onClick={() => fold(false)}><MonitorSmartphone aria-hidden="true" /></IconButton>
      : <div className="task-activity__chip">
        <MonitorSmartphone aria-hidden="true" />
        <span role="status" title={context.devices.map(device => device.displayName).join(" · ")}>{label}</span>
        <Button tone="ghost" onClick={() => context.devices.length === 1 ? context.confirm({ ...first }) : context.manage()}>
          {context.devices.length === 1 ? m.revoke : m.manage}</Button>
        {sessionId && <IconButton label={m.collapse} onClick={() => fold(true)}><ChevronDown aria-hidden="true" /></IconButton>}
      </div>}
  </aside>;
}
