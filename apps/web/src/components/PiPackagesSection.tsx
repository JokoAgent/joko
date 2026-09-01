import { useState } from "react";
import type { JSX } from "react";
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  PackageCheck,
  Palette,
  ShieldAlert,
  Trash2
} from "lucide-react";

import type { AppController } from "../controller.js";
import type {
  ResourceCompatibilityIssueView,
  ResourceCompatibilityView,
  ResourcePackageWarningView,
  ResourceView
} from "../model.js";
import type { RunAction, Translator } from "./types.js";
import { Button, IconButton, Modal, ModalBackButton, Pill, cx } from "./ui.js";

export function PiPackagesSection({
  controller,
  resources,
  runAction,
  t
}: {
  readonly controller: AppController;
  readonly resources: readonly ResourceView[];
  readonly runAction: RunAction;
  readonly t: Translator;
}): JSX.Element {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<ResourceView | undefined>(undefined);
  const toggleExpanded = (resourceId: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return next;
    });
  };
  const runPackageMutation = (
    key: string,
    action: () => Promise<ResourceView>
  ): void => runAction(key, async () => {
    const result = await action();
    if (result.postMutationNotice) setNotice(result);
  });

  if (resources.length === 0) return <section className="settings-card package-list"><p className="muted">{t("settings.noResources")}</p></section>;
  return <>
    <section className="settings-card package-list" aria-label={t("settings.managedResources")}>
      {resources.map((resource) => {
        const expanded = expandedIds.has(resource.id);
        const compatibility = packageCompatibility(resource);
        const approvalNeeded = resource.requiresExtensionApproval || ["discovered", "awaitingApproval"].includes(resource.state);
        return <article className={cx("package-row", resource.state === "error" && "package-row--error")} key={resource.id}>
          <div className="package-row__summary">
            <IconButton
              className="package-row__expander"
              aria-expanded={expanded}
              aria-controls={`package-details-${resource.id}`}
              label={expanded ? t("resource.collapseDetails", { name: resource.name }) : t("resource.expandDetails", { name: resource.name })}
              onClick={() => toggleExpanded(resource.id)}
            >
              {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </IconButton>
            <span className="package-row__icon" aria-hidden="true">{resourceIcon(resource.kind)}</span>
            <span className="package-row__identity">
              <strong>{resource.name}</strong>
              <small>{resourceKindLabel(resource, t)} · {resourceScopeLabel(resource, t)}{resource.version === undefined ? "" : ` · v${resource.version}`}</small>
              <small className="package-row__source">{resource.source}</small>
            </span>
            <span className="package-row__badges">
              {resource.compatibilityDetails.length > 0 && <Pill tone={compatibilityTone(compatibility)}>{compatibilityLabel(compatibility, t)}</Pill>}
              {approvalNeeded && <Pill tone="warning">{t("resource.approvalRequired")}</Pill>}
              <Pill tone={resourceStateTone(resource)}>{resourceStateLabel(resource, t)}</Pill>
            </span>
            <span className="package-row__actions">
              {approvalNeeded && <Button tone="primary" onClick={() => runAction(`approve-resource:${resource.id}`, () => controller.approveResource(resource.id))}>{t("resource.approve")}</Button>}
              {resource.state === "approved" && resource.scope !== "project" && <Button onClick={() => runPackageMutation(`install-resource:${resource.id}`, () => controller.installResource(resource.id))}>{t("common.install")}</Button>}
              {resourceCanUpdate(resource) && <Button onClick={() => runPackageMutation(`update-resource:${resource.id}`, () => controller.updateResource(resource.id))}>{t("common.update")}</Button>}
              {resourceCanToggle(resource) && <Button onClick={() => runAction(`toggle-resource:${resource.id}`, () => controller.setResourceEnabled(resource.id, !resource.enabled))}>{resource.enabled ? t("common.disable") : t("common.enable")}</Button>}
              {resource.state !== "removed" && <IconButton label={`${t("common.remove")} ${resource.name}`} onClick={() => runAction(`remove-resource:${resource.id}`, () => controller.removeResource(resource.id))}><Trash2 aria-hidden="true" /></IconButton>}
            </span>
          </div>
          {expanded && <div className="package-row__details" id={`package-details-${resource.id}`}>
            <PackageDetails resource={resource} t={t} />
          </div>}
        </article>;
      })}
    </section>
    <Modal
      open={notice !== undefined}
      title={t("resource.compatibilityNoticeTitle")}
      description={notice === undefined ? "" : t("resource.compatibilityNoticeBody", { name: notice.name })}
      size="large"
      onClose={() => setNotice(undefined)}
      headerLeading={<ModalBackButton label={t("common.back")} onClick={() => setNotice(undefined)} />}
    >
      {notice !== undefined && <>
        <div className="package-notice__body"><PackageDetails resource={notice} t={t} /></div>
        <div className="modal__actions">
          {notice.requiresExtensionApproval && <Button tone="primary" onClick={() => runAction(`approve-resource:${notice.id}`, async () => {
            await controller.approveResource(notice.id, notice.discoveredRevision);
            setNotice(undefined);
          })}>{t("resource.approveCurrentContent")}</Button>}
        </div>
      </>}
    </Modal>
  </>;
}

