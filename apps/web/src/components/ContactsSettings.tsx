import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type JSX } from "react";
import {
  Building2,
  Check,
  Download,
  FileUp,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserRound,
  UsersRound
} from "lucide-react";
import type { AppController } from "../controller.js";
import type {
  ContactDirectoryView,
  ContactDraftView,
  ContactDuplicateCandidateView,
  ContactDuplicatePairView,
  ContactEventInputView,
  ContactGroupView,
  ContactIdentityInputView,
  ContactKindView,
  Locale,
  ContactListPageView,
  ContactPatchView,
  ContactProfileView,
  ContactRelationView,
  ContactStatusView,
  ContactSummaryView,
  ContactVCardImportDecisionKindView,
  ContactVCardImportDecisionView,
  ContactVCardImportPreviewEntryView,
  ContactVCardImportPreviewView,
  ContactVCardImportResultView
} from "../model.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, IconButton, Modal, SelectControl, Spinner, SwitchControl, cx } from "./ui.js";
import "./contacts-settings.css";

interface ContactEditorState {
  readonly mode: "create" | "edit";
  readonly contact?: ContactProfileView;
}

interface RelationEditorState {
  readonly contact: ContactProfileView;
  readonly relation?: ContactRelationView;
}

interface PendingCreateReview {
  readonly draft: ContactDraftView;
  readonly candidates: readonly ContactDuplicateCandidateView[];
}

interface MergeConfirmation {
  readonly target: ContactSummaryView;
  readonly merged: ContactSummaryView;
}

