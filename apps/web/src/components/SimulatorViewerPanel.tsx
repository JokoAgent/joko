import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { AlertTriangle, Play, RefreshCcw, ShieldCheck } from "lucide-react";
import type { AppController } from "../controller.js";
import type {
  SimulatorViewerControlView, SimulatorViewerInstanceView, SimulatorViewerStateView
} from "../model.js";
import { randomUuid } from "../web-crypto.js";
import type { Translator } from "./types.js";
import { Button, Modal } from "./ui.js";
import { SimulatorViewerScreen } from "./SimulatorViewerScreen.js";
import "./simulator-viewer.css";

export function SimulatorViewerPanel({ controller, sessionId, active, t }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly active: boolean;
  readonly t: Translator;
}): JSX.Element {
  const [state, setState] = useState<SimulatorViewerStateView>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [mutationPending, setMutationPending] = useState(false);
  const [name, setName] = useState("");
  const [templateUdid, setTemplateUdid] = useState("");
  const [attachUdid, setAttachUdid] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<SimulatorViewerInstanceView>();
  const [ownerDocument, setOwnerDocument] = useState<Document>(() => document);
  const panel = useRef<HTMLDivElement | null>(null);
  const owner = useRef<AbortController | undefined>(undefined);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const connected = controller.state.connectionState === "connected";
  const profileId = controller.state.activeProfile?.id;
  const enabled = active && connected;

  const refresh = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    setLoading(true);
    try {
      const next = await controllerRef.current.getSimulatorViewerState(sessionId, signal);
      if (!signal.aborted) { setState(next); setError(undefined); setMutationError(undefined); }
      return !signal.aborted;
    } catch (cause) {
      if (!signal.aborted) setError(messageOf(cause));
      return false;
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    owner.current?.abort();
    const next = new AbortController();
    owner.current = next;
    setState(undefined);
    setError(undefined);
    setPending(false);
    setMutationPending(false);
    setMutationError(undefined);
    setDeleteCandidate(undefined);
    if (enabled) void refresh(next.signal);
    return () => { next.abort(); if (owner.current === next) owner.current = undefined; };
  }, [enabled, profileId, refresh, sessionId]);

  const observedInstance = state?.instances[0];
  const observedRouteKey = observedInstance === undefined ? "" : `${observedInstance.route.instanceId}:` +
    `${observedInstance.route.generation}:${observedInstance.route.leaseId}`;
  useEffect(() => {
    if (!enabled || !observedInstance) return;
    const polling = new AbortController();
    let reading = false;
    const read = async (): Promise<void> => {
      if (reading || polling.signal.aborted) return;
      reading = true;
      try {
        const mutation = await controllerRef.current.getSimulatorViewerMutationState(
          sessionId, observedInstance.route, polling.signal);
        if (polling.signal.aborted) return;
        setState(previous => previous === undefined ? previous : {
          ...previous,
          instances: previous.instances.map(instance =>
            instance.route.instanceId !== mutation.instanceId ||
            instance.route.generation !== observedInstance.route.generation ||
            instance.route.leaseId !== observedInstance.route.leaseId ||
            sameMutation(instance.mutation, mutation)
              ? instance : { ...instance, mutation })
        });
      } catch { /* Lifecycle refresh owns stale routes; polling never replaces visible state. */ }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 400);
    return () => { polling.abort(); clearInterval(timer); };
  }, [enabled, observedRouteKey, sessionId]);

  const run = async (input: SimulatorViewerControlView): Promise<void> => {
    const signal = owner.current?.signal;
    if (!signal || signal.aborted || !enabled || pending || loading || error !== undefined ||
        state?.support !== "supported" ||
        (input.action === "create" || input.action === "attach") && state.instances.length > 0) return;
    setPending(true);
    setError(undefined);
    try {
      await controllerRef.current.controlSimulatorInstance(sessionId, randomUuid(), input, signal);
      if (!signal.aborted) {
        setDeleteCandidate(undefined);
        await refresh(signal);
      }
    } catch (cause) {
      if (!signal.aborted) {
        // A transport or service failure can follow dispatch. Observe; never blindly resend it.
        setError(`${t("simulator.actionUnconfirmed")} ${messageOf(cause)}`);
        try { setState(await controllerRef.current.getSimulatorViewerState(sessionId, signal)); }
        catch { /* Keep the explicit uncertain result until the user refreshes. */ }
      }
    } finally {
      if (!signal.aborted) setPending(false);
    }
  };

  const devices = state?.devices.filter(device => device.available) ?? [];
  const chosenTemplate = devices.some(device => device.udid === templateUdid) ? templateUdid : devices[0]?.udid ?? "";
  const chosenAttach = devices.some(device => device.udid === attachUdid) ? attachUdid : devices[0]?.udid ?? "";
  const canMutate = enabled && state?.support === "supported" && !pending && !loading && error === undefined;
  const canAdd = canMutate && state?.instances.length === 0;
  const currentDelete = state?.instances.find(instance => instance.route.instanceId === deleteCandidate?.route.instanceId &&
    instance.route.generation === deleteCandidate?.route.generation &&
    instance.route.leaseId === deleteCandidate?.route.leaseId && instance.creationProvenance === "joko");

  const setMutationControl = async (instance: SimulatorViewerInstanceView,
    agentPaused: boolean): Promise<void> => {
    const signal = owner.current?.signal;
    if (!signal || signal.aborted || !enabled || mutationPending || pending || loading ||
        state?.support !== "supported") return;
    setMutationPending(true);
    setMutationError(undefined);
    try {
      const mutation = await controllerRef.current.setSimulatorViewerMutationControl(
        sessionId, instance.route, agentPaused, signal);
      if (!signal.aborted) setState(previous => previous === undefined ? previous : {
        ...previous,
        instances: previous.instances.map(current => current.route.instanceId === mutation.instanceId
          ? { ...current, mutation } : current)
      });
    } catch (cause) {
      if (!signal.aborted) setMutationError(`${t("simulator.mutationControlFailed")} ${messageOf(cause)}`);
    } finally { if (!signal.aborted) setMutationPending(false); }
  };

  return <div className="simulator-viewer" ref={(node) => {
    panel.current = node;
    if (node && node.ownerDocument !== ownerDocument) setOwnerDocument(node.ownerDocument);
  }}>
    <header className="simulator-viewer__header">
      <div><p className="eyebrow">{t("simulator.eyebrow")}</p><h2>{t("simulator.title")}</h2></div>
      <Button tone="ghost" disabled={!enabled || loading || pending} onClick={() => { const signal = owner.current?.signal; if (signal) void refresh(signal); }}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button>
    </header>
    {!connected && <p role="status" className="simulator-viewer__notice">{t("simulator.disconnected")}</p>}
    {connected && loading && state === undefined && <p role="status" className="simulator-viewer__notice">{t("common.loading")}</p>}
    {error && <div className="inline-error" role="alert"><AlertTriangle aria-hidden="true" /><p>{error}</p><Button disabled={!enabled || pending} onClick={() => { const signal = owner.current?.signal; if (signal) void refresh(signal); }}>{t("common.refresh")}</Button></div>}
    {state && <>
      {state.support !== "supported" && <p role="status" className="simulator-viewer__notice">{t("simulator.unavailable")}{state.reasonCode ? ` (${state.reasonCode})` : ""}</p>}
      <section className="simulator-viewer__section" aria-labelledby="simulator-instances-title">
        <h3 id="simulator-instances-title">{t("simulator.instances")}</h3>
        {state.instances.length === 0 && <p className="muted">{t("simulator.noInstances")}</p>}
        <div className="simulator-viewer__grid">
          {state.instances.map(instance => <article className="simulator-viewer__card" key={instance.route.instanceId} aria-label={instance.simulatorName}>
            <div className="simulator-viewer__card-header"><h4>{instance.simulatorName}</h4><span>{instance.creationProvenance === "joko" ? t("simulator.createdHere") : t("simulator.external")}</span></div>
            {(instance.mutation.activeSource === "agent" || instance.mutation.queuedAgentMutations > 0 ||
              instance.mutation.agentPaused) && <div className="simulator-viewer__mutation" role="status">
              <div><strong>{instance.mutation.takeoverPending
                ? t("simulator.takeoverPendingTitle")
                : instance.mutation.agentPaused ? t("simulator.manualControlTitle")
                  : t("simulator.agentBusyTitle")}</strong>
              <p>{instance.mutation.takeoverPending
                ? t("simulator.takeoverPendingDescription")
                : instance.mutation.agentPaused ? t("simulator.manualControlDescription")
                  : t("simulator.agentBusyDescription")}</p></div>
              <Button tone="ghost" disabled={mutationPending || instance.mutation.takeoverPending || pending}
                onClick={() => void setMutationControl(instance, !instance.mutation.agentPaused)}>
                {instance.mutation.agentPaused ? <Play aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
                {t(instance.mutation.agentPaused ? "simulator.resumeAgentInput" : "simulator.takeControl")}
              </Button>
            </div>}
            <SimulatorViewerScreen key={`${instance.route.instanceId}:${instance.route.generation}:${instance.route.leaseId}`}
              controller={controller} sessionId={sessionId} route={instance.route}
              enabled={canMutate && instance.lifecycleState === "ready" && instance.viewerState === "attached"}
              controlEnabled={canMutate && !mutationPending && !instance.mutation.takeoverPending &&
                instance.mutation.activeSource !== "agent" && instance.mutation.queuedAgentMutations === 0 &&
                instance.lifecycleState === "ready" && instance.viewerState === "attached"}
              onReconcile={async () => {
                const signal = owner.current?.signal;
                if (!signal || signal.aborted || !enabled || !await refresh(signal)) {
                  throw new Error("Simulator state could not be refreshed.");
                }
              }}
              ownerDocument={ownerDocument} t={t} />
            <p className="simulator-viewer__metadata">{instance.simulatorUdid}</p>
            <p className="simulator-viewer__metadata">{t("simulator.state", {
              lifecycle: t(`simulator.lifecycle.${instance.lifecycleState}`),
              viewer: t(`simulator.viewer.${instance.viewerState}`)
            })}</p>
            {instance.errorCode && <p role="status" className="simulator-viewer__metadata">{instance.errorCode}</p>}
            {mutationError && <p className="simulator-viewer__input-error" role="alert">{mutationError}</p>}
            <div className="simulator-viewer__actions">
              {instance.lifecycleState !== "ready" && <Button disabled={!canMutate || mutationPending || instance.mutation.takeoverPending || instance.mutation.activeSource === "agent" || instance.mutation.queuedAgentMutations > 0} onClick={() => void run({ action: "start", route: instance.route })}>{t("simulator.start")}</Button>}
              {instance.lifecycleState === "ready" && <Button disabled={!canMutate || mutationPending || instance.mutation.takeoverPending || instance.mutation.activeSource === "agent" || instance.mutation.queuedAgentMutations > 0} onClick={() => void run({ action: "stop", route: instance.route })}>{t("simulator.stop")}</Button>}
              {instance.viewerState === "attached" && <Button disabled={!canMutate || mutationPending || instance.mutation.takeoverPending || instance.mutation.activeSource === "agent" || instance.mutation.queuedAgentMutations > 0} onClick={() => void run({ action: "detach", route: instance.route })}>{t("simulator.detach")}</Button>}
              {instance.creationProvenance === "joko" && <Button tone="danger" disabled={!canMutate || mutationPending || instance.mutation.takeoverPending || instance.mutation.activeSource === "agent" || instance.mutation.queuedAgentMutations > 0} onClick={() => setDeleteCandidate(instance)}>{t("common.delete")}</Button>}
            </div>
          </article>)}
        </div>
      </section>
      <section className="simulator-viewer__section" aria-labelledby="simulator-add-title">
        <h3 id="simulator-add-title">{t("simulator.addInstance")}</h3>
        <p className="muted">{t("simulator.addDescription")}</p>
        {state.instances.length > 0 && <p className="muted">{t("simulator.onePerTask")}</p>}
        <div className="simulator-viewer__forms">
          <form onSubmit={(event) => { event.preventDefault(); if (chosenTemplate && name.trim() === name && name.length > 0) void run({ action: "create", templateUdid: chosenTemplate, name }); }}>
            <label>{t("simulator.template")}<select value={chosenTemplate} disabled={!canAdd} onChange={(event) => setTemplateUdid(event.target.value)}>{devices.map(device => <option key={device.udid} value={device.udid}>{device.name} · {device.runtimeName}</option>)}</select></label>
            <label>{t("simulator.name")}<input value={name} maxLength={128} disabled={!canAdd} onChange={(event) => setName(event.target.value)} /></label>
            <Button type="submit" disabled={!canAdd || !chosenTemplate || !name || name.trim() !== name}>{t("simulator.create")}</Button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); if (chosenAttach) void run({ action: "attach", deviceUdid: chosenAttach }); }}>
            <label>{t("simulator.existingDevice")}<select value={chosenAttach} disabled={!canAdd} onChange={(event) => setAttachUdid(event.target.value)}>{devices.map(device => <option key={device.udid} value={device.udid}>{device.name} · {device.state}</option>)}</select></label>
            <Button type="submit" disabled={!canAdd || !chosenAttach}>{t("simulator.attach")}</Button>
          </form>
        </div>
      </section>
    </>}
    <Modal open={currentDelete !== undefined} title={t("simulator.deleteTitle")} description={t("simulator.deleteWarning")} dialogRole="alertdialog" closeLabel={t("common.close")} onClose={() => setDeleteCandidate(undefined)} ownerDocument={ownerDocument} restoreFocusFallback={() => panel.current?.querySelector<HTMLButtonElement>(".simulator-viewer__header button") ?? null}>
      {currentDelete && <div className="simulator-viewer__delete"><p><strong>{currentDelete.simulatorName}</strong></p><p className="simulator-viewer__metadata">{currentDelete.simulatorUdid}</p><div className="modal__actions"><Button onClick={() => setDeleteCandidate(undefined)}>{t("common.cancel")}</Button><Button tone="danger" disabled={!canMutate || mutationPending || currentDelete.mutation.takeoverPending || currentDelete.mutation.activeSource === "agent" || currentDelete.mutation.queuedAgentMutations > 0} onClick={() => void run({ action: "delete", route: currentDelete.route })}>{t("simulator.confirmDelete")}</Button></div></div>}
    </Modal>
  </div>;
}

function sameMutation(left: SimulatorViewerInstanceView["mutation"],
  right: SimulatorViewerInstanceView["mutation"]): boolean {
  return left.instanceId === right.instanceId && left.activeSource === right.activeSource &&
    left.lastSource === right.lastSource && left.queuedAgentMutations === right.queuedAgentMutations &&
    left.agentPaused === right.agentPaused && left.takeoverPending === right.takeoverPending;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
