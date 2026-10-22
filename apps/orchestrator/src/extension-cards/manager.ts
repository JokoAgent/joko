import { randomUUID } from "node:crypto";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { ExtensionCardProjection } from "@joko/core";
import { parseExtensionCardFormValues, readExtensionCardForm, readMailCard } from "@joko/contracts";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "../credential-vault.js";
import type { ExtensionRuntimeDescriptor } from "../extension-surface-manifest.js";
import { ExtensionCardService, type ExtensionCardScope, type ExtensionCardRow, type ExtensionCardPush } from "./service.js";
import { MailCardService } from "./mail-cards.js";
import { EXTENSION_CARD_ACTION_ID_RE, EXTENSION_CARD_ACTION_PROMPT_MAX_LEN, extensionCardRootCallId, isExtensionCardLinkAllowed } from "./protocol.js";
import type { ExtensionMailPreview } from "./mail-reader.js";
import { extensionCardMediaUris, type ExtensionCardMedia, type ExtensionMailAttachment, type ExtensionMailUploadMetadata } from "./media.js";
import type { ExtensionOAuthCards } from "./oauth-cards.js";

export interface ExtensionCardAuthority {
  readonly key: string;
  readonly name: string;
  readonly runtime: ExtensionRuntimeDescriptor;
  readonly installationKey?: string;
}
export interface ExtensionCardAction {
  readonly type: "event";
  readonly name: "card-action";
  readonly callId: string;
  readonly spawnCallId: string;
  readonly actionId: string;
  readonly prompt?: string;
  readonly formValues?: Record<string, string>;
  readonly change: boolean;
  readonly mailAttachment?: ExtensionMailAttachment;
  readonly ts: number;
}
interface SavedCard { readonly version: 1; readonly anchorEventId: string; readonly row: ExtensionCardRow }
interface Options {
  readonly store: OperationalStore;
  readonly vault: CredentialVault;
  readonly authority: (extensionId: string) => ExtensionCardAuthority | undefined;
  readonly assertProject?: (extensionId: string, sessionId: string) => void;
  readonly redact: (text: string) => string;
  readonly dispatch: (scope: ExtensionCardScope, event: ExtensionCardAction, assertCurrent: () => void) => Promise<void>;
  readonly previewMail?: (sessionId: string, url: string, read: boolean, opened: boolean, signal: AbortSignal, assertCurrent: () => void) => Promise<ExtensionMailPreview>;
  readonly media?: ExtensionCardMedia;
  readonly oauthCards?: () => ExtensionOAuthCards | undefined;
}
const SETTING_OWNER = "extension-card-records";