export function ContactsSettings({ controller, locale, t }: {
  readonly controller: AppController;
  readonly locale: Locale;
  readonly t: Translator;
}): JSX.Element {
  const ownerKey = controller.state.activeProfile?.id ?? "disconnected";
  const [directory, setDirectory] = useState<ContactDirectoryView>();
  const [groups, setGroups] = useState<readonly ContactGroupView[]>([]);
  const [page, setPage] = useState<ContactListPageView>({ contacts: [], total: 0 });
  const [profile, setProfile] = useState<ContactProfileView>();
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [kind, setKind] = useState<ContactKindView | "all">("all");
  const [status, setStatus] = useState<ContactStatusView | "all">("all");
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [editor, setEditor] = useState<ContactEditorState>();
  const [identityOpen, setIdentityOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [relationEditor, setRelationEditor] = useState<RelationEditorState>();
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [deleteContact, setDeleteContact] = useState<ContactProfileView>();
  const [pendingCreate, setPendingCreate] = useState<PendingCreateReview>();
  const [duplicatePairs, setDuplicatePairs] = useState<readonly ContactDuplicatePairView[]>();
  const [mergeConfirmation, setMergeConfirmation] = useState<MergeConfirmation>();
  const [importPreview, setImportPreview] = useState<ContactVCardImportPreviewView>();
  const [importResult, setImportResult] = useState<ContactVCardImportResultView>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const listOptions = useMemo(() => ({
    ...(appliedQuery.trim() === "" ? {} : { query: appliedQuery.trim() }),
    ...(kind === "all" ? {} : { kind }),
    ...(status === "all" ? {} : { status }),
    ...(groupId === "" ? {} : { groupId }),
    pageSize: 100,
    pageOffset: 0
  }), [appliedQuery, groupId, kind, status]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(undefined);
    void Promise.all([
      controller.getContactDirectory(abort.signal),
      controller.listContactGroups(abort.signal),
      controller.listContacts(listOptions, abort.signal)
    ]).then(([nextDirectory, nextGroups, nextPage]) => {
      if (abort.signal.aborted) return;
      setDirectory(nextDirectory);
      setGroups(nextGroups);
      setPage(nextPage);
      setSelectedId((current) => current !== undefined && nextPage.contacts.some((contact) => contact.id === current)
        ? current
        : nextPage.contacts[0]?.id);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(errorMessage(reason, t("contacts.loadFailed")));
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [controller, listOptions, ownerKey, reloadToken, t]);

  useEffect(() => {
    if (selectedId === undefined) {
      setProfile(undefined);
      return;
    }
    const abort = new AbortController();
    setDetailLoading(true);
    void controller.getContact(selectedId, abort.signal).then((contact) => {
      if (!abort.signal.aborted) setProfile(contact);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) {
        setProfile(undefined);
        setError(errorMessage(reason, t("contacts.loadContactFailed")));
      }
    }).finally(() => {
      if (!abort.signal.aborted) setDetailLoading(false);
    });
    return () => abort.abort();
  }, [controller, ownerKey, selectedId, t]);

  const run = async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(undefined);
    try {
      return await action();
    } catch (reason) {
      setError(errorMessage(reason, t("contacts.actionFailed")));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const refresh = (preferredId?: string): void => {
    if (preferredId !== undefined) setSelectedId(preferredId);
    setReloadToken((value) => value + 1);
  };

  const applyContactMutation = (contact: ContactProfileView, nextDirectory: ContactDirectoryView): void => {
    setDirectory(nextDirectory);
    setProfile(contact);
    setSelectedId(contact.id);
    refresh(contact.id);
  };

  const submitContact = async (draft: ContactDraftView | ContactPatchView): Promise<void> => {
    if (editor === undefined || directory === undefined) return;
    if (editor.mode === "create") {
      const created = await run("contact-save", () => controller.createContact(directory.revision, draft as ContactDraftView));
      if (created === undefined) return;
      setDirectory(created.directory);
      if (created.contact === undefined) {
        setPendingCreate({ draft: draft as ContactDraftView, candidates: created.candidates });
      } else {
        setEditor(undefined);
        applyContactMutation(created.contact, created.directory);
      }
      return;
    }
    const contact = editor.contact;
    if (contact === undefined) return;
    const updated = await run("contact-save", () => controller.updateContact(contact.id, contact.revision, draft as ContactPatchView));
    if (updated !== undefined) {
      setEditor(undefined);
      applyContactMutation(updated.contact, updated.directory);
    }
  };

  const createDespiteCandidates = async (): Promise<void> => {
    if (pendingCreate === undefined || directory === undefined) return;
    const result = await run("contact-save", () => controller.createContact(
      directory.revision,
      pendingCreate.draft,
      pendingCreate.candidates.filter((candidate) => candidate.matchType === "name").map((candidate) => candidate.contactId)
    ));
    if (result?.contact === undefined) return;
    setPendingCreate(undefined);
    setEditor(undefined);
    applyContactMutation(result.contact, result.directory);
  };

  const confirmSelected = async (): Promise<void> => {
    if (profile === undefined) return;
    const result = await run("contact-confirm", () => controller.confirmContact(profile.id, profile.revision));
    if (result !== undefined) applyContactMutation(result.contact, result.directory);
  };

  const deleteSelected = async (): Promise<void> => {
    if (deleteContact === undefined) return;
    const result = await run("contact-delete", () => controller.deleteContact(deleteContact.id, deleteContact.revision));
    if (result === undefined) return;
    setDirectory(result);
    setDeleteContact(undefined);
    setProfile(undefined);
    setSelectedId(undefined);
    refresh();
  };

  const addIdentity = async (identity: ContactIdentityInputView): Promise<void> => {
    if (profile === undefined) return;
    const result = await run("identity-add", () => controller.addContactIdentity(profile.id, profile.revision, identity));
    if (result !== undefined) {
      setIdentityOpen(false);
      applyContactMutation(result.contact, result.directory);
    }
  };

  const removeIdentity = async (identityId: string): Promise<void> => {
    if (profile === undefined) return;
    const result = await run(`identity-remove:${identityId}`, () => controller.removeContactIdentity(profile.id, profile.revision, identityId));
    if (result !== undefined) applyContactMutation(result.contact, result.directory);
  };

  const addEvent = async (event: ContactEventInputView): Promise<void> => {
    if (profile === undefined) return;
    const result = await run("event-add", () => controller.appendContactEvent(profile.id, profile.revision, event));
    if (result !== undefined) {
      setEventOpen(false);
      applyContactMutation(result.contact, result.directory);
    }
  };

  const removeEvent = async (eventId: string): Promise<void> => {
    if (profile === undefined) return;
    const result = await run(`event-remove:${eventId}`, () => controller.removeContactEvent(profile.id, profile.revision, eventId));
    if (result !== undefined) applyContactMutation(result.contact, result.directory);
  };

  const toggleGroup = async (group: ContactGroupView, member: boolean): Promise<void> => {
    if (profile === undefined) return;
    const result = await run(`group-member:${group.id}`, () => controller.setContactGroupMembership(profile.id, profile.revision, group.id, member));
    if (result !== undefined) applyContactMutation(result.contact, result.directory);
  };

  const saveRelation = async (toContactId: string, relation: string, note: string): Promise<void> => {
    if (relationEditor === undefined) return;
    const owner = relationEditor.contact;
    const existing = relationEditor.relation;
    const result = existing === undefined
      ? await run("relation-save", () => controller.addContactRelation(owner.id, owner.revision, toContactId, relation, note))
      : await run("relation-save", () => controller.updateContactRelation(owner.id, owner.revision, existing.id, existing.revision, relation, note));
    if (result !== undefined) {
      setRelationEditor(undefined);
      applyContactMutation(result.contact, result.directory);
    }
  };

  const removeRelation = async (relation: ContactRelationView): Promise<void> => {
    if (profile === undefined) return;
    const result = await run(`relation-remove:${relation.id}`, () => controller.removeContactRelation(profile.id, profile.revision, relation.id));
    if (result !== undefined) applyContactMutation(result.contact, result.directory);
  };

  const loadDuplicates = async (): Promise<void> => {
    const result = await run("duplicate-scan", () => controller.scanContactDuplicates(100));
    if (result !== undefined) {
      setDirectory(result.directory);
      setDuplicatePairs(result.pairs);
    }
  };

  const mergeContacts = async (): Promise<void> => {
    if (mergeConfirmation === undefined) return;
    const result = await run("contact-merge", () => controller.mergeContacts(
      mergeConfirmation.target.id,
      mergeConfirmation.target.revision,
      mergeConfirmation.merged.id,
      mergeConfirmation.merged.revision
    ));
    if (result === undefined) return;
    setMergeConfirmation(undefined);
    setDuplicatePairs((pairs) => pairs?.filter((pair) => pair.first.id !== result.mergedContactId && pair.second.id !== result.mergedContactId));
    applyContactMutation(result.target, result.directory);
  };

  const selectVCard = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    const preview = await run("vcard-preview", async () => controller.previewContactVCardImport(await file.text()));
    if (preview !== undefined) setImportPreview(preview);
  };

  const commitImport = async (selections: readonly ContactImportSelection[]): Promise<void> => {
    if (importPreview === undefined) return;
    const result = await run("vcard-commit", async () => {
      const decisions = await contactImportDecisions(controller, importPreview, selections);
      return controller.commitContactVCardImport(importPreview.previewId, importPreview.directoryRevision, decisions);
    });
    if (result === undefined) return;
    setDirectory(result.directory);
    setImportPreview(undefined);
    setImportResult(result);
    refresh(result.contactIds[0]);
  };

  const exportContacts = async (ids: readonly string[]): Promise<void> => {
    const exported = await run("vcard-export", () => controller.exportContactsVCard(ids));
    if (exported === undefined) return;
    downloadText(exported.text, exported.suggestedFileName, "text/vcard;charset=utf-8", fileInputRef.current?.ownerDocument ?? document);
  };

  const loadMore = async (): Promise<void> => {
    if (page.nextPageOffset === undefined) return;
    const next = await run("contact-more", () => controller.listContacts({ ...listOptions, pageOffset: page.nextPageOffset }));
    if (next !== undefined) setPage({ ...next, contacts: [...page.contacts, ...next.contacts] });
  };

  return <section className="contacts-settings">
    <header className="contacts-settings__heading">
      <div>
        <h2>{t("contacts.title")}</h2>
        <p>{t("contacts.body")}</p>
      </div>
      <div className="contacts-settings__header-actions">
        <input ref={fileInputRef} className="contacts-settings__file" type="file" accept=".vcf,.vcard,text/vcard,text/x-vcard" onChange={selectVCard} />
        <Button onClick={() => fileInputRef.current?.click()} disabled={busy !== undefined}><FileUp aria-hidden="true" />{t("contacts.import")}</Button>
        <Button onClick={() => void exportContacts([])} disabled={busy !== undefined}><Download aria-hidden="true" />{t("contacts.exportAll")}</Button>
        <Button tone="primary" onClick={() => setEditor({ mode: "create" })} disabled={directory === undefined || busy !== undefined}><Plus aria-hidden="true" />{t("contacts.new")}</Button>
      </div>
    </header>
    {error !== undefined && <ErrorBanner message={error} onRetry={() => refresh(profile?.id)} onClose={() => setError(undefined)} />}
    <div className="contacts-directory-card settings-card">
      <div>
        <strong>{t("contacts.directory")}</strong>
        <span>{directory?.enabled === true ? t("contacts.directoryEnabled") : t("contacts.directoryDisabled")}</span>
      </div>
      <div className="contacts-directory-card__stats" aria-label={t("contacts.statistics")}>
        <ContactStat value={directory?.people ?? 0} label={t("contacts.people")} />
        <ContactStat value={directory?.organizations ?? 0} label={t("contacts.organizations")} />
        <ContactStat value={directory?.pending ?? 0} label={t("contacts.pending")} />
        <ContactStat value={directory?.groups ?? 0} label={t("contacts.groups")} />
      </div>
      <SwitchControl
        aria-label={t("contacts.enableDirectory")}
        checked={directory?.enabled === true}
        disabled={directory === undefined || busy !== undefined}
        onChange={() => {
          if (directory === undefined) return;
          void run("directory-enabled", () => controller.setContactDirectoryEnabled(directory.revision, !directory.enabled)).then((next) => {
            if (next !== undefined) setDirectory(next);
          });
        }}
      />
    </div>
    <div className="contacts-workbench">
      <aside className="contacts-catalog" aria-label={t("contacts.directory")}>
        <form className="contacts-search" onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query); }}>
          <Search aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={t("contacts.searchPlaceholder")} aria-label={t("common.search")} />
          <Button tone="ghost" type="submit">{t("common.search")}</Button>
        </form>
        <div className="contacts-filters">
          <SelectControl value={kind} aria-label={t("contacts.filterKind")} onChange={(event) => setKind(event.target.value as ContactKindView | "all")}>
            <option value="all">{t("contacts.allKinds")}</option>
            <option value="person">{t("contacts.person")}</option>
            <option value="organization">{t("contacts.organization")}</option>
          </SelectControl>
          <SelectControl value={status} aria-label={t("contacts.filterStatus")} onChange={(event) => setStatus(event.target.value as ContactStatusView | "all")}>
            <option value="all">{t("contacts.allStatuses")}</option>
            <option value="confirmed">{t("contacts.confirmed")}</option>
            <option value="pending">{t("contacts.pending")}</option>
          </SelectControl>
          <SelectControl value={groupId} aria-label={t("contacts.filterGroup")} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">{t("contacts.allGroups")}</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </SelectControl>
        </div>
        <div className="contacts-catalog__meta">
          <span>{t("contacts.results", { count: page.total })}</span>
          <Button tone="ghost" onClick={() => setGroupManagerOpen(true)}><UsersRound aria-hidden="true" />{t("contacts.manageGroups")}</Button>
          <Button tone="ghost" onClick={() => void loadDuplicates()} disabled={busy !== undefined}>{t("contacts.findDuplicates")}</Button>
        </div>
        <div className="contacts-list" aria-busy={loading}>
          {loading && page.contacts.length === 0 && <div className="contacts-empty"><Spinner />{t("common.loading")}</div>}
          {!loading && page.contacts.length === 0 && <div className="contacts-empty">{t("contacts.empty")}</div>}
          {page.contacts.map((contact) => <button
            type="button"
            key={contact.id}
            className={cx("contacts-list__item", selectedId === contact.id && "is-active")}
            aria-pressed={selectedId === contact.id}
            onClick={() => setSelectedId(contact.id)}
          >
            <ContactAvatar contact={contact} />
            <span><strong>{contact.displayName}</strong><small>{contact.summary || contact.aliases.join(" · ") || contactKindLabel(contact.kind, t)}</small></span>
            {contact.status === "pending" && <em>{t("contacts.pending")}</em>}
          </button>)}
          {page.nextPageOffset !== undefined && <Button className="contacts-list__more" onClick={() => void loadMore()} disabled={busy !== undefined}>{t("common.loadMore")}</Button>}
        </div>
      </aside>
      <article className="contact-detail" aria-busy={detailLoading}>
        {detailLoading && profile === undefined && <div className="contacts-empty"><Spinner />{t("common.loading")}</div>}
        {!detailLoading && profile === undefined && <div className="contacts-empty contacts-empty--detail"><UserRound aria-hidden="true" /><strong>{t("contacts.selectPrompt")}</strong><span>{t("contacts.selectPromptBody")}</span></div>}
        {profile !== undefined && <>
          <header className="contact-detail__header">
            <ContactAvatar contact={profile} large />
            <div><h3>{profile.displayName}</h3><p>{profile.summary || contactKindLabel(profile.kind, t)}</p></div>
            <div className="contact-detail__actions">
              {profile.status === "pending" && <Button tone="primary" onClick={() => void confirmSelected()} disabled={busy !== undefined}><Check aria-hidden="true" />{t("contacts.confirmContact")}</Button>}
              <IconButton label={t("contacts.exportSelected")} onClick={() => void exportContacts([profile.id])} disabled={busy !== undefined}><Download aria-hidden="true" /></IconButton>
              <IconButton label={t("common.edit")} onClick={() => setEditor({ mode: "edit", contact: profile })}><Pencil aria-hidden="true" /></IconButton>
              <IconButton label={t("common.delete")} onClick={() => setDeleteContact(profile)}><Trash2 aria-hidden="true" /></IconButton>
            </div>
          </header>
          <div className="contact-detail__meta">
            <span>{contactKindLabel(profile.kind, t)}</span><span>{contactStatusLabel(profile.status, t)}</span><span>{contactSourceLabel(profile.source, t)}</span>
            <span>{t("contacts.updated", { date: formatContactDate(profile.updatedAt, locale) })}</span>
          </div>
          {profile.aliases.length > 0 && <DetailSection title={t("contacts.aliases")}><div className="contact-tags">{profile.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div></DetailSection>}
          {profile.narrative !== "" && <DetailSection title={t("contacts.narrative")}><p className="contact-prose">{profile.narrative}</p></DetailSection>}
          {profile.agentNotes !== "" && <DetailSection title={t("contacts.agentNotes")} privateLabel={t("contacts.private")}><p className="contact-prose">{profile.agentNotes}</p></DetailSection>}
          <DetailSection title={t("contacts.identities")} action={<Button tone="ghost" onClick={() => setIdentityOpen(true)}><Plus aria-hidden="true" />{t("common.add")}</Button>}>
            {profile.identities.length === 0 ? <p className="contact-muted">{t("contacts.noIdentities")}</p> : <div className="contact-record-list">{profile.identities.map((identity) => <div key={identity.id}>
              <span><strong>{identity.platform}</strong><small>{identity.value}{identity.label === "" ? "" : ` · ${identity.label}`}{identity.note === "" ? "" : ` · ${identity.note}`}</small></span>
              <IconButton label={t("common.remove")} onClick={() => void removeIdentity(identity.id)} disabled={busy !== undefined}><Trash2 aria-hidden="true" /></IconButton>
            </div>)}</div>}
          </DetailSection>
          <DetailSection title={t("contacts.groups")} action={<Button tone="ghost" onClick={() => setGroupManagerOpen(true)}>{t("contacts.manageGroups")}</Button>}>
            {groups.length === 0 ? <p className="contact-muted">{t("contacts.noGroups")}</p> : <div className="contact-group-grid">{groups.map((group) => {
              const member = profile.groups.some((current) => current.id === group.id);
              return <label key={group.id}><input type="checkbox" checked={member} disabled={busy !== undefined} onChange={(event) => void toggleGroup(group, event.currentTarget.checked)} /><span><strong>{group.name}</strong><small>{group.description}</small></span></label>;
            })}</div>}
          </DetailSection>
          <DetailSection title={t("contacts.events")} action={<Button tone="ghost" onClick={() => setEventOpen(true)}><Plus aria-hidden="true" />{t("common.add")}</Button>}>
            {profile.events.length === 0 ? <p className="contact-muted">{t("contacts.noEvents")}</p> : <div className="contact-record-list">{profile.events.map((event) => <div key={event.id}>
              <time dateTime={event.date}>{event.date}</time><span><strong>{event.text}</strong><small>{event.source}</small></span>
              <IconButton label={t("common.remove")} onClick={() => void removeEvent(event.id)} disabled={busy !== undefined}><Trash2 aria-hidden="true" /></IconButton>
            </div>)}</div>}
          </DetailSection>
          <DetailSection title={t("contacts.relations")} action={<Button tone="ghost" onClick={() => setRelationEditor({ contact: profile })}><Plus aria-hidden="true" />{t("common.add")}</Button>}>
            {profile.relations.length === 0 ? <p className="contact-muted">{t("contacts.noRelations")}</p> : <div className="contact-record-list">{profile.relations.map((relation) => <div key={relation.id}>
              <ContactAvatar contact={{ kind: relation.relatedKind, displayName: relation.relatedDisplayName }} />
              <span><strong>{relation.relatedDisplayName}</strong><small>{relation.direction === "outgoing" ? `${relation.relation} →` : `← ${relation.relation}`}{relation.note === "" ? "" : ` · ${relation.note}`}</small></span>
              <IconButton label={t("common.edit")} onClick={() => setRelationEditor({ contact: profile, relation })}><Pencil aria-hidden="true" /></IconButton>
              <IconButton label={t("common.remove")} onClick={() => void removeRelation(relation)} disabled={busy !== undefined}><Trash2 aria-hidden="true" /></IconButton>
            </div>)}</div>}
          </DetailSection>
        </>}
      </article>
    </div>

    <ContactEditorDialog open={editor !== undefined} state={editor} busy={busy === "contact-save"} t={t} onClose={() => setEditor(undefined)} onSubmit={submitContact} />
    <IdentityDialog open={identityOpen} busy={busy === "identity-add"} t={t} onClose={() => setIdentityOpen(false)} onSubmit={addIdentity} />
    <EventDialog open={eventOpen} busy={busy === "event-add"} t={t} onClose={() => setEventOpen(false)} onSubmit={addEvent} />
    <RelationDialog controller={controller} open={relationEditor !== undefined} state={relationEditor} busy={busy === "relation-save"} t={t} onClose={() => setRelationEditor(undefined)} onSubmit={saveRelation} />
    <GroupManagerDialog
      controller={controller}
      directory={directory}
      groups={groups}
      open={groupManagerOpen}
      busy={busy}
      t={t}
      run={run}
      onClose={() => setGroupManagerOpen(false)}
      onChanged={() => refresh(profile?.id)}
    />
    <CandidateReviewDialog review={pendingCreate} busy={busy === "contact-save"} t={t} onClose={() => setPendingCreate(undefined)} onOpen={(id) => { setSelectedId(id); setPendingCreate(undefined); setEditor(undefined); }} onCreate={() => void createDespiteCandidates()} />
    <DuplicateDialog pairs={duplicatePairs} busy={busy} t={t} onClose={() => setDuplicatePairs(undefined)} onMerge={(target, merged) => setMergeConfirmation({ target, merged })} />
    <ImportDialog preview={importPreview} busy={busy === "vcard-commit"} t={t} onClose={() => setImportPreview(undefined)} onCommit={(selections) => void commitImport(selections)} />
    <ImportResultDialog result={importResult} t={t} onClose={() => setImportResult(undefined)} onOpen={(contactId) => { setImportResult(undefined); refresh(contactId); }} />
    <ConfirmDialog
      open={deleteContact !== undefined}
      title={t("contacts.deleteTitle")}
      body={t("contacts.deleteBody", { name: deleteContact?.displayName ?? "" })}
      confirm={t("common.delete")}
      busy={busy === "contact-delete"}
      danger
      t={t}
      onClose={() => setDeleteContact(undefined)}
      onConfirm={() => void deleteSelected()}
    />
    <ConfirmDialog
      open={mergeConfirmation !== undefined}
      title={t("contacts.mergeTitle")}
      body={t("contacts.mergeBody", { target: mergeConfirmation?.target.displayName ?? "", merged: mergeConfirmation?.merged.displayName ?? "" })}
      confirm={t("contacts.merge")}
      busy={busy === "contact-merge"}
      t={t}
      onClose={() => setMergeConfirmation(undefined)}
      onConfirm={() => void mergeContacts()}
    />
  </section>;
}

