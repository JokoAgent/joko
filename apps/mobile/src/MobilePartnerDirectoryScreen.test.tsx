// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobilePartnerDirectoryScreen,
  type MobilePartnerDirectoryScreenProps
} from "./MobilePartnerDirectoryScreen";
import type {
  MobilePartnerCatalog,
  MobilePartnerDirectoryProfile,
  MobilePartnerDirectoryTransport
} from "./mobile-partner-directory";
import type { MobilePartnerInitializationTransport } from "./mobile-partner-initialization";
import type { MobilePartnerCreationTransport } from "./mobile-partner-creation";
import type { MobilePartnerDeletionTransport } from "./mobile-partner-deletion";
import { create } from "@bufbuild/protobuf";
import * as groupWire from "@joko/contracts";
import { RunState, SessionState, SnapshotSchema, PartnerImportEditor, PartnerImportReceipts, PartnerImportPreviewPageSchema,
  PartnerImportSourceSchema, PartnerImportResultSchema, PartnerImportCategory, PartnerImportStatus, type PartnerImportApi } from "@joko/contracts";
import type { MobilePartnerDirectoryObservation } from "./mobile-partner-activity";
import type { MobilePartnerWorkingTransport } from "./mobile-partner-working";
import type { MobileComposerRichInputProps } from "./MobileComposerRichInput";
import type { MobileGroupAttachmentTransport } from "./mobile-partner-groups";
import type { MobileLocalComposerAttachment } from "./mobile-attachments";
import { MobilePhotoLibrary } from "./mobile-photo-library";
import { MobileAttachmentFiles } from "./mobile-attachment-files";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({ back: undefined as undefined | (() => boolean), dismiss: undefined as undefined | (() => void), viewable: undefined as undefined | ((items: unknown) => void), composer: undefined as MobileComposerRichInputProps | undefined }));
vi.mock("./MobileComposerRichInput", async () => {
  const React = await import("react");
  return { MobileComposerRichInput: React.forwardRef((props: MobileComposerRichInputProps, ref) => {
    native.composer = props; React.useImperativeHandle(ref, () => ({ focus() {}, blur() {} }));
    return React.createElement("input", { "aria-label": props.accessibilityLabel, value: props.draft.text, disabled: !props.editable,
      onInput: (event: React.FormEvent<HTMLInputElement>) => { const text = event.currentTarget.value; props.onEdit({ draft: { ...props.draft, text }, selection: { start: text.length, end: text.length } }, props.draft); } });
  }) };
});
vi.mock("./MobileMarkdownMessage", async () => { const React = await import("react"); return { MobileMarkdownMessage: ({ text }: { text: string }) => React.createElement("span", {}, text) }; });
vi.mock("./MobileInteractionSheet", () => ({ MobileInteractionSheet: () => null }));
vi.mock("./MobileImageLightbox", () => ({ MobileImageLightbox: () => null }));
vi.mock("./MobileGroupIcon", () => ({ MobileGroupIcon: () => null }));
vi.mock("./MobileActionSheet", async () => { const React = await import("react"); return { MobileActionSheet: ({ visible, items, onClose, onAction }: { visible: boolean; items: readonly { id: string; label: string; disabled?: boolean }[]; onClose(): void; onAction(id: string): void }) => visible ? React.createElement("div", {}, items.map(item => React.createElement("button", { key: item.id, "aria-label": item.label, disabled: item.disabled, onClick: () => { onClose(); onAction(item.id); } }, item.label))) : null }; });
vi.mock("./MobilePhotoLibrarySheet", () => ({ MobilePhotoLibrarySheet: () => null }));
vi.mock("./mobile-image-output", () => ({ mobileImageOutput: { perform: vi.fn() } }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return { SafeAreaView: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
vi.mock("./MobileKeyboardAvoidingView", async () => {
  const React = await import("react");
  return { MobileKeyboardAvoidingView: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
    useMobileKeyboardState: () => ({ height: 0, visible: false }) };
});
vi.mock("./MobilePartnerPresenceRing", async () => {
  const React = await import("react");
  return { MobilePartnerPresenceRing: ({ active }: { active: boolean }) => active
    ? React.createElement("span", { "data-testid": "partnerDirectory.presenceRing" }) : null };
});
vi.mock("./MobileWorkingStatusText", async () => {
  const React = await import("react");
  return { MobileWorkingStatusText: ({ text }: { text: string }) => React.createElement("span", { "data-testid": "partnerDirectory.caption" }, text) };
});
vi.mock("./MobilePartnerCreateSheet", async () => {
  const React = await import("react");
  return { MobilePartnerCreateSheet: ({ visible }: { visible: boolean }) => visible ? React.createElement("div", { "data-testid": "partnerCreation.sheet" }) : null };
});

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    accessibilityHint: _accessibilityHint, accessible: _accessible, onPress, disabled, numberOfLines: _numberOfLines, testID, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityHint?: string;
      accessibilityState?: { checked?: boolean; disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      numberOfLines?: number;
      testID?: string;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.checked === undefined ? {} : { "aria-checked": accessibilityState.checked }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(testID ? { "data-testid": testID } : {}),
      style: undefined
    }, props.children);
  return {
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, Platform: { OS: "ios" },
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
      native.back = handler;
      return { remove: () => { if (native.back === handler) native.back = undefined; } };
    } },
    FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent, ListFooterComponent, onViewableItemsChanged }: {
      data: readonly unknown[];
      renderItem: (value: { item: unknown; index: number }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
      onViewableItemsChanged?: (items: unknown) => void;
    }) => { if (onViewableItemsChanged) native.viewable = onViewableItemsChanged; return React.createElement("div", {}, ListHeaderComponent, data.length === 0 ? ListEmptyComponent
      : data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))), ListFooterComponent); },
    Alert: { alert: vi.fn() },
    Pressable: element("button"),
    Modal: ({ visible, children, onDismiss }: { visible: boolean; children: React.ReactNode; onDismiss?: () => void }) => {
      if (onDismiss) native.dismiss = onDismiss;
      return visible ? React.createElement("div", { "data-testid": "partnerDeletion.sheet" }, children) : null;
    },
    ScrollView: element("div"),
    RefreshControl: () => null,
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, onChangeText, value, testID, autoCorrect: _autoCorrect,
      clearButtonMode: _clearButtonMode, placeholderTextColor: _placeholderTextColor, ...props }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      value?: string;
      testID?: string;
      autoCorrect?: boolean;
      clearButtonMode?: string;
      placeholderTextColor?: string;
    }) => React.createElement("input", { ...props, value, "aria-label": accessibilityLabel,
      "data-testid": testID, onChange: () => undefined,
      onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
      style: undefined }),
    View: element("div")
  };
});

