import { Code, ConnectError } from "@connectrpc/connect";
import {
  Archive,
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
import { NativeFileActionsMenu } from "./NativeFileCopyMenu.js";
import { formatPartnerDuration, partnerDelegationActive } from "./PartnerDelegationInlineCard.js";
import { Button, CheckboxControl, IconButton, Modal, Pill, SelectControl, Spinner, cx, formatBytes } from "./ui.js";
import type { Translator } from "./types.js";
import "./partners-page.css";

interface PartnerCatalogState {
  readonly directory: PartnerDirectoryView;
  readonly partners: readonly PartnerProfileView[];
}

interface PartnerEditorDraft {
  readonly displayName: string;
  readonly avatar: string;
  readonly identitySource: string;
  readonly usesDirectoryDefaults: boolean;
  readonly capabilities: PartnerCapabilitiesView;
}

export function PartnersPage({ controller, snapshot, focusPartnerId, t, onOpenNavigation }: {
  readonly controller: AppController;
  readonly snapshot: AppSnapshot;
  readonly focusPartnerId?: string;
  readonly t: Translator;
  readonly onOpenNavigation: () => void;
}): JSX.Element {
  const latestControllerRef = useRef(controller);
  latestControllerRef.current = controller;
  const ownerKey = `${controller.state.activeProfile?.serverId ?? ""}\u0000${controller.state.activeProfile?.id ?? ""}\u0000${controller.state.connectionState}\u0000${snapshot.generation}`;
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const [catalog, setCatalog] = useState<PartnerCatalogState>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);
  const [deletePartner, setDeletePartner] = useState<PartnerProfileView>();
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string>();
  const loadGenerationRef = useRef(0);

  const load = (signal?: AbortSignal): void => {
    const generation = ++loadGenerationRef.current;
    const expectedOwner = ownerRef.current;
    setLoading(true);
    setLoadError(undefined);
    void latestControllerRef.current.listPartners(undefined, signal).then((result) => {
      if (generation !== loadGenerationRef.current || expectedOwner !== ownerRef.current) return;
      setCatalog(result);
      if (focusPartnerId !== undefined) {
        const focused = result.partners.find((partner) => partner.id === focusPartnerId);
        if (focused !== undefined) setShowArchived(focused.lifecycle === "archived");
      }
    }).catch((error: unknown) => {
      if (signal?.aborted === true || generation !== loadGenerationRef.current || expectedOwner !== ownerRef.current) return;
      setLoadError(errorMessage(error, t("partners.loadFailed")));
    }).finally(() => {
      if (generation === loadGenerationRef.current && expectedOwner === ownerRef.current) setLoading(false);
    });
  };

  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    return () => {
      loadGenerationRef.current += 1;
      abort.abort();
    };
  }, [ownerKey]);

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

  const selected = catalog?.partners.find((partner) => partner.id === focusPartnerId);
  const visible = catalog?.partners.filter((partner) => partner.lifecycle === (showArchived ? "archived" : "active")) ?? [];
  const usableModels = useMemo(() => partnerModels(snapshot), [snapshot.backends, snapshot.models]);

  return <main className="route-page partners-page">
    <header className="route-header">
      {!controller.state.preferences.navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
      <div><p className="eyebrow">{t("partners.eyebrow")}</p><h1>{t("nav.partners")}</h1><p>{t("partners.subtitle")}</p></div>
      <div className="route-header__actions">
        <Button onClick={() => setEditingDefaults(true)} disabled={catalog === undefined || usableModels.length === 0}><Settings2 aria-hidden="true" />{t("partners.defaults")}</Button>
        <Button tone="primary" onClick={() => setCreating(true)} disabled={catalog === undefined || usableModels.length === 0}><UserRoundPlus aria-hidden="true" />{t("partners.invite")}</Button>
      </div>
    </header>
    {catalog !== undefined && <section className="partner-summary" aria-label={t("partners.summary")}>
      <div><strong>{catalog.directory.activeCount}</strong><span>{t("partners.active")}</span></div>
      <div><strong>{catalog.directory.archivedCount}</strong><span>{t("partners.archived")}</span></div>
      <div className={catalog.directory.errorCount > 0 ? "is-warning" : undefined}><strong>{catalog.directory.errorCount}</strong><span>{t("partners.needsAttention")}</span></div>
      <Button tone="ghost" onClick={() => load()} disabled={loading}><RefreshCcw aria-hidden="true" />{t("common.refresh")}</Button>
    </section>}
    <div className="partners-toolbar">
      <div className="segmented" role="radiogroup" aria-label={t("partners.filter")}>
        <button type="button" role="radio" aria-checked={!showArchived} className={cx("segmented__item", !showArchived && "is-active")} onClick={() => setShowArchived(false)}>{t("partners.active")}</button>
        <button type="button" role="radio" aria-checked={showArchived} className={cx("segmented__item", showArchived && "is-active")} onClick={() => setShowArchived(true)}>{t("partners.archived")}</button>
      </div>
    </div>
    {actionError !== undefined && <p className="partner-page-error" role="alert">{actionError}</p>}
    {loading && catalog === undefined ? <div className="partner-page-state"><Spinner /><p>{t("partners.loading")}</p></div>
      : loadError !== undefined && catalog === undefined ? <div className="partner-page-state"><CircleAlert aria-hidden="true" /><h2>{t("partners.unavailable")}</h2><p>{loadError}</p><Button onClick={() => load()}>{t("common.retry")}</Button></div>
        : <section className="partner-card-grid">{visible.map((partner) => <PartnerCard
          key={partner.id}
          partner={partner}
          pending={pendingIds.has(partner.id)}
          t={t}
          onEdit={() => controller.navigate({ kind: "partners", partnerId: partner.id })}
          onOpen={() => void openTask(partner)}
          onRetry={() => void retryInitialization(partner)}
          onArchive={() => void mutateLifecycle(partner, partner.lifecycle === "archived" ? "active" : "archived")}
          onDelete={() => setDeletePartner(partner)}
        />)}{visible.length === 0 && <div className="partner-empty"><Bot aria-hidden="true" /><h2>{showArchived ? t("partners.noArchived") : t("partners.empty")}</h2><p>{t("partners.emptyBody")}</p>{!showArchived && <Button tone="primary" onClick={() => setCreating(true)}>{t("partners.invite")}</Button>}</div>}</section>}
    {catalog !== undefined && <PartnerInviteDialog
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
    {catalog !== undefined && <PartnerDefaultsDialog
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
    <DeletePartnerDialog partner={deletePartner} pending={deletePartner === undefined ? false : pendingIds.has(deletePartner.id)} t={t} onClose={() => setDeletePartner(undefined)} onDelete={() => {
      const partner = deletePartner;
      setDeletePartner(undefined);
      if (partner !== undefined) void mutateLifecycle(partner, "deleted");
    }} />
  </main>;
}

function PartnerCard({ partner, pending, t, onEdit, onOpen, onRetry, onArchive, onDelete }: {
  readonly partner: PartnerProfileView;
  readonly pending: boolean;
  readonly t: Translator;
  readonly onEdit: () => void;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
}): JSX.Element {
  const primary = partner.capabilities.modelChain[0]!;
  const statusTone = partner.initializationState === "ready" ? "success" : partner.initializationState === "error" ? "danger" : "warning";
  return <article className={cx("partner-card", partner.lifecycle === "archived" && "is-archived")} data-partner-id={partner.id}>
    <header><PartnerAvatar preset={partner.avatar} /><div><h2>{partner.displayName}</h2><p>{primary.providerId} · {primary.modelId}</p></div><Pill tone={statusTone}>{t(`partners.state.${partner.initializationState}`)}</Pill></header>
    <p className="partner-card__identity">{firstIdentityLine(partner.identitySource)}</p>
    <div className="partner-card__activity" aria-label={t("partners.activitySummary")}>
      {partner.activity.unreadReplyCount > 0 && <Pill tone="accent">{t("partners.unreadReplies", { count: partner.activity.unreadReplyCount })}</Pill>}
      <span>{t("partners.artifactCount", { count: partner.activity.artifactCount })}</span>
      <span>{t("partners.activeDelegationCount", { count: partner.activity.activeDelegationCount })}</span>
    </div>
    <dl><div><dt>{t("partners.profileVersion")}</dt><dd>{partner.profileVersion.toString()}</dd></div><div><dt>{t("partners.modelRoutes")}</dt><dd>{partner.capabilities.modelChain.length}</dd></div><div><dt>{t("partners.settingsSource")}</dt><dd>{t(partner.usesDirectoryDefaults ? "partners.sharedDefaults" : "partners.customSettings")}</dd></div></dl>
    {partner.initializationState === "error" && <div className="partner-card__error" role="alert"><CircleAlert aria-hidden="true" /><span><strong>{t("partners.preparationFailed")}</strong><small>{t(`partners.error.${partner.initializationErrorCode ?? "stateChanged"}`)}</small></span></div>}
    <footer>
      {partner.initializationState === "ready" && <Button onClick={onOpen}><MessageSquare aria-hidden="true" />{t("partners.openTask")}</Button>}
      {partner.initializationState === "error" && <Button onClick={onRetry} disabled={pending}><RotateCcw aria-hidden="true" />{pending ? t("common.working") : t("common.retry")}</Button>}
      <Button onClick={onEdit}><Pencil aria-hidden="true" />{t("common.edit")}</Button>
      <Button onClick={onArchive} disabled={pending}><Archive aria-hidden="true" />{partner.lifecycle === "archived" ? t("partners.restore") : t("session.archive")}</Button>
      <Button tone="ghost" className="partner-card__delete" onClick={onDelete}><Trash2 aria-hidden="true" />{t("common.delete")}</Button>
    </footer>
  </article>;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  useEffect(() => {
    if (!open) return;
    setDraft(initial());
    setSubmitting(false);
    setError(undefined);
  }, [open, directory.revision, ownerKey]);
  const valid = validPartnerDraft(draft);
  const submit = async (): Promise<void> => {
    if (!valid || submitting) return;
    const expectedOwner = ownerRef.current;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await controller.createPartner(directory.revision, draft);
      if (ownerRef.current === expectedOwner) onCreated(result);
    } catch (caught) {
      if (ownerRef.current === expectedOwner) setError(errorMessage(caught, t("partners.inviteFailed")));
    } finally {
      if (ownerRef.current === expectedOwner) setSubmitting(false);
    }
  };
  const selectTemplate = (template: PartnerTemplateView): void => setDraft((current) => ({
    ...current,
    templateId: template.id,
    identitySource: template.identitySource
  }));
  return <Modal open={open} title={t("partners.inviteTitle")} description={t("partners.inviteBody")} size="large" onClose={submitting ? () => undefined : onClose}>
    <form className="partner-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={submitting}><legend>{t("partners.template")}</legend><div className="partner-template-grid">{directory.templates.map((template) => <button type="button" key={template.id} className={cx(draft.templateId === template.id && "is-selected")} aria-pressed={draft.templateId === template.id} onClick={() => selectTemplate(template)}><strong>{template.displayName}</strong><span>{template.description}</span></button>)}</div></fieldset>
      <div className="partner-editor__identity-row"><label className="field"><span>{t("partners.name")}</span><input required maxLength={100} value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><AvatarPicker value={draft.avatar} options={directory.avatarPresets} disabled={submitting} t={t} onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))} /></div>
      <label className="field"><span>{t("partners.identity")}</span><textarea required rows={8} maxLength={8_000} value={draft.identitySource} onChange={(event) => setDraft((current) => ({ ...current, identitySource: event.target.value }))} /><small>{t("partners.identityHelp")}</small></label>
      {directory.defaultCapabilities !== undefined && <label className="check-row"><CheckboxControl checked={draft.usesDirectoryDefaults} onChange={(event) => setDraft((current) => ({ ...current, usesDirectoryDefaults: event.target.checked, capabilities: event.target.checked ? undefined : current.capabilities ?? directory.defaultCapabilities }))} /><span><strong>{t("partners.useDefaults")}</strong><small>{t("partners.useDefaultsHelp")}</small></span></label>}
      {!draft.usesDirectoryDefaults && draft.capabilities !== undefined && <CapabilitiesEditor value={draft.capabilities} snapshot={snapshot} disabled={submitting} t={t} onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))} />}
      {error !== undefined && <p className="partner-editor__error" role="alert">{error}</p>}
      <div className="modal__actions"><Button onClick={onClose} disabled={submitting}>{t("common.cancel")}</Button><Button type="submit" tone="primary" disabled={!valid || submitting}>{submitting ? t("partners.preparing") : t("partners.invite")}</Button></div>
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
  useEffect(() => {
    if (!open) return;
    setValue(directory.defaultCapabilities ?? defaultCapabilities(snapshot));
    setSaving(false);
    setError(undefined);
  }, [open, directory.revision, ownerKey]);
  const save = async (): Promise<void> => {
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
  return <Modal open={open} title={t("partners.defaultsTitle")} description={t("partners.defaultsBody")} size="large" onClose={saving ? () => undefined : onClose}><div className="partner-editor"><CapabilitiesEditor value={value} snapshot={snapshot} disabled={saving} t={t} onChange={setValue} />{error !== undefined && <p className="partner-editor__error" role="alert">{error}</p>}<div className="modal__actions"><Button onClick={onClose} disabled={saving}>{t("common.cancel")}</Button><Button tone="primary" disabled={saving || !validPartnerCapabilities(value)} onClick={() => void save()}>{saving ? t("common.working") : t("common.save")}</Button></div></div></Modal>;
}