/** The executable package binding is private; shared history contains inert markup. */
export class ExtensionCardsManager {
  readonly cards: ExtensionCardService;
  readonly mail: MailCardService;
  readonly #transient = new Map<string, ExtensionCardPush>();
  readonly #actions = new Set<string>();
  #closed = false;
  constructor(private readonly options: Options) {
    this.cards = new ExtensionCardService({
      available: (scope, hostMail) => {
        try {
          this.assertScope(scope);
          const source = options.authority(scope.extensionId);
          return source?.key === scope.authorityKey && (hostMail ? source.runtime.mail === true || source.runtime.network?.secrets?.some(secret => secret.source === "oauth") === true : source.runtime.card !== undefined);
        } catch { return false; }
      },
      persist: async row => { this.#write(row); },
      broadcast: card => this.#remember(card)
    });
    this.mail = new MailCardService({ cards: this.cards, read: async id => this.#readAny(id)?.row ?? null,
      list: async sessionId => this.#list(sessionId), persist: async row => { this.#write(row); },
      broadcast: card => this.#remember(card) });
  }
  assertScope(scope: ExtensionCardScope): void {
    if (this.#closed) throw new Error("Extension cards stopped.");
    const session = this.options.store.getSession(scope.sessionId).descriptor;
    if (session.createdAt !== scope.sessionCreatedAt || session.targetId !== scope.targetId || session.archived || session.deletedAt !== undefined
      || this.options.store.findPendingSessionLifecycleCleanup(session.id) !== undefined) throw new Error("Extension card task changed.");
  }
  async previewMail(sessionId: string, url: string, read: boolean, opened: boolean, signal: AbortSignal, assertCurrent: () => void): Promise<ExtensionMailPreview> {
    if (!this.options.previewMail || this.#closed) throw new Error("Mail preview unavailable.");
    return this.options.previewMail(sessionId, url, read, opened, signal, assertCurrent);
  }
  assertAuthority(scope: ExtensionCardScope): ExtensionCardAuthority {
    this.assertScope(scope);
    this.options.assertProject?.(scope.extensionId, scope.sessionId);
    const authority = this.options.authority(scope.extensionId);
    if (!authority || authority.key !== scope.authorityKey) throw new Error("Extension card source changed.");
    return authority;
  }
  registerCall(extensionId: string, authorityKey: string, sessionId: string, toolUseId: string | null): string {
    const session = this.options.store.getSession(sessionId).descriptor;
    const scope: ExtensionCardScope = { extensionId, authorityKey, sessionId, sessionCreatedAt: session.createdAt, targetId: session.targetId, toolUseId };
    this.assertAuthority(scope);
    const callId = `extension-card:${randomUUID()}`;
    this.cards.registerCall(callId, scope);
    return callId;
  }
  matchesOccurrence(sessionId: string, cardId: string, html: string): boolean { return this.#read(sessionId, cardId).row.html === html; }
  async publishHostAuthorization(callId: string, scope: ExtensionCardScope, html: string, current: () => void): Promise<void> {
    current(); this.assertAuthority(scope);
    const result = await this.cards.publishHostAuthorization(scope.extensionId, scope.authorityKey, callId, html, current);
    if (!result.accepted) throw new Error("Plugin authorization card could not be published.");
  }
  oauthCards() { return this.options.oauthCards?.(); }
  get(sessionId: string, cardId: string): { card: ExtensionCardProjection; animatedHtml: string; working: boolean; interactive: boolean; mediaUris: string[]; hostAuthorization: boolean; authorizationPhase?: import("@joko/contracts").ExtensionAuthorizationPhase; authorizationClientConfigured: boolean } {
    const saved = this.#read(sessionId, cardId), source = this.options.authority(saved.row.extensionId);
    const hostAuthorization = isHostAuthorization(saved.row.html), authorization = hostAuthorization ? this.oauthCards()?.view(cardId) : undefined;
    let projectAvailable = true;
    try { this.options.assertProject?.(saved.row.extensionId, sessionId); } catch { projectAvailable = false; }
    const interactive = projectAvailable && (hostAuthorization ? authorization?.interactive === true : source?.key === saved.row.authorityKey) && this.options.store.findSessionRuntimePolicy(sessionId)?.policy !== "review_read_only";
    const transient = interactive ? this.#transient.get(cardId) : undefined;
    return { card: this.#projection(saved.row, source?.name), mediaUris: extensionCardMediaUris(saved.row.html), hostAuthorization, authorizationClientConfigured: authorization?.clientConfigured === true, ...(authorization ? { authorizationPhase: authorization.phase } : {}),
      animatedHtml: transient?.updatedAt === saved.row.updatedAt ? transient.animatedHtml ?? "" : "",
      working: transient?.updatedAt === saved.row.updatedAt && this.cards.callInfoOf(cardId) !== null
        && (transient.state === "working" || this.cards.inFlightCallInfoOf(cardId) !== null), interactive };
  }
  async finalizeCall(callId: string): Promise<boolean> {
    const hasCard = await this.cards.finalizeCall(callId);
    if (!hasCard) return false;
    try {
      const saved = this.#readAny(callId), transient = this.#transient.get(callId);
      if (saved && transient?.state !== "working") {
        const row = { ...saved.row, updatedAt: Date.now() };
        this.#write(row); this.#remember({ ...row, animatedHtml: null, state: "done" });
      }
    } catch { /* A history update never changes a completed provider tool result. */ }
    return true;
  }
  #remember(card: ExtensionCardPush): void {
    this.#transient.set(card.callId, { ...card, html: this.options.redact(card.html),
      animatedHtml: card.animatedHtml === null ? null : this.options.redact(card.animatedHtml) });
    if (this.#transient.size > 4096) this.#transient.delete(this.#transient.keys().next().value!);
  }
  async beginAttachment(sessionId: string, cardId: string, connectionId: string, input: ExtensionMailUploadMetadata, assertCaller: () => void) {
    const row = this.#read(sessionId, cardId).row, mail = readMailCard(row.html);
    const current = () => {
      assertCaller(); this.assertAuthority(row); this.#read(sessionId, cardId);
      if (this.options.store.findSessionRuntimePolicy(sessionId)?.policy === "review_read_only") throw new Error("Review cards are read-only.");
    };
    current();
    if (!this.options.media || !mail || mail.supersededBy || !["draft", "syncing", "error"].includes(mail.state) || !mail.fields.some(field => field.kind === "mail-attachments")) throw new Error("Mail attachments unavailable.");
    return this.options.media.begin(row, connectionId, input, current);
  }
  #mediaScope(input: { sessionId: string; cardId: string; extensionId: string; uri: string }, assertCaller: () => void): { scope: ExtensionCardScope; current: () => void } {
    if (!this.options.media || Boolean(input.cardId) === Boolean(input.extensionId)) throw new Error("Extension media scope invalid.");
    let scope: ExtensionCardScope;
    if (input.cardId) scope = this.#read(input.sessionId, input.cardId).row;
    else {
      const source = this.options.authority(input.extensionId), session = this.options.store.getSession(input.sessionId).descriptor;
      if (!source?.runtime.mailReader) throw new Error("Mail source unavailable.");
      scope = { extensionId: input.extensionId, authorityKey: source.key, sessionId: input.sessionId, sessionCreatedAt: session.createdAt, targetId: session.targetId, toolUseId: null };
    }
    const current = () => {
      assertCaller(); this.assertScope(scope);
      if (input.cardId) { if (!extensionCardMediaUris(this.#read(input.sessionId, input.cardId).row.html).includes(input.uri)) throw new Error("Extension image unavailable."); }
      else this.assertAuthority(scope);
    };
    current(); return { scope, current };
  }
  async readMedia(input: { sessionId: string; cardId: string; extensionId: string; uri: string }, assertCaller: () => void): Promise<string> {
    const { scope, current } = this.#mediaScope(input, assertCaller);
    return this.options.media!.image(scope, input.uri, current);
  }
  async describeMedia(input: { sessionId: string; cardId: string; extensionId: string; uri: string }, assertCaller: () => void) {
    const { scope, current } = this.#mediaScope(input, assertCaller);
    const match = /^joko-media:\/\/blobs\/([a-f0-9]{64})\.(png|jpg|jpeg|gif|webp|glb|mp3|wav|m4a)$/u.exec(input.uri);
    if (!match || !input.cardId) throw new Error("Extension card media unavailable.");
    return (await this.options.media!.describe(scope, match[1]!, current, input.uri)).blob;
  }
  async dispatch(input: { readonly sessionId: string; readonly cardId: string; readonly actionId: string; readonly prompt: string;
    readonly formValues: Readonly<Record<string, string>>; readonly change: boolean; readonly uploadId?: string }, assertCaller: () => void, connectionId = ""): Promise<boolean> {
    assertCaller();
    if (!EXTENSION_CARD_ACTION_ID_RE.test(input.actionId) || input.prompt.length > EXTENSION_CARD_ACTION_PROMPT_MAX_LEN || input.prompt.includes("\0")) return false;
    const saved = this.#read(input.sessionId, input.cardId), scope = saved.row;
    // A closed/restarted host setup card never becomes an author event.
    if (isHostAuthorization(scope.html)) return false;
    if (this.options.store.findSessionRuntimePolicy(scope.sessionId)?.policy === "review_read_only") return false;
    this.assertAuthority(scope);
    const form = readExtensionCardForm(scope.html);
    let values = Object.keys(input.formValues).length ? parseExtensionCardFormValues(input.formValues) : {};
    if (values === null || input.change && !form) return false;
    const hasValues = Object.keys(values).length > 0;
    if (input.change && !hasValues) return false;
    if (hasValues && (!form || form.some(field => !Object.hasOwn(values!, field.name)) || Object.keys(values).some(name => !form.some(field => field.name === name)))) return false;
    if (form && (input.change || hasValues)) {
      const mail = readMailCard(scope.html);
      if (mail?.supersededBy || mail && !["draft", "syncing", "error"].includes(mail.state) && input.change) return false;
    }
    const declarations = cardDeclarations(scope.html);
    const mail = readMailCard(scope.html), attachment = Boolean(!input.change && mail && !mail.supersededBy && ["draft", "syncing", "error"].includes(mail.state)
      && mail.fields.some(field => field.kind === "mail-attachments") && ["attach", "image"].some(action => input.actionId === `mail:${action}:${mail.key}`));
    if (!(input.change ? declarations.changes : declarations.actions).has(input.actionId) && !attachment) return false;
    if (Boolean(input.uploadId) !== attachment || attachment && (!this.options.media || !hasValues || !connectionId || input.prompt)) return false;
    if (input.prompt && !declarations.prompts.has(input.actionId)) return false;
    const actionKey = `${scope.callId}\0${input.actionId}`;
    if (this.#actions.size >= 32 || this.#actions.has(actionKey)) return false;
    this.#actions.add(actionKey);
    try {
      const assertCurrent = () => {
        assertCaller(); this.assertAuthority(scope);
        if (this.options.store.findSessionRuntimePolicy(scope.sessionId)?.policy === "review_read_only") throw new Error("Review cards are read-only.");
      };
      assertCurrent();
      let mailAttachment: ExtensionMailAttachment | undefined;
      if (attachment) {
        const selection = this.options.media!.selection(scope, connectionId, input.uploadId!), base = readMailCard(selection.scope.html);
        if (!base || !mail || base.key !== mail.key || selection.inline !== (input.actionId === `mail:image:${mail.key}`) || base.fields.length !== mail.fields.length) return false;
        const rebased: Record<string, string> = {};
        for (const field of mail.fields) {
          const original = base.fields.find(item => item.name === field.name), local = values![field.name]!;
          if (!original || local !== original.value && field.value !== original.value && local !== field.value) return false;
          rebased[field.name] = local !== original.value ? local : field.value;
        }
        values = rebased;
        mailAttachment = await this.options.media!.complete(scope, connectionId, input.uploadId!, () => {
          assertCurrent(); const latest = this.#read(input.sessionId, input.cardId).row;
          if (latest.updatedAt !== scope.updatedAt || latest.html !== scope.html) throw new Error("Mail changed while attaching. Review the latest draft.");
        });
        assertCurrent();
      }
      if (!this.cards.reopenForAction(scope.callId, scope)) return false;
      const spawnCallId = input.change || readMailCard(scope.html) ? scope.callId : `${extensionCardRootCallId(scope.callId)}::sp${randomUUID().slice(0, 8)}`;
      if (spawnCallId !== scope.callId && !this.cards.reopenForAction(spawnCallId, { ...scope, toolUseId: null })) return false;
      await this.options.dispatch(scope, { type: "event", name: "card-action", callId: scope.callId, actionId: input.actionId,
        spawnCallId,
        ...(input.prompt.trim() ? { prompt: input.prompt.trim() } : {}), ...(hasValues ? { formValues: values! } : {}), ...(mailAttachment ? { mailAttachment } : {}), change: input.change, ts: Date.now() }, assertCurrent);
      assertCurrent(); return true;
    } finally { this.#actions.delete(actionKey); }
  }
  authorizeLink(sessionId: string, cardId: string, url: string): boolean {
    const saved = this.#read(sessionId, cardId), source = this.assertAuthority(saved.row);
    return source.runtime.card?.externalLinks === true && isExtensionCardLinkAllowed(url) && cardDeclarations(saved.row.html).links.has(url);
  }
  revoke(extensionId: string): void {
    this.cards.revoke(extensionId);
    for (const [id, card] of this.#transient) if (card.extensionId === extensionId) this.#transient.delete(id);
  }
  async dispose(): Promise<void> { this.oauthCards()?.dispose(); this.#closed = true; await this.cards.flushWrites(); this.#transient.clear(); }
  #readAny(cardId: string): SavedCard | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(cardId)) throw new Error("Extension card unavailable.");
    const sealed = this.options.store.findSetting<EncryptedCredential>("service", SETTING_OWNER, cardId)?.value;
    if (!sealed) return;
    const saved = JSON.parse(this.options.vault.open(sealed, cardId)) as SavedCard;
    if (saved.version !== 1 || saved.row.version !== 1 || saved.row.callId !== cardId) throw new Error("Extension card unavailable.");
    this.assertScope(saved.row);
    return saved;
  }
  #read(sessionId: string, cardId: string): SavedCard {
    const saved = this.#readAny(cardId);
    if (!saved || saved.row.sessionId !== sessionId) throw new Error("Extension card unavailable.");
    const anchor = this.options.store.findEvent(saved.anchorEventId);
    if (!anchor || this.options.store.listEvents({ sessionId, activeNativeTimeline: true, afterCursor: anchor.globalCursor - 1n, limit: 1 })[0]?.id !== anchor.id) throw new Error("Extension card unavailable.");
    return saved;
  }
  #list(sessionId: string): ExtensionCardRow[] {
    const rows: ExtensionCardRow[] = [];
    for (const setting of this.options.store.listSettings("service", SETTING_OWNER)) {
      try { const saved = this.#readAny(setting.key); if (saved?.row.sessionId === sessionId) rows.push(saved.row); } catch { /* Retired tasks do not grant a new draft scope. */ }
    }
    return rows;
  }
  #write(row: ExtensionCardRow): void {
    const source = this.assertAuthority(row), previous = this.#readAny(row.callId);
    if (previous && (previous.row.extensionId !== row.extensionId || previous.row.authorityKey !== row.authorityKey
      || previous.row.sessionId !== row.sessionId || previous.row.sessionCreatedAt !== row.sessionCreatedAt || previous.row.targetId !== row.targetId)) throw new Error("Extension card owner changed.");
    const safeRow = { ...row, html: this.options.redact(row.html) };
    const saved: SavedCard = { version: 1, anchorEventId: previous?.anchorEventId ?? `extension-card-created:${randomUUID()}`, row: safeRow };
    const card = this.#projection(safeRow, source.name);
    this.options.store.transaction(store => {
      this.assertAuthority(row);
      const session = store.getSession(row.sessionId).descriptor;
      store.setSetting("service", SETTING_OWNER, row.callId, this.options.vault.seal(JSON.stringify(saved), row.callId));
      store.appendEvent({ id: previous ? `extension-card-update:${randomUUID()}` : saved.anchorEventId, sessionId: row.sessionId,
        backendId: session.backendId, targetId: session.targetId, generation: session.binding.generation, traceId: `extension-card:${row.callId}`,
        payload: { type: "extension_card_changed", card } });
    });
  }
  #projection(row: ExtensionCardRow, name?: string): ExtensionCardProjection {
    return { id: row.callId, sessionId: row.sessionId, extensionId: row.extensionId, extensionName: this.options.redact(name ?? row.extensionId),
      toolUseId: row.toolUseId ?? "", html: row.html, text: cardText(row.html), height: row.height, updatedAt: row.updatedAt };
  }
}
function elements(node: DefaultTreeAdapterTypes.Node): DefaultTreeAdapterTypes.Element[] {
  return [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : [])];
}
function isHostAuthorization(html: string): boolean { return elements(parseFragment(html)).some(element => element.attrs.some(attribute => attribute.name === "data-joko-host-authorization" && attribute.value === "true")); }
function cardDeclarations(html: string): { actions: Set<string>; changes: Set<string>; prompts: Set<string>; links: Set<string> } {
  const result = { actions: new Set<string>(), changes: new Set<string>(), prompts: new Set<string>(), links: new Set<string>() };
  for (const element of elements(parseFragment(html))) {
    const attrs = Object.fromEntries(element.attrs.map(attr => [attr.name, attr.value]));
    if (attrs["data-joko-action"]) {
      result.actions.add(attrs["data-joko-action"]);
      if (Object.hasOwn(attrs, "data-joko-prompt")) result.prompts.add(attrs["data-joko-action"]);
    }
    if (attrs["data-joko-change"]) result.changes.add(attrs["data-joko-change"]);
    if (attrs["data-joko-link"]) result.links.add(attrs["data-joko-link"]);
  }
  return result;
}
function cardText(html: string): string {
  const text = (node: DefaultTreeAdapterTypes.Node): string => {
    if ("tagName" in node && ["script", "style", "head"].includes(node.tagName)) return "";
    if ("value" in node) return node.value;
    return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
  };
  const fields = readExtensionCardForm(html) ?? [];
  return [...fields.filter(field => field.kind !== "hidden" && !["mail-html", "mail-attachments"].includes(field.kind ?? "")).map(field => `${field.label}: ${field.value}`),
    text(parseFragment(html)).replace(/\s+/gu, " ").trim()].filter(Boolean).join("\n");
}