const colors: MobilePartnerDirectoryScreenProps["colors"] = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

function profile(input: Partial<MobilePartnerDirectoryProfile> & Pick<MobilePartnerDirectoryProfile,
  "partnerId" | "displayName">): MobilePartnerDirectoryProfile {
  const { partnerId, displayName, ...overrides } = input;
  return {
    partnerId,
    revision: 2n,
    profileVersion: 3n,
    displayName,
    description: "",
    avatar: "orbit",
    identitySource: `${displayName} works across product surfaces.`,
    templateId: "general",
    lifecycle: "active",
    initializationState: "ready",
    invitationStage: "ready",
    homeTargetId: `target-${partnerId}`,
    canonicalSessionId: `session-${partnerId}`,
    capabilities: { modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }],
      permissionMode: "ask", planMode: false },
    usesDirectoryDefaults: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    activity: { partnerId, unreadReplyCount: 0, artifactCount: 1, activeDelegationCount: 0,
      readThroughCursor: 0n, readUpdatedAt: 1_000 },
    ...overrides
  };
}

const ada = profile({ partnerId: "ada", displayName: "Ada", activity: {
  partnerId: "ada", unreadReplyCount: 2, latestReplyCursor: 5n, latestReplyAt: 3_000,
  artifactCount: 3, activeDelegationCount: 1, readThroughCursor: 3n, readUpdatedAt: 2_000
} });
const pending = profile({ partnerId: "pending", displayName: "Pending", initializationState: "pending",
  invitationStage: "home", canonicalSessionId: undefined });