function ImportResultDialog({ result, t, onClose, onOpen }: {
  readonly result?: ContactVCardImportResultView;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onOpen: (contactId: string) => void;
}): JSX.Element {
  return <Modal
    open={result !== undefined}
    title={t("contacts.importResultTitle")}
    description={t("contacts.importResultBody", {
      created: result?.created ?? 0,
      enriched: result?.enriched ?? 0,
      skipped: result?.skipped ?? 0
    })}
    onClose={onClose}
    showClose
  >
    <ul className="contact-import-result" aria-live="polite">
      {result?.entries.map((entry) => {
        const contactId = entry.contactId;
        return <li key={entry.entryId}>
          <span><strong>{entry.displayName}</strong><small>{importOutcomeLabel(entry.outcome, t)}</small></span>
          {contactId !== undefined && <Button tone="ghost" onClick={() => onOpen(contactId)}>{t("contacts.openImported")}</Button>}
        </li>;
      })}
    </ul>
    <div className="modal__actions"><Button tone="primary" onClick={onClose}>{t("common.close")}</Button></div>
  </Modal>;
}

function ContactStat({ value, label }: { readonly value: number; readonly label: string }): JSX.Element {
  return <span><strong>{value}</strong><small>{label}</small></span>;
}

function ContactAvatar({ contact, large = false }: {
  readonly contact: { readonly kind: ContactKindView; readonly displayName: string };
  readonly large?: boolean;
}): JSX.Element {
  return <span className={cx("contact-avatar", large && "contact-avatar--large")} aria-hidden="true">
    {contact.kind === "organization" ? <Building2 /> : contact.displayName.trim().slice(0, 1).toLocaleUpperCase() || <UserRound />}
  </span>;
}

