import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, Copy, ExternalLink, LoaderCircle, ShieldCheck } from "lucide-react";
import type { AppController } from "../controller.js";
import type { ProviderConfigurationView, ProviderLoginFlowView, ProviderLoginMethodView } from "../model.js";
import type { Translator } from "./types.js";
import { ProviderFlowBackButton, ProviderFlowFooter, ProviderWizardProgress } from "./ProviderFlow.js";
import { Button, Modal, SelectControl } from "./ui.js";

const TERMINAL_STATES = new Set<ProviderLoginFlowView["state"]>(["completed", "cancelled", "timedOut", "outcomeUnknown", "failed"]);

interface ProviderLoginDialogProps {
  readonly controller: AppController;
  readonly backendId?: string;
  readonly provider?: Pick<ProviderConfigurationView, "id" | "name" | "kind">;
  readonly loginMethods?: readonly ProviderLoginMethodView[];
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onCompleted?: (target: { readonly backendId: string; readonly providerId: string }) => void;
  readonly onBack?: () => void;
  readonly onUseApiKey?: () => void;
}

export function ProviderLoginDialog(props: ProviderLoginDialogProps): JSX.Element {
  const { controller, backendId, provider, loginMethods } = props;
  const key = JSON.stringify([controller.state.activeProfile?.id, controller.state.activeProfile?.serverId,
    String(controller.state.snapshot.generation), controller.state.connectionState, backendId, provider?.id, provider?.kind, loginMethods]);
  const source = useRef({ begin: controller.beginProviderLogin, key, revision: 0 });
  if (source.current.begin !== controller.beginProviderLogin || source.current.key !== key) {
    source.current = { begin: controller.beginProviderLogin, key, revision: source.current.revision + 1 };
  }
  return <ProviderLoginDialogOwner key={source.current.revision} {...props} />;
}