const archived = profile({ partnerId: "archived", displayName: "Archived", lifecycle: "archived" });
const catalog: MobilePartnerCatalog = {
  directory: { revision: 4n, activeCount: 2, archivedCount: 1, errorCount: 0, updatedAt: 4_000 },
  partners: [ada, pending, archived]
};

function transport(ownerKey = "owner-a"): MobilePartnerDirectoryTransport {
  return {
    ownerKey,
    list: vi.fn(async () => catalog),
    open: vi.fn(async () => ({ sessionId: "session-ada" }))
  };
}

let container: HTMLDivElement;
let root: Root;
const onBack = vi.fn();
const onOpenTask = vi.fn();

async function render(active?: MobilePartnerDirectoryTransport, initializationTransport?: MobilePartnerInitializationTransport,
  creationTransport?: MobilePartnerCreationTransport, observation?: MobilePartnerDirectoryObservation,
  workingTransport?: MobilePartnerWorkingTransport, deletionTransport?: MobilePartnerDeletionTransport,
  resumeFactory?: MobilePartnerDirectoryScreenProps["resumeFactory"], importFactory?: MobilePartnerDirectoryScreenProps["importFactory"],
  groups?: Pick<MobilePartnerDirectoryScreenProps, "groupApi" | "groupReceiptScope" | "groupCreationStorage" | "groupAttachments">) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root.render(createElement(MobilePartnerDirectoryScreen, {
      colors, locale: "en", transport: active, initializationTransport, creationTransport, observation, workingTransport, deletionTransport, resumeFactory, importFactory, ...groups, onBack, onOpenTask
    }));
  });
}

async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label);
  expect(button, `Missing accessible button ${label}`).toBeTruthy();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  native.back = undefined;
  native.viewable = undefined;
  native.composer = undefined;
  onBack.mockReset();
  onOpenTask.mockReset();
});

