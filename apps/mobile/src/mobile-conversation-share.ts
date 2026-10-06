import type { Event } from "@joko/contracts";
import { mobileTimelineGalleryPages, type MobileImageGalleryPage } from "./mobile-image-gallery";
import type { TimelineRow } from "./timeline";
import { redactShareMessageText } from "./mobile-share-redaction";

export interface MobileConversationShareImage {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly nativeQuarterTurn?: true;
}

export interface MobileConversationShareMessage {
  readonly clientId: string;
  readonly kind: "user" | "assistant";
  readonly body: string;
  readonly bodyParts: readonly ({ readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly key: string; readonly label: string })[];
  readonly attachments: readonly { readonly kind: "image" | "file"; readonly name: string; readonly uri?: string }[];
  readonly images?: ReadonlyMap<string, MobileConversationShareImage>;
}

export interface MobileConversationShareSnapshot {
  readonly leaseId: string;
  readonly allShareableIds: readonly string[];
  readonly messages: readonly MobileConversationShareMessage[];
}

export function mobileMessageShareable(row: TimelineRow): boolean {
  return row.completed && !row.optimistic && (row.kind === "user" || row.kind === "assistant");
}

export function projectMobileConversationShareMessage(
  row: TimelineRow, event: Event, pages: readonly MobileImageGalleryPage[] = mobileTimelineGalleryPages(event), acceptedInput?: Event
): MobileConversationShareMessage {
  if (!mobileMessageShareable(row) || row.eventId !== event.eventId) throw new Error("The selected message is unavailable.");
  const payload = event.payload?.kind;
  const bodyParts: MobileConversationShareMessage["bodyParts"][number][] = [];
  const attachments: MobileConversationShareMessage["attachments"][number][] = [];
  if (row.kind === "assistant" && payload?.case === "messageCompleted") {
    payload.value.blocks.forEach((block, contentIndex) => {
      const page = pages.find((image) => image.source.kind === "timeline" && image.source.contentKind === "block"
        && image.source.contentIndex === contentIndex);
      if (page) bodyParts.push({ kind: "image", key: page.pageId, label: redactShareMessageText(page.title) });
      else if (block.content.case === "text") bodyParts.push({ kind: "text", text: redactShareMessageText(block.content.value) });
      else if (block.content.case === "artifact") bodyParts.push({ kind: "text", text: redactShareMessageText(block.content.value.label || block.content.value.blob?.fileName || "[Artifact]") });
      else if (block.content.case === "image") bodyParts.push({ kind: "text", text: "[Image]" });
    });
  } else {
    bodyParts.push({ kind: "text", text: redactShareMessageText(row.text) });
    for (const page of pages) attachments.push({ kind: "image", name: redactShareMessageText(page.title), uri: page.pageId });
    for (const artifact of row.artifacts ?? []) attachments.push({ kind: "file", name: redactShareMessageText(artifact.title) });
    const input = (acceptedInput ?? event).payload?.kind;
    if (input?.case === "messageStarted" && input.value.userInputAccepted) {
      for (const part of input.value.userInput?.parts ?? []) {
        if (part.content.case === "file") attachments.push({ kind: "file",
          name: redactShareMessageText(part.content.value.fileName || "[File]") });
      }
    }
  }
  return { clientId: row.id, kind: row.kind as "user" | "assistant", body: redactShareMessageText(row.text), bodyParts, attachments };
}

export class MobileConversationShareSelection {
  #owner?: string;
  #selected = new Set<string>();
  #beforeAll?: readonly string[];
  #revision = 0;
  #listeners = new Set<() => void>();
  get revision(): number { return this.#revision; }
  get owner(): string | undefined { return this.#owner; }
  get active(): boolean { return this.#owner !== undefined; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  selected(orderedIds: readonly string[]): readonly string[] { return orderedIds.filter((id) => this.#selected.has(id)); }
  isSelected(id: string): boolean { return this.#selected.has(id); }
  enter(owner: string, id: string): void {
    if (!owner || !id) return;
    if (this.#owner !== owner) this.#selected.clear();
    this.#owner = owner;
    this.#selected.add(id);
    this.#beforeAll = undefined;
    this.#notify();
  }
  enterMany(owner: string, ids: readonly string[]): void {
    if (!owner || ids.length === 0) return;
    this.#owner = owner; this.#selected = new Set(ids); this.#beforeAll = undefined; this.#notify();
  }
  exit(): void {
    if (!this.#owner) return;
    this.#owner = undefined; this.#selected.clear(); this.#beforeAll = undefined; this.#notify();
  }
  toggle(id: string): void {
    if (!this.#owner || !id) return;
    this.#selected.has(id) ? this.#selected.delete(id) : this.#selected.add(id);
    this.#beforeAll = undefined;
    this.#notify();
  }
  toggleAll(orderedIds: readonly string[]): void {
    if (!this.#owner || orderedIds.length === 0) return;
    if (this.selected(orderedIds).length === orderedIds.length) {
      this.#selected = new Set(orderedIds.filter((id) => this.#beforeAll?.includes(id)));
      this.#beforeAll = undefined;
    } else {
      this.#beforeAll = [...this.#selected];
      this.#selected = new Set(orderedIds);
    }
    this.#notify();
  }
  reconcile(owner: string | undefined, orderedIds: readonly string[]): void {
    if (!this.#owner) return;
    if (owner !== this.#owner) { this.exit(); return; }
    const exposed = new Set(orderedIds);
    if ([...this.#selected].some((id) => !exposed.has(id))) {
      this.#selected = new Set([...this.#selected].filter((id) => exposed.has(id)));
      this.#beforeAll = undefined;
      this.#notify();
    }
  }
  #notify(): void { this.#revision += 1; for (const listener of this.#listeners) listener(); }
}
