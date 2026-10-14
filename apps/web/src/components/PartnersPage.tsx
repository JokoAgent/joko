import { Code, ConnectError } from "@connectrpc/connect";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  CircleAlert,
  Menu,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
  Settings2,
  Trash2,
  UserRoundPlus
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX } from "react";

import { PartnerCreationReceipts } from "../partner-creation-receipts.js";
import { PartnerDeletionPanel } from "./PartnerDeletionPanel.js";
import { PartnerRestartPanel } from "./PartnerRestartPanel.js";
import { PartnerResumeDialog } from "./PartnerResumeDialog.js";
import { PartnerRoutineDialog } from "./PartnerRoutineDialog.js";
import { PartnerGroupsSection } from "./PartnerGroups.js";
import { PartnerImportDialog } from "./PartnerImportDialog.js";
import { PartnerMemoryDialog } from "./PartnerMemoryDialog.js";
import { PartnerConnectionsDialog } from "./PartnerConnectionsDialog.js";
import { partnerTaskModelMessages } from "@joko/contracts";
import { partnerSessionTaskMessages, partnerSessionTaskActive, type PartnerSessionTaskView } from "@joko/contracts";
import { partnerConnectionsMessages } from "@joko/contracts";
import type { PartnerLearningSettingsDestination } from "@joko/contracts";
import { partnerMemoryMessages } from "@joko/contracts";
import { partnerImportMessages } from "@joko/contracts";
import { partnerResumeMessages, routineMessages } from "@joko/contracts";
import type { PartnerDeletionView } from "@joko/contracts";
import { partnerAvatarInput, type PartnerAvatarDraft } from "../partner-avatar.js";
import { PartnerAvatar } from "./PartnerAvatar.js";
import { PartnerSources } from "./PartnerSources.js";
import { partnerSourceKey, validatePartnerSourceOwner, validatePartnerSourceProfile, validatePartnerSourceSession } from "../partner-sources.js";
import { registerPartnerNavigationLeave } from "../partner-navigation-leave.js";
import { currentPartnerWorkingStatus } from "../partner-working-status.js";
import { PartnerWorkingLabel } from "./PartnerWorkingStatus.js";
import { usePartnerDocumentForeground } from "./use-partner-working-status.js";
import { AvatarPicker } from "./PartnerAvatarPicker.js";
import { usePartnerPermissionConfirmation } from "./use-partner-permission-confirmation.js";

import type { AppController } from "../controller.js";
import type {
  AppSnapshot,
  BackendView,
  ModelView,
  PartnerCapabilitiesView,
  ArtifactView,
  PartnerDelegationView,
  PartnerDirectoryView,
  PartnerDraftView,
  PartnerLifecycleView,
  PartnerModelRouteView,
  PartnerMutationView,
  PartnerPatchView,
  PartnerPrivateThreadDetailView,
  PartnerPrivateThreadView,
  PartnerProfileView,
  PartnerSessionView,
  PartnerTemplateView
} from "../model.js";
import { NativeArtifactFileActionsMenu } from "./NativeFileCopyMenu.js";
import { formatPartnerDuration, partnerDelegationActive } from "./PartnerDelegationInlineCard.js";
import { Button, CheckboxControl, IconButton, Modal, Pill, SelectControl, Spinner, cx, formatBytes } from "./ui.js";
import type { Translator } from "./types.js";
import "./partners-page.css";

interface PartnerCatalogState {
  readonly directory: PartnerDirectoryView;
  readonly partners: readonly PartnerProfileView[];
  readonly pendingDeletions?: readonly PartnerDeletionView[];
  readonly pendingRestarts?: readonly import("@joko/contracts").PartnerRestartView[];
}

interface PartnerEditorDraft {
  readonly displayName: string;
  readonly description: string;
  readonly avatar: PartnerAvatarDraft;
  readonly identitySource: string;
  readonly usesDirectoryDefaults: boolean;
  readonly capabilities: PartnerCapabilitiesView;
  readonly taskModelOverride?: PartnerModelRouteView;
}

