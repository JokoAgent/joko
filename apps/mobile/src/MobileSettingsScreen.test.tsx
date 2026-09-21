// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionSchema,
  ConnectionState,
  DeviceKind,
  DevicePresenceState,
  DeviceSchema,
  SnapshotSchema
} from "@joko/contracts";
import { emptyMobileAutomationsState } from "./mobile-automation";
import type { MobileState, SavedMobileConnection } from "./mobile-client";
import { emptyMobileFilesState } from "./workspace-files";
import {
  MobileSettingsScreen,
  resolveMobileSettingsCurrentDevice,
  type MobileSettingsClient,
  type MobileSettingsColors
} from "./MobileSettingsScreen";
import type { MobileThemePreferenceState } from "./mobile-theme-preference";
import type { MobileDiagnosticsState } from "./mobile-diagnostics";
import type { MobileLocalePreferenceState } from "./mobile-locale-preference";
import { EMPTY_MOBILE_VOICE_DICTIONARY } from "./mobile-voice-dictionary";
import type { MobileVoiceDictionaryStoreState } from "./mobile-voice-dictionary-store";
import type { MobileUpdateControllerState } from "./mobile-update-controller";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  alert: vi.fn(),
  copied: vi.fn(async (_value: string) => undefined),
  hardwareBack: undefined as (() => boolean) | undefined
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState, onPress, disabled,
    selectable: _selectable, contentContainerStyle: _contentContainerStyle, keyboardShouldPersistTaps: _keyboardShouldPersistTaps,
    accessibilityLiveRegion: _accessibilityLiveRegion, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean; expanded?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      selectable?: boolean;
      contentContainerStyle?: unknown;
      keyboardShouldPersistTaps?: unknown;
      accessibilityLiveRegion?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.selected === undefined ? {} : { "aria-checked": accessibilityState.selected }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    Alert: { alert: native.alert },
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
      native.hardwareBack = handler;
      return { remove: () => { if (native.hardwareBack === handler) native.hardwareBack = undefined; } };
    } },
    Platform: { OS: "android" },
    Pressable: element("button"),
    ScrollView: element("div"),
    Switch: ({ accessibilityLabel, value, onValueChange, disabled }: {
      accessibilityLabel?: string;
      value?: boolean;
      onValueChange?: (value: boolean) => void;
      disabled?: boolean;
    }) => React.createElement("input", {
      type: "checkbox",
      "aria-label": accessibilityLabel,
      checked: value,
      disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onValueChange?.(event.currentTarget.checked)
    }),
    StyleSheet: { create: <T,>(value: T) => value },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, value, onChangeText, editable = true, ...props }: {
      accessibilityLabel?: string;
      value?: string;
      onChangeText?: (value: string) => void;
      editable?: boolean;
    }) => React.createElement("input", {
      ...props,
      "aria-label": accessibilityLabel,
      value,
      disabled: !editable,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
      style: undefined
    }),
    View: element("div")
  };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: native.copied }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0-test" } } }));

const colors: MobileSettingsColors = {
  background: "#fafafa",
  surface: "#fff",
  ink: "#111",
  muted: "#666",
  border: "#ddd",
  accent: "#f90",
  negative: "#b00",
  brandBackground: "#fff0d0"
};

const profile: SavedMobileConnection = {
  profileId: "profile-current",
  origin: "http://192.168.1.20:4318",
  serverId: "node-current",
  connectionId: "connection-current",
  deviceId: "device-current",
  displayName: "Field phone",
  automatic: false,
  credentialState: "available",
  pendingOperations: []
};

const connection = create(ConnectionSchema, {
  connectionId: profile.connectionId,
  connectionProfileId: profile.profileId,
  deviceId: profile.deviceId,
  state: ConnectionState.CONNECTED,
  version: { revision: { value: 4n } }
});

const device = create(DeviceSchema, {
  deviceId: profile.deviceId,
  displayName: "Field phone",
  kind: DeviceKind.MOBILE,
  platform: "android",
  appVersion: "0.1.0",
  connectionIds: [profile.connectionId],
  presence: DevicePresenceState.ONLINE,
  version: { revision: { value: 5n } }
});

