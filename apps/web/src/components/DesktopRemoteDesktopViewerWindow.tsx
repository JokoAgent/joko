import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Clipboard, Monitor, SlidersHorizontal, ZoomIn, ZoomOut, LayoutGrid, AppWindow, Maximize, Minus, X } from "lucide-react";
import { RemoteDesktopVideoQuality } from "@joko/contracts";
import { DesktopRemoteDesktopViewerController, type DesktopViewerSnapshot } from "../remote-desktop-viewer-controller.js";
import { desktopViewerMessages } from "../remote-desktop-viewer-messages.js";
import { Button, IconButton } from "./ui.js";
import "./remote-desktop-viewer.css";

export function DesktopRemoteDesktopViewerWindow(): JSX.Element {
  const api = window.jokoRemoteDesktopViewer;
  const root = useRef<HTMLDivElement>(null);
  const controller = useRef<DesktopRemoteDesktopViewerController | undefined>(undefined);
  const [state, setState] = useState<DesktopViewerSnapshot>();
  const [panel, setPanel] = useState<"display" | "clipboard">();
  const [confirmClose, setConfirmClose] = useState(false);
  const stateRef = useRef(state); stateRef.current = state;
  const generation = useRef(-1);
  const closeDialog = useRef<HTMLDialogElement>(null);
  const panelRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    if (confirmClose && closeDialog.current && !closeDialog.current.open) closeDialog.current.showModal();
  }, [confirmClose]);
  useEffect(() => { if (panel !== undefined) panelRoot.current?.querySelector<HTMLElement>("button,select,input")?.focus(); }, [panel]);
  useEffect(() => {
    if (!root.current || !api) return;
    const owner = new DesktopRemoteDesktopViewerController(api, root.current, setState);
    controller.current = owner;
    const offState = api.onState((scope) => {
      if (scope.generation < generation.current) return;
      if (scope.generation !== generation.current || !scope.active) { setPanel(undefined); setConfirmClose(false); }
      generation.current = scope.generation;
    });
    const close = (): void => { owner.releaseInput(); setPanel(undefined);
      if (stateRef.current?.ready) setConfirmClose(true); else void owner.close(); };
    const offClose = api.onCloseRequested((value) => { if (generation.current === value) close(); });
    const inputFocus = (focused: boolean): void => {
      if (generation.current > 0) void api.inputFocus(generation.current, focused).catch(() => undefined);
    };
    const focus = (event: FocusEvent): void => inputFocus((event.target as HTMLElement | null)?.id === "keyboard-input");
    const focusOut = (event: FocusEvent): void => {
      if ((event.target as HTMLElement | null)?.id === "keyboard-input") inputFocus(false);
    };
    const blur = (): void => { owner.focusLost(); inputFocus(false); };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focusOut);
    window.addEventListener("blur", blur);
    return () => { offClose(); offState(); document.removeEventListener("focusin", focus); document.removeEventListener("focusout", focusOut);
      window.removeEventListener("blur", blur); inputFocus(false); owner.dispose();
      if (controller.current === owner) controller.current = undefined; };
  }, [api]);
  const t = desktopViewerMessages(state?.locale ?? "en");
  const controlDisabled = !state?.ready || !state.caps?.canControl || state.controlPending || state.closing;
  const inputDisabled = !state?.ready || !state.controlling || state.controlPending || state.settingsBusy;
  const togglePanel = (next: "display" | "clipboard"): void => {
    controller.current?.releaseInput(); setPanel((prior) => prior === next ? undefined : next);
    if (next === "display") void controller.current?.loadModes();
  };
  const issue = state?.error;
  return <main className={`remote-viewer-window${api?.platform === "darwin" ? " is-mac" : ""}`}>
    <header className="remote-viewer-toolbar">
      <Monitor size={18} aria-hidden="true" />
      <div className="remote-viewer-heading"><strong>{state?.target?.name ?? t.title}</strong><small role="status">
        {state?.closing ? state.lockOnExit && state.caps?.lockOnExit ? t.lockingOnExit : t.disconnecting :
          state?.controlPending ? t.controlPending : t[state?.status ?? "connecting"]}
        {state?.media !== "none" && state?.media !== undefined ? ` · ${t[state.media]}` : ""}
        {state?.latency === undefined ? "" : ` · ${Math.round(state.latency)} ms`}
        {state?.receiveRate === undefined ? "" : ` · ${Math.round(state.receiveRate / 1024)} KB/s`}
      </small></div>
      <Button disabled={controlDisabled} aria-pressed={state?.controlling ?? false}
        onClick={() => void controller.current?.control(!state?.controlling)}>{state?.controlling ? t.control : t.viewOnly}</Button>
      <div className="remote-viewer-toolgroup" role="group" aria-label={t.control}>
        <Tool label={t.allWindows} disabled={inputDisabled} onClick={() => controller.current?.keys(state?.caps?.platform === "darwin" ? ["ControlLeft", "ArrowUp"] : ["MetaLeft", "Tab"])}><LayoutGrid /></Tool>
        <Tool label={t.showDesktop} disabled={inputDisabled} onClick={() => controller.current?.keys(state?.caps?.platform === "darwin" ? ["MetaLeft", "F3"] : ["MetaLeft", "KeyD"])}><AppWindow /></Tool>
      </div>
      <div className="remote-viewer-toolgroup" role="group" aria-label={t.fit}>
        <Tool label={t.zoomOut} disabled={!state?.ready} onClick={() => controller.current?.zoom("out")}><ZoomOut /></Tool>
        <Button disabled={!state?.ready} aria-pressed={state?.scaleMode === "fit"} onClick={() => controller.current?.fit()}>{t.fit}</Button>
        <Button disabled={!state?.ready} aria-pressed={state?.scaleMode === "actual"} onClick={() => controller.current?.actualSize()}>{t.actual}</Button>
        <Tool label={t.zoomIn} disabled={!state?.ready} onClick={() => controller.current?.zoom("in")}><ZoomIn /></Tool>
      </div>
      <Tool label={t.settings} onClick={() => togglePanel("display")} pressed={panel === "display"}><SlidersHorizontal /></Tool>
      <Tool label={t.clipboard} disabled={inputDisabled || !(state?.caps?.clipboardContent || state?.caps?.clipboardText)} onClick={() => togglePanel("clipboard")} pressed={panel === "clipboard"}><Clipboard /></Tool>
      <Tool label={t.fullscreen} onClick={() => void api?.fullscreen()}><Maximize /></Tool>
      {api?.platform !== "darwin" && <Tool label={t.minimize} onClick={() => void api?.minimize()}><Minus /></Tool>}
      <Tool label={t.close} onClick={() => { controller.current?.releaseInput(); setPanel(undefined);
        if (state?.ready) setConfirmClose(true); else void controller.current?.close(); }}><X /></Tool>
    </header>
    {panel !== undefined && <section ref={panelRoot} className="remote-viewer-panel" role="dialog" aria-label={panel === "display" ? t.settings : t.clipboard}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setPanel(undefined); } }}>
      <div className="remote-viewer-panel-heading"><strong>{panel === "display" ? t.settings : t.clipboard}</strong>
        <Tool label={t.close} onClick={() => { setPanel(undefined); controller.current?.focusInput(); }}><X /></Tool></div>
      {panel === "display" && <>
        {(state?.caps?.displays.length ?? 0) > 1 && <label>{t.display}<select aria-label={t.display} value={state?.sourceDisplayId ?? state?.lease?.display?.displayId ?? ""}
          disabled={state?.settingsBusy || state?.lease === undefined} onChange={(event) => void controller.current?.selectDisplay(event.target.value)}>
          {state?.caps?.displays.map((display) => <option key={display.displayId} value={display.displayId}>{display.name}</option>)}
        </select></label>}
        {state?.caps?.videoSettings && <>
          <fieldset disabled={state.settingsBusy}><legend>{t.fps}</legend>{[30, 60].map((fps) => <Button key={fps}
            aria-pressed={state.settings.fps === fps} onClick={() => controller.current?.settings({ fps })}>{fps} fps</Button>)}</fieldset>
          <fieldset disabled={state.settingsBusy}><legend>{t.quality}</legend>{[
            [RemoteDesktopVideoQuality.AUTO, t.auto], [RemoteDesktopVideoQuality.SAVER, t.saver], [RemoteDesktopVideoQuality.HD, t.hd]
          ].map(([quality, label]) => <Button key={quality} aria-pressed={state.settings.quality === quality}
            onClick={() => controller.current?.settings({ quality: quality as RemoteDesktopVideoQuality })}>{label}</Button>)}</fieldset>
        </>}
        {state?.caps?.systemAudio && <label className="remote-viewer-check"><input type="checkbox" checked={state.settings.audio}
          disabled={state.audioPending || state.settingsBusy || state.closing}
          onChange={(event) => controller.current?.settings({ audio: event.target.checked })} />{t.audio}</label>}
        {state !== undefined && <>
          <label className="remote-viewer-check"><input type="checkbox" checked={state.privacyScreenDesired}
            disabled={state.privacyScreenPending || state.controlPending || state.closing ||
              ((!state.ready || !state.caps?.privacyScreen || !state.controlling) && !state.privacyScreenDesired)}
            onChange={(event) => void controller.current?.privacyScreen(event.target.checked)} />{t.privacyScreen}</label>
          {state.privacyScreenNotice === undefined && <p role="status">{state.privacyScreenPending ? t.privacyScreenPending :
            state.privacyScreenActive ? t.privacyScreenActive : !state.caps ? t.connecting : !state.caps.privacyScreen ? t.privacyScreenUnavailable :
              state.privacyScreenDesired ? t.privacyScreenWaiting : t.privacyScreenInactive}</p>}
          {state.privacyScreenNotice !== undefined && <div role="alert"><p>{state.privacyScreenNotice === "save" ? t.privacyScreenSaveError : t.privacyScreenError}</p>
            <Button disabled={state.privacyScreenPending || state.controlPending || state.closing ||
              (state.privacyScreenNotice === "effect" && (!state.ready || !state.controlling || !state.caps?.privacyScreen))}
              onClick={() => controller.current?.retryPrivacyScreen()}>{t.retry}</Button></div>}
          {api?.platform === "darwin" && state.caps?.platform === "darwin" && <>
            <label className="remote-viewer-check"><input type="checkbox" checked={state.credential?.autoUnlock === true}
              disabled={!state.ready || state.closing || state.credentialBusy}
              onChange={(event) => void controller.current?.credential(event.target.checked ? "enable" : "disable")} />{t.autoUnlock}</label>
            <p>{t.autoUnlockHint}</p>
            {state.credential?.autoUnlock && <label className="remote-viewer-check"><input type="checkbox"
              checked={state.credential.biometricVerification}
              disabled={state.credentialBusy || state.closing || (!state.credential.biometricAvailable && !state.credential.biometricVerification)}
              onChange={(event) => void controller.current?.credential("biometric", event.target.checked)} />{t.biometricVerification}</label>}
            <p>{t.autoUnlockStorageHint}</p>
            {state.credentialBusy && <p role="status">{t.credentialPending}</p>}
            {state.credentialNotice && <div role="alert"><p>{({ unavailable: t.credentialUnavailable, signing: t.credentialSigning,
              password: t.credentialPassword, identity: t.credentialIdentity, permission: t.credentialPermission,
              expired: t.credentialExpired, busy: t.credentialBusy })[state.credentialNotice]}</p>
              <Button disabled={state.credentialBusy || state.closing || !state.ready}
                onClick={() => controller.current?.retryCredential()}>{t.retry}</Button></div>}
          </>}
          <label className="remote-viewer-check"><input type="checkbox" checked={state.hostMuteDesired}
            disabled={state.hostMutePending || state.controlPending || state.closing ||
              ((!state.caps?.hostMute || !state.controlling) && !state.hostMuteDesired)}
            onChange={(event) => void controller.current?.hostMute(event.target.checked)} />{t.hostMute}</label>
          <p role="status">{state.hostMutePending ? t.hostMutePending : state.hostMuteActive ? t.hostMuteActive :
            !state.caps ? t.connecting : !state.caps.hostMute ? t.hostMuteUnavailable : state.hostMuteDesired ? t.hostMuteWaiting : t.hostMuteInactive}</p>
          {state.hostMuteNotice !== undefined && <div role="alert"><p>{state.hostMuteNotice === "save" ? t.hostMuteSaveError : t.hostMuteError}</p>
            <Button disabled={state.hostMutePending || state.controlPending || state.closing ||
              (state.hostMuteNotice === "effect" && (!state.ready || !state.controlling || !state.caps?.hostMute))}
              onClick={() => controller.current?.retryHostMute()}>{t.retry}</Button></div>}
          <label className="remote-viewer-check"><input type="checkbox" checked={state.lockOnExit}
            disabled={state.lockOnExitPending || state.closing || ((!state.caps?.lockOnExit || !state.ready) && !state.lockOnExit)}
            onChange={(event) => void controller.current?.lockOnExit(event.target.checked)} />{t.lockOnExit}</label>
          <p role="status">{state.lockOnExitPending ? t.savingPreference : !state.caps ? t.connecting :
            !state.caps.lockOnExit ? t.lockOnExitUnavailable : t.lockOnExitHint}</p>
          {state.lockOnExitNotice !== undefined && <div role="alert"><p>{t.lockOnExitSaveError}</p>
            <Button disabled={state.lockOnExitPending || state.closing} onClick={() => controller.current?.retryLockOnExit()}>{t.retry}</Button></div>}
          <label className="remote-viewer-check"><input type="checkbox" checked={state.clipboardSyncDesired}
            disabled={state.closing || state.clipboardSyncSaving ||
              ((!state.ready || !state.controlling || !state.caps?.clipboardSync || !state.clipboardSyncAvailable) && !state.clipboardSyncDesired)}
            onChange={(event) => void controller.current?.clipboardSync(event.target.checked)} />{t.clipboardSync}</label>
          <p role="status">{state.clipboardSyncPending ? t.clipboardSyncPending : state.clipboardSyncActive ? t.clipboardSyncActive :
            !state.caps ? t.connecting : !state.caps.clipboardSync || !state.clipboardSyncAvailable ? t.clipboardSyncUnavailable :
              state.clipboardSyncDesired ? t.clipboardSyncWaiting : t.clipboardSyncInactive}</p>
          {state.clipboardSyncNotice !== undefined && <div role="alert"><p>{state.clipboardSyncNotice === "save" ? t.clipboardSyncSaveError :
            state.clipboardSyncNotice === "permission" ? t.clipboardSyncPermission : state.clipboardSyncNotice === "conflict" ? t.clipboardSyncConflict :
              state.clipboardSyncNotice === "skipped" ? t.clipboardSyncSkipped : state.clipboardSyncNotice === "unknown" ? t.clipboardSyncUnknown : t.clipboardSyncError}</p>
            {state.clipboardSyncNotice !== "skipped" && <Button disabled={state.clipboardSyncPending || state.closing ||
              (state.clipboardSyncNotice !== "save" && (!state.ready || !state.controlling || !state.clipboardSyncAvailable))}
              onClick={() => void controller.current?.retryClipboardSync()}>{t.retry}</Button>}</div>}
        </>}
        {state?.caps?.viewerDisplay && state.caps.viewerDisplayRestore && <>
          <Button disabled={inputDisabled} onClick={() => void controller.current?.fitViewerDisplay()}>{t.fitDisplay}</Button>
          <Button disabled={inputDisabled || !state.viewerDisplayFitted} onClick={() => void controller.current?.restoreViewerDisplay()}>{t.restoreDisplay}</Button>
          <p>{t.temporaryViewerDisplay}</p>
        </>}
        {state?.caps?.displayModes && <><label>{t.resolution}<select aria-label={t.resolution} disabled={inputDisabled || state.modes.length === 0}
          value={state.viewerDisplayFitted ? "" : state.modes.find((mode) => mode.current)?.modeId ?? ""} onChange={(event) => void controller.current?.setMode(event.target.value)}>
          {state.viewerDisplayFitted && <option value="" disabled>{t.fittedDisplay}</option>}
          {state.modes.map((mode) => <option key={mode.modeId} value={mode.modeId}>{mode.width} × {mode.height}{mode.native ? " · native" : ""}</option>)}
        </select></label>
          {state.caps.resolutionRestore && <p>{t.temporaryResolution}</p>}
        </>}
        {state?.modeNotice && <p role="alert">{state.modeNotice === "restore-unavailable" ? t.modeRestoreFailed : t.modeFailed}</p>}
      </>}
      {panel === "clipboard" && <><Button disabled={inputDisabled || state?.clipboardBusy} onClick={() => void controller.current?.clipboard("copy")}>{t.copy}</Button>
        <Button disabled={inputDisabled || state?.clipboardBusy} onClick={() => void controller.current?.clipboard("paste")}>{t.paste}</Button>
        {state?.clipboardBusy && <p role="status">{t.clipboardBusy}</p>}</>}
    </section>}
    <div ref={root} className="remote-viewer-content">
      <div id="stage" tabIndex={0} aria-label={t.title}><div id="bg" aria-hidden="true"><canvas id="bg-canvas" /></div>
        <img id="image" alt="" /><video id="video" autoPlay muted playsInline /><div id="cursor"><img id="cursor-image" alt="" /></div></div>
      <textarea id="keyboard-input" autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false} aria-label={t.input} />
      <div id="mouse-buttons" hidden><button id="mouse-left" /><button id="mouse-right" /><button id="mouse-wheel"><span id="mouse-wheel-grip" /></button></div>
      {(!state?.ready || issue !== undefined) && !state?.closing && <div className="remote-viewer-connection" role={issue || state?.closeNotice ? "alert" : "status"}>
        <span>{state?.closeNotice ? state.closeNotice === "lock" ? t.lockOnExitError : t.closeError : issue === "clipboard" ? t.clipboardError : issue === "display" ? t.displayError : issue === "preferences" ? t.preferencesError : issue ? t[issue] : t[state?.status ?? "connecting"]}</span>
        {state?.closeNotice ? <><Button onClick={() => { setConfirmClose(true); }}>{t.retryExit}</Button>
          <Button onClick={() => void controller.current?.retry()}>{t.reconnect}</Button></> :
          issue === "clipboard" || issue === "display" || issue === "preferences" ? <Button onClick={() => controller.current?.dismissNotice()}>{t.cancel}</Button> : issue !== undefined && <Button onClick={() => void controller.current?.retry(issue === "busy" && state?.caps?.connectionTakeover)}>
          {issue === "busy" && state?.caps?.connectionTakeover ? t.takeover : t.retry}</Button>}
      </div>}
    </div>
    {confirmClose && <dialog ref={closeDialog} className="remote-viewer-close-dialog" aria-labelledby="remote-viewer-close-title"
      onCancel={(event) => { event.preventDefault(); if (!state?.closing) setConfirmClose(false); }}>
      <h2 id="remote-viewer-close-title">{t.closeTitle}</h2><p>{t.closeBody}{state?.lockOnExit && state.caps?.lockOnExit ? ` ${t.lockOnExitHint}` : ""}</p>
      {state?.closing && <p role="status">{state.lockOnExit && state.caps?.lockOnExit ? t.lockingOnExit : t.disconnecting}</p>}
      {state?.closeNotice && <p role="alert">{state.closeNotice === "lock" ? t.lockOnExitError : t.closeError}</p>}<div>
        <Button autoFocus disabled={state?.closing} onClick={() => setConfirmClose(false)}>{t.cancel}</Button>
        <Button disabled={state?.closing || state?.lockOnExitPending || state?.controlPending}
          onClick={() => void controller.current?.close()}>{state?.closeNotice ? t.retryExit : t.close}</Button></div>
    </dialog>}
  </main>;
}

function Tool({ label, children, onClick, disabled, pressed }: { readonly label: string; readonly children: ReactNode;
  readonly onClick: () => void; readonly disabled?: boolean; readonly pressed?: boolean }): JSX.Element {
  return <IconButton className="remote-viewer-tool" label={label} disabled={disabled} aria-pressed={pressed} onClick={onClick}>{children}</IconButton>;
}