function DetailSection({ title, privateLabel, action, children }: {
  readonly title: string;
  readonly privateLabel?: string;
  readonly action?: JSX.Element;
  readonly children: JSX.Element;
}): JSX.Element {
  return <section className="contact-detail__section"><header><h4>{title}</h4>{privateLabel !== undefined && <em>{privateLabel}</em>}{action}</header>{children}</section>;
}

function ContactEditorDialog({ open, state, busy, t, onClose, onSubmit }: {
  readonly open: boolean;
  readonly state?: ContactEditorState;
  readonly busy: boolean;
  readonly t: Translator;
  readonly onClose: () => void;
  readonly onSubmit: (draft: ContactDraftView | ContactPatchView) => Promise<void>;
}): JSX.Element | null {
  const source = state?.contact;
  const [kind, setKind] = useState<ContactKindView>(source?.kind ?? "person");
  const [name, setName] = useState(source?.displayName ?? "");
  const [aliases, setAliases] = useState(source?.aliases.join(", ") ?? "");
  const [summary, setSummary] = useState(source?.summary ?? "");
  const [narrative, setNarrative] = useState(source?.narrative ?? "");
  const [agentNotes, setAgentNotes] = useState(source?.agentNotes ?? "");
  const [status, setStatus] = useState<ContactStatusView>(source?.status ?? "confirmed");
  const [identityPlatform, setIdentityPlatform] = useState("");
  const [identityValue, setIdentityValue] = useState("");
  useEffect(() => {
    setKind(source?.kind ?? "person");
    setName(source?.displayName ?? "");
    setAliases(source?.aliases.join(", ") ?? "");
    setSummary(source?.summary ?? "");
    setNarrative(source?.narrative ?? "");
    setAgentNotes(source?.agentNotes ?? "");
    setStatus(source?.status ?? "confirmed");
    setIdentityPlatform("");
    setIdentityValue("");
  }, [open, source?.id]);
  if (state === undefined) return null;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const normalizedAliases = splitAliases(aliases, name);
    if (state.mode === "create") {
      void onSubmit({
        kind,
        displayName: name.trim(),
        aliases: normalizedAliases,
        summary: summary.trim(),
        narrative: narrative.trim(),
        agentNotes: agentNotes.trim(),
        status,
        source: "manual",
        identities: identityPlatform.trim() === "" || identityValue.trim() === "" ? [] : [{ platform: identityPlatform.trim(), value: identityValue.trim(), label: "", note: "" }]
      });
    } else {
      void onSubmit({ kind, displayName: name.trim(), aliases: normalizedAliases, summary: summary.trim(), narrative: narrative.trim(), agentNotes: agentNotes.trim(), status });
    }
  };
  return <Modal open={open} title={state.mode === "create" ? t("contacts.createTitle") : t("contacts.editTitle")} onClose={onClose} showClose size="large">
    <form className="contact-form" onSubmit={submit}>
      <div className="contact-form__grid">
        <Field label={t("contacts.kind")}><SelectControl value={kind} onChange={(event) => setKind(event.target.value as ContactKindView)}><option value="person">{t("contacts.person")}</option><option value="organization">{t("contacts.organization")}</option></SelectControl></Field>
        <Field label={t("common.status")}><SelectControl value={status} onChange={(event) => setStatus(event.target.value as ContactStatusView)}><option value="confirmed">{t("contacts.confirmed")}</option><option value="pending">{t("contacts.pending")}</option></SelectControl></Field>
        <Field label={t("contacts.displayName")} wide><input required maxLength={200} value={name} onChange={(event) => setName(event.currentTarget.value)} /></Field>
        <Field label={t("contacts.aliasesHint")} wide><input value={aliases} onChange={(event) => setAliases(event.currentTarget.value)} /></Field>
        <Field label={t("contacts.summary")} wide><textarea rows={2} value={summary} onChange={(event) => setSummary(event.currentTarget.value)} /></Field>
        <Field label={t("contacts.narrative")} wide><textarea rows={4} value={narrative} onChange={(event) => setNarrative(event.currentTarget.value)} /></Field>
        <Field label={`${t("contacts.agentNotes")} · ${t("contacts.private")}`} wide><textarea rows={3} value={agentNotes} onChange={(event) => setAgentNotes(event.currentTarget.value)} /></Field>
        {state.mode === "create" && <><Field label={t("contacts.identityPlatform")}><input value={identityPlatform} placeholder="email" onChange={(event) => setIdentityPlatform(event.currentTarget.value)} /></Field><Field label={t("contacts.identityValue")}><input value={identityValue} onChange={(event) => setIdentityValue(event.currentTarget.value)} /></Field></>}
      </div>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={busy || name.trim() === ""}>{busy ? t("common.working") : t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function IdentityDialog({ open, busy, t, onClose, onSubmit }: {
  readonly open: boolean; readonly busy: boolean; readonly t: Translator; readonly onClose: () => void;
  readonly onSubmit: (input: ContactIdentityInputView) => Promise<void>;
}): JSX.Element {
  const [platform, setPlatform] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setPlatform(""); setValue(""); setLabel(""); setNote(""); } }, [open]);
  return <Modal open={open} title={t("contacts.addIdentity")} onClose={onClose} showClose>
    <form className="contact-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ platform: platform.trim(), value: value.trim(), label: label.trim(), note: note.trim() }); }}>
      <Field label={t("contacts.identityPlatform")}><input required value={platform} placeholder="email" onChange={(event) => setPlatform(event.currentTarget.value)} /></Field>
      <Field label={t("contacts.identityValue")}><input required value={value} onChange={(event) => setValue(event.currentTarget.value)} /></Field>
      <Field label={t("contacts.identityLabel")}><input value={label} onChange={(event) => setLabel(event.currentTarget.value)} /></Field>
      <Field label={t("contacts.note")}><textarea rows={2} value={note} onChange={(event) => setNote(event.currentTarget.value)} /></Field>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={busy || platform.trim() === "" || value.trim() === ""}>{t("common.add")}</Button></div>
    </form>
  </Modal>;
}