function ProviderLoginDialogOwner({ controller, backendId, provider, loginMethods, t, onClose, onCompleted, onBack, onUseApiKey }: ProviderLoginDialogProps): JSX.Element {
  const [method, setMethod] = useState<ProviderLoginMethodView>("oauthBrowser");
  const [flow, setFlow] = useState<ProviderLoginFlowView>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [completionAttempt, setCompletionAttempt] = useState(0);
  const owner = useMemo(() => ({ active: true }), []);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const requestInFlight = useRef(false);
  const activeFlowRef = useRef<{ flow: ProviderLoginFlowView; controller: AppController } | undefined>(undefined);
  const current = (source: typeof owner): boolean => source.active && ownerRef.current === source;
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      owner.active = false;
      const active = activeFlowRef.current;
      activeFlowRef.current = undefined;
      if (active !== undefined && !TERMINAL_STATES.has(active.flow.state)) {
        void Promise.resolve().then(() => active.controller.cancelProviderLogin(active.flow.id)).catch(() => undefined);
      }
    };
  }, [owner]);
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const open = provider !== undefined;
  const connected = controller.state.connectionState === "connected";
  const verificationUri = safeExternalUrl(flow?.verificationUri);
  const terminal = flow !== undefined && TERMINAL_STATES.has(flow.state);
  const methods = useMemo<readonly ProviderLoginMethodView[]>(
    () => providerLoginMethods(provider?.kind, loginMethods),
    [loginMethods, provider?.kind]
  );

  useEffect(() => {
    if (!open) {
      setFlow(undefined);
      setInput("");
      setError(undefined);
      setBusy(false);
      setCompletionAttempt(0);
      return;
    }
    const nextMethod = defaultProviderLoginMethod(provider?.kind, loginMethods);
    setMethod(nextMethod);
    setFlow(undefined);
    setInput("");
    setError(undefined);
    setCompletionAttempt(0);
    setBusy(false);
  }, [owner, open]);

  useEffect(() => {
    setInput("");
  }, [flow?.pendingPrompt?.id]);

  useEffect(() => {
    if (flow === undefined || terminal || busy) return;
    let active = true;
    let inFlight = false;
    const poll = (): void => {
      if (inFlight || !current(owner)) return;
      inFlight = true;
      void controllerRef.current.getProviderLoginFlow(flow.id).then((next) => {
        if (!active || !current(owner)) return;
        activeFlowRef.current = { flow: next, controller: controllerRef.current };
        setFlow(next);
      }).catch((cause: unknown) => {
        if (active && current(owner)) setError(errorMessage(cause));
      }).finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(poll, 1_250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [busy, flow?.id, flow?.state, owner, terminal]);

  useEffect(() => {
    if (!open || !current(owner) || flow?.state !== "completed" || backendId === undefined || provider === undefined) return;
    let active = true;
    setBusy(true);
    setError(undefined);
    void controllerRef.current.refresh().then(() => {
      if (!active || !current(owner)) return;
      setBusy(false);
      const completed = onCompletedRef.current;
      if (completed === undefined) onCloseRef.current();
      else completed({ backendId, providerId: provider.id });
    }).catch((cause: unknown) => {
      if (!active || !current(owner)) return;
      setBusy(false);
      setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [backendId, completionAttempt, flow?.id, flow?.state, open, owner, provider?.id]);

  const begin = async (): Promise<void> => {
    if (!connected || backendId === undefined || provider === undefined || requestInFlight.current || !current(owner)) return;
    requestInFlight.current = true;
    const sourceController = controller;
    setBusy(true);
    setError(undefined);
    try {
      const next = await sourceController.beginProviderLogin(backendId, provider.id, method);
      if (!current(owner)) {
        if (!TERMINAL_STATES.has(next.state)) void Promise.resolve().then(() => sourceController.cancelProviderLogin(next.id)).catch(() => undefined);
        return;
      }
      activeFlowRef.current = { flow: next, controller: sourceController };
      setFlow(next);
      const externalUrl = safeExternalUrl(next.verificationUri);
      if (externalUrl !== undefined) {
        await sourceController.openHttpLink(externalUrl, { forceExternal: true });
      }
    } catch (cause) {
      if (current(owner)) setError(errorMessage(cause));
    } finally {
      if (current(owner)) { requestInFlight.current = false; setBusy(false); }
    }
  };

  const submit = async (): Promise<void> => {
    if (!connected || flow?.pendingPrompt === undefined || input.length === 0 || requestInFlight.current || !current(owner)) return;
    requestInFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const next = await controller.submitProviderLoginInput(flow, input);
      if (!current(owner)) return;
      activeFlowRef.current = { flow: next, controller };
      setInput("");
      setFlow(next);
    } catch (cause) {
      if (current(owner)) {
        setInput("");
        setError(errorMessage(cause));
      }
    } finally {
      if (current(owner)) { requestInFlight.current = false; setBusy(false); }
    }
  };

  const cancel = async (closeAfter = false): Promise<void> => {
    if (!current(owner)) return;
    if (closeAfter) owner.active = false;
    setInput("");
    setError(undefined);
    if (flow !== undefined && !TERMINAL_STATES.has(flow.state)) {
      setBusy(true);
      activeFlowRef.current = undefined;
      try {
        const next = await controller.cancelProviderLogin(flow.id);
        if (current(owner)) setFlow(next);
      } catch (cause) {
        if (!closeAfter && current(owner)) setError(errorMessage(cause));
      } finally {
        if (current(owner)) setBusy(false);
      }
    }
    if (closeAfter && ownerRef.current === owner) onClose();
  };

  const back = async (): Promise<void> => {
    if (!current(owner)) return;
    if (onBack === undefined) {
      await cancel(true);
      return;
    }
    setInput("");
    setError(undefined);
    if (flow !== undefined && !TERMINAL_STATES.has(flow.state)) {
      setBusy(true);
      activeFlowRef.current = undefined;
      try {
        const next = await controller.cancelProviderLogin(flow.id);
        if (!current(owner)) return;
        setFlow(next);
      } catch (cause) {
        if (current(owner)) setError(errorMessage(cause));
        return;
      } finally {
        if (current(owner)) setBusy(false);
      }
    }
    if (current(owner)) { owner.active = false; onBack(); }
  };

  const retry = (): void => {
    setFlow(undefined);
    setInput("");
    setError(undefined);
  };

  return <Modal
    open={open}
    title={onBack === undefined
      ? t("providerLogin.title", { name: provider?.name ?? "" })
      : t("settings.providerWizard.titleWith", { name: provider?.name ?? "" })}
    description={onBack === undefined ? t("providerLogin.security") : undefined}
    closeLabel={t("common.close")}
    onClose={() => void cancel(true)}
    className="provider-flow-modal provider-login-modal"
    headerLeading={<ProviderFlowBackButton onBack={() => void back()} disabled={busy} t={t} />}
    headerTrailing={onBack === undefined ? undefined : <ProviderWizardProgress activeStep={2} t={t} />}
  >
    {flow === undefined ? <div className="provider-login">
      {onBack !== undefined && <p className="provider-login__description">{t("providerLogin.security")}</p>}
      {methods.length > 1 && <label className="field"><span>{t("providerLogin.method")}</span><SelectControl value={method} onChange={(event) => setMethod(event.target.value as ProviderLoginMethodView)}>{methods.map((candidate) => <option value={candidate} key={candidate}>{methodLabel(candidate, t)}</option>)}</SelectControl></label>}
      <p className="provider-login__assurance"><ShieldCheck aria-hidden="true" />{t("providerLogin.noPersistence")}</p>
      {error !== undefined && <p className="provider-login__error" role="alert"><AlertTriangle aria-hidden="true" />{error}</p>}
      <ProviderFlowFooter>{onUseApiKey !== undefined && <Button disabled={busy} onClick={onUseApiKey}>{t("providerLogin.useApiKey")}</Button>}<Button tone="primary" disabled={!connected || busy || methods.length === 0} onClick={() => void begin()}>{busy && <LoaderCircle className="spin" aria-hidden="true" />}{t("providerLogin.start")}</Button></ProviderFlowFooter>
    </div> : <div className="provider-login" aria-live="polite">
      {onBack !== undefined && <p className="provider-login__description">{t("providerLogin.security")}</p>}
      {(!terminal || flow.state === "completed") && <p className="provider-login__description">{stateLabel(flow.state, t)}</p>}
      {verificationUri !== undefined && <a className="provider-login__verification" href={verificationUri} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /><span>{t("providerLogin.openVerification")}</span></a>}
      {flow.userCode !== undefined && <div className="provider-login__code"><span>{t("providerLogin.deviceCode")}</span><strong>{flow.userCode}</strong><Button tone="ghost" onClick={() => void navigator.clipboard.writeText(flow.userCode ?? "")}><Copy aria-hidden="true" />{t("timeline.copy")}</Button></div>}
      {flow.pendingPrompt !== undefined && <form className="provider-login__prompt" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="field"><span>{flow.pendingPrompt.message || t("providerLogin.input")}</span>{flow.pendingPrompt.kind === "select" ? <SelectControl value={input} onChange={(event) => setInput(event.target.value)}><option value="">{t("providerLogin.choose")}</option>{flow.pendingPrompt.options.map((option) => <option value={option.id} key={option.id}>{option.label}{option.description ? ` — ${option.description}` : ""}</option>)}</SelectControl> : <input type={flow.pendingPrompt.kind === "secret" || flow.pendingPrompt.kind === "manualCode" ? "password" : "text"} autoComplete="off" value={input} placeholder={flow.pendingPrompt.placeholder} onChange={(event) => setInput(event.target.value)} />}</label>
        {(flow.pendingPrompt.kind === "secret" || flow.pendingPrompt.kind === "manualCode") && <p className="provider-login__assurance"><ShieldCheck aria-hidden="true" />{t("providerLogin.sensitiveChannel")}</p>}
        <Button type="submit" tone="primary" disabled={busy || input.length === 0}>{busy && <LoaderCircle className="spin" aria-hidden="true" />}{t("providerLogin.submit")}</Button>
      </form>}
      {(flow.error !== undefined || error !== undefined) && <p className="provider-login__error" role="alert"><AlertTriangle aria-hidden="true" />{flow.error ?? error}</p>}
      {!terminal && <ProviderFlowFooter><Button disabled={busy} onClick={() => void cancel()}>{t("common.cancel")}</Button></ProviderFlowFooter>}
      {terminal && flow.state !== "completed" && <ProviderFlowFooter>{onUseApiKey !== undefined && <Button disabled={busy} onClick={onUseApiKey}>{t("providerLogin.useApiKey")}</Button>}<Button tone="primary" disabled={busy} onClick={retry}>{t("common.retry")}</Button></ProviderFlowFooter>}
      {flow.state === "completed" && error !== undefined && <ProviderFlowFooter><Button tone="primary" disabled={busy} onClick={() => setCompletionAttempt((attempt) => attempt + 1)}>{t("common.retry")}</Button></ProviderFlowFooter>}
    </div>}
  </Modal>;
}

export function providerLoginMethods(
  kind: ProviderConfigurationView["kind"] | undefined,
  advertised?: readonly ProviderLoginMethodView[]
): readonly ProviderLoginMethodView[] {
  if (advertised !== undefined) return [...new Set(advertised)];
  return kind === "apiKey"
    ? ["apiKey"]
    : kind === "subscription"
      ? ["subscription"]
      : kind === "oauth" ? ["oauthBrowser", "deviceCode"] : [];
}

export function defaultProviderLoginMethod(
  kind: ProviderConfigurationView["kind"] | undefined,
  advertised?: readonly ProviderLoginMethodView[]
): ProviderLoginMethodView {
  return providerLoginMethods(kind, advertised)[0] ?? "oauthBrowser";
}

function methodLabel(method: ProviderLoginMethodView, t: Translator): string {
  return method === "apiKey"
    ? t("settings.apiKey")
    : method === "deviceCode" ? t("providerLogin.deviceMethod") : method === "subscription" ? t("providerLogin.subscriptionMethod") : t("providerLogin.browserMethod");
}

function stateLabel(state: ProviderLoginFlowView["state"], t: Translator): string {
  const keys = {
    starting: "providerLogin.starting",
    pending: "providerLogin.pending",
    completed: "providerLogin.completed",
    cancelled: "providerLogin.cancelled",
    timedOut: "providerLogin.timedOut",
    outcomeUnknown: "providerLogin.outcomeUnknown",
    failed: "providerLogin.failed"
  } as const;
  return t(keys[state]);
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