function groupFixture(empty = false) {
  const group = create(groupWire.PartnerGroupSummarySchema, { id: "shared-group", name: "Shared project", revision: { value: 1n }, unread: true,
    members: [{ partnerId: "ada", name: "Ada", status: groupWire.PartnerGroupMemberStatus.ACTIVE }, { partnerId: "pending", name: "Pending", status: groupWire.PartnerGroupMemberStatus.ACTIVE }] });
  let currentGroups = empty ? [] : [group];
  const plan = create(groupWire.PartnerGroupPlanSchema, { id: "shared-plan", groupId: group.id, revision: { value: 1n }, status: groupWire.PartnerGroupPlanStatus.WAITING, currentStep: 0,
    steps: [{ position: 0, partnerId: "ada", partnerName: "Ada", task: "Write result", status: groupWire.PartnerGroupStepStatus.FAILED }, { position: 1, partnerId: "pending", partnerName: "Pending", task: "Review result", status: groupWire.PartnerGroupStepStatus.PENDING }] });
  const message = create(groupWire.PartnerGroupMessageSchema, { id: "shared-message", sequence: 5n, kind: groupWire.PartnerGroupMessageKind.PLAN, planId: plan.id });
  const api: groupWire.PartnerGroupApi = { ownerKey: "group-owner-one", newRequestId: () => "group-creation-request-0001",
    list: vi.fn(async () => create(groupWire.ListPartnerGroupsResponseSchema, { revision: { value: 1n }, groups: currentGroups })),
    get: vi.fn(async () => create(groupWire.GetPartnerGroupResponseSchema, { detail: { group, plans: [plan], messages: [message], canContinue: true } })),
    create: vi.fn(async () => { currentGroups = [group]; throw new Error("Creation response lost"); }), lookup: vi.fn(async () => create(groupWire.GetPartnerGroupCreationResponseSchema, { group })),
    retire: vi.fn(), update: vi.fn(), members: vi.fn(), remove: vi.fn(), send: vi.fn(), continue: vi.fn(async () => undefined), stop: vi.fn(), markRead: vi.fn(async () => undefined),
    planAction: vi.fn(async () => undefined), planEdit: vi.fn(async () => undefined), respond: vi.fn(), file: vi.fn(),
    changes: async function* (_after, signal) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); } };
  const receipts = new Map<string, string>();
  return { api, group, plan, message, props: { groupApi: api, groupReceiptScope: "node-profile-device", groupCreationStorage: {
    getItem: async (key: string) => receipts.get(key) ?? null, setItem: async (key: string, value: string) => { receipts.set(key, value); }, removeItem: async (key: string) => { receipts.delete(key); } } }, receipts };
}
it("creates a group from the actual mixed directory and recovers its durable unknown receipt", async () => {
  const f = groupFixture(true), m = groupWire.partnerGroupMessages("en");
  await render(transport(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, f.props); await press(m.create);
  const name = container.querySelector<HTMLInputElement>(`input[aria-label="${m.name}"]`)!;
  await act(async () => { name.value = "Shared project"; name.dispatchEvent(new Event("input", { bubbles: true })); }); await press("Ada"); await press("Pending");
  await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${m.create}"]`)).at(-1)!.click());
  expect(f.api.create).toHaveBeenCalledTimes(1); expect(f.receipts.size).toBe(1); expect(container.textContent).toContain(m.pendingCreate);
  await press(m.checkCreate); expect(f.receipts.size).toBe(0); expect(container.querySelector('[data-testid="partnerGroups.composer"]')).not.toBeNull(); expect(f.api.markRead).not.toHaveBeenCalled();
});
it("keeps the group draft through settings and reconnection while binding visible reads and failed-step actions to the current owner", async () => {
  const f = groupFixture(), active = transport(), m = groupWire.partnerGroupMessages("en");
  await render(active, undefined, undefined, undefined, undefined, undefined, undefined, undefined, f.props); await press(`${f.group.name} · ${m.groups} · ${m.unread}`);
  expect(f.api.markRead).not.toHaveBeenCalled(); await act(async () => native.viewable!({ viewableItems: [{ item: f.message, isViewable: true }] })); expect(f.api.markRead).toHaveBeenCalledWith(f.group.id, 5n, expect.any(AbortSignal));
  const input = () => container.querySelector<HTMLInputElement>('[data-testid="partnerGroups.composer"] input')!;
  await act(async () => { input().value = "Keep this draft"; input().dispatchEvent(new Event("input", { bubbles: true })); }); await press(m.settings);
  const backs = container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${m.back}"]`); await act(async () => backs[backs.length - 1]!.click()); expect(input().value).toBe("Keep this draft");
  const next = { ...f.api, ownerKey: "group-owner-two", markRead: vi.fn(async () => undefined) };
  await render(active, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { ...f.props, groupApi: next }); expect(input().value).toBe("Keep this draft");
  await press(m.retry); expect(next.planAction).toHaveBeenCalledWith(f.group.id, expect.objectContaining({ id: f.plan.id }), groupWire.PartnerGroupPlanAction.RETRY, expect.any(AbortSignal));
  await press(`${m.reassign} 1`); await press("Pending"); expect(next.planEdit).toHaveBeenCalledWith(f.group.id, expect.objectContaining({ id: f.plan.id }), 0, groupWire.PartnerGroupPlanEditAction.REASSIGN, "pending", expect.any(AbortSignal));
});
it("pastes an image into the mounted group composer and reuses its uploaded bytes and send receipt after a lost response", async () => {
  const f = groupFixture(), m = groupWire.partnerGroupMessages("en"), photoLibrary = new MobilePhotoLibrary(new MobileAttachmentFiles());
  vi.spyOn(photoLibrary, "directlyBrowsable").mockResolvedValue(false);
  const file: MobileLocalComposerAttachment = { attachmentId: "pasted-image", fileName: "clipboard.png", kind: "image", state: "local", mediaType: "image/png", byteSize: 32, sha256Hex: "a".repeat(64), capturedAtUnixMs: 1 };
  const attached = create(groupWire.PartnerGroupAttachmentSchema, { id: file.attachmentId, name: file.fileName, category: groupWire.PartnerGroupAttachmentCategory.IMAGE,
    blob: { blobId: "uploaded-image", fileName: file.fileName, mediaType: file.mediaType, byteSize: 32n, sha256Hex: file.sha256Hex } });
  const media = { ownerKey: f.api.ownerKey, photoLibrary, paste: vi.fn(async () => [file]), upload: vi.fn(async () => attached), remove: vi.fn(async () => undefined) };
  const groupAttachments = media as unknown as MobileGroupAttachmentTransport;
  vi.mocked(f.api.send).mockRejectedValueOnce(new Error("Send response lost"));
  await render(transport(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, { ...f.props, groupAttachments });
  await press(`${f.group.name} · ${m.groups} · ${m.unread}`);
  const source = native.composer!.draft;
  await act(async () => { expect(native.composer!.onPasteImagesStart!({ draft: source, count: 1 })).toBe(true); });
  await act(async () => { native.composer!.onPasteImages!({ draft: source, count: 1, images: [{ base64: "fixture-bytes", mediaType: "image/png", name: file.fileName }] }); });
  expect(media.paste).toHaveBeenCalledWith(f.group, [], expect.any(Array), expect.any(AbortSignal)); expect(container.textContent).toContain(file.fileName);
  await press(m.send); expect(container.textContent).toContain("Send response lost"); expect(container.textContent).toContain(file.fileName);
  await press(m.send); expect(media.upload).toHaveBeenCalledTimes(1); expect(f.api.send).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.api.send).mock.calls[1]!.slice(1, 3)).toEqual(vi.mocked(f.api.send).mock.calls[0]!.slice(1, 3));
  expect(media.remove).toHaveBeenCalledExactlyOnceWith(file); expect(container.textContent).not.toContain(file.fileName);
});