function EventDialog({ open, busy, t, onClose, onSubmit }: {
  readonly open: boolean; readonly busy: boolean; readonly t: Translator; readonly onClose: () => void;
  readonly onSubmit: (input: ContactEventInputView) => Promise<void>;
}): JSX.Element {
  const [date, setDate] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  useEffect(() => { if (open) { setDate(""); setText(""); setSource(""); } }, [open]);
  return <Modal open={open} title={t("contacts.addEvent")} onClose={onClose} showClose>
    <form className="contact-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ date, text: text.trim(), source: source.trim() }); }}>
      <Field label={t("contacts.eventDate")}><input required type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} /></Field>
      <Field label={t("contacts.eventText")}><input required value={text} onChange={(event) => setText(event.currentTarget.value)} /></Field>
      <Field label={t("common.source")}><input value={source} onChange={(event) => setSource(event.currentTarget.value)} /></Field>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={busy || date === "" || text.trim() === ""}>{t("common.add")}</Button></div>
    </form>
  </Modal>;
}

function RelationDialog({ controller, open, state, busy, t, onClose, onSubmit }: {
  readonly controller: AppController; readonly open: boolean; readonly state?: RelationEditorState; readonly busy: boolean; readonly t: Translator;
  readonly onClose: () => void; readonly onSubmit: (toContactId: string, relation: string, note: string) => Promise<void>;
}): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ContactSummaryView[]>([]);
  const [targetId, setTargetId] = useState("");
  const [relation, setRelation] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    setQuery("");
    setResults([]);
    setTargetId(state?.relation?.relatedContactId ?? "");
    setRelation(state?.relation?.relation ?? "");
    setNote(state?.relation?.note ?? "");
  }, [open, state?.relation?.id]);
  useEffect(() => {
    if (!open || state?.relation !== undefined || query.trim() === "") return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void controller.listContacts({ query: query.trim(), pageSize: 20 }, abort.signal).then((page) => {
        if (!abort.signal.aborted) setResults(page.contacts.filter((contact) => contact.id !== state?.contact.id));
      }).catch(() => { if (!abort.signal.aborted) setResults([]); });
    }, 180);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [controller, open, query, state?.contact.id, state?.relation]);
  if (state === undefined) return null;
  return <Modal open={open} title={state.relation === undefined ? t("contacts.addRelation") : t("contacts.editRelation")} onClose={onClose} showClose>
    <form className="contact-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(targetId, relation.trim(), note.trim()); }}>
      {state.relation === undefined ? <>
        <Field label={t("contacts.relatedContact")}><input value={query} placeholder={t("contacts.searchPlaceholder")} onChange={(event) => { setQuery(event.currentTarget.value); setTargetId(""); }} /></Field>
        <div className="contact-target-results">{results.map((contact) => <button type="button" className={targetId === contact.id ? "is-active" : ""} key={contact.id} onClick={() => { setTargetId(contact.id); setQuery(contact.displayName); }}><ContactAvatar contact={contact} /><span>{contact.displayName}</span></button>)}</div>
      </> : <p className="contact-selected-target"><Link2 aria-hidden="true" />{state.relation.relatedDisplayName}</p>}
      <Field label={t("contacts.relationType")}><input required value={relation} placeholder={t("contacts.relationExample")} onChange={(event) => setRelation(event.currentTarget.value)} /></Field>
      <Field label={t("contacts.note")}><textarea rows={2} value={note} onChange={(event) => setNote(event.currentTarget.value)} /></Field>
      <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" type="submit" disabled={busy || targetId === "" || relation.trim() === ""}>{t("common.save")}</Button></div>
    </form>
  </Modal>;
}