function PartnerSettingsDialog({ partner, partners, directory, snapshot, controller, ownerKey, t, onClose, onUpdated, onActivityUpdated }: {
  readonly partner: PartnerProfileView;
  readonly partners: readonly PartnerProfileView[];
  readonly directory: PartnerDirectoryView;
  readonly snapshot: AppSnapshot;
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onUpdated: (result: PartnerMutationView) => void;
  readonly onActivityUpdated: (partner: PartnerProfileView) => void;
}): JSX.Element {
  const [baseline, setBaseline] = useState(partner);
  const [draft, setDraft] = useState<PartnerEditorDraft>(() => editorDraft(partner));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [section, setSection] = useState<"profile" | "activity">("activity");
  const tabsId = useId();
  const ownerRef = useRef(ownerKey);
  ownerRef.current = ownerKey;
  const aliveRef = useRef(0);
  useEffect(() => () => { aliveRef.current += 1; }, []);
  const draftKey = editorDraftKey(draft);
  const baselineKey = editorDraftKey(editorDraft(baseline));
  const dirty = draftKey !== baselineKey;
  const valid = validEditorDraft(draft, directory);

  useEffect(() => {
    if (!dirty || !valid || saving || conflict || saveError !== undefined) return;
    setSaved(false);
    const timer = window.setTimeout(() => {
      const token = aliveRef.current;
      const expectedOwner = ownerRef.current;
      const captured = draftRef.current;
      const capturedKey = editorDraftKey(captured);
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
    }, 650);
    return () => window.clearTimeout(timer);
  }, [baseline.revision, conflict, draftKey, dirty, saveError, saving, valid]);

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
  return <Modal open title={t("partners.workspaceTitle", { name: partner.displayName })} description={section === "profile" ? t("partners.settingsBody") : t("partners.workspaceBody")} size="large" onClose={onClose}>
    <div className="partner-workspace">
      <div className="segmented partner-workspace__tabs" role="tablist" aria-label={t("partners.workspaceSections")} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "ArrowRight" || event.key === "End" ? "profile" : "activity";
        setSection(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-partner-section="${next}"]`)?.focus();
      }}>
        <button id={`${tabsId}-activity-tab`} data-partner-section="activity" type="button" role="tab" aria-controls={`${tabsId}-activity-panel`} aria-selected={section === "activity"} tabIndex={section === "activity" ? 0 : -1} className={cx("segmented__item", section === "activity" && "is-active")} onClick={() => setSection("activity")}>{t("partners.activity")}</button>
        <button id={`${tabsId}-profile-tab`} data-partner-section="profile" type="button" role="tab" aria-controls={`${tabsId}-profile-panel`} aria-selected={section === "profile"} tabIndex={section === "profile" ? 0 : -1} className={cx("segmented__item", section === "profile" && "is-active")} onClick={() => setSection("profile")}>{t("partners.profileSettings")}</button>
      </div>
      {section === "profile" ? <div id={`${tabsId}-profile-panel`} role="tabpanel" aria-labelledby={`${tabsId}-profile-tab`} className="partner-editor">
      <div className="partner-editor__status"><Pill tone={conflict || saveError !== undefined ? "danger" : saving || dirty ? "warning" : "success"}>{status}</Pill><span>{t("partners.profileVersionValue", { version: baseline.profileVersion.toString() })}</span></div>
      {(conflict || saveError !== undefined) && <div className="partner-conflict" role="alert"><CircleAlert aria-hidden="true" /><div><strong>{conflict ? t("partners.conflictTitle") : t("partners.saveFailed")}</strong><p>{conflict ? t("partners.conflictBody") : saveError}</p></div><div><Button onClick={() => void reconcile(false)}>{t("partners.reload")}</Button><Button tone="primary" onClick={() => void reconcile(true)}>{t("common.retry")}</Button></div></div>}
      {!valid && <p className="partner-editor__validation" role="alert">{t("partners.invalidDraft")}</p>}
      <div className="partner-editor__identity-row"><label className="field"><span>{t("partners.name")}</span><input required maxLength={100} value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><AvatarPicker value={draft.avatar} options={directory.avatarPresets} t={t} onChange={(avatar) => setDraft((current) => ({ ...current, avatar }))} /></div>
      <label className="field"><span>{t("partners.identity")}</span><textarea required rows={9} maxLength={8_000} value={draft.identitySource} onChange={(event) => setDraft((current) => ({ ...current, identitySource: event.target.value }))} /><small>{t("partners.autosaveHelp")}</small></label>
      <label className="check-row"><CheckboxControl checked={draft.usesDirectoryDefaults} disabled={directory.defaultCapabilities === undefined} onChange={(event) => setDraft((current) => ({ ...current, usesDirectoryDefaults: event.target.checked, capabilities: event.target.checked ? directory.defaultCapabilities ?? current.capabilities : current.capabilities }))} /><span><strong>{t("partners.useDefaults")}</strong><small>{directory.defaultCapabilities === undefined ? t("partners.defaultsMissing") : t("partners.useDefaultsHelp")}</small></span></label>
      {!draft.usesDirectoryDefaults && <CapabilitiesEditor value={draft.capabilities} snapshot={snapshot} disabled={saving} t={t} onChange={(capabilities) => setDraft((current) => ({ ...current, capabilities }))} />}
      <div className="partner-editor__footer"><span>{t("partners.updatedAt", { time: new Date(baseline.updatedAt).toLocaleString() })}</span>{baseline.canonicalSessionId !== undefined && <Button onClick={() => controller.navigate({ kind: "session", sessionId: baseline.canonicalSessionId })}><MessageSquare aria-hidden="true" />{t("partners.openTask")}</Button>}</div>
      </div> : <div id={`${tabsId}-activity-panel`} role="tabpanel" aria-labelledby={`${tabsId}-activity-tab`}><PartnerActivityPanel partner={partner} partners={partners} controller={controller} ownerKey={ownerKey} t={t} onPartnerUpdated={onActivityUpdated} /></div>}
    </div>
  </Modal>;
}

interface PartnerArtifactItem {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly artifact: ArtifactView;
}

interface PartnerActivityData {
  readonly sessions: readonly PartnerSessionView[];
  readonly threads: readonly PartnerPrivateThreadView[];
  readonly delegations: readonly PartnerDelegationView[];
  readonly artifacts: readonly PartnerArtifactItem[];
  readonly artifactFailures: number;
}

function PartnerActivityPanel({ partner, partners, controller, ownerKey, t, onPartnerUpdated }: {
  readonly partner: PartnerProfileView;
  readonly partners: readonly PartnerProfileView[];
  readonly controller: AppController;
  readonly ownerKey: string;
  readonly t: Translator;
  readonly onPartnerUpdated: (partner: PartnerProfileView) => void;
}): JSX.Element {
  const [data, setData] = useState<PartnerActivityData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
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
      controller.listPartnerDelegations(partner.id, externalSignal)
    ]).then(async ([profile, sessions, threads, delegations]) => {
      const sessionTitles = new Map(sessions.map((session) => [session.sessionId, session.displayName]));
      for (const delegation of delegations) {
        if (delegation.childSessionId !== undefined) sessionTitles.set(delegation.childSessionId, delegation.title);
      }
      const sessionIds = [...new Set([
        ...sessions.filter((session) => session.available && !session.deleted).map((session) => session.sessionId),
        ...delegations.flatMap((delegation) => delegation.childSessionId === undefined ? [] : [delegation.childSessionId])
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
      setSelectedThreadId((current) => current !== undefined && threads.some((thread) => thread.id === current)
        ? current
        : threads[0]?.id);
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

  const hasLiveDelegation = data?.delegations.some((delegation) => partnerDelegationActive(delegation.status)) === true;
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
      {data.threads.length === 0 ? <p className="partner-activity__empty">{t("partners.noPrivateConversations")}</p> : <div className="partner-private-layout">
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
        <NativeFileActionsMenu actions={actions} artifactId={artifact.id} blobId={artifact.blobId} name={artifact.fileName} byteSize={artifact.byteSize} {...(artifact.sourceSessionId === undefined ? {} : { sourceSessionId: artifact.sourceSessionId })} sourceRevealAvailable={artifact.sourceRevealAvailable} ownerKey={`${ownerKey}:${sessionId}:${artifact.id}`} t={t} />
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

function CapabilitiesEditor({ value, snapshot, disabled = false, t, onChange }: {
  readonly value: PartnerCapabilitiesView;
  readonly snapshot: AppSnapshot;
  readonly disabled?: boolean;
  readonly t: Translator;
  readonly onChange: (value: PartnerCapabilitiesView) => void;
}): JSX.Element {
  const models = partnerModels(snapshot);
  const backendId = value.modelChain[0]?.backendId;
  const backend = snapshot.backends.find((candidate) => candidate.id === backendId);
  const switchSupported = backend?.capabilities.get("model.switch")?.supported === true;
  const permissionOptions = (backend?.capabilities.get("permission.modes")?.options ?? ["ask", "auto"])
    .filter((mode): mode is "ask" | "auto" => mode === "ask" || mode === "auto");
  const planSupported = backend?.capabilities.get("plan_mode")?.supported === true;
  const replaceRoute = (index: number, route: PartnerModelRouteView): void => onChange({ ...value, modelChain: value.modelChain.map((candidate, candidateIndex) => candidateIndex === index ? route : candidate) });
  const selectModel = (index: number, key: string): void => {
    const model = models.find((candidate) => modelKey(candidate) === key);
    if (model === undefined) return;
    const route = routeForModel(model);
    const chain = index === 0 && model.backendId !== backendId ? [route] : value.modelChain.map((candidate, candidateIndex) => candidateIndex === index ? route : candidate);
    const nextBackend = snapshot.backends.find((candidate) => candidate.id === route.backendId);
    const modes = nextBackend?.capabilities.get("permission.modes")?.options ?? [];
    const permissionMode = modes.includes(value.permissionMode) ? value.permissionMode : modes.includes("ask") ? "ask" : "auto";
    onChange({ modelChain: chain, permissionMode, planMode: value.planMode && nextBackend?.capabilities.get("plan_mode")?.supported === true });
  };
  const addFallback = (): void => {
    const used = new Set(value.modelChain.map(routeKey));
    const model = models.find((candidate) => candidate.backendId === backendId && !used.has(modelKey(candidate)));
    if (model !== undefined) onChange({ ...value, modelChain: [...value.modelChain, routeForModel(model)] });
  };
  return <fieldset className="partner-capabilities" disabled={disabled}><legend>{t("partners.capabilities")}</legend>
    <div className="partner-model-chain">{value.modelChain.map((route, index) => {
      const model = snapshot.models.find((candidate) => modelKey(candidate) === routeKey(route));
      const options = models.filter((candidate) => index === 0 || candidate.backendId === backendId);
      return <div className="partner-model-route" key={`${index}:${routeKey(route)}`}>
        <span className="partner-model-route__number">{index + 1}</span>
        <label className="field"><span>{index === 0 ? t("partners.primaryModel") : t("partners.fallbackModel")}</span><SelectControl value={routeKey(route)} onChange={(event) => selectModel(index, event.target.value)}>{model === undefined && <option value={routeKey(route)}>{route.providerId} · {route.modelId}</option>}{options.map((candidate) => <option key={modelKey(candidate)} value={modelKey(candidate)} disabled={value.modelChain.some((used, usedIndex) => usedIndex !== index && routeKey(used) === modelKey(candidate))}>{candidate.providerName} · {candidate.name}</option>)}</SelectControl></label>
        {model !== undefined && model.efforts.length > 0 && <label className="field"><span>{t("controls.effort")}</span><SelectControl value={route.effort ?? ""} onChange={(event) => replaceRoute(index, { ...route, effort: event.target.value })}>{model.efforts.map((effort) => <option value={effort} key={effort}>{effort}</option>)}</SelectControl></label>}
        {model?.supportsFast === true && <label className="partner-route-check"><CheckboxControl checked={route.fastMode} onChange={(event) => replaceRoute(index, { ...route, fastMode: event.target.checked })} /><span>{t("controls.fast")}</span></label>}
        {index > 0 && <IconButton label={t("partners.removeFallback")} onClick={() => onChange({ ...value, modelChain: value.modelChain.filter((_, candidateIndex) => candidateIndex !== index) })}><Trash2 aria-hidden="true" /></IconButton>}
      </div>;
    })}</div>
    {switchSupported && value.modelChain.length < 3 && models.some((model) => model.backendId === backendId && !value.modelChain.some((route) => routeKey(route) === modelKey(model))) && <Button tone="ghost" onClick={addFallback}><Plus aria-hidden="true" />{t("partners.addFallback")}</Button>}
    <div className="partner-capabilities__axes"><label className="field"><span>{t("controls.permission")}</span><SelectControl value={value.permissionMode} onChange={(event) => onChange({ ...value, permissionMode: event.target.value as "ask" | "auto" })}>{permissionOptions.map((mode) => <option value={mode} key={mode}>{t(mode === "ask" ? "permission.ask" : "permission.auto")}</option>)}</SelectControl></label><label className="check-row"><CheckboxControl checked={value.planMode} disabled={!planSupported} onChange={(event) => onChange({ ...value, planMode: event.target.checked })} /><span><strong>{t("controls.plan")}</strong><small>{planSupported ? t("partners.planHelp") : t("partners.planUnavailable")}</small></span></label></div>
  </fieldset>;
}

function AvatarPicker({ value, options, disabled = false, t, onChange }: { readonly value: string; readonly options: readonly string[]; readonly disabled?: boolean; readonly t: Translator; readonly onChange: (value: string) => void }): JSX.Element {
  return <fieldset className="partner-avatar-picker" disabled={disabled}><legend>{t("partners.avatar")}</legend><div>{options.map((option) => <button type="button" key={option} className={cx(value === option && "is-selected")} aria-label={t("partners.avatarOption", { name: option })} aria-pressed={value === option} onClick={() => onChange(option)}><PartnerAvatar preset={option} /></button>)}</div></fieldset>;
}

function PartnerAvatar({ preset }: { readonly preset: string }): JSX.Element {
  return <span className={`partner-avatar partner-avatar--${safeCssToken(preset)}`} aria-hidden="true"><span /></span>;
}

function DeletePartnerDialog({ partner, pending, t, onClose, onDelete }: { readonly partner?: PartnerProfileView; readonly pending: boolean; readonly t: Translator; readonly onClose: () => void; readonly onDelete: () => void }): JSX.Element {
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => setConfirmation(""), [partner?.id]);
  return <Modal open={partner !== undefined} title={t("partners.deleteTitle", { name: partner?.displayName ?? "" })} description={t("partners.deleteBody")} size="small" onClose={pending ? () => undefined : onClose}><div className="partner-delete-dialog"><p>{t("partners.deleteWarning")}</p><label className="field"><span>{t("partners.typeName", { name: partner?.displayName ?? "" })}</span><input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><div className="modal__actions"><Button onClick={onClose} disabled={pending}>{t("common.cancel")}</Button><Button tone="danger" disabled={pending || confirmation !== partner?.displayName} onClick={onDelete}>{pending ? t("common.working") : t("common.delete")}</Button></div></div></Modal>;
}

function inviteDraft(directory: PartnerDirectoryView, snapshot: AppSnapshot): PartnerDraftView {
  const template = directory.templates[0];
  const usesDirectoryDefaults = directory.defaultCapabilities !== undefined;
  return {
    displayName: "",
    avatar: directory.avatarPresets[0] ?? "orbit",
    identitySource: template?.identitySource ?? "",
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
    permissionMode: permissionOptions.includes("ask") ? "ask" : "auto",
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
      && modes?.supported === true && modes.options.some((mode) => mode === "ask" || mode === "auto")
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
  if (value.modelChain.length < 1 || value.modelChain.length > 3) return false;
  const backendId = value.modelChain[0]!.backendId;
  const keys = new Set(value.modelChain.map(routeKey));
  return keys.size === value.modelChain.length && value.modelChain.every((route) => route.backendId === backendId
    && route.backendId.trim() !== "" && route.providerId.trim() !== "" && route.modelId.trim() !== ""
    && (route.effort === undefined || route.effort.trim() !== ""));
}

function validPartnerDraft(draft: PartnerDraftView): boolean {
  return draft.displayName.trim().length > 0 && draft.displayName.trim().length <= 100
    && draft.avatar.trim() !== "" && draft.templateId.trim() !== ""
    && draft.identitySource.trim().length > 0 && draft.identitySource.length <= 8_000
    && (draft.usesDirectoryDefaults || draft.capabilities !== undefined && validPartnerCapabilities(draft.capabilities));
}

function editorDraft(partner: PartnerProfileView): PartnerEditorDraft {
  return {
    displayName: partner.displayName,
    avatar: partner.avatar,
    identitySource: partner.identitySource,
    usesDirectoryDefaults: partner.usesDirectoryDefaults,
    capabilities: partner.capabilities
  };
}

function validEditorDraft(draft: PartnerEditorDraft, directory: PartnerDirectoryView): boolean {
  return draft.displayName.trim().length > 0 && draft.displayName.trim().length <= 100
    && draft.avatar.trim() !== "" && draft.identitySource.trim().length > 0 && draft.identitySource.length <= 8_000
    && (!draft.usesDirectoryDefaults || directory.defaultCapabilities !== undefined)
    && (draft.usesDirectoryDefaults || validPartnerCapabilities(draft.capabilities));
}

function editorPatch(draft: PartnerEditorDraft): PartnerPatchView {
  return {
    displayName: draft.displayName,
    avatar: draft.avatar,
    identitySource: draft.identitySource,
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

function safeCssToken(value: string): string {
  return /^[a-z][a-z0-9-]{0,31}$/u.test(value) ? value : "custom";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}