describe("MobilePartnerDirectoryScreen", () => {
  it("opens the real import sheet and waits for native dismissal before opening its owned saved task", async () => {
    const active = transport(); const values = new Map<string, string>();
    const api: PartnerImportApi = { ownerKey: active.ownerKey, newRequestId: () => "mobile_directory_import_0001",
      sources: vi.fn(async () => [create(PartnerImportSourceSchema, { id: "source", name: "Native analyst" })]),
      preview: vi.fn(async () => create(PartnerImportPreviewPageSchema, { id: "preview", source: { id: "source", name: "Native analyst" }, name: "Local analyst", total: 1,
        entries: [{ id: "identity", index: 0, name: "Identity", category: PartnerImportCategory.PERSONALITY, selected: true }] })),
      status: vi.fn(async () => undefined), retry: vi.fn(), start: vi.fn(async selection => create(PartnerImportResultSchema, { requestId: selection.requestId,
        partnerId: "imported", canonicalSessionId: "imported-task", saved: true, savedEntryIds: ["identity"], status: PartnerImportStatus.COMPLETE })) };
    const editor = new PartnerImportEditor(api, new PartnerImportReceipts({ getItem: async key => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } }, "node"));
    await render(active, undefined, undefined, undefined, undefined, undefined, undefined, () => editor);
    await press("Import a local agent"); await press("Native analyst"); await press("Save Partner");
    expect(api.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "Local analyst", deferSetup: true, requestId: "mobile_directory_import_0001" }), expect.any(AbortSignal));
    expect(onOpenTask).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("Save Partner"); expect(values.size).toBe(0);
    await act(async () => native.dismiss!()); expect(onOpenTask).toHaveBeenCalledExactlyOnceWith("imported-task"); expect(editor.active).toBe(false);
  });
  it("offers paused resume from the main roster without opening a task", async () => {
    const selected = { ...catalog.partners[0]!, lifecycle: "paused" as const, pauseCleanupPending: false };
    const active = transport(); vi.mocked(active.list).mockResolvedValue({ ...catalog, directory: { ...catalog.directory, activeCount: 0 }, partners: [selected] });
    const factory = vi.fn(() => undefined); await render(active, undefined, undefined, undefined, undefined, undefined, factory);
    expect(container.textContent).toContain("Paused"); await press("Resume partner");
    expect(factory).toHaveBeenCalledExactlyOnceWith(selected); expect(active.open).not.toHaveBeenCalled(); expect(onOpenTask).not.toHaveBeenCalled();
  });
  it.each([pending, { ...pending, initializationState: "error" as const }, archived])
    ("deletes a $lifecycle / $initializationState profile from the roster without opening or initializing a task", async (selected) => {
      const active = transport(); vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [selected] });
      const deletion: MobilePartnerDeletionTransport = { ownerKey: active.ownerKey, newRequestId: () => "deletion-directory-intent",
        listRequests: vi.fn(async () => []), read: vi.fn(async () => ({ retired: false })), retry: vi.fn(), retire: vi.fn(),
        delete: vi.fn(async (requestId, partner) => {
          vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [] });
          return { requestId, partnerId: partner.partnerId, phase: "completed" as const, createdAt: 1, updatedAt: 2 };
        }) };
      await render(active, undefined, undefined, undefined, undefined, deletion);
      if (selected.lifecycle === "archived") await press("Archived");
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="partnerDirectory.delete.${selected.partnerId}"]`)!.click());
      expect(container.querySelector('[data-testid="partnerDeletion.sheet"]')).not.toBeNull();
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="Type ${selected.displayName} to confirm"]`)!;
      expect(input).not.toBeNull(); expect(deletion.delete).not.toHaveBeenCalled();
      await act(async () => { input.value = selected.displayName; input.dispatchEvent(new Event("input", { bubbles: true })); });
      const confirmation = container.querySelector<HTMLButtonElement>('[data-testid="partnerDeletion.sheet"] button[aria-label="Delete Partner"]')!;
      await act(async () => confirmation.click());
      expect(deletion.delete).toHaveBeenCalledWith("deletion-directory-intent", selected, selected.displayName, expect.any(AbortSignal));
      expect(container.querySelector('[data-testid="partnerDeletion.sheet"]')).toBeNull();
      expect(container.querySelector(`[data-testid="partnerDirectory.item.${selected.partnerId}"]`)).toBeNull();
      expect(active.open).not.toHaveBeenCalled(); expect(onOpenTask).not.toHaveBeenCalled();
    });
  it("retires a deletion sheet immediately on node change and ignores the late result", async () => {
    const active = transport(); let finish!: (value: Awaited<ReturnType<MobilePartnerDeletionTransport["delete"]>>) => void;
    let deletionSignal!: AbortSignal;
    const deletion: MobilePartnerDeletionTransport = { ownerKey: active.ownerKey, newRequestId: () => "deletion-directory-intent",
      listRequests: vi.fn(async () => []), read: vi.fn(async () => ({ retired: false })), retry: vi.fn(), retire: vi.fn(),
      delete: vi.fn((_id, _partner, _name, signal) => { deletionSignal = signal; return new Promise<Awaited<ReturnType<MobilePartnerDeletionTransport["delete"]>>>((resolve) => { finish = resolve; }); }) };
    await render(active, undefined, undefined, undefined, undefined, deletion);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.delete.ada"]')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Type Ada to confirm"]')!;
    await act(async () => { input.value = ada.displayName; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="partnerDeletion.sheet"] button[aria-label="Delete Partner"]')!.click());
    const next = transport("next-node"); await render(next, undefined, undefined, undefined, undefined, deletion);
    expect(deletionSignal.aborted).toBe(true); expect(container.querySelector('[data-testid="partnerDeletion.sheet"]')).toBeNull();
    expect(container.querySelector('[data-testid="partnerDirectory.delete.ada"]')).toBeNull();
    const reads = vi.mocked(next.list).mock.calls.length;
    await act(async () => finish({ requestId: "deletion-directory-intent", partnerId: ada.partnerId, phase: "completed", createdAt: 1, updatedAt: 2 }));
    expect(next.list).toHaveBeenCalledTimes(reads); expect(deletion.delete).toHaveBeenCalledOnce();
  });
  it("uses current Host facts and the shared optional caption without granting an old turn display", async () => {
    const status = { sessionId: ada.canonicalSessionId!, targetId: ada.homeTargetId, backendId: "backend", generation: 2n,
      runId: "run", attemptId: "attempt", phase: "testing" as const };
    const working = { ...ada, activity: { ...ada.activity, workingStatus: status } };
    const active = transport(); vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [working] });
    const observation = { ownerKey: active.ownerKey, online: true, snapshot: create(SnapshotSchema, {
      sessions: [{ sessionId: status.sessionId, targetId: status.targetId, backendId: status.backendId, state: SessionState.RUNNING, version: { generation: 2n } }],
      runs: [{ runId: status.runId, sessionId: status.sessionId, targetId: status.targetId, backendId: status.backendId,
        activeAttemptId: status.attemptId, state: RunState.RUNNING, version: { generation: 2n } }]
    }) };
    const read = vi.fn(async () => "Looking through the tests");
    const captionTransport = { ownerKey: active.ownerKey, read };
    await render(active, undefined, undefined, observation, captionTransport);
    expect(container.querySelector('[data-testid="partnerDirectory.caption"]')?.textContent).toBe("Looking through the tests");
    expect(read).toHaveBeenCalledOnce();
    observation.snapshot.runs[0]!.activeAttemptId = "next-attempt";
    await render(active, undefined, undefined, observation, captionTransport);
    expect(container.querySelector('[data-testid="partnerDirectory.caption"]')).toBeNull();
    expect(container.textContent).not.toContain("Looking through the tests");
    expect(read).toHaveBeenCalledOnce();
  });
  it("offers creation through the matching node header and empty-state CTA without bypassing an offline owner", async () => {
    const active = transport(); vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [], directory: { ...catalog.directory, activeCount: 0 } });
    const creation = { ownerKey: active.ownerKey } as MobilePartnerCreationTransport;
    await render(active, undefined, creation);
    const header = container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.create"]')!;
    const empty = container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.emptyCreate"]')!;
    expect(header.disabled).toBe(false); expect(empty.disabled).toBe(false);
    await act(async () => empty.click()); expect(container.querySelector('[data-testid="partnerCreation.sheet"]')).not.toBeNull();
    await render(active, undefined, { ...creation, ownerKey: "other-owner" });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.create"]')!.disabled).toBe(true);
  });
  it("opens pending setup through the matching node owner and returns to the roster on Android back", async () => {
    const active = transport();
    const initialization: MobilePartnerInitializationTransport = { ownerKey: active.ownerKey,
      load: vi.fn(async () => pending), retry: vi.fn(async () => ada), open: vi.fn(async () => ({ sessionId: "session-ada" })) };
    await render(active, initialization); await press("View Pending's setup");
    expect(initialization.load).toHaveBeenCalledWith("pending", expect.any(AbortSignal));
    expect(container.textContent).toContain("Getting Pending ready"); expect(active.open).not.toHaveBeenCalled();
    await act(async () => { expect(native.back?.()).toBe(true); });
    expect(container.querySelector('[data-testid="partnerDirectory.item.ada"]')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled(); expect(onOpenTask).not.toHaveBeenCalled();
    await render(active, { ...initialization, ownerKey: "another-node" });
    expect((container.querySelector('[aria-label="Open Pending\'s task"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows activity, disables unavailable entries, searches and opens an exact Partner task", async () => {
    const active = transport();
    await render(active);
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).toContain("Ada works across product surfaces.");
    expect((container.querySelector('[aria-label="Open Pending\'s task"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[aria-label="Search Partners"]')).toBeTruthy();
    const input = container.querySelector('[aria-label="Search Partners"]') as HTMLInputElement;
    await act(async () => {
      input.value = "Pending";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="partnerDirectory.item.ada"]')).toBeNull();
    expect(container.querySelector('[data-testid="partnerDirectory.item.pending"]')).toBeTruthy();
    await press("Clear");
    await press("Open Ada's task");
    expect(active.open).toHaveBeenCalledWith(ada, expect.any(AbortSignal));
    expect(onOpenTask).toHaveBeenCalledWith("session-ada");
  });

  it("switches to archived state and retires a late directory from an old owner", async () => {
    let finish!: (value: MobilePartnerCatalog) => void;
    const old = transport("owner-old");
    vi.mocked(old.list).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old);
    const next = transport("owner-new");
    vi.mocked(next.list).mockResolvedValue({ ...catalog, partners: [profile({ partnerId: "new", displayName: "New" })],
      directory: { ...catalog.directory, activeCount: 1, archivedCount: 0 } });
    await render(next);
    expect(container.textContent).toContain("New");
    await act(async () => finish(catalog));
    expect(container.textContent).not.toContain("Ada works");
    await render(transport());
    await press("Archived");
    expect(container.querySelector('[data-testid="partnerDirectory.item.archived"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="partnerDirectory.item.ada"]')).toBeNull();
  });

  it("shows the bounded offline state and handles Android back", async () => {
    await render(undefined);
    expect(container.textContent).toContain("Reconnect to view Partners");
    expect(native.back?.()).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows canonical working and waiting state, preserves the same owner's reply offline and retires it on owner loss", async () => {
    const active = transport();
    vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [{ ...ada,
      activity: { ...ada.activity, latestReplyPreview: "**Ready** [report](https://example.test)" } }] });
    const observation: MobilePartnerDirectoryObservation = { ownerKey: active.ownerKey, online: true,
      snapshot: create(SnapshotSchema, { sessions: [{ sessionId: ada.canonicalSessionId, targetId: ada.homeTargetId,
        backendId: "backend", state: SessionState.RUNNING, version: { generation: 1n } }] }) };
    await render(active, undefined, undefined, observation);
    expect(container.textContent).toContain("Thinking…");
    expect(container.querySelector('[data-testid="partnerDirectory.presenceRing"]')).not.toBeNull();
    observation.snapshot.sessions[0]!.state = SessionState.WAITING;
    await render(active, undefined, undefined, observation);
    expect(container.textContent).toContain("Waiting for your confirmation · Ready report");
    expect(container.querySelector('[data-testid="partnerDirectory.presenceRing"]')).toBeNull();
    await render(undefined, undefined, undefined, { ...observation, online: false });
    expect(container.textContent).toContain("Offline · Ready report");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.item.ada"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.refresh"]')!.disabled).toBe(true);
    expect(active.open).not.toHaveBeenCalled();
    await render(undefined);
    expect(container.textContent).not.toContain("Ready report");
  });

  it("polls without overlapping reads and stops after a read failure or offline transition", async () => {
    vi.useFakeTimers();
    try {
      const active = transport(); await render(active);
      let finish!: (value: MobilePartnerCatalog) => void;
      vi.mocked(active.list).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(active.list).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(7500); });
      expect(active.list).toHaveBeenCalledTimes(2);
      await act(async () => finish(catalog));
      vi.mocked(active.list).mockRejectedValueOnce(new Error("connection lost"));
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(container.textContent).toContain("The saved list may be out of date");
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(active.list).toHaveBeenCalledTimes(3);
      await render(undefined);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(active.list).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
