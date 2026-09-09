import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import type { AppController } from "../controller.js";
import type { BackendView, ModelView } from "../model.js";
import { modelSourceAccess, type ModelSourceSelection } from "../model-source-access.js";
import { ProviderLoginDialog } from "./ProviderLoginDialog.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";
import "./model-source-notice.css";

export function ModelSourceNotice({ controller, backend, selection, model, t }: {
  readonly controller: AppController;
  readonly backend: BackendView | undefined;
  readonly selection: ModelSourceSelection | undefined;
  readonly model: ModelView | undefined;
  readonly t: Translator;
}): JSX.Element | null {
  const [loginOpen, setLoginOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const checkOwnerRef = useRef<object | undefined>(undefined);
  const checkFlightRef = useRef<object | undefined>(undefined);
  useEffect(() => {
    const owner = {}; checkOwnerRef.current = owner;
    checkFlightRef.current = undefined;
    setChecking(false); setCheckError(false);
    return () => { if (checkOwnerRef.current === owner) { checkOwnerRef.current = undefined; checkFlightRef.current = undefined; } };
  }, [controller.getArtifactUrl, controller.state.activeProfile?.id, controller.state.activeProfile?.serverId,
    controller.state.snapshot.generation, controller.state.connectionState, backend?.id, selection?.providerId, selection?.modelId]);
  const access = modelSourceAccess(backend, selection, model, controller.state.snapshot.providers);
  const authentication = access.authentication;
  useEffect(() => { if (access.available) setLoginOpen(false); }, [access.available]);
  if (access.available || backend === undefined && selection === undefined) return null;
  const pending = access.authenticationState === "pending" || access.authenticationState === "refreshing";
  const canSignIn = authentication?.supportsLogin === true && authentication.loginMethods.length > 0
    && authentication.routingEnabled !== false && model?.routingEnabled !== false;
  const disabled = controller.state.connectionState !== "connected" || pending || checking;
  const refresh = async (): Promise<void> => {
    const owner = checkOwnerRef.current;
    if (owner === undefined || checkFlightRef.current !== undefined || disabled || backend === undefined) return;
    const flight = {}; checkFlightRef.current = flight;
    setChecking(true); setCheckError(false);
    try {
      if (selection === undefined) await controller.refresh();
      else await controller.refreshProviderModels(backend.id, selection.providerId, false);
    }
    catch { if (checkOwnerRef.current === owner) setCheckError(true); }
    finally { if (checkOwnerRef.current === owner && checkFlightRef.current === flight) { checkFlightRef.current = undefined; setChecking(false); } }
  };
  return <>
    <div className="composer__source-notice" role="status">
      <AlertTriangle aria-hidden="true" />
      <span><strong>{selection === undefined ? `${backend?.name ?? ""} · ${t("settings.backendNativeDefault")}`
        : `${model?.name ?? selection.modelId} · ${model?.providerName ?? selection.providerId}`}</strong>
        {access.reason !== undefined && access.reason !== "authentication" && <span>{t(`modelPicker.${access.reason}`)}</span>}
        {access.authenticationState !== undefined && <span>{t(`providerAuth.${access.authenticationState}`)}</span>}
        <span>{t("modelPicker.sourceRecoveryDraft")}</span>
        {checkError && <span role="alert">{t("modelPicker.sourceCheckFailed")}</span>}
      </span>
      <div className="composer__source-actions">
        {backend !== undefined && <Button disabled={disabled} onClick={() => { void refresh(); }}>{t(checking ? "common.working" : "modelPicker.checkSource")}</Button>}
        <Button disabled={disabled}
          onClick={(event) => {
            if (canSignIn) setLoginOpen(true);
            else {
              const ownerWindow = event.currentTarget.ownerDocument.defaultView;
              if (ownerWindow !== null) ownerWindow.location.hash = access.reason === "nativeUnavailable" ? "#/settings/about/backends" : "#/settings/providers";
            }
          }}>{t(canSignIn ? "providerLogin.signIn" : "modelPicker.connectSource")}</Button>
      </div>
    </div>
    {loginOpen && authentication !== undefined && <ProviderLoginDialog controller={controller}
      backendId={authentication.backendId} provider={authentication} loginMethods={authentication.loginMethods}
      t={t} onClose={() => setLoginOpen(false)} />}
  </>;
}