export function PartnersPage({ controller, snapshot, focusPartnerId, preparation: preparationProp, t, onOpenNavigation }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly focusPartnerId?: string;
  readonly preparation?: boolean;
  readonly t: Translator;
  readonly onOpenNavigation: () => void;
}): JSX.Element {
  const latestControllerRef = useRef(controller);
  latestControllerRef.current = controller;
  const rootRef = useRef<HTMLElement>(null);
  const preparation = preparationProp === true || controller.state.route?.kind === "partners" && controller.state.route.preparation === true;
  const requestedSourceProfile = controller.state.route?.kind === "partners" ? controller.state.route.profileId : undefined;
  const ownerKey = JSON.stringify([controller.state.activeProfile?.serverId, controller.state.activeProfile?.id,
    controller.state.activeProfile?.origin, controller.state.activeProfile?.deviceId, controller.state.connectionGeneration,
    controller.state.connectionState, snapshot.generation.toString(), requestedSourceProfile, focusPartnerId, preparation]);
  const foreground = usePartnerDocumentForeground();
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const [catalog, setCatalog] = useState<PartnerCatalogState>();
  const catalogOwnerRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importOwner, setImportOwner] = useState<string>();
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [deletePartner, setDeletePartner] = useState<PartnerProfileView>();
  const [restartPartner, setRestartPartner] = useState<PartnerProfileView>();
  const [resumePartner, setResumePartner] = useState<PartnerProfileView>();
  const resumeOwnerRef = useRef<string | undefined>(undefined);
  const restartOwnerRef = useRef<string | undefined>(undefined);
  const deleteOwnerRef = useRef<string | undefined>(undefined);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string>();
  const loadGenerationRef = useRef(0);
  const [reload, setReload] = useState(0);
  const load = (): void => setReload((value) => value + 1);

  const readCatalog = (signal: AbortSignal, quiet: boolean): Promise<boolean> => {
    const generation = ++loadGenerationRef.current;
    const expectedOwner = ownerRef.current;
    if (!quiet) { setLoading(true); setLoadError(undefined); }
    return latestControllerRef.current.listPartners(undefined, signal).then(async (result) => {
      if (signal.aborted || generation !== loadGenerationRef.current || expectedOwner !== ownerRef.current) return false;
      const sourceProfile = latestControllerRef.current.state.route?.kind === "partners" ? latestControllerRef.current.state.route.profileId : undefined;
      let incoming = result;
      if (focusPartnerId !== undefined && sourceProfile !== undefined) {
        const active = latestControllerRef.current.state.activeProfile;
        if (active?.id !== sourceProfile) throw new Error("The original Partner node has not been adopted.");
        const [fresh, links] = await Promise.all([latestControllerRef.current.getPartner(focusPartnerId, signal),
          preparation ? Promise.resolve(undefined) : latestControllerRef.current.listPartnerSessions(focusPartnerId, signal)]);
        if (signal.aborted || generation !== loadGenerationRef.current || expectedOwner !== ownerRef.current) return false;
        validatePartnerSourceOwner(active, latestControllerRef.current.state.snapshot);
        if (preparation) validatePartnerSourceProfile(focusPartnerId, fresh);
        else validatePartnerSourceSession(focusPartnerId, fresh, links!, latestControllerRef.current.state.snapshot);
        incoming = { ...result, partners: upsertPartner(result.partners, fresh) };
      }
      const previousOwner = catalogOwnerRef.current;
      catalogOwnerRef.current = expectedOwner;
      setCatalog((current) => previousOwner === expectedOwner ? retainCurrentCatalog(current, incoming) : incoming);
      setLoadError(undefined);
      if (focusPartnerId !== undefined) {
        const focused = result.partners.find((partner) => partner.id === focusPartnerId);
        if (focused !== undefined) setShowArchived(focused.lifecycle === "archived");
      }
      return true;
    }).catch((error: unknown) => {
      if (signal.aborted || generation !== loadGenerationRef.current || expectedOwner !== ownerRef.current) return false;
      setLoadError(errorMessage(error, t("partners.loadFailed")));
      return false;
    }).finally(() => {
      if (generation === loadGenerationRef.current && expectedOwner === ownerRef.current) setLoading(false);
    });
  };

  useEffect(() => {
    if (!foreground || controller.state.connectionState !== "connected") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (quiet: boolean): Promise<void> => {
      const success = await readCatalog(abort.signal, quiet);
      if (success && !abort.signal.aborted) timer = setTimeout(() => { void read(true); }, 2500);
    };
    void read(false);
    return () => {
      loadGenerationRef.current += 1;
      abort.abort(); clearTimeout(timer);
    };
  }, [ownerKey, foreground, reload]);

  const mergeMutation = (result: PartnerMutationView): void => {
    setCatalog((current) => current === undefined ? current : ({
      directory: result.directory,
      partners: result.partner.lifecycle === "deleted"
        ? current.partners.filter((partner) => partner.id !== result.partner.id)
        : upsertPartner(current.partners, result.partner)
    }));
  };
  const setPending = (partnerId: string, pending: boolean): void => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(partnerId); else next.delete(partnerId);
      return next;
    });
  };
  const mutateLifecycle = async (partner: PartnerProfileView, lifecycle: PartnerLifecycleView): Promise<void> => {
    setPending(partner.id, true);
    setActionError(undefined);
    try {
      const result = await latestControllerRef.current.setPartnerLifecycle(partner.id, partner.revision, lifecycle);
      if (ownerRef.current !== ownerKey) return;
      mergeMutation(result);
      if (lifecycle === "deleted" || focusPartnerId === partner.id) latestControllerRef.current.navigate({ kind: "partners" });
    } catch (error) {
      if (ownerRef.current === ownerKey) setActionError(errorMessage(error, t("partners.actionFailed")));
    } finally {
      if (ownerRef.current === ownerKey) setPending(partner.id, false);
    }
  };
  const retryInitialization = async (partner: PartnerProfileView): Promise<void> => {
    setPending(partner.id, true);
    setActionError(undefined);
    try {
      const result = await latestControllerRef.current.retryPartnerInitialization(partner.id, partner.revision);
      if (ownerRef.current === ownerKey) mergeMutation(result);
    } catch (error) {
      if (ownerRef.current === ownerKey) setActionError(errorMessage(error, t("partners.retryFailed")));
    } finally {
      if (ownerRef.current === ownerKey) setPending(partner.id, false);
    }
  };
  const openTask = async (partner: PartnerProfileView): Promise<void> => {
    if (partner.canonicalSessionId === undefined) return;
    const expectedOwner = ownerRef.current;
    setActionError(undefined);
    if (controller.openSourcePartner && controller.state.activeProfile) {
      try { await controller.openSourcePartner(partnerSourceKey(controller.state.activeProfile), partner.id, "session"); }
      catch (error) { if (ownerRef.current === expectedOwner) setActionError(errorMessage(error, t("partners.actionFailed"))); }
      return;
    }
    if (partner.activity.unreadReplyCount > 0 && partner.activity.latestReplyCursor !== undefined) {
      try {
        const activity = await latestControllerRef.current.markPartnerRead(
          partner.id,
          partner.activity.latestReplyCursor
        );
        if (ownerRef.current === ownerKey) {
          setCatalog((current) => current === undefined ? current : ({
            ...current,
            partners: current.partners.map((candidate) =>
              candidate.id === partner.id ? { ...candidate, activity } : candidate)
          }));
        }
      } catch (error) {
        if (ownerRef.current === ownerKey) setActionError(errorMessage(error, t("partners.markReadFailed")));
      }
    }
    if (ownerRef.current !== expectedOwner) return;
    latestControllerRef.current.navigate({ kind: "session", sessionId: partner.canonicalSessionId });
  };

  const catalogCurrent = catalogOwnerRef.current === ownerKey;
  const selected = !preparation && catalogCurrent && (requestedSourceProfile === undefined || requestedSourceProfile === controller.state.activeProfile?.id)
    ? catalog?.partners.find((partner) => partner.id === focusPartnerId) : undefined;
  const visible = catalogCurrent ? catalog?.partners.filter((partner) => showArchived ? partner.lifecycle === "archived" : ["active", "paused"].includes(partner.lifecycle)) ?? [] : [];
  const usableModels = useMemo(() => partnerModels(snapshot), [snapshot.backends, snapshot.models]);
  const creationCatalogCurrent = catalog !== undefined && catalogOwnerRef.current === ownerKey;
  useEffect(() => {
    if (!preparation || !catalogCurrent) return;
    const card = rootRef.current?.querySelector<HTMLElement>("[data-preparation-target='true']");
    card?.scrollIntoView?.({ block: "nearest" }); card?.focus({ preventScroll: true });
  }, [ownerKey, preparation, catalogCurrent]);

  return <main ref={rootRef} className="route-page partners-page">
    <header className="route-header">
      {!controller.state.preferences.navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
      <div><p className="eyebrow">{t("partners.eyebrow")}</p><h1>{t("nav.partners")}</h1><p>{t("partners.subtitle")}</p></div>
      <div className="route-header__actions">
        <Button onClick={() => setEditingDefaults(true)} disabled={catalog === undefined || usableModels.length === 0}><Settings2 aria-hidden="true" />{t("partners.defaults")}</Button>
        <Button tone="primary" onClick={() => setCreating(true)} disabled={!creationCatalogCurrent || loading}><UserRoundPlus aria-hidden="true" />{t("partners.invite")}</Button>
        <Button onClick={() => setImportOwner(ownerKey)} disabled={!creationCatalogCurrent || loading}>{partnerImportMessages(controller.state.effectiveLocale).title}</Button>
      </div>
    </header>
    {importOwner === ownerKey && creationCatalogCurrent && <PartnerImportDialog key={`import:${ownerKey}`} controller={controller} ownerKey={ownerKey}
      foreground={foreground && controller.state.connectionState === "connected"} t={t} onClose={() => { setImportOwner(undefined); load(); }}
      onCreated={result => { if (ownerRef.current === ownerKey && result.canonicalSessionId) { setImportOwner(undefined); load(); controller.navigate({ kind: "session", sessionId: result.canonicalSessionId }); } }} />}
    <PartnerDeletionPanel key={`deletion:${ownerKey}`} controller={controller} ownerKey={ownerKey} foreground={foreground}
      partner={deleteOwnerRef.current === ownerKey ? deletePartner : undefined} pending={catalogOwnerRef.current === ownerKey ? catalog?.pendingDeletions ?? [] : []}
      t={t} onClose={() => setDeletePartner(undefined)}
      onChanged={() => { setReload((value) => value + 1); if (focusPartnerId) controller.navigate({ kind: "partners" }); }} />
    <PartnerRestartPanel key={`restart:${ownerKey}`} controller={controller} ownerKey={ownerKey} foreground={foreground}
      partner={restartOwnerRef.current === ownerKey ? restartPartner : undefined} pending={catalogOwnerRef.current === ownerKey ? catalog?.pendingRestarts ?? [] : []}
      t={t} onClose={() => setRestartPartner(undefined)} onChanged={load} />
    {resumePartner && resumeOwnerRef.current === ownerKey && <PartnerResumeDialog key={`resume:${ownerKey}:${resumePartner.id}`}
      controller={controller} ownerKey={ownerKey} foreground={foreground} partner={resumePartner}
      onClose={() => setResumePartner(undefined)} onChanged={load} />}
    {catalog !== undefined && catalogCurrent && <section className="partner-summary" aria-label={t("partners.summary")}>
      <div><strong>{catalog.directory.activeCount}</strong><span>{t("partners.active")}</span></div>
      <div><strong>{catalog.directory.archivedCount}</strong><span>{t("partners.archived")}</span></div>
      <div className={catalog.directory.errorCount > 0 ? "is-warning" : undefined}><strong>{catalog.directory.errorCount}</strong><span>{t("partners.needsAttention")}</span></div>
      <Button tone="ghost" onClick={() => load()} disabled={loading}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button>
    </section>}
    {catalog && catalogCurrent && !showArchived && <PartnerGroupsSection controller={controller} partners={catalog.partners} t={t} />}
    <div className="partners-toolbar">
      <div className="segmented" role="radiogroup" aria-label={t("partners.filter")}>
        <button type="button" role="radio" aria-checked={!showArchived} className={cx("segmented__item", !showArchived && "is-active")} onClick={() => setShowArchived(false)}>{t("partners.active")}</button>
        <button type="button" role="radio" aria-checked={showArchived} className={cx("segmented__item", showArchived && "is-active")} onClick={() => setShowArchived(true)}>{t("partners.archived")}</button>
      </div>
    </div>
    {actionError !== undefined && <p className="partner-page-error" role="alert">{actionError}</p>}
    {controller.state.activeProfile && <header className="partner-source__header"><div><h2>{controller.state.activeProfile.name}</h2><Pill>{t("partners.source.current")}</Pill></div></header>}
    {loadError !== undefined && catalog !== undefined && <p className="partner-page-error" role="alert">{loadError}<Button onClick={() => load()}>{t("common.retry")}</Button></p>}
    {loading && (catalog === undefined || !catalogCurrent) ? <div className="partner-page-state"><Spinner /><p>{t("partners.loading")}</p></div>
      : loadError !== undefined && catalog === undefined ? <div className="partner-page-state"><CircleAlert aria-hidden="true" /><h2>{t("partners.unavailable")}</h2><p>{loadError}</p><Button onClick={() => load()}>{t("common.retry")}</Button></div>
        : <section className="partner-card-grid">{visible.map((partner) => <PartnerCard
          key={partner.id}
          partner={partner}
          preparationTarget={preparation && partner.id === focusPartnerId}
          controller={controller}
          snapshot={snapshot}
          workingOwner={foreground && controller.state.ready && controller.state.connectionState === "connected"
            && catalogOwnerRef.current === ownerKey && loadError === undefined ? ownerKey : undefined}
          pending={pendingIds.has(partner.id)}
          t={t}
          onEdit={() => { if (controller.openSourcePartner && controller.state.activeProfile && partner.initializationState === "ready" && partner.lifecycle !== "archived") {
            void controller.openSourcePartner(partnerSourceKey(controller.state.activeProfile), partner.id, "settings").catch(error => {
              if (ownerRef.current === ownerKey) setActionError(errorMessage(error, t("partners.actionFailed")));
            });
          } else controller.navigate({ kind: "partners", partnerId: partner.id }); }}
          onOpen={() => void openTask(partner)}
          onRetry={() => void retryInitialization(partner)}
          onArchive={() => void mutateLifecycle(partner, partner.lifecycle === "archived" ? "active" : "archived")}
          onDelete={() => { deleteOwnerRef.current = ownerKey; setDeletePartner(partner); }}
          onRestart={() => { restartOwnerRef.current = ownerKey; setRestartPartner(partner); }}
          onResume={() => { resumeOwnerRef.current = ownerKey; setResumePartner(partner); }}
        />)}{visible.length === 0 && <div className="partner-empty"><Bot aria-hidden="true" /><h2>{showArchived ? t("partners.noArchived") : t("partners.empty")}</h2><p>{t("partners.emptyBody")}</p>{!showArchived && <Button tone="primary" onClick={() => setCreating(true)}>{t("partners.invite")}</Button>}</div>}</section>}
    <PartnerSources controller={controller} archived={showArchived} t={t} />
    {catalog !== undefined && creationCatalogCurrent && <PartnerInviteDialog
      key={ownerKey}
      open={creating}
      directory={catalog.directory}
      snapshot={snapshot}
      controller={controller}
      ownerKey={ownerKey}
      t={t}
      onClose={() => setCreating(false)}
      onCreated={(result) => {
        mergeMutation(result);
        setCreating(false);
        controller.navigate({ kind: "partners", partnerId: result.partner.id });
      }}
    />}
    {catalog !== undefined && catalogCurrent && <PartnerDefaultsDialog
      open={editingDefaults}
      directory={catalog.directory}
      snapshot={snapshot}
      controller={controller}
      ownerKey={ownerKey}
      t={t}
      onClose={() => setEditingDefaults(false)}
      onSaved={(directory, affected) => {
        setCatalog((current) => current === undefined ? current : ({
          directory,
          partners: affected.reduce(upsertPartner, current.partners)
        }));
        setEditingDefaults(false);
      }}
    />}
    {catalog !== undefined && selected !== undefined && <PartnerSettingsDialog
      key={`${ownerKey}\u0000${selected.id}`}
      partner={selected}
      partners={catalog.partners}
      directory={catalog.directory}
      snapshot={snapshot}
      controller={controller}
      ownerKey={ownerKey}
      t={t}
      onClose={() => controller.navigate({ kind: "partners" })}
      onUpdated={mergeMutation}
      onActivityUpdated={(profile) => setCatalog((current) => current === undefined ? current : ({
        ...current,
        partners: upsertPartner(current.partners, profile)
      }))}
    />}
  </main>;
}

function PartnerCard({ partner, controller, snapshot, workingOwner, pending, preparationTarget = false, t, onEdit, onOpen, onRetry, onArchive, onDelete, onRestart, onResume }: {
  readonly partner: PartnerProfileView;
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly workingOwner: string | undefined;
  readonly pending: boolean;
  readonly preparationTarget?: boolean;
  readonly t: Translator;
  readonly onEdit: () => void;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onRestart: () => void;
  readonly onResume: () => void;
}): JSX.Element {
  const primary = partner.capabilities.modelChain[0]!;
  const statusTone = partner.initializationState === "ready" ? "success" : partner.initializationState === "error" ? "danger" : "warning";
  const working = workingOwner === undefined || !partner.activity.workingStatus ? undefined : currentPartnerWorkingStatus(partner, snapshot);
  return <article className={cx("partner-card", partner.lifecycle === "archived" && "is-archived")} data-partner-id={partner.id}
    data-preparation-target={preparationTarget ? "true" : undefined} tabIndex={preparationTarget ? -1 : undefined}>
    <header><PartnerAvatar preset={partner.avatar} partner={partner} /><div><h2>{partner.displayName}</h2><p>{primary.providerId} · {primary.modelId}</p></div><Pill tone={partner.lifecycle === "paused" ? "warning" : statusTone}>{partner.lifecycle === "paused" ? partnerResumeMessages(controller.state.effectiveLocale).paused : t(`partners.state.${partner.initializationState}`)}</Pill></header>
    {working && workingOwner ? <p className="partner-card__working" role="status" aria-live="polite">
      <PartnerWorkingLabel controller={controller} partner={partner} status={working} ownerKey={workingOwner} t={t} />
    </p> : <p className="partner-card__identity">{firstIdentityLine(partner.activity.latestReplyPreview || partner.description || partner.identitySource)}</p>}
    <div className="partner-card__activity" aria-label={t("partners.activitySummary")}>
      {partner.activity.unreadReplyCount > 0 && <Pill tone="accent">{t("partners.unreadReplies", { count: partner.activity.unreadReplyCount })}</Pill>}
      <span>{t("partners.artifactCount", { count: partner.activity.artifactCount })}</span>
      <span>{t("partners.activeDelegationCount", { count: partner.activity.activeDelegationCount })}</span>
    </div>
    <dl><div><dt>{t("partners.profileVersion")}</dt><dd>{partner.profileVersion.toString()}</dd></div><div><dt>{t("partners.modelRoutes")}</dt><dd>{partner.capabilities.modelChain.length}</dd></div><div><dt>{t("partners.settingsSource")}</dt><dd>{t(partner.usesDirectoryDefaults ? "partners.sharedDefaults" : "partners.customSettings")}</dd></div></dl>
    {partner.initializationState === "error" && <div className="partner-card__error" role="alert"><CircleAlert aria-hidden="true" /><span><strong>{t("partners.preparationFailed")}</strong><small>{t(`partners.error.${partner.initializationErrorCode ?? "stateChanged"}`)}</small></span></div>}
    <footer>
      {partner.lifecycle === "active" && partner.initializationState === "ready" && <Button onClick={onOpen}><MessageSquare aria-hidden="true" />{t("partners.openTask")}</Button>}
      {partner.initializationState === "error" && <Button onClick={onRetry} disabled={pending}><RotateCcw aria-hidden="true" />{pending ? t("common.working") : t("common.retry")}</Button>}
      <Button onClick={onEdit} disabled={preparationTarget && partner.initializationState !== "ready"}><Pencil aria-hidden="true" />{t("common.edit")}</Button>
      {partner.lifecycle === "active" && partner.canonicalSessionId !== undefined && <Button onClick={onRestart} disabled={pending}><RefreshCcw aria-hidden="true" />{t("partners.restartAction")}</Button>}
      {partner.lifecycle === "paused" && <Button onClick={onResume} disabled={pending || !workingOwner}><RotateCcw aria-hidden="true" />{partnerResumeMessages(controller.state.effectiveLocale).action}</Button>}
      {partner.lifecycle !== "paused" && <Button onClick={onArchive} disabled={pending}><Archive aria-hidden="true" />{partner.lifecycle === "archived" ? t("partners.restore") : t("session.archive")}</Button>}
      <Button tone="ghost" className="partner-card__delete" onClick={onDelete}><Trash2 aria-hidden="true" />{t("common.delete")}</Button>
    </footer>
  </article>;
}