function GroupManagerDialog({ controller, directory, groups, open, busy, t, run, onClose, onChanged }: {
  readonly controller: AppController;
  readonly directory?: ContactDirectoryView;
  readonly groups: readonly ContactGroupView[];
  readonly open: boolean;
  readonly busy?: string;
  readonly t: Translator;
  readonly run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<ContactGroupView>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [removing, setRemoving] = useState<ContactGroupView>();
  const reset = (): void => { setEditing(undefined); setName(""); setDescription(""); };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (directory === undefined) return;
    const result = editing === undefined
      ? await run("group-save", () => controller.createContactGroup(directory.revision, name.trim(), description.trim()))
      : await run("group-save", () => controller.updateContactGroup(editing.id, editing.revision, name.trim(), description.trim()));
    if (result !== undefined) { reset(); onChanged(); }
  };
  const remove = async (): Promise<void> => {
    if (removing === undefined) return;
    const result = await run("group-delete", () => controller.deleteContactGroup(removing.id, removing.revision));
    if (result !== undefined) { setRemoving(undefined); onChanged(); }
  };
  return <>
    <Modal open={open} title={t("contacts.manageGroups")} onClose={onClose} showClose size="large">
      <div className="contact-group-manager">
        <div className="contact-record-list">{groups.length === 0 ? <p className="contact-muted">{t("contacts.noGroups")}</p> : groups.map((group) => <div key={group.id}>
          <span><strong>{group.name}</strong><small>{group.description || t("contacts.members", { count: group.memberCount })}</small></span>
          <IconButton label={t("common.edit")} onClick={() => { setEditing(group); setName(group.name); setDescription(group.description); }}><Pencil aria-hidden="true" /></IconButton>
          <IconButton label={t("common.delete")} onClick={() => setRemoving(group)}><Trash2 aria-hidden="true" /></IconButton>
        </div>)}</div>
        <form className="contact-form contact-group-manager__form" onSubmit={(event) => void save(event)}>
          <h4>{editing === undefined ? t("contacts.createGroup") : t("contacts.editGroup")}</h4>
          <Field label={t("contacts.groupName")}><input required value={name} onChange={(event) => setName(event.currentTarget.value)} /></Field>
          <Field label={t("contacts.groupDescription")}><textarea rows={3} value={description} onChange={(event) => setDescription(event.currentTarget.value)} /></Field>
          <div className="modal__actions">{editing !== undefined && <Button onClick={reset}>{t("common.cancel")}</Button>}<Button tone="primary" type="submit" disabled={busy !== undefined || name.trim() === ""}>{t("common.save")}</Button></div>
        </form>
      </div>
    </Modal>
    <ConfirmDialog open={removing !== undefined} title={t("contacts.deleteGroupTitle")} body={t("contacts.deleteGroupBody", { name: removing?.name ?? "" })} confirm={t("common.delete")} busy={busy === "group-delete"} danger t={t} onClose={() => setRemoving(undefined)} onConfirm={() => void remove()} />
  </>;
}

function CandidateReviewDialog({ review, busy, t, onClose, onOpen, onCreate }: {
  readonly review?: PendingCreateReview; readonly busy: boolean; readonly t: Translator; readonly onClose: () => void;
  readonly onOpen: (id: string) => void; readonly onCreate: () => void;
}): JSX.Element {
  return <Modal open={review !== undefined} title={t("contacts.similarTitle")} description={t("contacts.similarBody")} onClose={onClose} showClose>
    <div className="contact-candidate-list">{review?.candidates.map((candidate) => <div key={candidate.contactId}><ContactAvatar contact={candidate} /><span><strong>{candidate.displayName}</strong><small>{candidate.summary || contactKindLabel(candidate.kind, t)}</small></span><Button onClick={() => onOpen(candidate.contactId)}>{t("common.open")}</Button></div>)}</div>
    <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" disabled={busy} onClick={onCreate}>{t("contacts.createSeparate")}</Button></div>
  </Modal>;
}