function mobileState(patch: Partial<MobileState> = {}): MobileState {
  return {
    status: "connected",
    busy: false,
    node: {
      serverId: profile.serverId,
      displayName: "Joko studio",
      version: "1.4.0",
      apiVersion: "joko.v1",
      health: 1,
      pairingEnabled: true
    },
    origin: profile.origin,
    saved: [profile],
    activeProfileId: profile.profileId,
    connectionMode: "saved",
    discoveryState: "idle",
    nearby: [],
    owner: create(SnapshotSchema, {
      snapshotId: "owner-current",
      generation: 1n,
      server: {
        serverId: profile.serverId,
        displayName: "Joko studio",
        version: "1.4.0",
        apiVersion: "joko.v1",
        health: 1,
        pairingEnabled: true
      },
      connections: [connection],
      devices: [device]
    }),
    older: [],
    live: [],
    liveStatus: "streaming",
    historyBusy: false,
    historyEnd: false,
    pending: [],
    homeSearchQuery: "",
    homeSearchFilter: "active",
    homeSearchStatus: "idle",
    homeSearchSessionIds: [],
    files: emptyMobileFilesState(),
    automations: emptyMobileAutomationsState(),
    ...patch
  };
}

function mobileClient(patch: Partial<MobileSettingsClient> = {}): MobileSettingsClient {
  return {
    renameCurrentDevice: vi.fn(async () => true),
    reconcile: vi.fn(async () => undefined),
    dismissUnconfirmed: vi.fn(async () => undefined),
    ...patch
  };
}

const readyTheme: MobileThemePreferenceState = { status: "ready", preference: "system", saving: false };
const readyLocale: MobileLocalePreferenceState = {
  status: "ready",
  preference: "system",
  effectiveLocale: "en",
  saving: false
};
const readyDiagnostics: MobileDiagnosticsState = {
  status: "ready",
  enabled: false,
  saving: false,
  exporting: false,
  eventCount: 0
};
const readyVoiceDictionary: MobileVoiceDictionaryStoreState = {
  status: "ready",
  saving: false,
  document: {
    version: 1,
    revision: 0,
    dictionaryRevision: 0,
    refinementInstructions: "",
    autoLearningEnabled: true,
    dictionary: EMPTY_MOBILE_VOICE_DICTIONARY,
    usage: { voiceStarts: 0, correctionObservations: 0, lastVoiceStartedAt: null, lastCorrectionAt: null },
    history: []
  }
};
const readyUpdates: MobileUpdateControllerState = {
  status: "ready",
  startup: "ready",
  channel: "stable",
  betaEnabled: true,
  channelSaving: false,
  manualPhase: "idle",
  pendingRestart: false,
  running: {
    appVersion: "0.1.0",
    runtimeVersion: "runtime-test",
    updateId: "12345678-aaaa-bbbb-cccc-123456789abc",
    channel: "stable",
    createdAt: new Date(2026, 8, 21, 9, 30),
    isEnabled: true,
    isEmbeddedLaunch: false,
    isEmergencyLaunch: false
  },
  forcedChecking: false,
  forcedCheckFailed: false,
  authorityAvailable: true
};

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  native.alert.mockReset();
  native.copied.mockClear();
  native.hardwareBack = undefined;
});