function retainCurrentCatalog(current: PartnerCatalogState | undefined, incoming: PartnerCatalogState): PartnerCatalogState {
  if (!current) return incoming;
  if (current.directory.revision > incoming.directory.revision) return current;
  return { ...incoming, partners: incoming.partners.map((partner) => {
    const previous = current.partners.find((item) => item.id === partner.id);
    if (!previous) return partner;
    const profile = previous.revision > partner.revision ? previous : partner;
    const activity = previous.activity.readThroughCursor > partner.activity.readThroughCursor ? previous.activity : partner.activity;
    return { ...profile, activity: { ...activity, workingStatus: partner.activity.workingStatus } };
  }) };
}

function PartnerInviteDialog({ open, directory, snapshot, controller, ownerKey, t, onClose, onCreated }: {
  readonly open: boolean;
  readonly directory: PartnerDirectoryView;
  readonly snapshot: AppSnapshot;
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onCreated: (result: PartnerMutationView) => void;
}): JSX.Element {
  const initial = (): PartnerDraftView => inviteDraft(directory, snapshot);
  const [draft, setDraft] = useState<PartnerDraftView>(initial);
  const [formDirectory, setFormDirectory] = useState(directory);
  const [submitting, setSubmitting] = useState(false);
  const [avatarPreparing, setAvatarPreparing] = useState(false);
  const avatarPreparingRef = useRef(false);
  const preparingAvatar = (value: boolean): void => { avatarPreparingRef.current = value; setAvatarPreparing(value); };
  const [error, setError] = useState<string>();
  const [receipts, setReceipts] = useState<readonly string[]>([]);
  const [receiptUnavailable, setReceiptUnavailable] = useState(true);
  const [resolution, setResolution] = useState<"absent" | "retired">();
  const formRef = useRef<HTMLFormElement>(null);
  const flightRef = useRef(false);
  const epochRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const receiptStoreRef = useRef<PartnerCreationReceipts | undefined>(undefined);
  const inputRef = useRef({ directory, snapshot });
  inputRef.current = { directory, snapshot };
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    if (!open) return;
    const ownerDocument = formRef.current?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (ownerWindow === null || ownerWindow === undefined) return;
    const activate = (): void => {
      epochRef.current += 1;
      abortRef.current = new AbortController();
      flightRef.current = false;
      setSubmitting(false);
      setResolution(undefined);
      setError(undefined);
      try {
        const store = new PartnerCreationReceipts(ownerWindow.localStorage, controller.state.activeProfile);
        const pending = store.list();
        receiptStoreRef.current = store;
        setReceipts(pending);
        setReceiptUnavailable(false);
        if (pending.length === 0) setDraft(inviteDraft(inputRef.current.directory, inputRef.current.snapshot));
      } catch {
        receiptStoreRef.current = undefined;
        setReceiptUnavailable(true);
        setError(t("partners.creationReceiptFailed"));
      }
      setFormDirectory(inputRef.current.directory);
    };
    const retire = (): void => {
      epochRef.current += 1;
      abortRef.current?.abort();
      flightRef.current = false;
    };
    activate();
    ownerWindow.addEventListener("pagehide", retire);
    ownerWindow.addEventListener("pageshow", activate);
    return () => {
      retire();
      ownerWindow.removeEventListener("pagehide", retire);
      ownerWindow.removeEventListener("pageshow", activate);
    };
  }, [open, ownerKey, controller]);
  useEffect(() => {
    if (directory.revision > formDirectory.revision) setFormDirectory(directory);
  }, [directory, formDirectory.revision]);
  const modelsAvailable = partnerModels(snapshot).length > 0;
  const valid = validPartnerDraft(draft) && modelsAvailable;
  const locked = submitting || receiptUnavailable || receipts.length > 0;
  const effectiveCapabilities = draft.usesDirectoryDefaults ? formDirectory.defaultCapabilities : draft.capabilities;
  const permissionCatalog = useMemo(() => partnerPermissionCatalogKey(snapshot), [snapshot.backends, snapshot.models, snapshot.generation]);
  const permissionConfirmation = usePartnerPermissionConfirmation(JSON.stringify([ownerKey, open, formDirectory.revision.toString(), directory.revision.toString(), draft, permissionCatalog]),
    open && !locked && !avatarPreparing && valid && effectiveCapabilities !== undefined && partnerCapabilitiesAvailable(effectiveCapabilities, snapshot), t);
  const begin = (): { readonly signal: AbortSignal; readonly current: () => boolean } | undefined => {
    const abort = abortRef.current;
    if (flightRef.current || abort === undefined || abort.signal.aborted || !open) return undefined;
    flightRef.current = true;
    const epoch = epochRef.current;
    const activeController = controller;
    setSubmitting(true);
    setError(undefined);
    return { signal: abort.signal, current: () => !abort.signal.aborted && epoch === epochRef.current
      && ownerRef.current === ownerKey && controllerRef.current === activeController };
  };
  const finish = (action: { readonly current: () => boolean }): void => {
    if (!action.current()) return;
    flightRef.current = false;
    setSubmitting(false);
  };
  const submitConfirmed = async (): Promise<void> => {
    const store = receiptStoreRef.current;
    if (!valid || locked || avatarPreparingRef.current || store === undefined) return;
    const action = begin();
    if (action === undefined) return;
    let requestId: string | undefined;
    let dispatched = false;
    try {
      const pending = store.list();
      if (pending.length > 0) { setReceipts(pending); return; }
      requestId = crypto.randomUUID();
      store.claim(requestId);
      setReceipts([requestId]);
      const capturedDraft = draft;
      dispatched = true;
      const result = await controller.createPartner(formDirectory.revision, capturedDraft, requestId, action.signal);
      if (!action.current()) return;
      store.resolve(requestId);
      setReceipts(store.list());
      onCreated(result);
    } catch (caught) {
      if (!action.current()) return;
      if (dispatched && requestId !== undefined && caught instanceof ConnectError
        && (caught.code === Code.InvalidArgument || caught.code === Code.AlreadyExists)) {
        try { store.resolve(requestId); setReceipts(store.list()); }
        catch { setReceiptUnavailable(true); }
        setError(errorMessage(caught, t("partners.inviteFailed")));
      } else {
        if (!dispatched) setReceiptUnavailable(true);
        setError(t(dispatched ? "partners.creationUnknown" : "partners.creationReceiptFailed"));
      }
    } finally {
      finish(action);
    }
  };
  const submit = (): void => {
    if (!valid || locked || avatarPreparingRef.current || effectiveCapabilities === undefined || !partnerCapabilitiesAvailable(effectiveCapabilities, snapshot)) return;
    if (effectiveCapabilities.permissionMode === "bypassPermissions") permissionConfirmation.request(() => { void submitConfirmed(); });
    else void submitConfirmed();
  };
  const recover = async (): Promise<void> => {
    const store = receiptStoreRef.current;
    const requestId = receipts[0];
    if (store === undefined || requestId === undefined) return;
    const action = begin();
    if (action === undefined) return;
    setResolution(undefined);
    try {
      const result = await controller.getPartnerCreation(requestId, action.signal);
      if (!action.current()) return;
      if (result.partner.lifecycle !== "active") { setResolution("retired"); return; }
      store.resolve(requestId);
      setReceipts(store.list());
      onCreated(result);
    } catch (caught) {
      if (!action.current()) return;
      if (caught instanceof ConnectError && caught.code === Code.NotFound) setResolution("absent");
      else setError(t("partners.creationLookupFailed"));
    } finally { finish(action); }
  };
  const newIntent = async (): Promise<void> => {
    const store = receiptStoreRef.current;
    const requestId = receipts[0];
    if (store === undefined || requestId === undefined || resolution === undefined) return;
    const action = begin();
    if (action === undefined) return;
    try {
      const retired = await controller.retirePartnerCreation(requestId, action.signal);
      if (!action.current()) return;
      if (retired.partner?.lifecycle === "active") {
        store.resolve(requestId);
        setReceipts(store.list());
        onCreated({ partner: retired.partner, directory: retired.directory });
        return;
      }
      const fresh = await controller.getPartnerDirectory(action.signal);
      if (!action.current()) return;
      store.resolve(requestId);
      const pending = store.list();
      setReceipts(pending);
      setResolution(undefined);
      setFormDirectory(fresh);
      if (pending.length === 0 && (!fresh.templates.some((template) => template.id === draft.templateId)
        || typeof draft.avatar === "string" && !fresh.avatarPresets.includes(draft.avatar))) setDraft(inviteDraft(fresh, snapshot));
    } catch {
      if (action.current()) setError(t("partners.creationLookupFailed"));
    } finally { finish(action); }
  };
  const selectTemplate = (template: PartnerTemplateView): void => setDraft((current) => ({
    ...current,
    templateId: template.id,
    description: template.description,
    identitySource: template.identitySource
  }));
  return <Modal open={open} title={t("partners.inviteTitle")} description={t("partners.inviteBody")} size="large" onClose={submitting || avatarPreparing ? () => undefined : onClose}>
    {permissionConfirmation.dialog}
    <form ref={(node) => { formRef.current = node; permissionConfirmation.rootRef.current = node; }} className="partner-editor" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <fieldset disabled={locked}><legend>{t("partners.template")}</legend><div className="partner-template-grid">{formDirectory.templates.map((template) => <button type="button" key={template.id} className={cx(draft.templateId === template.id && "is-selected")} aria-pressed={draft.templateId === template.id} onClick={() => selectTemplate(template)}><strong>{template.displayName}</strong><span>{template.description}</span></button>)}</div></fieldset>
      <div className="partner-editor__identity-row"><label className="field"><span>{t("partners.name")}</span><input required disabled={locked} maxLength={200} value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><AvatarPicker ownerKey={ownerKey} value={draft.avatar} options={formDirectory.avatarPresets} disabled={locked} t={t} onPreparing={preparingAvatar} onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))} /></div>
      <label className="field"><span>{t("partners.description")}</span><textarea disabled={locked} rows={2} maxLength={12_000} value={draft.description ?? ""} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
      <label className="field"><span>{t("partners.identity")}</span><textarea required disabled={locked} rows={8} maxLength={8_000} value={draft.identitySource} onChange={(event) => setDraft((current) => ({ ...current, identitySource: event.target.value }))} /><small>{t("partners.identityHelp")}</small></label>
      {formDirectory.defaultCapabilities !== undefined && <label className="check-row"><CheckboxControl disabled={locked} checked={draft.usesDirectoryDefaults} onChange={(event) => setDraft((current) => ({ ...current, usesDirectoryDefaults: event.target.checked, capabilities: event.target.checked ? undefined : current.capabilities ?? formDirectory.defaultCapabilities }))} /><span><strong>{t("partners.useDefaults")}</strong><small>{t("partners.useDefaultsHelp")}</small></span></label>}
      {!draft.usesDirectoryDefaults && draft.capabilities !== undefined && <CapabilitiesEditor value={draft.capabilities} snapshot={snapshot} disabled={locked} t={t} onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))} />}
      {receipts.length > 0 && <p role="status">{t(resolution === "absent" ? "partners.creationAbsent" : resolution === "retired" ? "partners.creationRetired" : "partners.creationUnknown")}</p>}
      {!modelsAvailable && receipts.length === 0 && <p role="status">{t("partners.error.modelUnavailable")}</p>}
      {error !== undefined && <p className="partner-editor__error" role="alert">{error}</p>}
      <div className="modal__actions"><Button onClick={onClose} disabled={submitting || avatarPreparing}>{t(receipts.length > 0 ? "common.close" : "common.cancel")}</Button>{receipts.length > 0 ? <Button tone="primary" disabled={submitting} onClick={() => void (resolution === undefined ? recover() : newIntent())}>{submitting ? t("common.working") : t(resolution === undefined ? "partners.creationCheck" : "partners.creationNewIntent")}</Button> : <Button type="submit" tone="primary" disabled={!valid || locked || avatarPreparing}>{submitting ? t("partners.preparing") : t("partners.invite")}</Button>}</div>
    </form>
  </Modal>;
}

