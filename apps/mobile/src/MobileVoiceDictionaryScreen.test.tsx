// @vitest-environment jsdom
import { act, createElement, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileVoiceDictionaryScreen, type MobileVoiceDictionaryScreenProps } from "./MobileVoiceDictionaryScreen";
import { mobileMessage } from "./mobile-messages";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileVoicePreferencesStoreState } from "./mobile-voice-preferences-store";
import type { MobileVoiceDictionaryControllerState } from "./mobile-voice-dictionary-controller";
import type { VoiceDictionaryPeerStatusView } from "@joko/contracts";
import type { MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";
import { create } from "@bufbuild/protobuf";
import { VoiceInputServiceSettingsSchema, VoiceInputTranscriptionProtocol, VoiceInputSaucMode, VoiceInputSaucAuthentication, TestVoiceInputConnectionResponseSchema } from "@joko/contracts";
import type { MobileVoiceSettingsTransport } from "./mobile-voice-service-settings";
import { dictionaryWatchFixture, idleDictionaryWatch } from "./test/voice-dictionary-watch";

const native = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityLiveRegion: _live,
    accessibilityState: _state, selectable: _selectable,
    onPress, disabled, contentContainerStyle: _content, keyboardShouldPersistTaps: _taps, ...props }: Record<string, unknown> & {
      children?: React.ReactNode; accessibilityLabel?: string; accessibilityRole?: string;
      accessibilityLiveRegion?: string; onPress?: () => void; disabled?: boolean;
      contentContainerStyle?: unknown; keyboardShouldPersistTaps?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(onPress ? { onClick: onPress } : {}),
      disabled,
      style: undefined
    }, props.children);
  const TextInput = forwardRef<HTMLInputElement | HTMLTextAreaElement, {
    accessibilityLabel?: string; value?: string; editable?: boolean; multiline?: boolean;
    onChangeText?: (value: string) => void; onSubmitEditing?: () => void;
  } & Record<string, unknown>>((rawProps, ref) => {
    const { accessibilityLabel, value, editable = true, multiline, secureTextEntry, autoCorrect: _autoCorrect,
      placeholderTextColor: _placeholderTextColor,
      onChangeText: rawChangeText, onSubmitEditing: rawSubmitEditing, ...props } = rawProps;
    const onChangeText = rawChangeText as ((value: string) => void) | undefined;
    const onSubmitEditing = rawSubmitEditing as (() => void) | undefined;
    return React.createElement(multiline ? "textarea" : "input", {
        ...props,
        ref,
        "aria-label": accessibilityLabel,
        value,
        ...(!multiline && secureTextEntry ? { type: "password" } : {}),
        disabled: !editable,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChangeText?.(event.target.value),
        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter") onSubmitEditing?.(); },
        style: undefined
      });
  });
  return {
    Alert: { alert: native.alert },
    AppState: { addEventListener: () => ({ remove: () => undefined }) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value },
    Switch: ({ accessibilityLabel, value, onValueChange, disabled }: {
      accessibilityLabel?: string; value?: boolean; onValueChange?: (value: boolean) => void; disabled?: boolean;
    }) => React.createElement("input", { type: "checkbox", "aria-label": accessibilityLabel, checked: value,
      disabled, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(event.target.checked) }),
    Text: element("span"),
    TextInput,
    View: element("div")
  };
});

const colors = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd",
  accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

function voiceState(status: MobileVoicePreferencesStoreState["status"] = "ready"): MobileVoicePreferencesStoreState {
  return {
    status,
    saving: false,
    ...(status === "error" ? { error: "damaged" } : {}),
    document: {
      version: 1,
      revision: 3,
      preferencesRevision: 3,
      refinementInstructions: "Keep commands verbatim.",
      autoLearningEnabled: true,
      recognitionContextEnabled: false, recognitionContextData: [],
      usage: { voiceStarts: 4, correctionObservations: 2, lastVoiceStartedAt: 30, lastCorrectionAt: 25 },
      history: []
    }
  };
}