function PackageDetails({ resource, t }: { readonly resource: ResourceView; readonly t: Translator }): JSX.Element {
  return <div className="package-details">
    {resource.requiresExtensionApproval && <div className="package-callout package-callout--warning" role="status"><ShieldAlert aria-hidden="true" /><span><strong>{t("resource.approvalRequired")}</strong><small>{t("resource.approvalRequiredBody")}</small></span></div>}
    {resource.error !== undefined && <div className="package-callout package-callout--danger" role="alert"><AlertTriangle aria-hidden="true" /><span><strong>{t("resource.inspectionError")}</strong><small>{resource.error}</small></span></div>}
    {resource.warnings.map((warning) => <div className="package-callout package-callout--warning" key={warning}><AlertTriangle aria-hidden="true" /><span><strong>{resourceWarningLabel(warning, t)}</strong>{warning === "lifecycleScriptsDisabled" && resource.disabledLifecycleScripts.length > 0 && <small>{t("resource.lifecycleScriptsList", { scripts: resource.disabledLifecycleScripts.join(", ") })}</small>}</span></div>)}
    <section className="package-details__section">
      <h4>{t("resource.packageContents")}</h4>
      {resource.compatibilityDetails.length === 0
        ? <p className="muted">{resource.warnings.includes("noResources") ? t("resource.noCompatibleContents") : t("resource.detailsAfterInspection")}</p>
        : <div className="package-content-list">{resource.compatibilityDetails.map((detail, index) => <article key={`${detail.kind}:${detail.name}:${index}`}>
            <header><span><strong>{detail.name}</strong><small>{resourceDetailKindLabel(detail.kind, t)}</small></span><Pill tone={compatibilityTone(detail.compatibility)}>{compatibilityLabel(detail.compatibility, t)}</Pill></header>
            {detail.adaptedApis.length > 0 && <ApiList label={t("resource.adaptedApis")} values={detail.adaptedApis} tone="supported" />}
            {detail.unsupportedApis.length > 0 && <ApiList label={t("resource.unsupportedApis")} values={detail.unsupportedApis} tone="unsupported" />}
            {detail.issues.length > 0 && <div className="package-issue-list" aria-label={t("resource.compatibilityIssues")}>{detail.issues.map((issue) => <span key={issue}>{compatibilityIssueLabel(issue, t)}</span>)}</div>}
          </article>)}</div>}
    </section>
    {resource.runtimeRequirements.length > 0 && <section className="package-details__section">
      <h4>{t("resource.runtimeRequirements")}</h4>
      <div className="package-requirement-list">{resource.runtimeRequirements.map((requirement) => <div key={`${requirement.packageName}:${requirement.range}`}>
        <span><code>{requirement.packageName}</code><small>{requirement.range}{requirement.currentVersion === undefined ? "" : ` · ${t("resource.currentRuntime", { version: requirement.currentVersion })}`}</small></span>
        <Pill tone={requirement.status === "compatible" ? "success" : requirement.status === "incompatible" ? "danger" : "warning"}>{runtimeRequirementLabel(requirement.status, t)}</Pill>
      </div>)}</div>
    </section>}
    {resource.extensionContentFingerprint !== undefined && <section className="package-details__section package-fingerprint">
      <h4>{t("resource.contentFingerprint")}</h4>
      <code>{resource.extensionContentFingerprint}</code>
      <small>{t("resource.contentFingerprintBody")}</small>
    </section>}
  </div>;
}

function ApiList({ label, values, tone }: { readonly label: string; readonly values: readonly string[]; readonly tone: "supported" | "unsupported" }): JSX.Element {
  return <div className={cx("package-api-list", `package-api-list--${tone}`)}><span>{label}</span><div>{values.map((value) => <code key={value}>{value}</code>)}</div></div>;
}

export function packageCompatibility(resource: ResourceView): ResourceCompatibilityView {
  const values = resource.compatibilityDetails.map((detail) => detail.compatibility);
  if (values.includes("unsupported")) return "unsupported";
  if (values.includes("partial")) return "partial";
  if (values.includes("unknown") || values.length === 0) return "unknown";
  return "supported";
}

