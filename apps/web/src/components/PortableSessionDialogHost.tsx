import { useMemo } from "react";
import type { JSX } from "react";

import type { OperationApi, SessionView } from "../model.js";
import type { AppSnapshot } from "../model.js";
import type { PortableSessionImportOwner } from "../portable-session-import-connection.js";
import {
  portableSessionExecutionForTarget,
  portableSessionTargetOptions
} from "../portable-session-ui.js";
import type { Translator } from "./types.js";
import {
  PortableSessionExportDialog,
  PortableSessionImportDialog,
  type PortableSessionDialogLabels,
  type PortableSessionFidelity
} from "./PortableSessionDialogs.js";

type PortableSessionController = Pick<OperationApi,
  | "cancelPortableSessionImport"
  | "commitPortableSessionImport"
  | "exportPortableSession"
  | "inspectPortableSessionImport"
  | "retryPortableSessionActivation"
  | "unlockPortableSessionImport"
>;

export interface PortableSessionImportRequest {
  readonly id: number;
  readonly file?: File;
  /** Unbound only for an OS handoff received before the first connection. */
  readonly owner?: PortableSessionImportOwner;
}

export function PortableSessionDialogHost({
  controller,
  snapshot,
  locale,
  t,
  exportSession,
  importRequest,
  connectionOwner,
  defaultTargetId,
  worktreeSupportedTargetIds,
  onCloseExport,
  onCloseImport,
  onExported,
  onOpenTask
}: {
  readonly controller: PortableSessionController;
  readonly snapshot: AppSnapshot;
  readonly locale: string;
  readonly t: Translator;
  readonly exportSession?: SessionView;
  readonly importRequest?: PortableSessionImportRequest;
  readonly connectionOwner?: string;
  readonly defaultTargetId?: string;
  readonly worktreeSupportedTargetIds: ReadonlySet<string>;
  readonly onCloseExport: () => void;
  readonly onCloseImport: (requestId: number) => void;
  readonly onExported: (fidelity: PortableSessionFidelity) => void;
  readonly onOpenTask: (sessionId: string) => void;
}): JSX.Element {
  const labels = useMemo(() => portableSessionDialogLabels(t, locale), [locale, t]);
  const targets = portableSessionTargetOptions(snapshot, worktreeSupportedTargetIds);
  const validDefaultTargetId = defaultTargetId !== undefined && targets.some((target) => target.id === defaultTargetId)
    ? defaultTargetId
    : targets[0]?.id;
  const request = importRequest?.owner !== undefined && importRequest.owner.key === connectionOwner ? importRequest : undefined;
  const importApi = request?.owner?.api;
  return <>
    <PortableSessionExportDialog
      key={JSON.stringify(["export", exportSession?.id])}
      connectionOwner={controller.exportPortableSession}
      open={exportSession !== undefined}
      labels={labels}
      onClose={onCloseExport}
      onExport={(options, context) => exportSession === undefined
        ? Promise.resolve({ status: "cancelled" })
        : controller.exportPortableSession(exportSession.id, options, context)}
      onExported={onExported}
    />
    {request !== undefined && importApi !== undefined && <PortableSessionImportDialog
      key={JSON.stringify(["import", request.id, request.owner!.key])}
      open
      initialFile={request.file}
      labels={labels}
      targets={targets}
      defaultTargetId={validDefaultTargetId}
      executionForTarget={(targetId) => portableSessionExecutionForTarget(snapshot, targetId)}
      onClose={() => onCloseImport(request.id)}
      onInspect={(file) => importApi.inspectPortableSessionImport(file)}
      onUnlock={(draftId, password) => importApi.unlockPortableSessionImport(draftId, password)}
      onCancelDraft={(draftId) => importApi.cancelPortableSessionImport(draftId)}
      onCommit={(input) => importApi.commitPortableSessionImport(input)}
      onRetryActivation={(sessionId) => importApi.retryPortableSessionActivation(sessionId)}
      onOpenTask={onOpenTask}
    />}
  </>;
}

export function portableSessionDialogLabels(t: Translator, locale: string): PortableSessionDialogLabels {
  return {
    exportTitle: t("portable.exportTitle"),
    sensitiveWarning: t("portable.sensitiveWarning"),
    encrypt: t("portable.encrypt"),
    password: t("portable.password"),
    confirmPassword: t("portable.confirmPassword"),
    showPassword: t("portable.showPassword"),
    hidePassword: t("portable.hidePassword"),
    passwordMismatch: t("portable.passwordMismatch"),
    passwordTooShort: t("portable.passwordTooShort"),
    cancel: t("common.cancel"),
    export: t("portable.export"),
    exportWithoutMedia: t("portable.exportWithoutMedia"),
    oversizeHint: (megabytes) => t("portable.oversizeHint", { megabytes }),
    oversizeFailure: t("portable.oversizeFailure"),
    exportFailed: t("portable.exportFailed"),
    importTitle: t("portable.importTitle"),
    chooseFile: t("portable.chooseFile"),
    chooseAnotherFile: t("portable.chooseAnotherFile"),
    passwordPrompt: t("portable.passwordPrompt"),
    unlock: t("portable.unlock"),
    wrongPassword: t("portable.wrongPassword"),
    previewMeta: (preview) => t("portable.previewMeta", {
      messages: preview.messageCount,
      media: preview.mediaCount,
      date: portableSessionExportDate(preview.exportedAt, locale)
    }),
    workerSummary: (count) => t("portable.workerSummary", { count }),
    fidelity: (value) => portableSessionFidelityLabel(value, t),
    riskWarning: t("portable.riskWarning"),
    destination: t("portable.destination"),
    createWorktree: t("portable.createWorktree"),
    createWorktreeHint: t("portable.createWorktreeHint"),
    import: t("portable.import"),
    importFailed: t("portable.importFailed"),
    conflictTitle: t("portable.conflictTitle"),
    conflictBody: t("portable.conflictBody"),
    overwrite: t("portable.overwrite"),
    importComplete: t("portable.importComplete"),
    activationFailedTitle: t("portable.activationFailedTitle"),
    activationFailedBody: (reason) => t("portable.activationFailedBody", { reason }),
    retryActivation: t("portable.retryActivation"),
    activationRetryFailed: t("portable.activationRetryFailed"),
    fidelityResult: (value) => t("portable.fidelityResult", { fidelity: portableSessionFidelityLabel(value, t) }),
    importedWorkers: (count) => t("portable.importedWorkers", { count }),
    close: t("common.close"),
    openTask: t("portable.openTask")
  };
}

function portableSessionFidelityLabel(value: PortableSessionFidelity, t: Translator): string {
  if (value === "full") return t("portable.fidelity.full");
  if (value === "partial") return t("portable.fidelity.partial");
  return t("portable.fidelity.productOnly");
}

function portableSessionExportDate(value: number, locale: string): string {
  const resolvedLocale = locale === "en-XA" ? "en" : locale;
  try {
    return new Intl.DateTimeFormat(resolvedLocale, { dateStyle: "medium", timeStyle: "short" }).format(value);
  } catch {
    return new Date(value).toLocaleString();
  }
}
