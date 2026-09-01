import { Eye, EyeOff, LoaderCircle, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type {
  PortableSessionExecutionSelection,
  PortableSessionActivationResultView,
  PortableSessionExportOutcomeView,
  PortableSessionFidelityView,
  PortableSessionImportDraftView,
  PortableSessionImportPreviewView,
  PortableSessionImportResultView,
  PortableSessionTargetOption
} from "../model.js";
import { Button, IconButton, Modal, cx, CheckboxControl, SelectControl } from "./ui.js";
import "./PortableSessionDialogs.css";

export type {
  PortableSessionExecutionSelection,
  PortableSessionImportDraftView,
  PortableSessionImportPreviewView,
  PortableSessionImportResultView,
  PortableSessionTargetOption
} from "../model.js";
export type PortableSessionFidelity = PortableSessionFidelityView;

export interface PortableSessionDialogLabels {
  readonly exportTitle: string;
  readonly sensitiveWarning: string;
  readonly encrypt: string;
  readonly password: string;
  readonly confirmPassword: string;
  readonly showPassword: string;
  readonly hidePassword: string;
  readonly passwordMismatch: string;
  readonly passwordTooShort: string;
  readonly cancel: string;
  readonly export: string;
  readonly exportWithoutMedia: string;
  readonly oversizeHint: (mediaMegabytes: number) => string;
  readonly oversizeFailure: string;
  readonly exportFailed: string;
  readonly importTitle: string;
  readonly chooseFile: string;
  readonly chooseAnotherFile: string;
  readonly passwordPrompt: string;
  readonly unlock: string;
  readonly wrongPassword: string;
  readonly previewMeta: (preview: PortableSessionImportPreviewView) => string;
  readonly workerSummary: (count: number) => string;
  readonly fidelity: (value: PortableSessionFidelity) => string;
  readonly riskWarning: string;
  readonly destination: string;
  readonly createWorktree: string;
  readonly createWorktreeHint: string;
  readonly import: string;
  readonly importFailed: string;
  readonly conflictTitle: string;
  readonly conflictBody: string;
  readonly overwrite: string;
  readonly importComplete: string;
  readonly activationFailedTitle: string;
  readonly activationFailedBody: (reason: string) => string;
  readonly retryActivation: string;
  readonly activationRetryFailed: string;
  readonly fidelityResult: (value: PortableSessionFidelity) => string;
  readonly importedWorkers: (count: number) => string;
  readonly close: string;
  readonly openTask: string;
}

export type PortableSessionExportOutcome = PortableSessionExportOutcomeView;

export function PortableSessionExportDialog({
  open,
  labels,
  onClose,
  onExport,
  onExported
}: {
  readonly open: boolean;
  readonly labels: PortableSessionDialogLabels;
  readonly onClose: () => void;
  readonly onExport: (input: { readonly password?: string; readonly excludeMedia: boolean }) => Promise<PortableSessionExportOutcome>;
  readonly onExported: (fidelity: PortableSessionFidelity) => void;
}): JSX.Element {
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excludeMedia, setExcludeMedia] = useState(false);
  const [oversizeMediaMb, setOversizeMediaMb] = useState<number>();
  const [error, setError] = useState<string>();
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setEncrypt(false);
    setPassword("");
    setConfirmation("");
    setShowPassword(false);
    setBusy(false);
    setExcludeMedia(false);
    setOversizeMediaMb(undefined);
    setError(undefined);
  }, [open]);

  useEffect(() => {
    if (encrypt) passwordRef.current?.focus();
  }, [encrypt]);

  const mismatch = encrypt && password.length > 0 && confirmation.length > 0 && password !== confirmation;
  const tooShort = encrypt && password.length > 0 && password.length < 4;
  const canSubmit = !busy && (!encrypt || (password.length >= 4 && password === confirmation));
  const close = (): void => { if (!busy) onClose(); };
  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onExport({
        ...(encrypt ? { password } : {}),
        excludeMedia
      });
      if (result.status === "cancelled") return;
      if (result.status === "oversize") {
        if (result.mediaBytes > 0 && !excludeMedia) {
          setExcludeMedia(true);
          setOversizeMediaMb(Math.round(result.mediaBytes / (1024 * 1024)));
        } else {
          setError(labels.oversizeFailure);
        }
        return;
      }
      onExported(result.fidelity);
      onClose();
    } catch {
      setError(labels.exportFailed);
    } finally {
      setBusy(false);
    }
  };

  return <Modal
    open={open}
    title={labels.exportTitle}
    description={labels.sensitiveWarning}
    closeLabel={labels.close}
    size="small"
    className="portable-session-dialog portable-session-dialog--export"
    dialogRole="alertdialog"
    dismissOnBackdrop={!busy}
    onClose={close}
  >
    <div className="portable-session-form">
      {oversizeMediaMb !== undefined && <p className="portable-session-form__hint">{labels.oversizeHint(oversizeMediaMb)}</p>}
      <label className="portable-session-check">
        <CheckboxControl checked={encrypt} disabled={busy} onChange={(event) => setEncrypt(event.target.checked)} />
        <span>{labels.encrypt}</span>
      </label>
      {encrypt && <div className="portable-session-passwords">
        <label>
          <span className="sr-only">{labels.password}</span>
          <input
            ref={passwordRef}
            type={showPassword ? "text" : "password"}
            value={password}
            placeholder={labels.password}
            disabled={busy}
            aria-invalid={tooShort || mismatch}
            onChange={(event) => setPassword(event.target.value)}
          />
          <IconButton disabled={busy} disabledReason={busy ? labels.showPassword : undefined} label={showPassword ? labels.hidePassword : labels.showPassword} onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </IconButton>
        </label>
        <input
          type={showPassword ? "text" : "password"}
          value={confirmation}
          placeholder={labels.confirmPassword}
          disabled={busy}
          aria-invalid={mismatch}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {(mismatch || tooShort) && <p className="portable-session-form__error" role="alert">{mismatch ? labels.passwordMismatch : labels.passwordTooShort}</p>}
      </div>}
      {error !== undefined && <p className="portable-session-form__error" role="alert">{error}</p>}
      <div className="modal__actions">
        <Button disabled={busy} onClick={close}>{labels.cancel}</Button>
        <Button tone="primary" disabled={!canSubmit} onClick={() => void submit()}>
          {busy && <LoaderCircle className="is-spinning" aria-hidden="true" />}
          {excludeMedia ? labels.exportWithoutMedia : labels.export}
        </Button>
      </div>
    </div>
  </Modal>;
}