export function resourceCanToggle(resource: ResourceView): boolean {
  if (!resource.canToggle || resource.requiresExtensionApproval) return false;
  if (resource.scope === "project") return ["approved", "disabled", "loaded"].includes(resource.state);
  return ["installed", "disabled", "loaded"].includes(resource.state);
}

export function resourceCanUpdate(resource: ResourceView): boolean {
  return ["installed", "loaded", "disabled", "updateAvailable"].includes(resource.state);
}

function resourceIcon(kind: ResourceView["kind"]): JSX.Element {
  if (kind === "package") return <PackageCheck />;
  if (kind === "theme") return <Palette />;
  return <Braces />;
}

function resourceStateTone(resource: ResourceView): "success" | "danger" | "warning" | "accent" | "neutral" {
  if (resource.state === "loaded") return "success";
  if (resource.state === "error") return "danger";
  if (resource.state === "awaitingApproval" || resource.state === "updateAvailable") return "warning";
  if (resource.state === "installing") return "accent";
  return "neutral";
}

function compatibilityTone(value: ResourceCompatibilityView): "success" | "danger" | "warning" | "neutral" {
  if (value === "supported") return "success";
  if (value === "unsupported") return "danger";
  if (value === "partial") return "warning";
  return "neutral";
}

function compatibilityLabel(value: ResourceCompatibilityView, t: Translator): string {
  if (value === "supported") return t("resource.compatibilitySupported");
  if (value === "partial") return t("resource.compatibilityPartial");
  if (value === "unsupported") return t("resource.compatibilityUnsupported");
  return t("resource.compatibilityUnknown");
}

function resourceStateLabel(resource: ResourceView, t: Translator): string {
  if (resource.state === "discovered") return t("resource.stateDiscovered");
  if (resource.state === "awaitingApproval") return t("resource.stateAwaitingApproval");
  if (resource.state === "approved") return t("resource.stateApproved");
  if (resource.state === "installing") return t("resource.stateInstalling");
  if (resource.state === "installed") return t("resource.stateInstalled");
  if (resource.state === "loaded") return t("resource.stateLoaded");
  if (resource.state === "disabled") return t("resource.stateDisabled");
  if (resource.state === "updateAvailable") return t("resource.stateUpdateAvailable");
  if (resource.state === "removed") return t("resource.stateRemoved");
  return t("resource.stateError");
}

function resourceKindLabel(resource: ResourceView, t: Translator): string {
  return resourceDetailKindLabel(resource.kind, t);
}

function resourceDetailKindLabel(kind: ResourceView["kind"], t: Translator): string {
  if (kind === "extension") return t("resource.kindExtension");
  if (kind === "skill") return t("resource.kindSkill");
  if (kind === "prompt") return t("resource.kindPrompt");
  if (kind === "theme") return t("resource.kindTheme");
  return t("resource.kindPackage");
}

function resourceScopeLabel(resource: ResourceView, t: Translator): string {
  if (resource.scope === "user") return t("resource.scopeUser");
  if (resource.scope === "global") return t("resource.scopeGlobal");
  if (resource.scope === "project") return t("resource.scopeProject");
  return t("resource.scopeManaged");
}

function resourceWarningLabel(value: ResourcePackageWarningView, t: Translator): string {
  if (value === "noResources") return t("resource.warningNoResources");
  if (value === "inspectionFailed") return t("resource.warningInspectionFailed");
  if (value === "inspectionLimit") return t("resource.warningInspectionLimit");
  if (value === "lifecycleScriptsDisabled") return t("resource.warningLifecycleScriptsDisabled");
  return t("resource.warningUnknown");
}

function compatibilityIssueLabel(value: ResourceCompatibilityIssueView, t: Translator): string {
  if (value === "workingIndicator") return t("resource.issueWorkingIndicator");
  if (value === "widgetComponent") return t("resource.issueWidgetComponent");
  if (value === "editorIntegration") return t("resource.issueEditorIntegration");
  if (value === "terminalLayout") return t("resource.issueTerminalLayout");
  if (value === "customUi") return t("resource.issueCustomUi");
  if (value === "themeControl") return t("resource.issueThemeControl");
  if (value === "terminalInput") return t("resource.issueTerminalInput");
  if (value === "terminalRendering") return t("resource.issueTerminalRendering");
  if (value === "cliFlags") return t("resource.issueCliFlags");
  if (value === "analysisIncomplete") return t("resource.issueAnalysisIncomplete");
  return t("resource.issueUnknown");
}

function runtimeRequirementLabel(value: ResourceView["runtimeRequirements"][number]["status"], t: Translator): string {
  if (value === "compatible") return t("resource.runtimeCompatible");
  if (value === "incompatible") return t("resource.runtimeIncompatible");
  return t("resource.runtimeUnknown");
}