function PartnerDefaultsDialog({ open, directory, snapshot, controller, ownerKey, t, onClose, onSaved }: {
  readonly open: boolean;
  readonly directory: PartnerDirectoryView;
  readonly snapshot: AppSnapshot;
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSaved: (directory: PartnerDirectoryView, affected: readonly PartnerProfileView[]) => void;
}): JSX.Element {
  const [value, setValue] = useState<PartnerCapabilitiesView>(() => directory.defaultCapabilities ?? defaultCapabilities(snapshot));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const permissionCatalog = useMemo(() => partnerPermissionCatalogKey(snapshot), [snapshot.backends, snapshot.models, snapshot.generation]);
  const permissionConfirmation = usePartnerPermissionConfirmation(JSON.stringify([ownerKey, open, directory.revision.toString(), value, permissionCatalog]),
    open && !saving && validPartnerCapabilities(value) && partnerCapabilitiesAvailable(value, snapshot), t);
  useEffect(() => {
    if (!open) return;
    setValue(directory.defaultCapabilities ?? defaultCapabilities(snapshot));
    setSaving(false);
    setError(undefined);
  }, [open, directory.revision, ownerKey]);
  const saveConfirmed = async (): Promise<void> => {
    if (!validPartnerCapabilities(value) || saving) return;
    const expectedOwner = ownerRef.current;
    setSaving(true);
    setError(undefined);
    try {
      const result = await controller.updatePartnerDefaults(directory.revision, value);
      if (ownerRef.current === expectedOwner) onSaved(result.directory, result.affectedPartners);
    } catch (caught) {
      if (ownerRef.current === expectedOwner) setError(errorMessage(caught, t("partners.defaultsFailed")));
    } finally {
      if (ownerRef.current === expectedOwner) setSaving(false);
    }
  };
  const save = (): void => {
    if (!validPartnerCapabilities(value) || saving || !partnerCapabilitiesAvailable(value, snapshot)) return;
    if (value.permissionMode === "bypassPermissions") permissionConfirmation.request(() => { void saveConfirmed(); });
    else void saveConfirmed();
  };
  return <Modal open={open} title={t("partners.defaultsTitle")} description={t("partners.defaultsBody")} size="large" onClose={saving ? () => undefined : onClose}>{permissionConfirmation.dialog}<div ref={(node) => { permissionConfirmation.rootRef.current = node; }} className="partner-editor"><CapabilitiesEditor value={value} snapshot={snapshot} disabled={saving} t={t} onChange={setValue} />{error !== undefined && <p className="partner-editor__error" role="alert">{error}</p>}<div className="modal__actions"><Button onClick={onClose} disabled={saving}>{t("common.cancel")}</Button><Button tone="primary" disabled={saving || !validPartnerCapabilities(value) || !partnerCapabilitiesAvailable(value, snapshot)} onClick={save}>{saving ? t("common.working") : t("common.save")}</Button></div></div></Modal>;
}