function DuplicateDialog({ pairs, busy, t, onClose, onMerge }: {
  readonly pairs?: readonly ContactDuplicatePairView[]; readonly busy?: string; readonly t: Translator; readonly onClose: () => void;
  readonly onMerge: (target: ContactSummaryView, merged: ContactSummaryView) => void;
}): JSX.Element {
  return <Modal open={pairs !== undefined} title={t("contacts.duplicatesTitle")} description={t("contacts.duplicatesBody")} onClose={onClose} showClose size="large">
    {pairs?.length === 0 ? <p className="contact-muted">{t("contacts.noDuplicates")}</p> : <div className="contact-duplicate-list">{pairs?.map((pair) => <div key={`${pair.first.id}:${pair.second.id}`}>
      <ContactCandidateSummary contact={pair.first} t={t} />
      <span className="contact-duplicate-list__divider">↔</span>
      <ContactCandidateSummary contact={pair.second} t={t} />
      <div><Button disabled={busy !== undefined} onClick={() => onMerge(pair.first, pair.second)}>{t("contacts.keepNamed", { name: pair.first.displayName })}</Button><Button disabled={busy !== undefined} onClick={() => onMerge(pair.second, pair.first)}>{t("contacts.keepNamed", { name: pair.second.displayName })}</Button></div>
    </div>)}</div>}
  </Modal>;
}

function ContactCandidateSummary({ contact, t }: { readonly contact: ContactSummaryView; readonly t: Translator }): JSX.Element {
  return <span className="contact-candidate-summary"><ContactAvatar contact={contact} /><span><strong>{contact.displayName}</strong><small>{contact.summary || contactKindLabel(contact.kind, t)}</small></span></span>;
}

export interface ContactImportSelection {
  readonly entryId: string;
  readonly decision: ContactVCardImportDecisionKindView;
  readonly target?: string;
  readonly organizationDecision?: ContactVCardImportDecisionKindView;
  readonly organizationTarget?: string;
}

function ImportDialog({ preview, busy, t, onClose, onCommit }: {
  readonly preview?: ContactVCardImportPreviewView; readonly busy: boolean; readonly t: Translator; readonly onClose: () => void;
  readonly onCommit: (selections: readonly ContactImportSelection[]) => void;
}): JSX.Element {
  const [selections, setSelections] = useState<readonly ContactImportSelection[]>([]);
  useEffect(() => {
    setSelections(preview?.entries.map(defaultImportSelection) ?? []);
  }, [preview?.previewId]);
  const update = (entryId: string, patch: Partial<ContactImportSelection>): void => {
    setSelections((current) => current.map((selection) => selection.entryId === entryId ? { ...selection, ...patch } : selection));
  };
  const valid = preview !== undefined && preview.entries.every((entry) => importSelectionValid(entry, selections.find((selection) => selection.entryId === entry.entryId)));
  return <Modal open={preview !== undefined} title={t("contacts.importTitle")} description={t("contacts.importBody", { count: preview?.entries.length ?? 0 })} onClose={onClose} showClose size="large">
    <div className="contact-import-list">{preview?.entries.map((entry) => {
      const selection = selections.find((candidate) => candidate.entryId === entry.entryId) ?? defaultImportSelection(entry);
      return <article key={entry.entryId}>
        <header><ContactAvatar contact={entry.contact} /><span><strong>{entry.contact.displayName}</strong><small>{importDispositionLabel(entry, t)}</small></span></header>
        <div className="contact-import-list__decision">
          <Field label={t("contacts.importAction")}><SelectControl value={selection.decision} onChange={(event) => update(entry.entryId, { decision: event.target.value as ContactVCardImportDecisionKindView, target: undefined })}>
            <option value="create">{t("contacts.importCreate")}</option><option value="merge">{t("contacts.importMerge")}</option><option value="skip">{t("contacts.importSkip")}</option>
          </SelectControl></Field>
          {selection.decision === "merge" && <Field label={t("contacts.mergeTarget")}><SelectControl value={selection.target ?? ""} required onChange={(event) => update(entry.entryId, { target: event.target.value })}>
            <option value="" disabled>{t("contacts.chooseTarget")}</option>
            {entry.existingContactId !== undefined && <option value={`contact:${entry.existingContactId}`}>{t("contacts.existingExact")}</option>}
            {entry.existingEntryId !== undefined && <option value={`entry:${entry.existingEntryId}`}>{t("contacts.previousEntry")}</option>}
            {entry.candidates.map((candidate) => <option key={candidate.contactId} value={`contact:${candidate.contactId}`}>{candidate.displayName}</option>)}
            {entry.similarEntryIds.map((id) => <option key={id} value={`entry:${id}`}>{t("contacts.importedEntry", { id })}</option>)}
          </SelectControl></Field>}
          {entry.organizationCandidates.length > 0 && selection.decision !== "skip" && <>
            <Field label={t("contacts.organizationAction")}><SelectControl value={selection.organizationDecision ?? "skip"} onChange={(event) => update(entry.entryId, { organizationDecision: event.target.value as ContactVCardImportDecisionKindView, organizationTarget: undefined })}>
              <option value="create">{t("contacts.importCreate")}</option><option value="merge">{t("contacts.importMerge")}</option><option value="skip">{t("contacts.importSkip")}</option>
            </SelectControl></Field>
            {selection.organizationDecision === "merge" && <Field label={t("contacts.mergeTarget")}><SelectControl value={selection.organizationTarget ?? ""} onChange={(event) => update(entry.entryId, { organizationTarget: event.target.value })}>
              <option value="" disabled>{t("contacts.chooseTarget")}</option>{entry.organizationCandidates.map((candidate) => <option key={candidate.contactId} value={`contact:${candidate.contactId}`}>{candidate.displayName}</option>)}
            </SelectControl></Field>}
          </>}
        </div>
        {(entry.groups.length > 0 || entry.organizationName !== undefined) && <footer>{entry.organizationName !== undefined && <span>{entry.organizationName}{entry.title === undefined ? "" : ` · ${entry.title}`}</span>}{entry.groups.map((group) => <span key={group}>{group}</span>)}</footer>}
      </article>;
    })}</div>
    <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone="primary" disabled={busy || !valid} onClick={() => onCommit(selections)}>{busy ? t("common.working") : t("contacts.importCommit")}</Button></div>
  </Modal>;
}