type ImportStep = "picking" | "password" | "preview" | "conflict" | "committing" | "done";

export function PortableSessionImportDialog({
  open,
  initialFile,
  labels,
  targets,
  defaultTargetId,
  executionForTarget,
  onClose,
  onInspect,
  onUnlock,
  onCancelDraft,
  onCommit,
  onRetryActivation,
  onOpenTask
}: {
  readonly open: boolean;
  readonly initialFile?: File;
  readonly labels: PortableSessionDialogLabels;
  readonly targets: readonly PortableSessionTargetOption[];
  readonly defaultTargetId?: string;
  readonly executionForTarget: (targetId: string) => PortableSessionExecutionSelection | undefined;
  readonly onClose: () => void;
  readonly onInspect: (file: File) => Promise<PortableSessionImportDraftView>;
  readonly onUnlock: (draftId: string, password: string) => Promise<PortableSessionImportDraftView>;
  readonly onCancelDraft: (draftId: string) => Promise<void>;
  readonly onCommit: (input: {
    readonly draftId: string;
    readonly targetId: string;
    readonly execution: PortableSessionExecutionSelection;
    readonly overwrite: boolean;
    readonly useWorktree: boolean;
  }) => Promise<PortableSessionImportResultView>;
  readonly onRetryActivation: (sessionId: string) => Promise<PortableSessionActivationResultView>;
  readonly onOpenTask: (sessionId: string) => void;
}): JSX.Element {
  const [step, setStep] = useState<ImportStep>("picking");
  const [draft, setDraft] = useState<PortableSessionImportDraftView>();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [result, setResult] = useState<PortableSessionImportResultView>();
  const [error, setError] = useState<string>();
  const [inspecting, setInspecting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [retryingActivation, setRetryingActivation] = useState(false);
  const liveDraftIdRef = useRef<string | undefined>(undefined);
  const lifecycleRef = useRef(0);
  const cancelDraftRef = useRef(onCancelDraft);
  const targetOptionsRef = useRef(targets);
  const defaultTargetIdRef = useRef(defaultTargetId);
  const openRef = useRef(open);
  const passwordRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  cancelDraftRef.current = onCancelDraft;
  targetOptionsRef.current = targets;
  defaultTargetIdRef.current = defaultTargetId;
  openRef.current = open;
  const busy = inspecting || unlocking || retryingActivation || step === "committing";
  const preview = draft?.preview;
  const selectedTarget = targets.find((target) => target.id === targetId);
  const selectedExecution = executionForTarget(targetId);

  useEffect(() => {
    lifecycleRef.current += 1;
    const activeDraftId = liveDraftIdRef.current;
    liveDraftIdRef.current = undefined;
    if (activeDraftId !== undefined) void cancelDraftRef.current(activeDraftId).catch(() => undefined);
    if (!open) return;
    const availableTargets = targetOptionsRef.current;
    const preferredTargetId = defaultTargetIdRef.current;
    setStep("picking");
    setDraft(undefined);
    setPassword("");
    setShowPassword(false);
    setPasswordError(false);
    setTargetId(preferredTargetId !== undefined && availableTargets.some((target) => target.id === preferredTargetId)
      ? preferredTargetId
      : availableTargets[0]?.id ?? "");
    setUseWorktree(false);
    setResult(undefined);
    setError(undefined);
    setInspecting(false);
    setUnlocking(false);
    setRetryingActivation(false);
  }, [open]);

  const targetIdentity = targets.map((target) => target.id).join("\u0000");
  useEffect(() => {
    if (!open) return;
    const availableTargets = targetOptionsRef.current;
    const preferredTargetId = defaultTargetIdRef.current;
    setTargetId((current) => {
      if (availableTargets.some((target) => target.id === current)) return current;
      if (preferredTargetId !== undefined && availableTargets.some((target) => target.id === preferredTargetId)) return preferredTargetId;
      return availableTargets[0]?.id ?? "";
    });
  }, [open, defaultTargetId, targetIdentity]);

  useEffect(() => {
    if (step === "password") passwordRef.current?.focus();
  }, [step]);

  useEffect(() => () => {
    lifecycleRef.current += 1;
    const activeDraftId = liveDraftIdRef.current;
    liveDraftIdRef.current = undefined;
    if (activeDraftId !== undefined) void cancelDraftRef.current(activeDraftId).catch(() => undefined);
  }, []);

  const inspect = async (file: File): Promise<void> => {
    const lifecycle = ++lifecycleRef.current;
    const previousDraftId = liveDraftIdRef.current;
    liveDraftIdRef.current = undefined;
    setDraft(undefined);
    if (previousDraftId !== undefined) await cancelDraftRef.current(previousDraftId).catch(() => undefined);
    setError(undefined);
    setInspecting(true);
    try {
      const next = await onInspect(file);
      if (lifecycle !== lifecycleRef.current || !openRef.current) {
        await cancelDraftRef.current(next.draftId).catch(() => undefined);
        return;
      }
      liveDraftIdRef.current = next.draftId;
      setDraft(next);
      setStep(next.passwordRequired ? "password" : "preview");
    } catch {
      if (lifecycle !== lifecycleRef.current || !openRef.current) return;
      setDraft(undefined);
      setError(labels.importFailed);
      setStep("picking");
    } finally {
      if (lifecycle === lifecycleRef.current && openRef.current) setInspecting(false);
    }
  };

  useEffect(() => {
    if (!open || initialFile === undefined) return;
    void inspect(initialFile);
    // A newly supplied File object is the intentional restart boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile]);

  const cancelDraft = async (): Promise<void> => {
    lifecycleRef.current += 1;
    const activeDraftId = liveDraftIdRef.current;
    liveDraftIdRef.current = undefined;
    setDraft(undefined);
    if (activeDraftId !== undefined) await cancelDraftRef.current(activeDraftId).catch(() => undefined);
  };
  const close = (): void => {
    if (busy) return;
    void cancelDraft();
    onClose();
  };
  const unlock = async (): Promise<void> => {
    if (draft === undefined || password === "") return;
    const lifecycle = lifecycleRef.current;
    setUnlocking(true);
    setPasswordError(false);
    setError(undefined);
    try {
      const next = await onUnlock(draft.draftId, password);
      if (lifecycle !== lifecycleRef.current || !openRef.current) return;
      liveDraftIdRef.current = next.draftId;
      setDraft(next);
      setPassword("");
      setStep("preview");
    } catch (candidate) {
      if (lifecycle !== lifecycleRef.current || !openRef.current) return;
      if (portableSessionErrorCode(candidate) === "DECRYPTION_FAILED") setPasswordError(true);
      else setError(labels.importFailed);
    } finally {
      if (lifecycle === lifecycleRef.current && openRef.current) setUnlocking(false);
    }
  };
  const commit = async (overwrite: boolean): Promise<void> => {
    if (draft === undefined || targetId === "" || selectedExecution === undefined) return;
    const lifecycle = lifecycleRef.current;
    setStep("committing");
    setError(undefined);
    try {
      const imported = await onCommit({
        draftId: draft.draftId,
        targetId,
        execution: selectedExecution,
        overwrite,
        useWorktree: preview?.workspaceKind === "project" && selectedTarget?.worktreeSupported === true && useWorktree
      });
      if (lifecycle !== lifecycleRef.current || !openRef.current) return;
      liveDraftIdRef.current = undefined;
      setDraft(undefined);
      setResult(imported);
      setStep("done");
    } catch (candidate) {
      if (lifecycle !== lifecycleRef.current || !openRef.current) return;
      if (!overwrite && portableSessionErrorCode(candidate) === "PORTABLE_SESSION_IMPORT_CONFLICT") setStep("conflict");
      else {
        setError(labels.importFailed);
        setStep("preview");
      }
    }
  };

  const retryActivation = async (): Promise<void> => {
    if (result === undefined || result.status !== "imported_activation_failed") return;
    const lifecycle = lifecycleRef.current;
    setRetryingActivation(true);
    setError(undefined);
    try {
      const activation = await onRetryActivation(result.sessionId);
      if (lifecycle !== lifecycleRef.current || !openRef.current) return;
      setResult((current) => {
        if (current === undefined) return current;
        const { activationError: _previousActivationError, ...base } = current;
        return {
          ...base,
          status: activation.status,
          ...(activation.activationError === undefined ? {} : { activationError: activation.activationError })
        };
      });
      if (activation.status !== "ready") setError(labels.activationRetryFailed);
    } catch {
      if (lifecycle === lifecycleRef.current && openRef.current) setError(labels.activationRetryFailed);
    } finally {
      if (lifecycle === lifecycleRef.current && openRef.current) setRetryingActivation(false);
    }
  };

  const canCommit = preview !== undefined && targetId !== "" && selectedExecution !== undefined;
  const waitingForInitialInspection = step === "picking" && initialFile !== undefined && error === undefined;
  return <Modal
    open={open && !waitingForInitialInspection}
    title={labels.importTitle}
    closeLabel={labels.close}
    size="small"
    className="portable-session-dialog portable-session-dialog--import"
    dialogRole="alertdialog"
    dismissOnBackdrop={!busy}
    onClose={close}
  >
    <div className="portable-session-form">
      {step === "picking" && <div className="portable-session-picker">
        <input
          ref={fileRef}
          type="file"
          accept=".jshare,application/vnd.joko.session"
          disabled={inspecting}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void inspect(file);
            event.target.value = "";
          }}
        />
        <Button tone="primary" disabled={inspecting} onClick={() => fileRef.current?.click()}>
          {inspecting && <LoaderCircle className="is-spinning" aria-hidden="true" />}
          {labels.chooseFile}
        </Button>
      </div>}

      {step === "password" && <div className="portable-session-passwords">
        <p className="portable-session-form__hint">{labels.passwordPrompt}</p>
        <label>
          <span className="sr-only">{labels.password}</span>
          <input
            ref={passwordRef}
            type={showPassword ? "text" : "password"}
            value={password}
            placeholder={labels.password}
            disabled={unlocking}
            aria-invalid={passwordError}
            onChange={(event) => { setPassword(event.target.value); setPasswordError(false); }}
            onKeyDown={(event) => { if (event.key === "Enter" && password !== "") void unlock(); }}
          />
          <IconButton disabled={unlocking} disabledReason={unlocking ? labels.showPassword : undefined} label={showPassword ? labels.hidePassword : labels.showPassword} onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </IconButton>
        </label>
        {passwordError && <p className="portable-session-form__error" role="alert">{labels.wrongPassword}</p>}
      </div>}

      {(step === "preview" || step === "committing") && preview !== undefined && <>
        <div className="portable-session-preview">
          <strong title={preview.title}>{preview.title}</strong>
          <span>{labels.previewMeta(preview)}</span>
          {preview.workerCount > 0 && <span>{labels.workerSummary(preview.workerCount)}</span>}
          <span>{labels.fidelity(preview.fidelity)}</span>
        </div>
        <div className="portable-session-risk" role="note"><ShieldAlert aria-hidden="true" /><p>{labels.riskWarning}</p></div>
        <label className="portable-session-select">
          <span>{labels.destination}</span>
          <SelectControl value={targetId} disabled={step === "committing"} onChange={(event) => { setTargetId(event.target.value); setUseWorktree(false); }}>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
          </SelectControl>
        </label>
        {preview.workspaceKind === "project" && selectedTarget?.worktreeSupported === true && <label className="portable-session-check portable-session-check--detail">
          <CheckboxControl checked={useWorktree} disabled={step === "committing"} onChange={(event) => setUseWorktree(event.target.checked)} />
          <span><strong>{labels.createWorktree}</strong><small>{labels.createWorktreeHint}</small></span>
        </label>}
      </>}

      {step === "conflict" && <div className="portable-session-conflict"><strong>{labels.conflictTitle}</strong><p>{labels.conflictBody}</p></div>}
      {step === "done" && result !== undefined && <div
        className={cx("portable-session-done", result.status === "imported_activation_failed" && "portable-session-done--warning")}
        role={result.status === "ready" ? "status" : "alert"}
      >
        <strong>{result.status === "ready" ? labels.importComplete : labels.activationFailedTitle}</strong>
        {result.status === "imported_activation_failed" && <p>{labels.activationFailedBody(result.activationError?.message ?? labels.activationRetryFailed)}</p>}
        <p>{labels.fidelityResult(result.fidelity)}</p>
        {result.workerCount > 0 && <p>{labels.importedWorkers(result.workerCount)}</p>}
      </div>}
      {error !== undefined && <p className="portable-session-form__error" role="alert">{error}</p>}

      <div className="modal__actions">
        {step !== "done" && step !== "conflict" && <Button disabled={busy} onClick={close}>{labels.cancel}</Button>}
        {step === "password" && <Button tone="primary" disabled={password === "" || unlocking} onClick={() => void unlock()}>
          {unlocking && <LoaderCircle className="is-spinning" aria-hidden="true" />}{labels.unlock}
        </Button>}
        {(step === "preview" || step === "committing") && <Button tone="primary" disabled={!canCommit || step === "committing"} onClick={() => void commit(false)}>
          {step === "committing" && <LoaderCircle className="is-spinning" aria-hidden="true" />}{labels.import}
        </Button>}
        {step === "conflict" && <><Button onClick={() => setStep("preview")}>{labels.cancel}</Button><Button tone="primary" onClick={() => void commit(true)}>{labels.overwrite}</Button></>}
        {step === "done" && result !== undefined && <>
          <Button disabled={retryingActivation} onClick={close}>{labels.close}</Button>
          {result.status === "ready"
            ? <Button tone="primary" onClick={() => { onOpenTask(result.sessionId); onClose(); }}>{labels.openTask}</Button>
            : <Button tone="primary" disabled={retryingActivation} onClick={() => void retryActivation()}>
                {retryingActivation && <LoaderCircle className="is-spinning" aria-hidden="true" />}{labels.retryActivation}
              </Button>}
        </>}
      </div>
    </div>
  </Modal>;
}

function portableSessionErrorCode(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const direct = "code" in value ? value.code : undefined;
  if (typeof direct === "string") return direct;
  const publicError = "publicError" in value ? value.publicError : undefined;
  if (publicError === null || typeof publicError !== "object" || !("code" in publicError)) return undefined;
  return typeof publicError.code === "string" ? publicError.code : undefined;
}