export function PartnerSettingsDialog({ partner, partners, directory, snapshot, controller, ownerKey, t, initialSection = "activity", initialPrivateThreadId, initialLearningDestination, showClose = false, onClose, onUpdated, onActivityUpdated }: {
  readonly partner: PartnerProfileView;
  readonly partners: readonly PartnerProfileView[];
  readonly directory: PartnerDirectoryView;
  readonly snapshot: AppSnapshot;
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly t: Translator;
  readonly initialSection?: "profile" | "activity";
  readonly initialPrivateThreadId?: string;
  readonly initialLearningDestination?: PartnerLearningSettingsDestination;
  readonly showClose?: boolean;
  readonly onClose: () => void;
  readonly onUpdated: (result: PartnerMutationView) => void;
  readonly onActivityUpdated: (partner: PartnerProfileView) => void;
}): JSX.Element {
  const [baseline, setBaseline] = useState(partner);
  const [routinesVisible, setRoutinesVisible] = useState(false);
  const [memoryVisible, setMemoryVisible] = useState(false);
  const [connectionsVisible, setConnectionsVisible] = useState(false);
  const [restartVisible, setRestartVisible] = useState(false);
  const [restartBusy, setRestartBusy] = useState(false);
  const [resumeVisible, setResumeVisible] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const restartForeground = usePartnerDocumentForeground();
  const [draft, setDraft] = useState<PartnerEditorDraft>(() => editorDraft(partner));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);
  const [avatarPreparing, setAvatarPreparing] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [section, setSection] = useState<"profile" | "activity">(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  const tabsId = useId();
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const aliveRef = useRef(0);
  useEffect(() => () => { aliveRef.current += 1; }, []);
  const draftKey = editorDraftKey(draft);
  const baselineKey = editorDraftKey(editorDraft(baseline));
  const dirty = draftKey !== baselineKey;
  const learningEntryRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialLearningDestination || baseline.initializationState !== "ready" || !baseline.canonicalSessionId
      || dirty || saving || avatarPreparing || restartBusy || resumeBusy || conflict || !restartForeground
      || controller.state.connectionState !== "connected") return;
    const key = `${ownerKey}\u0000${baseline.id}\u0000${initialLearningDestination}`;
    if (learningEntryRef.current === key) return;
    learningEntryRef.current = key;
    setSection("profile");
    if (initialLearningDestination === "memory") setMemoryVisible(true); else setConnectionsVisible(true);
  }, [initialLearningDestination, ownerKey, baseline.id, baseline.initializationState, baseline.canonicalSessionId,
    dirty, saving, avatarPreparing, restartBusy, resumeBusy, conflict, restartForeground, controller.state.connectionState]);
  const [pendingLeave, setPendingLeave] = useState(false);
  const leaveRef = useRef<{ readonly finish: (accepted: boolean) => void } | undefined>(undefined);
  const leaveStateRef = useRef({ dirty, blocked: false });
  leaveStateRef.current = { dirty, blocked: saving || avatarPreparing || restartBusy || routinesVisible || resumeVisible || memoryVisible || connectionsVisible };
  const finishLeave = (accepted: boolean): void => {
    const request = leaveRef.current;
    if (request === undefined) return;
    leaveRef.current = undefined;
    setPendingLeave(false);
    if (accepted) {
      const clean = editorDraft(baseline);
      draftRef.current = clean; leaveStateRef.current = { dirty: false, blocked: false }; setDraft(clean);
    }
    request?.finish(accepted);
  };
  const askLeave = (signal: AbortSignal): Promise<boolean> | undefined => {
    if (signal.aborted || leaveStateRef.current.blocked) return Promise.resolve(false);
    if (!leaveStateRef.current.dirty) return undefined;
    leaveRef.current?.finish(false);
    return new Promise<boolean>(resolve => {
      const cancel = (): void => { if (leaveRef.current === request) { leaveRef.current = undefined; setPendingLeave(false); } finish(false); };
      const finish = (accepted: boolean): void => { signal.removeEventListener("abort", cancel); resolve(!signal.aborted && accepted); };
      const request = { finish };
      leaveRef.current = request;
      signal.addEventListener("abort", cancel, { once: true }); setPendingLeave(true);
    });
  };
  useEffect(() => {
    const unregister = registerPartnerNavigationLeave(askLeave);
    return () => { unregister(); leaveRef.current?.finish(false); leaveRef.current = undefined; };
  }, [ownerKey]);
  useEffect(() => { if (!restartForeground) finishLeave(false); }, [restartForeground]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => { if (leaveStateRef.current.dirty || leaveStateRef.current.blocked) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, []);
  const close = (): void => { const decision = askLeave(new AbortController().signal); if (decision === undefined) onClose(); else void decision.then(accepted => { if (accepted) onClose(); }); };
  const valid = !avatarPreparing && validEditorDraft(draft, directory);
  const effectiveCapabilities = draft.usesDirectoryDefaults ? directory.defaultCapabilities ?? draft.capabilities : draft.capabilities;
  const permissionCatalog = useMemo(() => partnerPermissionCatalogKey(snapshot), [snapshot.backends, snapshot.models, snapshot.generation]);
  const permissionScope = JSON.stringify([ownerKey, partner.id, partner.revision.toString(), baseline.revision.toString(), directory.revision.toString(), draftKey, permissionCatalog]);
  const permissionAvailable = valid && partnerCapabilitiesAvailable(effectiveCapabilities, snapshot) && restartForeground && controller.state.connectionState === "connected";
  const permissionConfirmation = usePartnerPermissionConfirmation(permissionScope, permissionAvailable && !saving && !restartBusy && !resumeBusy && !memoryVisible && !connectionsVisible && !conflict && saveError === undefined, t);

  useEffect(() => {
    if (!dirty || !valid || !permissionAvailable || saving || pendingLeave || restartBusy || resumeBusy || memoryVisible || connectionsVisible || conflict || saveError !== undefined) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      const token = aliveRef.current;
      const expectedOwner = ownerRef.current;
      const captured = draftRef.current;
      const capturedKey = editorDraftKey(captured);
      const write = (): void => {
        setSaving(true);
        void controller.updatePartner(partner.id, baseline.revision, editorPatch(captured)).then((result) => {
        if (token !== aliveRef.current || expectedOwner !== ownerRef.current) return;
        setBaseline(result.partner);
        onUpdated(result);
        if (editorDraftKey(draftRef.current) === capturedKey) setSaved(true);
      }).catch((error: unknown) => {
        if (token !== aliveRef.current || expectedOwner !== ownerRef.current) return;
        if (ConnectError.from(error).code === Code.Aborted) setConflict(true);
        else setSaveError(errorMessage(error, t("partners.saveFailed")));
      }).finally(() => {
        if (token === aliveRef.current && expectedOwner === ownerRef.current) setSaving(false);
      });
      };
      if (effectiveCapabilities.permissionMode === "bypassPermissions" && baseline.capabilities.permissionMode !== "bypassPermissions") {
        permissionConfirmation.request(write, () => setSaveError(t("partners.fullAccessConfirmationRequired")));
      } else write();
    }, 650);
    return () => window.clearTimeout(timer);
  }, [baseline.revision, conflict, draftKey, dirty, saveError, saving, pendingLeave, restartBusy, resumeBusy, memoryVisible, connectionsVisible, valid, permissionAvailable, permissionScope]);

  const reconcile = async (preserveDraft: boolean): Promise<void> => {
    const token = aliveRef.current;
    const expectedOwner = ownerRef.current;
    try {
      const current = await controller.getPartner(partner.id);
      if (token !== aliveRef.current || expectedOwner !== ownerRef.current) return;
      setBaseline(current);
      onUpdated({ partner: current, directory });
      if (!preserveDraft) setDraft(editorDraft(current));
      setConflict(false);
      setSaveError(undefined);
      setSaved(!preserveDraft);
    } catch (error) {
      if (token === aliveRef.current && expectedOwner === ownerRef.current) setSaveError(errorMessage(error, t("partners.reloadFailed")));
    }
  };
  const status = conflict ? t("partners.conflict") : saveError !== undefined ? t("partners.notSaved") : saving ? t("partners.saving") : dirty ? t("partners.unsaved") : saved ? t("partners.saved") : t("partners.unsaved");
  return <Modal open title={t(initialSection === "profile" ? "partners.settingsTitle" : "partners.workspaceTitle", { name: partner.displayName })} description={section === "profile" ? t("partners.settingsBody") : t("partners.workspaceBody")} size="large" onClose={close} showClose={showClose} closeLabel={t("common.close")}>
    <Modal open={pendingLeave} dialogRole="alertdialog" title={t("partners.leave.title")} description={t("partners.leave.body")} onClose={() => finishLeave(false)}>
      <div className="modal__actions"><Button onClick={() => finishLeave(false)}>{t("partners.leave.stay")}</Button><Button tone="danger" onClick={() => finishLeave(true)}>{t("partners.leave.discard")}</Button></div>
    </Modal>
    {permissionConfirmation.dialog}
    {connectionsVisible && <PartnerConnectionsDialog key={`${ownerKey}:${partner.id}`} controller={controller} partner={baseline}
      ownerKey={ownerKey} focusSkills={initialLearningDestination === "skills"} onClose={() => setConnectionsVisible(false)} />}
    {memoryVisible && <PartnerMemoryDialog key={`${ownerKey}:${partner.id}`} controller={controller} partner={baseline} ownerKey={ownerKey} onClose={() => setMemoryVisible(false)} />}
    {resumeVisible && <PartnerResumeDialog controller={controller} ownerKey={ownerKey} foreground={restartForeground} partner={baseline}
      onBusyChange={setResumeBusy} onClose={() => setResumeVisible(false)} onChanged={(profile) => { setBaseline(profile); setDraft(editorDraft(profile)); onActivityUpdated(profile); }} />}
    {routinesVisible && <PartnerRoutineDialog key={`${ownerKey}:${partner.id}`} controller={controller} partnerId={partner.id} ownerKey={ownerKey} onClose={() => setRoutinesVisible(false)} />}
    <div ref={(node) => { permissionConfirmation.rootRef.current = node; }} className="partner-workspace">
      <div className="segmented partner-workspace__tabs" role="tablist" aria-label={t("partners.workspaceSections")} onKeyDown={(event) => {
        if (restartBusy) return;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "ArrowRight" || event.key === "End" ? "profile" : "activity";
        setSection(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-partner-section="${next}"]`)?.focus();
      }}>
        <button id={`${tabsId}-activity-tab`} data-partner-section="activity" type="button" role="tab" aria-controls={`${tabsId}-activity-panel`} aria-selected={section === "activity"} tabIndex={section === "activity" ? 0 : -1} disabled={restartBusy} className={cx("segmented__item", section === "activity" && "is-active")} onClick={() => setSection("activity")}>{t("partners.activity")}</button>
        <button id={`${tabsId}-profile-tab`} data-partner-section="profile" type="button" role="tab" aria-controls={`${tabsId}-profile-panel`} aria-selected={section === "profile"} tabIndex={section === "profile" ? 0 : -1} disabled={restartBusy} className={cx("segmented__item", section === "profile" && "is-active")} onClick={() => setSection("profile")}>{t("partners.profileSettings")}</button>
      </div>
      {section === "profile" ? <div id={`${tabsId}-profile-panel`} role="tabpanel" aria-labelledby={`${tabsId}-profile-tab`} className="partner-editor">
      {baseline.initializationState === "ready" && baseline.canonicalSessionId !== undefined && <Button disabled={saving || dirty || avatarPreparing || conflict || restartBusy || resumeBusy || routinesVisible || memoryVisible || connectionsVisible || !restartForeground || controller.state.connectionState !== "connected"}
        onClick={() => setConnectionsVisible(true)}>{partnerConnectionsMessages(controller.state.effectiveLocale).title}</Button>}
      {baseline.initializationState === "ready" && baseline.canonicalSessionId !== undefined && <Button disabled={saving || dirty || avatarPreparing || conflict || restartBusy || resumeBusy || routinesVisible || connectionsVisible}
        onClick={() => setMemoryVisible(true)}>{partnerMemoryMessages(controller.state.effectiveLocale).title}</Button>}
      {baseline.initializationState === "ready" && baseline.canonicalSessionId !== undefined && <Button disabled={saving || dirty || avatarPreparing || conflict || restartBusy || connectionsVisible} onClick={() => setRoutinesVisible(true)}>{routineMessages(controller.state.effectiveLocale).title}</Button>}
      {baseline.lifecycle === "active" && baseline.canonicalSessionId !== undefined && <Button disabled={saving || dirty || avatarPreparing || conflict || restartBusy || connectionsVisible} onClick={() => setRestartVisible(true)}>{t("partners.restartAction")}</Button>}
      {baseline.lifecycle === "paused" && <Button disabled={saving || dirty || avatarPreparing || conflict || restartBusy || resumeBusy || connectionsVisible || !restartForeground || controller.state.connectionState !== "connected"}
        onClick={() => setResumeVisible(true)}>{partnerResumeMessages(controller.state.effectiveLocale).action}</Button>}
      <PartnerRestartPanel key={`restart:${ownerKey}:${baseline.id}`} controller={controller} ownerKey={ownerKey}
        foreground={restartForeground} partner={restartVisible ? baseline : undefined} pending={[]} t={t}
        onClose={() => setRestartVisible(false)} onBusyChange={setRestartBusy} onChanged={() => undefined} />
      <fieldset disabled={restartBusy || resumeVisible || memoryVisible || connectionsVisible} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="partner-editor__status"><Pill tone={conflict || saveError !== undefined ? "danger" : saving || dirty ? "warning" : "success"}>{status}</Pill><span>{t("partners.profileVersionValue", { version: baseline.profileVersion.toString() })}</span></div>
      {(conflict || saveError !== undefined) && <div className="partner-conflict" role="alert"><CircleAlert aria-hidden="true" /><div><strong>{conflict ? t("partners.conflictTitle") : t("partners.saveFailed")}</strong><p>{conflict ? t("partners.conflictBody") : saveError}</p></div><div><Button onClick={() => void reconcile(false)}>{t("partners.reload")}</Button><Button tone="primary" onClick={() => void reconcile(true)}>{t("common.retry")}</Button></div></div>}
      {!valid && <p className="partner-editor__validation" role="alert">{t("partners.invalidDraft")}</p>}
      <div className="partner-editor__identity-row"><label className="field"><span>{t("partners.name")}</span><input required maxLength={200} value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><AvatarPicker ownerKey={ownerKey} value={draft.avatar} options={directory.avatarPresets} t={t} onPreparing={setAvatarPreparing} partner={baseline} disabled={saving || conflict} onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))} /></div>
      <label className="field"><span>{t("partners.description")}</span><textarea rows={3} maxLength={12_000} value={draft.description} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} /></label>
      <label className="field"><span>{t("partners.identity")}</span><textarea required rows={9} maxLength={8_000} value={draft.identitySource} onChange={(event) => setDraft((current) => ({ ...current, identitySource: event.target.value }))} /><small>{t("partners.autosaveHelp")}</small></label>
      <label className="check-row"><CheckboxControl checked={draft.usesDirectoryDefaults} disabled={directory.defaultCapabilities === undefined} onChange={(event) => setDraft((current) => ({ ...current, usesDirectoryDefaults: event.target.checked, capabilities: event.target.checked ? directory.defaultCapabilities ?? current.capabilities : current.capabilities }))} /><span><strong>{t("partners.useDefaults")}</strong><small>{directory.defaultCapabilities === undefined ? t("partners.defaultsMissing") : t("partners.useDefaultsHelp")}</small></span></label>
      {!draft.usesDirectoryDefaults && <CapabilitiesEditor value={draft.capabilities} snapshot={snapshot} disabled={saving} t={t} onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))} />}
      <TaskModelEditor value={draft.taskModelOverride} capabilities={draft.usesDirectoryDefaults ? directory.defaultCapabilities ?? draft.capabilities : draft.capabilities}
        snapshot={snapshot} disabled={saving} locale={controller.state.effectiveLocale} onChange={taskModelOverride => setDraft(current => {
          const { taskModelOverride: _previous, ...rest } = current;
          return taskModelOverride === undefined ? rest : { ...rest, taskModelOverride };
        })} />
      <div className="partner-editor__footer"><span>{t("partners.updatedAt", { time: new Date(baseline.updatedAt).toLocaleString() })}</span>{baseline.canonicalSessionId !== undefined && <Button onClick={() => controller.navigate({ kind: "session", sessionId: baseline.canonicalSessionId })}><MessageSquare aria-hidden="true" />{t("partners.openTask")}</Button>}</div>
      </fieldset></div> : <div id={`${tabsId}-activity-panel`} role="tabpanel" aria-labelledby={`${tabsId}-activity-tab`}><PartnerActivityPanel key={initialPrivateThreadId ?? "activity"} partner={partner} partners={partners} controller={controller} ownerKey={ownerKey} t={t} initialThreadId={initialPrivateThreadId} onPartnerUpdated={onActivityUpdated} /></div>}
    </div>
  </Modal>;
}

interface PartnerArtifactItem {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly artifact: ArtifactView;
}

interface PartnerActivityData {
  readonly tasks: readonly PartnerSessionTaskView[];
  readonly sessions: readonly PartnerSessionView[];
  readonly threads: readonly PartnerPrivateThreadView[];
  readonly delegations: readonly PartnerDelegationView[];
  readonly artifacts: readonly PartnerArtifactItem[];
  readonly artifactFailures: number;
}

function PartnerActivityPanel({ partner, partners, controller, ownerKey, t, initialThreadId, onPartnerUpdated }: {
  readonly partner: PartnerProfileView;
  readonly partners: readonly PartnerProfileView[];
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly t: Translator;
  readonly initialThreadId?: string;
  readonly onPartnerUpdated: (partner: PartnerProfileView) => void;
}): JSX.Element {
  const [data, setData] = useState<PartnerActivityData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState(initialThreadId);
  const [threadDetail, setThreadDetail] = useState<PartnerPrivateThreadDetailView>();
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string>();
  const [threadReload, setThreadReload] = useState(0);
  const [cancellingId, setCancellingId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const requestRef = useRef(0);

  const load = (quiet = false, externalSignal?: AbortSignal): void => {
    const request = ++requestRef.current;
    const expectedOwner = ownerRef.current;
    if (!quiet) setLoading(true);
    setError(undefined);
    void Promise.all([
      controller.getPartner(partner.id, externalSignal),
      controller.listPartnerSessions(partner.id, externalSignal),
      controller.listPartnerPrivateThreads(partner.id, externalSignal),
      controller.listPartnerDelegations(partner.id, externalSignal),
      controller.listPartnerSessionTasks(partner.id, externalSignal)
    ]).then(async ([profile, sessions, threads, delegations, tasks]) => {
      const sessionTitles = new Map(sessions.map((session) => [session.sessionId, session.displayName]));
      for (const delegation of delegations) {
        if (delegation.childSessionId !== undefined) sessionTitles.set(delegation.childSessionId, delegation.title);
      }
      for (const task of tasks) if (task.sessionId) sessionTitles.set(task.sessionId, task.title);
      const sessionIds = [...new Set([
        ...sessions.filter((session) => session.available && !session.deleted).map((session) => session.sessionId),
        ...delegations.flatMap((delegation) => delegation.childSessionId === undefined ? [] : [delegation.childSessionId]),
        ...tasks.flatMap(task => task.sessionId ? [task.sessionId] : [])
      ])];
      const artifactGroups = await Promise.all(sessionIds.map(async (sessionId) => {
        try {
          const artifacts = await controller.listSessionArtifacts(sessionId, externalSignal);
          return { sessionId, artifacts } as const;
        } catch (caught) {
          if (externalSignal?.aborted === true) throw caught;
          return { sessionId, artifacts: undefined } as const;
        }
      }));
      if (request !== requestRef.current || expectedOwner !== ownerRef.current || externalSignal?.aborted === true) return;
      const next: PartnerActivityData = {
        tasks,
        sessions,
        threads,
        delegations,
        artifacts: artifactGroups.flatMap((group) => group.artifacts?.map((artifact) => ({
          sessionId: group.sessionId,
          sessionTitle: sessionTitles.get(group.sessionId) ?? t("partners.unavailableTask"),
          artifact
        })) ?? []),
        artifactFailures: artifactGroups.filter((group) => group.artifacts === undefined).length
      };
      setData(next);
      setSelectedThreadId((current) => current !== undefined && (current === initialThreadId || threads.some((thread) => thread.id === current))
        ? current
        : initialThreadId ?? threads[0]?.id);
      onPartnerUpdated(profile);
    }).catch((caught: unknown) => {
      if (externalSignal?.aborted === true || request !== requestRef.current || expectedOwner !== ownerRef.current) return;
      setError(errorMessage(caught, t("partners.activityLoadFailed")));
    }).finally(() => {
      if (request === requestRef.current && expectedOwner === ownerRef.current && externalSignal?.aborted !== true) {
        setLoading(false);
      }
    });
  };

  useEffect(() => {
    const abort = new AbortController();
    load(false, abort.signal);
    return () => {
      requestRef.current += 1;
      abort.abort();
    };
  }, [ownerKey, partner.id]);

  const hasLiveDelegation = data?.delegations.some((delegation) => partnerDelegationActive(delegation.status)) === true || data?.tasks.some(partnerSessionTaskActive) === true;
  useEffect(() => {
    if (!hasLiveDelegation) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => load(true, abort.signal), 2_000);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [hasLiveDelegation, data?.delegations.map((delegation) => `${delegation.id}:${delegation.revision}`).join("|")]);

  useEffect(() => {
    if (selectedThreadId === undefined) {
      setThreadDetail(undefined);
      setThreadError(undefined);
      return;
    }
    const abort = new AbortController();
    const expectedOwner = ownerRef.current;
    setThreadLoading(true);
    setThreadError(undefined);
    void controller.getPartnerPrivateThread(partner.id, selectedThreadId, abort.signal).then(async (detail) => {
      if (abort.signal.aborted || expectedOwner !== ownerRef.current) return;
      const lastSequence = detail.messages.at(-1)?.sequence ?? 0;
      const through = detail.readState?.throughSequence ?? 0;
      if (lastSequence > through) {
        const readState = await controller.markPartnerPrivateThreadRead(
          partner.id,
          selectedThreadId,
          lastSequence,
          abort.signal
        );
        if (abort.signal.aborted || expectedOwner !== ownerRef.current) return;
        setThreadDetail({ ...detail, readState });
      } else {
        setThreadDetail(detail);
      }
    }).catch((caught: unknown) => {
      if (!abort.signal.aborted && expectedOwner === ownerRef.current) {
        setThreadError(errorMessage(caught, t("partners.privateThreadLoadFailed")));
      }
    }).finally(() => {
      if (!abort.signal.aborted && expectedOwner === ownerRef.current) setThreadLoading(false);
    });
    return () => abort.abort();
  }, [ownerKey, partner.id, selectedThreadId, threadReload]);

  useEffect(() => {
    if (threadDetail?.messages.some((message) => message.deliveryStatus === "pending") !== true) return;
    const timer = window.setTimeout(() => setThreadReload((current) => current + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [threadDetail]);

  const cancelDelegation = async (delegation: PartnerDelegationView): Promise<void> => {
    const expectedOwner = ownerRef.current;
    setCancellingId(delegation.id);
    setActionError(undefined);
    try {
      const updated = await controller.cancelPartnerDelegation(
        partner.id,
        delegation.id,
        delegation.revision
      );
      if (expectedOwner !== ownerRef.current) return;
      setData((current) => current === undefined ? current : ({
        ...current,
        delegations: current.delegations.map((candidate) => candidate.id === updated.id ? updated : candidate)
      }));
      onPartnerUpdated(await controller.getPartner(partner.id));
    } catch (caught) {
      if (expectedOwner === ownerRef.current) {
        setActionError(errorMessage(caught, t("partners.cancelDelegationFailed")));
        load(true);
      }
    } finally {
      if (expectedOwner === ownerRef.current) setCancellingId(undefined);
    }
  };

  const openPartnerSession = async (session: PartnerSessionView): Promise<void> => {
    const expectedOwner = ownerRef.current;
    setActionError(undefined);
    if (session.role === "canonical" && partner.activity.unreadReplyCount > 0
      && partner.activity.latestReplyCursor !== undefined) {
      try {
        const activity = await controller.markPartnerRead(partner.id, partner.activity.latestReplyCursor);
        if (ownerRef.current === ownerKey) onPartnerUpdated({ ...partner, activity });
      } catch (caught) {
        if (ownerRef.current === ownerKey) {
          setActionError(errorMessage(caught, t("partners.markReadFailed")));
        }
      }
    }
    if (ownerRef.current !== expectedOwner) return;
    controller.navigate({ kind: "session", sessionId: session.sessionId });
  };

  if (loading && data === undefined) return <div className="partner-workspace-state"><Spinner /><p>{t("partners.activityLoading")}</p></div>;
  if (error !== undefined && data === undefined) return <div className="partner-workspace-state" role="alert"><CircleAlert aria-hidden="true" /><p>{error}</p><Button onClick={() => load()}>{t("common.retry")}</Button></div>;
  if (data === undefined) return <div className="partner-workspace-state"><Spinner /></div>;

  const histories = data.sessions.filter((session) => session.role === "history");
  const canonical = data.sessions.find((session) => session.role === "canonical");
  const actions = {
    copyFile: controller.copyArtifactFile,
    openFile: controller.openArtifactFile,
    openFileWithApplication: controller.openArtifactFileWithApplication,
    revealSource: controller.revealArtifactSource
  };
  return <div className="partner-activity">
    <div className="partner-activity__summary" aria-label={t("partners.activitySummary")}>
      <div><strong>{partner.activity.unreadReplyCount}</strong><span>{t("partners.unread")}</span></div>
      <div><strong>{data.artifacts.length}</strong><span>{t("partners.artifacts")}</span></div>
      <div><strong>{data.delegations.filter((delegation) => partnerDelegationActive(delegation.status)).length}</strong><span>{t("partners.activeDelegations")}</span></div>
      <Button tone="ghost" onClick={() => load()} disabled={loading}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button>
    </div>
    {(error !== undefined || actionError !== undefined) && <p className="partner-editor__error" role="alert">{actionError ?? error}</p>}

    <section className="partner-activity__section" aria-labelledby="partner-tasks-heading">
      <header><div><h3 id="partner-tasks-heading">{t("partners.tasks")}</h3><p>{t("partners.tasksBody")}</p></div></header>
      <div className="partner-task-list">
        {canonical !== undefined && <PartnerTaskRow session={canonical} t={t} onOpen={() => void openPartnerSession(canonical)} />}
        {histories.map((session) => <PartnerTaskRow key={session.sessionId} session={session} t={t} onOpen={() => void openPartnerSession(session)} />)}
        {canonical === undefined && histories.length === 0 && <p className="partner-activity__empty">{t("partners.noTasks")}</p>}
      </div>
    </section>

    <section className="partner-activity__section" aria-labelledby="partner-private-heading">
      <header><div><h3 id="partner-private-heading">{t("partners.privateConversations")}</h3><p>{t("partners.privateConversationsBody")}</p></div></header>
      {data.threads.length === 0 && initialThreadId === undefined ? <p className="partner-activity__empty">{t("partners.noPrivateConversations")}</p> : <div className="partner-private-layout">
        <div className="partner-private-list" role="list">{data.threads.map((thread) => {
          const other = partnerById(partners, thread.firstPartnerId === partner.id ? thread.secondPartnerId : thread.firstPartnerId);
          return <button type="button" role="listitem" key={thread.id} className={cx(selectedThreadId === thread.id && "is-selected")} onClick={() => setSelectedThreadId(thread.id)}>
            <span><strong>{other?.displayName ?? t("partners.unknownPartner")}</strong><small>{new Date(thread.updatedAt).toLocaleString()}</small></span>
            <span>{t(`partners.privateState.${thread.status}`)} · {thread.messageCount}/{thread.maxMessages}</span>
          </button>;
        })}</div>
        <div className="partner-private-thread" aria-live="polite">
          {threadLoading ? <Spinner /> : threadError !== undefined ? <div role="alert"><p>{threadError}</p><Button onClick={() => setThreadReload((current) => current + 1)}>{t("common.retry")}</Button></div>
            : threadDetail === undefined ? <p>{t("partners.selectPrivateConversation")}</p>
              : <>{threadDetail.messages.map((message) => {
                const sender = partnerById(partners, message.senderPartnerId);
                return <article key={message.id} className={cx("partner-private-message", message.senderPartnerId === partner.id && "is-own")}>
                  <header><strong>{sender?.displayName ?? t("partners.unknownPartner")}</strong><span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time>{message.deliveryStatus !== "delivered" && <> · {t(`partners.privateDelivery.${message.deliveryStatus}`)}</>}</span></header>
                  <p>{message.content}</p>
                </article>;
              })}{threadDetail.messages.length === 0 && <p>{t("partners.noPrivateMessages")}</p>}
              {threadDetail.thread.status === "closed" && <p className="partner-private-thread__closed">{t(`partners.privateClose.${threadDetail.thread.closeReason ?? "idleTimeout"}`)}</p>}
              {threadDetail.thread.blockedUntil !== undefined && threadDetail.thread.blockedUntil > Date.now() && <p className="partner-private-thread__closed">{t("partners.privateBlockedUntil", { time: new Date(threadDetail.thread.blockedUntil).toLocaleString() })}</p>}</>}
        </div>
      </div>}
    </section>

    <section className="partner-activity__section" aria-labelledby="partner-session-tasks-heading">
      <header><h3 id="partner-session-tasks-heading">{partnerSessionTaskMessages(controller.state.effectiveLocale).title}</h3></header>
      <div className="partner-collaboration-list">{data.tasks.map(task => {
        const copy = partnerSessionTaskMessages(controller.state.effectiveLocale);
        const act = async (action: "pause" | "resume" | "cancel") => {
          const expectedOwner = ownerRef.current; setCancellingId(task.id); setActionError(undefined);
          try {
            await controller.controlPartnerSessionTask(partner.id, partner.revision, task, action);
            if (expectedOwner === ownerRef.current) load(true);
          } catch { if (expectedOwner === ownerRef.current) { setActionError(copy.failed); load(true); } }
          finally { if (expectedOwner === ownerRef.current) setCancellingId(undefined); }
        };
        return <article key={task.id} className="partner-collaboration-card"><header><strong>{task.title}</strong><span role="status">{copy.states[task.control === "active" ? task.status : task.control]}</span></header>
          {task.result && <p>{task.result}</p>}{task.error && <p role="status">{task.error}</p>}
          <div className="partner-collaboration-card__actions">
            {task.sessionId && <Button onClick={() => controller.navigate({ kind: "session", sessionId: task.sessionId! })}>{copy.open}</Button>}
            {task.control === "paused" && <Button disabled={cancellingId !== undefined} onClick={() => void act("resume")}>{copy.resume}</Button>}
            {partnerSessionTaskActive(task) && task.control === "active" && <Button disabled={cancellingId !== undefined} onClick={() => void act("pause")}>{copy.pause}</Button>}
            {(partnerSessionTaskActive(task) || task.control !== "active") && task.sessionId && <Button disabled={cancellingId !== undefined} onClick={() => void act("cancel")}>{copy.cancel}</Button>}
          </div>
        </article>;
      })}{data.tasks.length === 0 && <p className="partner-activity__empty">{partnerSessionTaskMessages(controller.state.effectiveLocale).empty}</p>}</div>
    </section>

    <section className="partner-activity__section" aria-labelledby="partner-delegations-heading">
      <header><div><h3 id="partner-delegations-heading">{t("partners.delegations")}</h3><p>{t("partners.delegationsBody")}</p></div></header>
      <div className="partner-collaboration-list">{data.delegations.map((delegation) => <PartnerCollaborationCard
        key={delegation.id}
        delegation={delegation}
        target={partnerById(partners, delegation.targetPartnerId)}
        cancelling={cancellingId === delegation.id}
        controller={controller}
        t={t}
        onCancel={() => void cancelDelegation(delegation)}
      />)}{data.delegations.length === 0 && <p className="partner-activity__empty">{t("partners.noDelegations")}</p>}</div>
    </section>

    <section className="partner-activity__section" aria-labelledby="partner-artifacts-heading">
      <header><div><h3 id="partner-artifacts-heading">{t("partners.artifacts")}</h3><p>{t("partners.artifactsBody")}</p></div></header>
      {data.artifactFailures > 0 && <p className="partner-activity__warning" role="status">{t("partners.artifactsPartial", { count: data.artifactFailures })}</p>}
      <div className="partner-artifact-list">{data.artifacts.map(({ artifact, sessionId, sessionTitle }) => <article key={`${sessionId}:${artifact.id}`}>
        <div><strong>{artifact.title || artifact.fileName}</strong><small>{sessionTitle} · {formatBytes(artifact.byteSize)}</small></div>
        <NativeArtifactFileActionsMenu actions={actions} artifact={artifact} ownerKey={`${ownerKey}:${sessionId}:${artifact.id}`} t={t} />
      </article>)}{data.artifacts.length === 0 && <p className="partner-activity__empty">{t("partners.noArtifacts")}</p>}</div>
    </section>
  </div>;
}

function PartnerTaskRow({ session, t, onOpen }: {
  readonly session: PartnerSessionView;
  readonly t: Translator;
  readonly onOpen: () => void;
}): JSX.Element {
  return <article className="partner-task-row">
    <div><strong>{session.displayName}</strong><small>{t(`partners.sessionRole.${session.role}`)} · {session.lastActivityAt === undefined ? t("common.unknown") : new Date(session.lastActivityAt).toLocaleString()}</small></div>
    {session.readOnly && <Pill>{t("partners.readOnly")}</Pill>}
    <Button onClick={onOpen} disabled={!session.available || session.deleted}>{t("partners.openTask")}</Button>
  </article>;
}

function PartnerCollaborationCard({ delegation, target, cancelling, controller, t, onCancel }: {
  readonly delegation: PartnerDelegationView;
  readonly target?: PartnerProfileView;
  readonly cancelling: boolean;
  readonly controller: AppController;
  readonly t: Translator;
  readonly onCancel: () => void;
}): JSX.Element {
  const terminal = !partnerDelegationActive(delegation.status);
  const tone = delegation.status === "completed" ? "success"
    : delegation.status === "failed" ? "danger"
      : delegation.status === "unknown" || delegation.status === "waiting" ? "warning"
        : delegation.status === "running" ? "accent" : "neutral";
  const end = delegation.completedAt ?? Date.now();
  return <article className={cx("partner-collaboration-card", `is-${delegation.status}`)}>
    <header><div><strong>{delegation.title}</strong><small>{t("partners.delegatedTo", { name: target?.displayName ?? t("partners.unknownPartner") })}</small></div><Pill tone={tone}>{t(`partners.delegationState.${delegation.status}`)}</Pill></header>
    <p className="partner-collaboration-card__objective">{delegation.objective}</p>
    <dl><div><dt>{t("partners.duration")}</dt><dd>{formatPartnerDuration(Math.max(0, end - (delegation.startedAt ?? delegation.createdAt)), t)}</dd></div><div><dt>{t("partners.artifacts")}</dt><dd>{delegation.artifactCount}</dd></div><div><dt>{t("partners.profileVersion")}</dt><dd>{delegation.targetProfileVersion.toString()}</dd></div></dl>
    {delegation.status === "unknown" && <p className="partner-collaboration-card__warning" role="status">{t("partners.delegationUnknownBody")}</p>}
    {delegation.resultSummary !== undefined && <div className="partner-collaboration-card__result"><strong>{t("partners.delegationResult")}</strong><p>{delegation.resultSummary}</p></div>}
    {delegation.error !== undefined && <p className="partner-collaboration-card__error" role="alert">{delegation.error}</p>}
    <footer>
      {delegation.childSessionId !== undefined && <Button onClick={() => controller.navigate({ kind: "session", sessionId: delegation.childSessionId! })}>{t("partners.openDelegatedTask")}</Button>}
      {!terminal && <Button tone="ghost" disabled={cancelling} onClick={onCancel}>{cancelling ? t("common.working") : t("partners.stopDelegation")}</Button>}
    </footer>
  </article>;
}

function partnerById(partners: readonly PartnerProfileView[], partnerId: string): PartnerProfileView | undefined {
  return partners.find((partner) => partner.id === partnerId);
}

function TaskModelEditor({ value, capabilities, snapshot, disabled, locale, onChange }: {
  readonly value?: PartnerModelRouteView; readonly capabilities: PartnerCapabilitiesView; readonly snapshot: AppSnapshot;
  readonly disabled: boolean; readonly locale: string; readonly onChange: (value: PartnerModelRouteView | undefined) => void;
}): JSX.Element {
  const m = partnerTaskModelMessages(locale), route = value ?? capabilities.modelChain[0]!;
  const models = partnerModels(snapshot).filter(model => {
    const backend = snapshot.backends.find(candidate => candidate.id === model.backendId);
    return backend?.capabilities.get("permission.modes")?.options.includes(capabilities.permissionMode)
      && (!capabilities.planMode || backend.capabilities.get("plan_mode")?.supported === true);
  });
  const model = models.find(candidate => modelKey(candidate) === routeKey(route));
  const fastSupported = model?.supportsFast === true && snapshot.backends.find(candidate => candidate.id === route.backendId)?.capabilities.get("model.fast_mode")?.supported === true;
  return <fieldset className="partner-capabilities" disabled={disabled}><legend>{m.title}</legend>
    <label className="field"><span>{m.choose}</span><SelectControl value={routeKey(route)} onChange={event => {
      const next = models.find(candidate => modelKey(candidate) === event.target.value); if (next) onChange(routeForModel(next));
    }}>{model === undefined && <option value={routeKey(route)}>{route.providerId} · {route.modelId} · {m.unavailable}</option>}
      {models.map(candidate => <option key={modelKey(candidate)} value={modelKey(candidate)}>{candidate.providerName} · {candidate.name}</option>)}</SelectControl></label>
    {model !== undefined && model.efforts.length > 0 && <label className="field"><span>{m.effort}</span><SelectControl value={route.effort ?? ""}
      onChange={event => onChange({ ...route, effort: event.target.value })}>{model.efforts.map(effort => <option value={effort} key={effort}>{effort}</option>)}</SelectControl></label>}
    {(fastSupported || route.fastMode) && <label className="partner-route-check"><CheckboxControl checked={route.fastMode}
      disabled={!fastSupported} onChange={event => onChange({ ...route, fastMode: event.target.checked })} /><span>{m.fast}</span></label>}
    {value === undefined ? <p className="muted">{m.inheriting}</p> : <Button tone="ghost" onClick={() => onChange(undefined)}>{m.inherit}</Button>}
    <p className="muted">{m.help}</p>
  </fieldset>;
}

function CapabilitiesEditor({ value, snapshot, disabled = false, t, onChange }: {
  readonly value: PartnerCapabilitiesView;
  readonly snapshot: AppSnapshot;
  readonly disabled?: boolean;
  readonly t: Translator;
  readonly onChange: (value: PartnerCapabilitiesView) => void;
}): JSX.Element {
  const models = partnerModels(snapshot);
  const chainBackends = value.modelChain.map(route => snapshot.backends.find(candidate => candidate.id === route.backendId));
  const permissionOptions = (["ask", "auto", "bypassPermissions"] as const).filter(mode => chainBackends.every(candidate => candidate?.capabilities.get("permission.modes")?.supported === true && candidate.capabilities.get("permission.modes")?.options?.includes(mode)));
  const planSupported = chainBackends.every(candidate => candidate?.capabilities.get("plan_mode")?.supported === true);
  const modelLabel = (model: ModelView): string => `${new Set(models.map(candidate => candidate.backendId)).size > 1
    ? `${snapshot.backends.find(candidate => candidate.id === model.backendId)?.name ?? model.backendId} · ` : ""}${model.providerName} · ${model.name}`;
  const canSelectModel = (model: ModelView, index?: number): boolean => {
    const candidate = snapshot.backends.find(available => available.id === model.backendId);
    return candidate?.capabilities.get("permission.modes")?.options?.includes(value.permissionMode) === true
      && (!value.planMode || candidate.capabilities.get("plan_mode")?.supported === true)
      && (!value.modelChain.some((route, position) => position !== index && route.backendId === model.backendId)
        || candidate.capabilities.get("model.switch")?.supported === true);
  };
  const replaceRoute = (index: number, route: PartnerModelRouteView): void => onChange({ ...value, modelChain: value.modelChain.map((candidate, candidateIndex) => candidateIndex === index ? route : candidate) });
  const moveFallback = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (disabled || index < 1 || target < 1 || target >= value.modelChain.length) return;
    const modelChain = [...value.modelChain];
    [modelChain[index], modelChain[target]] = [modelChain[target]!, modelChain[index]!];
    onChange({ ...value, modelChain });
  };
  const selectModel = (index: number, key: string): void => {
    const model = models.find((candidate) => modelKey(candidate) === key);
    if (model === undefined) return;
    const route = routeForModel(model);
    const chain = value.modelChain.map((candidate, candidateIndex) => candidateIndex === index ? route : candidate);
    const nextBackends = chain.map(candidate => snapshot.backends.find(available => available.id === candidate.backendId));
    if (!nextBackends.every(candidate => candidate?.capabilities.get("permission.modes")?.options?.includes(value.permissionMode)
      && (!value.planMode || candidate.capabilities.get("plan_mode")?.supported === true))) return;
    onChange({ ...value, modelChain: chain });
  };
  const addFallback = (): void => {
    const used = new Set(value.modelChain.map(routeKey));
    const model = models.find((candidate) => canSelectModel(candidate) && !used.has(modelKey(candidate)));
    if (model !== undefined) onChange({ ...value, modelChain: [...value.modelChain, routeForModel(model)] });
  };
  return <fieldset className="partner-capabilities" disabled={disabled}><legend>{t("partners.capabilities")}</legend>
    <div className="partner-model-chain">{value.modelChain.map((route, index) => {
      const model = snapshot.models.find((candidate) => modelKey(candidate) === routeKey(route));
      const options = models;
      return <div className="partner-model-route" key={`${index}:${routeKey(route)}`}>
        <span className="partner-model-route__number">{index + 1}</span>
        <label className="field"><span>{index === 0 ? t("partners.primaryModel") : t("partners.fallbackModel")}</span><SelectControl value={routeKey(route)} onChange={(event) => selectModel(index, event.target.value)}>{model === undefined && <option value={routeKey(route)}>{route.providerId} · {route.modelId}</option>}{options.map((candidate) => <option key={modelKey(candidate)} value={modelKey(candidate)} disabled={!canSelectModel(candidate, index) || value.modelChain.some((used, usedIndex) => usedIndex !== index && routeKey(used) === modelKey(candidate))}>{modelLabel(candidate)}</option>)}</SelectControl></label>
        {model !== undefined && model.efforts.length > 0 && <label className="field"><span>{t("controls.effort")}</span><SelectControl value={route.effort ?? ""} onChange={(event) => replaceRoute(index, { ...route, effort: event.target.value })}>{model.efforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}</SelectControl></label>}
        {model?.supportsFast === true && <label className="partner-route-check"><CheckboxControl checked={route.fastMode} onChange={(event) => replaceRoute(index, { ...route, fastMode: event.target.checked })} /><span>{t("controls.fast")}</span></label>}
        {index > 0 && <div className="partner-model-route__actions">
          <IconButton label={t("partners.moveFallbackUp")} disabled={disabled || index === 1} onClick={() => moveFallback(index, -1)}><ArrowUp aria-hidden="true" /></IconButton>
          <IconButton label={t("partners.moveFallbackDown")} disabled={disabled || index === value.modelChain.length - 1} onClick={() => moveFallback(index, 1)}><ArrowDown aria-hidden="true" /></IconButton>
          <IconButton label={t("partners.removeFallback")} disabled={disabled} onClick={() => onChange({ ...value, modelChain: value.modelChain.filter((_, candidateIndex) => candidateIndex !== index) })}><Trash2 aria-hidden="true" /></IconButton>
        </div>}
      </div>;
    })}</div>
    {value.modelChain.length < 5 && models.some((model) => canSelectModel(model) && !value.modelChain.some((route) => routeKey(route) === modelKey(model))) && <Button tone="ghost" onClick={addFallback}><Plus aria-hidden="true" />{t("partners.addFallback")}</Button>}
    <div className="partner-capabilities__axes"><label className="field"><span>{t("controls.permission")}</span><SelectControl value={value.permissionMode} onChange={(event) => { const mode = permissionOptions.find(candidate => candidate === event.target.value); if (mode !== undefined) onChange({ ...value, permissionMode: mode }); }}>{!permissionOptions.includes(value.permissionMode) && <option value={value.permissionMode} disabled>{t(value.permissionMode === "ask" ? "permission.ask" : value.permissionMode === "auto" ? "permission.auto" : "permission.full")} · {t("common.unavailable")}</option>}{permissionOptions.map((mode) => <option value={mode} key={mode}>{t(mode === "ask" ? "permission.ask" : mode === "auto" ? "permission.auto" : "permission.full")}</option>)}</SelectControl></label><label className="check-row"><CheckboxControl checked={value.planMode} disabled={!planSupported} onChange={(event) => onChange({ ...value, planMode: event.target.checked })} /><span><strong>{t("controls.plan")}</strong><small>{planSupported ? t("partners.planHelp") : t("partners.planUnavailable")}</small></span></label></div>
  </fieldset>;
}


function inviteDraft(directory: PartnerDirectoryView, snapshot: AppSnapshot): PartnerDraftView {
  const template = directory.templates[0];
  const usesDirectoryDefaults = directory.defaultCapabilities !== undefined;
  return {
    displayName: "",
    avatar: directory.avatarPresets[0] ?? "orbit",
    identitySource: template?.identitySource ?? "",
    description: template?.description ?? "",
    templateId: template?.id ?? "general",
    ...(usesDirectoryDefaults ? {} : { capabilities: defaultCapabilities(snapshot) }),
    usesDirectoryDefaults
  };
}

function defaultCapabilities(snapshot: AppSnapshot): PartnerCapabilitiesView {
  const model = partnerModels(snapshot)[0];
  const backend = snapshot.backends.find((candidate) => candidate.id === model?.backendId);
  const permissionOptions = backend?.capabilities.get("permission.modes")?.options ?? [];
  return {
    modelChain: model === undefined ? [] : [routeForModel(model)],
    permissionMode: permissionOptions.includes("ask") ? "ask" : permissionOptions.includes("auto") ? "auto" : "bypassPermissions",
    planMode: false
  };
}

function partnerModels(snapshot: Pick<AppSnapshot, "backends" | "models">): readonly ModelView[] {
  return snapshot.models.filter((model) => {
    const backend = snapshot.backends.find((candidate) => candidate.id === model.backendId);
    const modes = backend?.capabilities.get("permission.modes");
    return model.available && model.routingEnabled !== false && backend !== undefined
      && backend.health !== "unavailable" && backend.installationState === "installed"
      && (backend.authenticationState === "authenticated" || backend.authenticationState === "notRequired")
      && modes?.supported === true && modes.options.some((mode) => mode === "ask" || mode === "auto" || mode === "bypassPermissions")
      && (model.efforts.length === 0 || backend.capabilities.get("model.effort")?.supported === true);
  });
}

function routeForModel(model: ModelView): PartnerModelRouteView {
  return {
    backendId: model.backendId,
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.efforts[0] === undefined ? {} : { effort: model.efforts[0] }),
    fastMode: false
  };
}

function modelKey(model: Pick<ModelView, "backendId" | "providerId" | "modelId">): string {
  return JSON.stringify([model.backendId, model.providerId, model.modelId]);
}

function routeKey(route: PartnerModelRouteView): string {
  return JSON.stringify([route.backendId, route.providerId, route.modelId]);
}

function validPartnerCapabilities(value: PartnerCapabilitiesView): boolean {
  if (value.modelChain.length < 1 || value.modelChain.length > 5) return false;
  const keys = new Set(value.modelChain.map(routeKey));
  return keys.size === value.modelChain.length && value.modelChain.every((route) => route.backendId.trim() !== "" && route.providerId.trim() !== "" && route.modelId.trim() !== ""
    && (route.effort === undefined || route.effort.trim() !== ""));
}

function partnerCapabilitiesAvailable(value: PartnerCapabilitiesView, snapshot: AppSnapshot): boolean {
  if (!validPartnerCapabilities(value)) return false;
  const availableModels = partnerModels(snapshot);
  return value.modelChain.every((route) => {
    const backend = snapshot.backends.find((candidate) => candidate.id === route.backendId);
    const model = availableModels.find((candidate) => modelKey(candidate) === routeKey(route));
    return model !== undefined && backend?.capabilities.get("permission.modes")?.supported === true
      && backend.capabilities.get("permission.modes")?.options.includes(value.permissionMode) === true
      && (route.effort === undefined || model.efforts.includes(route.effort))
      && (!route.fastMode || model.supportsFast === true && backend.capabilities.get("model.fast_mode")?.supported === true)
      && (!value.planMode || backend.capabilities.get("plan_mode")?.supported === true);
  });
}

function partnerPermissionCatalogKey(snapshot: AppSnapshot): string {
  return JSON.stringify([snapshot.generation, snapshot.backends, snapshot.models], (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value instanceof Map ? [...value.entries()] : value);
}

function validPartnerDraft(draft: PartnerDraftView): boolean {
  return draft.displayName.trim().length > 0 && draft.displayName.trim().length <= 200
    && (draft.description === undefined || draft.description.length <= 12_000 && !draft.description.includes("\0"))
    && partnerAvatarInput(draft.avatar) && draft.templateId.trim() !== ""
    && draft.identitySource.trim().length > 0 && draft.identitySource.length <= 8_000
    && (draft.usesDirectoryDefaults || draft.capabilities !== undefined && validPartnerCapabilities(draft.capabilities));
}

function editorDraft(partner: PartnerProfileView): PartnerEditorDraft {
  return {
    displayName: partner.displayName,
    description: partner.description,
    avatar: partner.avatar,
    identitySource: partner.identitySource,
    usesDirectoryDefaults: partner.usesDirectoryDefaults,
    capabilities: partner.capabilities,
    ...(partner.taskModelOverride === undefined ? {} : { taskModelOverride: partner.taskModelOverride })
  };
}

function validEditorDraft(draft: PartnerEditorDraft, directory: PartnerDirectoryView): boolean {
  return draft.displayName.trim().length > 0 && draft.displayName.trim().length <= 200
    && draft.description.length <= 12_000 && !draft.description.includes("\0")
    && (partnerAvatarInput(draft.avatar) || typeof draft.avatar !== "string" && "sha256" in draft.avatar)
    && draft.identitySource.trim().length > 0 && draft.identitySource.length <= 8_000
    && (!draft.usesDirectoryDefaults || directory.defaultCapabilities !== undefined)
    && (draft.usesDirectoryDefaults || validPartnerCapabilities(draft.capabilities));
}

function editorPatch(draft: PartnerEditorDraft): PartnerPatchView {
  return {
    displayName: draft.displayName,
    description: draft.description,
    ...(partnerAvatarInput(draft.avatar) ? { avatar: draft.avatar } : {}),
    identitySource: draft.identitySource,
    taskModelOverride: draft.taskModelOverride ?? null,
    usesDirectoryDefaults: draft.usesDirectoryDefaults,
    ...(draft.usesDirectoryDefaults ? {} : {
      modelChain: draft.capabilities.modelChain,
      permissionMode: draft.capabilities.permissionMode,
      planMode: draft.capabilities.planMode
    })
  };
}

function editorDraftKey(draft: PartnerEditorDraft): string {
  return JSON.stringify(draft);
}

function upsertPartner(partners: readonly PartnerProfileView[], partner: PartnerProfileView): readonly PartnerProfileView[] {
  const existing = partners.findIndex((candidate) => candidate.id === partner.id);
  if (existing < 0) return [...partners, partner].sort(comparePartners);
  return partners.map((candidate, index) => index === existing ? partner : candidate).sort(comparePartners);
}

function comparePartners(left: PartnerProfileView, right: PartnerProfileView): number {
  return left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id);
}

function firstIdentityLine(source: string): string {
  return source.split(/\r?\n/u).map((line) => line.replace(/^#+\s*/u, "").trim()).find(Boolean) ?? source;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}