function ConfirmDialog({ open, title, body, confirm, busy, danger = false, t, onClose, onConfirm }: {
  readonly open: boolean; readonly title: string; readonly body: string; readonly confirm: string; readonly busy: boolean; readonly danger?: boolean;
  readonly t: Translator; readonly onClose: () => void; readonly onConfirm: () => void;
}): JSX.Element {
  return <Modal open={open} title={title} description={body} onClose={onClose} dialogRole="alertdialog">
    <div className="modal__actions"><Button onClick={onClose}>{t("common.cancel")}</Button><Button tone={danger ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>{busy ? t("common.working") : confirm}</Button></div>
  </Modal>;
}

function Field({ label, wide = false, children }: { readonly label: string; readonly wide?: boolean; readonly children: JSX.Element }): JSX.Element {
  return <label className={cx("contact-field", wide && "contact-field--wide")}><span>{label}</span>{children}</label>;
}

function splitAliases(value: string, displayName: string): readonly string[] {
  const seen = new Set<string>([displayName.trim().toLocaleLowerCase()]);
  return value.split(/[,;\n]/u).map((entry) => entry.trim()).filter((entry) => {
    const key = entry.toLocaleLowerCase();
    if (entry === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function contactKindLabel(kind: ContactKindView, t: Translator): string {
  return kind === "organization" ? t("contacts.organization") : t("contacts.person");
}

function contactStatusLabel(status: ContactStatusView, t: Translator): string {
  return status === "pending" ? t("contacts.pending") : t("contacts.confirmed");
}

function contactSourceLabel(source: ContactProfileView["source"], t: Translator): string {
  if (source === "agent") return t("contacts.sourceAgent");
  if (source === "import") return t("contacts.sourceImport");
  return t("contacts.sourceManual");
}

function formatContactDate(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en-XA" ? "en" : locale, { dateStyle: "medium" }).format(value);
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() !== "" ? reason.message : fallback;
}

function downloadText(text: string, fileName: string, type: string, ownerDocument: Document): void {
  const ownerWindow = ownerDocument.defaultView ?? window;
  const blob = new ownerWindow.Blob([text], { type });
  const url = ownerWindow.URL.createObjectURL(blob);
  const anchor = ownerDocument.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  ownerDocument.body.append(anchor);
  anchor.click();
  anchor.remove();
  ownerWindow.setTimeout(() => ownerWindow.URL.revokeObjectURL(url), 0);
}

function defaultImportSelection(entry: ContactVCardImportPreviewEntryView): ContactImportSelection {
  const target = entry.existingContactId !== undefined
    ? `contact:${entry.existingContactId}`
    : entry.existingEntryId !== undefined
      ? `entry:${entry.existingEntryId}`
      : undefined;
  return {
    entryId: entry.entryId,
    decision: entry.disposition === "autoEnrich" ? "merge" : entry.disposition === "create" ? "create" : "skip",
    ...(target === undefined ? {} : { target }),
    ...(entry.organizationCandidates.length === 0 ? {} : { organizationDecision: "skip" })
  };
}

function importSelectionValid(entry: ContactVCardImportPreviewEntryView, selection: ContactImportSelection | undefined): boolean {
  if (selection === undefined || selection.decision === "merge" && selection.target === undefined) return false;
  return entry.organizationCandidates.length === 0
    || selection.decision === "skip"
    || selection.organizationDecision !== undefined
      && (selection.organizationDecision !== "merge" || selection.organizationTarget !== undefined);
}

function importDispositionLabel(entry: ContactVCardImportPreviewEntryView, t: Translator): string {
  if (entry.disposition === "autoEnrich") return t("contacts.importExactMatch");
  if (entry.disposition === "needsReview") return t("contacts.importNeedsReview");
  return t("contacts.importNew");
}

function importOutcomeLabel(outcome: ContactVCardImportResultView["entries"][number]["outcome"], t: Translator): string {
  if (outcome === "created") return t("contacts.importOutcomeCreated");
  if (outcome === "enriched") return t("contacts.importOutcomeEnriched");
  return t("contacts.importOutcomeSkipped");
}

export async function contactImportDecisions(
  controller: Pick<AppController, "getContact">,
  preview: ContactVCardImportPreviewView,
  selections: readonly ContactImportSelection[]
): Promise<readonly ContactVCardImportDecisionView[]> {
  const byEntry = new Map(selections.map((selection) => [selection.entryId, selection]));
  const revisions = new Map<string, bigint>();
  const contactTargets = new Set<string>();
  for (const selection of selections) {
    for (const target of [selection.target, selection.organizationTarget]) {
      if (target?.startsWith("contact:") === true) contactTargets.add(target.slice("contact:".length));
    }
  }
  await Promise.all([...contactTargets].map(async (id) => revisions.set(id, (await controller.getContact(id)).revision)));
  return preview.entries.map((entry) => {
    const selection = byEntry.get(entry.entryId) ?? defaultImportSelection(entry);
    const target = importTarget(selection.target, revisions);
    const organizationTarget = organizationImportTarget(selection.organizationTarget, revisions);
    return {
      entryId: entry.entryId,
      decision: selection.decision,
      ...target,
      confirmedNameCandidateIds: selection.decision === "create" ? entry.candidates.map((candidate) => candidate.contactId) : [],
      ...(selection.decision === "skip" || entry.organizationCandidates.length === 0 ? {} : {
        organizationDecision: selection.organizationDecision ?? "skip",
        ...organizationTarget,
        confirmedOrganizationCandidateIds: selection.organizationDecision === "create"
          ? entry.organizationCandidates.map((candidate) => candidate.contactId)
          : []
      })
    };
  });
}

function importTarget(value: string | undefined, revisions: ReadonlyMap<string, bigint>): Pick<ContactVCardImportDecisionView,
  "targetContactId" | "expectedTargetRevision" | "targetEntryId"> {
  if (value === undefined) return {};
  if (value.startsWith("entry:")) return { targetEntryId: value.slice("entry:".length) };
  const id = value.slice("contact:".length);
  return { targetContactId: id, expectedTargetRevision: revisions.get(id) };
}

function organizationImportTarget(value: string | undefined, revisions: ReadonlyMap<string, bigint>): Pick<ContactVCardImportDecisionView,
  "organizationTargetContactId" | "expectedOrganizationTargetRevision" | "organizationTargetEntryId"> {
  if (value === undefined) return {};
  if (value.startsWith("entry:")) return { organizationTargetEntryId: value.slice("entry:".length) };
  const id = value.slice("contact:".length);
  return { organizationTargetContactId: id, expectedOrganizationTargetRevision: revisions.get(id) };
}