function mount(options: {
  state?: MobileState;
  foreground?: boolean;
  theme?: MobileThemePreferenceState;
  locale?: MobileLocalePreferenceState;
  diagnostics?: MobileDiagnosticsState;
  voiceDictionary?: MobileVoiceDictionaryStoreState;
  updates?: MobileUpdateControllerState;
  client?: MobileSettingsClient;
} = {}) {
  const container = document.createElement("div");
  const client = options.client ?? mobileClient();
  const onThemeChange = vi.fn(async () => undefined);
  const onLocaleChange = vi.fn(async () => undefined);
  const onDiagnosticsEnabledChange = vi.fn(async (_enabled: boolean) => undefined);
  const onDiagnosticsClear = vi.fn(async () => undefined);
  const onDiagnosticsExport = vi.fn(async () => undefined);
  const onChannelChange = vi.fn(async () => undefined);
  const onCheck = vi.fn(async () => undefined);
  const onReset = vi.fn(async () => undefined);
  const onBack = vi.fn();
  const onConnections = vi.fn();
  const onDevices = vi.fn();
  let state = options.state ?? mobileState();
  let foreground = options.foreground ?? true;
  let theme = options.theme ?? readyTheme;
  let locale = options.locale ?? readyLocale;
  let diagnostics = options.diagnostics ?? readyDiagnostics;
  let voiceDictionary = options.voiceDictionary ?? readyVoiceDictionary;
  let updates = options.updates ?? readyUpdates;
  const render = () => createElement(MobileSettingsScreen, {
    colors,
    state,
    foreground,
    theme,
    locale,
    diagnostics,
    voiceDictionary,
    updates,
    updateActions: { onChannelChange, onCheck, onReset },
    client,
    onThemeChange,
    onLocaleChange,
    onDiagnosticsEnabledChange,
    onDiagnosticsClear,
    onDiagnosticsExport,
    onVoiceDictionaryRetry: vi.fn(async () => undefined),
    onVoiceDictionaryReset: vi.fn(async () => undefined),
    onVoiceInstructionsChange: vi.fn(async () => undefined),
    onVoiceAutoLearningChange: vi.fn(async () => undefined),
    onVoiceDictionaryAdd: vi.fn(async () => undefined),
    onVoiceDictionaryEdit: vi.fn(async () => "updated" as const),
    onVoiceDictionaryDelete: vi.fn(async () => undefined),
    onBack,
    onConnections,
    onDevices,
    appVersion: "0.1.0-test"
  });
  root = createRoot(container);
  act(() => root!.render(render()));
  return {
    container,
    client,
    onThemeChange,
    onLocaleChange,
    onDiagnosticsEnabledChange,
    onDiagnosticsClear,
    onDiagnosticsExport,
    onChannelChange,
    onCheck,
    onReset,
    onBack,
    onConnections,
    onDevices,
    rerender: (next: { state?: MobileState; foreground?: boolean; theme?: MobileThemePreferenceState;
      locale?: MobileLocalePreferenceState;
      diagnostics?: MobileDiagnosticsState; voiceDictionary?: MobileVoiceDictionaryStoreState;
      updates?: MobileUpdateControllerState }) => {
      state = next.state ?? state;
      foreground = next.foreground ?? foreground;
      theme = next.theme ?? theme;
      locale = next.locale ?? locale;
      diagnostics = next.diagnostics ?? diagnostics;
      voiceDictionary = next.voiceDictionary ?? voiceDictionary;
      updates = next.updates ?? updates;
      act(() => root!.render(render()));
    }
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = container.querySelector(`button[aria-label="${label}"]`);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return match;
}

function input(container: HTMLElement, label: string): HTMLInputElement {
  const match = container.querySelector(`input[aria-label="${label}"]`);
  if (!(match instanceof HTMLInputElement)) throw new Error(`Missing input ${label}`);
  return match;
}

function changeInput(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("MobileSettingsScreen", () => {
  it("renders exact node/device/about identity, changes theme, copies ID, and navigates", async () => {
    const mounted = mount();

    expect(mounted.container.textContent).toContain("Joko studio");
    expect(mounted.container.textContent).toContain("Field phone");
    expect(mounted.container.textContent).toContain(profile.deviceId);
    expect(mounted.container.textContent).toContain("1.4.0");
    expect(mounted.container.textContent).toContain("joko.v1");
    expect(mounted.container.textContent).toContain("0.1.0-test");

    act(() => button(mounted.container, "Voice input").click());
    expect(mounted.container.textContent).toContain("These instructions, entries, correction evidence");
    act(() => button(mounted.container, "Back to Voice input").click());
    expect(mounted.container.textContent).toContain("Settings");

    await act(async () => button(mounted.container, "Dark appearance").click());
    expect(mounted.onThemeChange).toHaveBeenCalledWith("dark");
    act(() => button(mounted.container, "Connection settings").click());
    act(() => button(mounted.container, "All devices").click());
    act(() => button(mounted.container, "Back to Joko").click());
    expect(mounted.onConnections).toHaveBeenCalledTimes(1);
    expect(mounted.onDevices).toHaveBeenCalledTimes(1);
    expect(mounted.onBack).toHaveBeenCalledTimes(1);

    await act(async () => button(mounted.container, "Copy device ID").click());
    expect(native.copied).toHaveBeenCalledWith(profile.deviceId);
    expect(mounted.container.textContent).toContain("Device ID copied.");
  });

  it("offers every supported language, publishes a selection, and rerenders the mounted surface", async () => {
    const mounted = mount();
    const languageLabels = ["System", "English", "简体中文", "繁體中文", "日本語", "한국어"];
    for (const label of languageLabels) expect(button(mounted.container, label)).not.toBeNull();

    await act(async () => button(mounted.container, "日本語").click());
    expect(mounted.onLocaleChange).toHaveBeenCalledWith("ja");

    mounted.rerender({ locale: { status: "ready", preference: "ja", effectiveLocale: "ja", saving: false } });
    expect(mounted.container.textContent).toContain("設定");
    expect(mounted.container.textContent).toContain("言語");
    expect(mounted.container.textContent).toContain("ローカル診断");
    expect(button(mounted.container, "日本語").getAttribute("aria-checked")).toBe("true");

    mounted.rerender({ locale: { status: "ready", preference: "ja", effectiveLocale: "ja", saving: true } });
    for (const label of ["システム", "English", "简体中文", "繁體中文", "日本語", "한국어"]) {
      expect(button(mounted.container, label).disabled).toBe(true);
    }
  });

  it("mounts current update identity and routes channel and manual checks through the update owner", async () => {
    const mounted = mount();
    expect(mounted.container.textContent).toContain("Updates");
    expect(mounted.container.textContent).toContain("runtime-test");
    expect(mounted.container.textContent).toContain("12345678");
    await act(async () => button(mounted.container, "Beta").click());
    await act(async () => button(mounted.container, "Check for updates").click());
    expect(mounted.onChannelChange).toHaveBeenCalledWith("beta");
    expect(mounted.onCheck).toHaveBeenCalledOnce();

    mounted.rerender({ updates: { ...readyUpdates, manualOutcome: "up-to-date" } });
    expect(mounted.container.textContent).toContain("Joko is up to date.");
  });

  it("keeps offline and background identity visible while device mutations and receipts are read-only", () => {
    const pending = {
      operationId: "operation-rename",
      connectionId: profile.connectionId,
      kind: "device-rename" as const,
      targetDeviceId: profile.deviceId,
      state: "unknown" as const
    };
    const mounted = mount({ state: mobileState({ status: "offline", pending: [pending], offlineSnapshotAt: 1_000 }) });

    expect(mounted.container.textContent).toContain("Showing the last verified device identity");
    expect(button(mounted.container, "Rename this phone").disabled).toBe(true);
    expect(button(mounted.container, "Check status").disabled).toBe(true);
    expect(button(mounted.container, "Verify and clear").disabled).toBe(true);

    mounted.rerender({ state: mobileState(), foreground: false });
    expect(mounted.container.textContent).toContain("Background · read-only");
    expect(button(mounted.container, "Rename this phone").disabled).toBe(true);
  });

  it("keeps privacy-bounded local diagnostics folded and confirms toggle, export, and clear actions", async () => {
    const mounted = mount();
    expect(mounted.container.textContent).not.toContain("Message text, files, paths");

    act(() => button(mounted.container, "Local diagnostics").click());
    expect(mounted.container.textContent).toContain("Message text, files, paths, IDs, credentials, raw errors, audio, and transcripts are never included.");

    await act(async () => input(mounted.container, "Record local diagnostics").click());
    expect(mounted.onDiagnosticsEnabledChange).toHaveBeenCalledWith(true);
    await act(async () => button(mounted.container, "Export diagnostics").click());
    expect(mounted.onDiagnosticsExport).toHaveBeenCalledOnce();

    mounted.rerender({ diagnostics: { ...readyDiagnostics, enabled: true, eventCount: 2 } });
    act(() => button(mounted.container, "Clear diagnostics").click());
    expect(native.alert).toHaveBeenCalledWith(
      "Clear local diagnostics?",
      expect.stringContaining("permanently removes"),
      expect.any(Array)
    );
    const actions = native.alert.mock.calls.at(-1)?.[2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => actions.find((action) => action.text === "Clear")?.onPress?.());
    expect(mounted.onDiagnosticsClear).toHaveBeenCalledOnce();
    expect(mounted.container.textContent).toContain("Local diagnostics cleared.");
    expect(mounted.container.textContent).not.toContain("Upload diagnostics");
  });

  it("protects a dirty rename draft and blocks closing or duplicate saves while one request is in flight", async () => {
    const flight = deferred<boolean>();
    const client = mobileClient({ renameCurrentDevice: vi.fn(() => flight.promise) });
    const mounted = mount({ client });
    act(() => button(mounted.container, "Rename this phone").click());
    act(() => changeInput(input(mounted.container, "Device name"), "  Field phone two  "));

    act(() => button(mounted.container, "Back to Settings").click());
    expect(native.alert).toHaveBeenCalledWith(
      "Discard device name changes?",
      expect.stringContaining("not been saved"),
      expect.any(Array)
    );
    expect(input(mounted.container, "Device name").value).toBe("  Field phone two  ");

    await act(async () => button(mounted.container, "Save name").click());
    expect(client.renameCurrentDevice).toHaveBeenCalledWith(profile.deviceId, "Field phone two");
    expect(client.renameCurrentDevice).toHaveBeenCalledTimes(1);
    expect(button(mounted.container, "Back to Settings").disabled).toBe(true);
    expect(input(mounted.container, "Device name").disabled).toBe(true);
    expect(native.hardwareBack?.()).toBe(true);
    expect(client.renameCurrentDevice).toHaveBeenCalledTimes(1);

    await act(async () => flight.resolve(true));
    expect(mounted.container.textContent).toContain("Device name saved.");
    expect(mounted.container.querySelector('input[aria-label="Device name"]')).toBeNull();
  });

  it("retains the draft for an unknown result without replay and retires it when ownership changes", async () => {
    const client = mobileClient({ renameCurrentDevice: vi.fn(async () => false) });
    const mounted = mount({ client });
    act(() => button(mounted.container, "Rename this phone").click());
    act(() => changeInput(input(mounted.container, "Device name"), "Private phone"));
    await act(async () => button(mounted.container, "Save name").click());

    expect(mounted.container.textContent).toContain("operation receipt was retained");
    expect(input(mounted.container, "Device name").value).toBe("Private phone");
    expect(button(mounted.container, "Save name").disabled).toBe(true);
    act(() => button(mounted.container, "Save name").click());
    expect(client.renameCurrentDevice).toHaveBeenCalledTimes(1);

    mounted.rerender({ state: mobileState({ activeProfileId: "another-profile" }) });
    expect(mounted.container.querySelector('input[aria-label="Device name"]')).toBeNull();
    expect(mounted.container.textContent).toContain("unfinished device-name draft was retired");
    expect(client.renameCurrentDevice).toHaveBeenCalledTimes(1);
  });

  it("requires one exact active profile, connection, and current mobile device", () => {
    expect(resolveMobileSettingsCurrentDevice(mobileState())?.device.deviceId).toBe(profile.deviceId);
    expect(resolveMobileSettingsCurrentDevice(mobileState({ saved: [profile, profile] }))).toBeUndefined();
    expect(resolveMobileSettingsCurrentDevice(mobileState({ owner: create(SnapshotSchema, {
      server: { serverId: profile.serverId, apiVersion: "joko.v1" },
      connections: [connection],
      devices: [create(DeviceSchema, { ...device, kind: DeviceKind.DESKTOP })]
    }) }))).toBeUndefined();
    expect(resolveMobileSettingsCurrentDevice(mobileState({ node: {
      ...mobileState().node!, serverId: "different-node"
    } }))).toBeUndefined();

    const withoutRevision = mobileState({ owner: create(SnapshotSchema, {
      server: { serverId: profile.serverId, apiVersion: "joko.v1" },
      connections: [connection],
      devices: [create(DeviceSchema, { ...device, version: undefined })]
    }) });
    const mounted = mount({ state: withoutRevision });
    expect(button(mounted.container, "Rename this phone").disabled).toBe(true);
  });
});