function nodeDictionary(revision = 8n): MobileVoiceDictionaryControllerState {
  return {
    status: "ready", ownerKey: "node-a", saving: false,
    snapshot: { revision, syncEnabled: true, dictionary: {
        entries: [
          { id: "source", text: "Variant", source: "automatic", frequency: 3,
            aliases: [{ text: "variant old", count: 2, lastSeenAt: 20 }], createdAt: 10, updatedAt: 20 },
          { id: "target", text: "Canonical", source: "manual", frequency: 4,
            aliases: [], createdAt: 5, updatedAt: 25 }
        ],
        candidates: [{ text: "VoiceKit", evidenceCount: 2,
          aliases: [{ text: "voice kit", count: 2, lastSeenAt: 22 }], createdAt: 8, updatedAt: 22 }],
        suppressedAutomaticTexts: []
      }, refinementTerms: ["Canonical", "Variant"] }
  };
}

const peerFingerprint = "b".repeat(64);
function peerStatus(): VoiceDictionaryPeerStatusView {
  return { available: true, configurationRevision: 3n, nodeId: "node-a", fingerprint: "a".repeat(64), enabled: true,
    phase: "waiting", peers: [], candidates: [{ nodeId: "node-b", displayName: "Office", fingerprint: peerFingerprint,
      seenAt: 1_000, granted: false, keyChanged: false }] };
}
function peerTransport(): MobileVoiceDictionaryTransport {
  const unrelated = async () => { throw new Error("Content is controlled by the screen fixture."); };
  return { ownerKey: "owner-a", isCurrent: () => true,
    watchVoiceInputDictionary: vi.fn(idleDictionaryWatch),
    watchVoiceInputDictionaryPeerStatus: vi.fn(idleDictionaryWatch),
    getVoiceInputDictionary: unrelated, setVoiceInputDictionarySyncEnabled: unrelated, addVoiceInputDictionaryTerms: unrelated,
    editVoiceInputDictionaryEntry: unrelated, deleteVoiceInputDictionaryEntry: unrelated, applyVoiceInputDictionaryLearning: unrelated,
    getVoiceInputDictionaryPeerStatus: vi.fn(async () => peerStatus()),
    grantVoiceInputDictionaryPeer: vi.fn(async () => peerStatus()),
    revokeVoiceInputDictionaryPeer: vi.fn(async () => peerStatus()),
    syncVoiceInputDictionaryNow: vi.fn(async () => peerStatus()),
    configureVoiceInputDictionaryListener: vi.fn(async () => peerStatus()), getVoiceInputDictionaryPeerInvitation: vi.fn(async () => invitation("node-a", "a")),
    grantVoiceInputDictionaryDirectPeer: vi.fn(async () => peerStatus()), clearVoiceInputDictionaryPeerRoute: vi.fn(async () => peerStatus()) };
}
function invitation(nodeId = "node-b", fingerprint = "b"): string { return JSON.stringify({ version: 1, nodeId, displayName: "Office",
  publicKey: "MCowBQYDK2VuAyEA" + "A".repeat(43) + "=", fingerprint: fingerprint.repeat(64), host: "peer.example", port: 43_121 }); }

function confirmPeerAlert(): void {
  const actions = native.alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
  actions.find((action) => action.text === mobileMessage("en", "settings.voicePeers.confirm"))?.onPress?.();
}

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  native.alert.mockReset();
  vi.unstubAllGlobals();
});

function render(locale: MobileSupportedLocale, overrides: Partial<MobileVoiceDictionaryScreenProps> = {}) {
  const props: MobileVoiceDictionaryScreenProps = {
    colors,
    locale,
    state: voiceState(),
    dictionary: nodeDictionary(),
    onRefreshDictionary: vi.fn(async () => undefined),
    onSetSyncEnabled: vi.fn(async () => undefined),
    onBack: vi.fn(),
    onRetry: vi.fn(async () => undefined),
    onReset: vi.fn(async () => undefined),
    onSetInstructions: vi.fn(async () => undefined),
    onSetAutoLearning: vi.fn(async () => undefined),
    onAddTerm: vi.fn(async () => undefined),
    onEditEntry: vi.fn(async () => "updated" as const),
    onDeleteEntry: vi.fn(async () => undefined),
    ...overrides
  };
  act(() => root!.render(createElement(MobileVoiceDictionaryScreen, props)));
  return props;
}

function button(label: string): HTMLButtonElement {
  const value = Array.from(container.querySelectorAll("button")).find((entry) => entry.getAttribute("aria-label") === label);
  if (!(value instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return value;
}

function change(label: string, value: string): void {
  const input = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
    .find((entry) => entry.getAttribute("aria-label") === label);
  if (!input) throw new Error(`Missing input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("MobileVoiceDictionaryScreen", () => {
  it("connects the voice service settings section to full primary and fallback configuration and private context authorization", async () => {
    const settings = create(VoiceInputServiceSettingsSchema, { enabled: true, protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
      fallbackProtocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC, fallbackEnabled: true,
      endpoint: "wss://speech.example/api/v3/sauc/bigmodel_async", fallbackEndpoint: "wss://fallback.example/api/v3/sauc/bigmodel_async",
      resourceId: "primary-resource", fallbackResourceId: "fallback-resource", version: { revision: { value: 4n } },
      sauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY },
      fallbackSauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY } });
    const api: MobileVoiceSettingsTransport = { ownerKey: "voice-node-a", isCurrent: () => true,
      get: vi.fn(async () => settings), getCapabilities: vi.fn(async () => ({ support: "supported" as const, supportsLocale: true,
        supportsLiveDrafts: true, supportsRefinement: true, supportsRecognitionContext: true,
        recognitionContextMaximumItems: 20, recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192, supportedLocales: [],
        limits: { supportedMimeTypes: ["audio/pcm"], maximumAudioChunkBytes: 1024, maximumAudioBytes: 4096,
          maximumAudioChunkDurationMs: 1000, maximumAudioDurationMs: 10_000, maximumLocaleCharacters: 35, stableWaitMs: 500, maximumConcurrentSessions: 1 } })),
      save: vi.fn(async () => settings), test: vi.fn(async () => create(TestVoiceInputConnectionResponseSchema, { ok: true })),
      reconcile: vi.fn(async () => undefined), hasPending: () => false };
    const setContext = vi.fn(async () => undefined);
    await act(async () => { render("en", { serviceTransport: api, onSetRecognitionContext: setContext }); });
    act(() => { button("Primary · Streaming input").click(); button("Fallback · Bidirectional streaming").click(); });
    expect(Array.from(container.querySelectorAll("button")).map((entry) => entry.getAttribute("aria-label")).filter((label) => label?.startsWith("Primary")))
      .toContain("Primary · APP ID + Access Token");
    act(() => button("Primary · APP ID + Access Token").click());
    change("Primary · APP ID", "public-app"); change("Primary · Hotword table name", "word-table");
    change("Primary · Hotword table ID", "word-id"); change("Fallback · Replacement table ID", "replacement-id");
    change("Primary · APP ID + Access Token", "private-primary"); change("Fallback · API Key", "private-fallback");
    act(() => (container.querySelector('[aria-label="Primary · Send dictionary main terms as hotwords"]') as HTMLInputElement).click());
    await act(async () => button("Save configuration").click());
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: expect.objectContaining({ value: 4n }),
      endpoint: "wss://speech.example/api/v3/sauc/bigmodel_nostream", fallbackEndpoint: "wss://fallback.example/api/v3/sauc/bigmodel",
      sauc: expect.objectContaining({ mode: VoiceInputSaucMode.STREAM_INPUT, authentication: VoiceInputSaucAuthentication.ACCESS_TOKEN,
        appId: "public-app", useDictionaryHotwords: true, boostingTableName: "word-table", boostingTableId: "word-id" }),
      fallbackSauc: expect.objectContaining({ mode: VoiceInputSaucMode.BIDIRECTIONAL, correctTableId: "replacement-id" })
    }), { primary: "private-primary", fallback: "private-fallback" }, expect.any(AbortSignal));
    expect((container.querySelector('[aria-label="Primary · API Key"]') as HTMLInputElement).value).toBe("");
    await act(async () => button("Test saved connection").click()); expect(api.test).toHaveBeenCalledOnce();
    act(() => { (container.querySelector('[aria-label="Authorize sending these texts to the recognition service"]') as HTMLInputElement).click(); button("Add text").click(); });
    change("Recognition context 1", "private context\nsecond paragraph");
    await act(async () => button("Save private context").click());
    expect(setContext).toHaveBeenCalledWith(true, [{ text: "private context\nsecond paragraph" }]);
    expect(api.save).toHaveBeenCalledOnce();
    change("Primary · Endpoint", "wss://retained.example/api/v3/sauc/bigmodel_async");
    await act(async () => { render("en", { serviceTransport: undefined, onSetRecognitionContext: setContext }); });
    expect((container.querySelector('[aria-label="Primary · Endpoint"]') as HTMLInputElement).value).toBe("wss://retained.example/api/v3/sauc/bigmodel_async");
    expect((container.querySelector('[aria-label="Primary · Endpoint"]') as HTMLInputElement).disabled).toBe(true);
    await act(async () => { render("en", { serviceTransport: { ...api, ownerKey: "voice-node-b" }, onSetRecognitionContext: setContext }); });
    expect(button("Save configuration").disabled).toBe(true);
    expect(container.textContent).toContain("Review current revision");
    act(() => button("Review current revision").click());
    expect(button("Save configuration").disabled).toBe(false);
    vi.mocked(api.get).mockResolvedValue({ ...settings,
      version: { ...settings.version!, revision: { ...settings.version!.revision!, value: 5n } } });
    await act(async () => button("Refresh configuration").click());
    expect(button("Save configuration").disabled).toBe(true);
    expect((container.querySelector('[aria-label="Primary · Endpoint"]') as HTMLInputElement).value).toBe("wss://retained.example/api/v3/sauc/bigmodel_async");
    act(() => button("Review current revision").click());
    expect(button("Save configuration").disabled).toBe(false);
  });
  it("configures and exports a listener, confirms an exact direct invitation, clears its route and retires native confirmations", async () => {
    const peer = peerTransport();
    const updates = dictionaryWatchFixture<VoiceDictionaryPeerStatusView>();
    vi.mocked(peer.watchVoiceInputDictionaryPeerStatus).mockImplementation(updates.watch);
    await act(async () => { render("en", { peerTransport: peer }); });
    change(mobileMessage("en", "settings.voicePeers.listenPort"), "43121");
    change(mobileMessage("en", "settings.voicePeers.publicHost"), "peer.example");
    change(mobileMessage("en", "settings.voicePeers.publicPort"), "43121");
    const configured = { ...peerStatus(), configurationRevision: 4n, listener: { listenPort: 43_121, host: "peer.example", port: 43_121 } };
    vi.mocked(peer.configureVoiceInputDictionaryListener).mockResolvedValue(configured);
    await act(async () => button(mobileMessage("en", "settings.voicePeers.saveListener")).click());
    expect(peer.configureVoiceInputDictionaryListener).toHaveBeenCalledExactlyOnceWith(3n, configured.listener, expect.any(AbortSignal));
    await act(async () => button(mobileMessage("en", "settings.voicePeers.exportInvitation")).click());
    expect(container.querySelector(`[aria-label="${mobileMessage("en", "settings.voicePeers.invitation")}"]`)!.textContent).toBe(invitation("node-a", "a"));
    change(mobileMessage("en", "settings.voicePeers.pasteInvitation"), invitation());
    act(() => button(mobileMessage("en", "settings.voicePeers.previewInvitation")).click());
    expect(native.alert.mock.calls.at(-1)?.[1]).toContain(peerFingerprint);
    expect(native.alert.mock.calls.at(-1)?.[1]).toContain("peer.example:43121");
    const granted = { ...configured, configurationRevision: 5n, candidates: [], peers: [{ peerId: "node-b", revision: 5n,
      displayName: "Office", fingerprint: peerFingerprint, online: false, grantedAt: 1_000, route: { host: "peer.example", port: 43_121 } }] };
    vi.mocked(peer.grantVoiceInputDictionaryDirectPeer).mockResolvedValue(granted);
    await act(async () => confirmPeerAlert());
    expect(peer.grantVoiceInputDictionaryDirectPeer).toHaveBeenCalledExactlyOnceWith(4n, invitation(), peerFingerprint, expect.any(AbortSignal));
    expect(container.textContent).toContain(mobileMessage("en", "settings.voicePeers.offline"));
    const cleared = { ...granted, configurationRevision: 6n, peers: [{ ...granted.peers[0]!, route: undefined }] };
    vi.mocked(peer.clearVoiceInputDictionaryPeerRoute).mockResolvedValue(cleared);
    await act(async () => button(mobileMessage("en", "settings.voicePeers.clearRoute")).click());
    expect(peer.clearVoiceInputDictionaryPeerRoute).toHaveBeenCalledExactlyOnceWith(5n, "node-b", expect.any(AbortSignal));
    expect(peer.revokeVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    act(() => button(mobileMessage("en", "settings.voicePeers.previewInvitation")).click());
    await act(async () => updates.push({ ...cleared, configurationRevision: 7n }));
    await act(async () => confirmPeerAlert());
    expect(peer.grantVoiceInputDictionaryDirectPeer).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(mobileMessage("en", "settings.voicePeers.failed"));
    act(() => button(mobileMessage("en", "settings.voicePeers.previewInvitation")).click());
    await act(async () => render("en", { peerTransport: undefined }));
    await act(async () => render("en", { peerTransport: peer }));
    await act(async () => confirmPeerAlert());
    expect(peer.grantVoiceInputDictionaryDirectPeer).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain(mobileMessage("en", "settings.voicePeers.saved"));
  });
  it.each(["en", "zh-CN", "zh-TW", "ja", "ko"] as const)("renders node dictionary and private preferences in %s", (locale) => {
    render(locale);
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.title"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.privacy"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.entries"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.candidates"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.localActivity"));
    expect(container.textContent).toContain(mobileMessage(locale, "settings.voice.syncHint"));
    expect(button(mobileMessage(locale, "settings.voice.confirmCandidate", { term: "VoiceKit" }))).toBeTruthy();
  });

  it("keeps an edit draft across locale changes, previews a merge, reports the result, and restores input focus", async () => {
    const onEditEntry = vi.fn(async () => "mergedEntry" as const);
    render("en", { onEditEntry });
    act(() => button(mobileMessage("en", "settings.voice.edit", { term: "Variant" })).click());
    change(mobileMessage("en", "settings.voice.term"), "Canonical");
    expect(container.textContent).toContain(mobileMessage("en", "settings.voice.mergeEntry", { term: "Canonical" }));
    render("ja", { onEditEntry });
    expect((container.querySelector(`[aria-label="${mobileMessage("ja", "settings.voice.term")}"]`) as HTMLInputElement).value)
      .toBe("Canonical");
    await act(async () => button(mobileMessage("ja", "settings.voice.saveEntry")).click());
    expect(onEditEntry).toHaveBeenCalledWith("source", "Canonical", "variant old", 8n);
    expect(container.textContent).toContain(mobileMessage("ja", "settings.voice.merged"));
    expect(document.activeElement?.getAttribute("aria-label")).toBe(mobileMessage("ja", "settings.voice.term"));
  });

  it("keeps a conflicting editor draft and its frozen revision until the user explicitly reviews the latest version", async () => {
    const onEditEntry = vi.fn(async () => "updated" as const).mockRejectedValueOnce(new Error("revision conflict"));
    render("en", { onEditEntry });
    act(() => button(mobileMessage("en", "settings.voice.edit", { term: "Variant" })).click());
    change(mobileMessage("en", "settings.voice.term"), "Canonical");
    await act(async () => button(mobileMessage("en", "settings.voice.saveEntry")).click());
    render("en", { onEditEntry, dictionary: nodeDictionary(9n) });
    expect((container.querySelector(`[aria-label="${mobileMessage("en", "settings.voice.term")}"]`) as HTMLInputElement).value).toBe("Canonical");
    expect(container.textContent).toContain(mobileMessage("en", "settings.voice.conflict"));
    expect(onEditEntry).toHaveBeenCalledWith("source", "Canonical", "variant old", 8n);
    act(() => button(mobileMessage("en", "settings.voice.reviewLatest")).click());
    await act(async () => button(mobileMessage("en", "settings.voice.saveEntry")).click());
    expect(onEditEntry).toHaveBeenLastCalledWith("source", "Canonical", "variant old", 9n);
  });

  it("disables unavailable node edits while keeping private instructions editable", () => {
    render("en", { dictionary: { status: "unavailable", saving: false } });
    expect(container.textContent).toContain(mobileMessage("en", "settings.voice.nodeUnavailable"));
    expect((container.querySelector(`[aria-label="${mobileMessage("en", "settings.voice.instructions")}"]`) as HTMLInputElement).disabled).toBe(false);
    expect(button(mobileMessage("en", "settings.voice.addTerm")).disabled).toBe(true);
    expect((container.querySelector(`[aria-label="${mobileMessage("en", "settings.voice.sync")}"]`) as HTMLInputElement).disabled).toBe(true);
  });

  it("distinguishes failed private history from the node dictionary result", () => {
    render("en", { state: { ...voiceState(), error: "local disk unavailable" } });
    expect(container.textContent).toContain(mobileMessage("en", "settings.voice.localSaveError"));
    expect(container.textContent).not.toContain(mobileMessage("en", "settings.voice.saveError"));
  });

  it("offers retry and explicit reset recovery for a damaged strict-v1 record", async () => {
    const onRetry = vi.fn(async () => undefined);
    const onReset = vi.fn(async () => undefined);
    render("en", { state: voiceState("error"), onRetry, onReset });
    await act(async () => button(mobileMessage("en", "common.retry")).click());
    expect(onRetry).toHaveBeenCalledOnce();
    act(() => button(mobileMessage("en", "settings.voice.reset")).click());
    expect(native.alert).toHaveBeenCalledWith(
      mobileMessage("en", "settings.voice.resetTitle"),
      mobileMessage("en", "settings.voice.resetBody"),
      expect.any(Array)
    );
    const actions = native.alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
    act(() => actions.find((action) => action.text === mobileMessage("en", "settings.voice.reset"))?.onPress?.());
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("requires a native confirmation with the full fingerprint and never rebases its frozen revision on a live update", async () => {
    const peer = peerTransport();
    const updates = dictionaryWatchFixture<VoiceDictionaryPeerStatusView>();
    vi.mocked(peer.watchVoiceInputDictionaryPeerStatus).mockImplementation(updates.watch);
    await act(async () => { render("en", { peerTransport: peer }); });
    act(() => button(mobileMessage("en", "settings.voicePeers.allow")).click());
    expect(native.alert).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(peerFingerprint), expect.any(Array));
    expect(peer.grantVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    await act(async () => { updates.push({ ...peerStatus(), configurationRevision: 4n }); });
    await act(async () => { confirmPeerAlert(); });
    expect(peer.grantVoiceInputDictionaryPeer).toHaveBeenCalledExactlyOnceWith(3n, "node-b", peerFingerprint, expect.any(AbortSignal));
    expect(container.textContent).toContain(mobileMessage("en", "settings.voicePeers.saved"));
  });

  it("does not revive a native alert after backgrounding and returning to the same node", async () => {
    const peer = peerTransport();
    await act(async () => { render("en", { peerTransport: peer }); });
    act(() => button(mobileMessage("en", "settings.voicePeers.allow")).click());
    await act(async () => { render("en", { peerTransport: undefined }); });
    await act(async () => { render("en", { peerTransport: peer }); });
    await act(async () => { confirmPeerAlert(); });
    expect(peer.grantVoiceInputDictionaryPeer).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(mobileMessage("en", "settings.voicePeers.saved"));
  });

  it("allows revocation while sharing is off and forbids authorizing a changed key", async () => {
    const peer = peerTransport();
    const value = { ...peerStatus(), enabled: false, phase: "off" as const,
      peers: [{ peerId: "node-b", revision: 2n, displayName: "Office", fingerprint: peerFingerprint, online: false, grantedAt: 100 }],
      candidates: [{ ...peerStatus().candidates[0]!, fingerprint: "c".repeat(64), keyChanged: true }] };
    vi.mocked(peer.getVoiceInputDictionaryPeerStatus).mockResolvedValue(value);
    await act(async () => { render("en", { peerTransport: peer }); });
    expect(button(mobileMessage("en", "settings.voicePeers.syncNow")).disabled).toBe(true);
    expect(button(mobileMessage("en", "settings.voicePeers.allow")).disabled).toBe(true);
    expect(container.textContent).toContain(mobileMessage("en", "settings.voicePeers.keyChanged"));
    act(() => button(mobileMessage("en", "settings.voicePeers.revoke")).click());
    expect(native.alert.mock.calls.at(-1)?.[1]).toContain(peerFingerprint);
    await act(async () => { confirmPeerAlert(); });
    expect(peer.revokeVoiceInputDictionaryPeer).toHaveBeenCalledExactlyOnceWith("node-b", 2n, expect.any(AbortSignal));
  });
});
