// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { AuthenticationState, BackendDescriptorSchema, CapabilitySupport, ModelFavoriteSettingsSchema, ModelSourceDescriptorSchema, ModelSourceKind, PermissionMode,
  ProviderAccountUsageSnapshotSchema, ProviderDescriptorSchema, SessionSchema, capabilityNames, type ProviderAccountUsageSnapshot } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileRuntimeControls } from "./mobile-runtime-controls";
import type { MobileProviderUsageTransport } from "./mobile-account-usage";

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = React.createElement;
  const primitive = (tag: "div" | "span") => ({ children }: { readonly children?: ReactNode }) => element(tag, {}, children);
  const ScrollView = React.forwardRef((_props: {
    readonly children?: ReactNode;
    readonly onScroll?: (event: { readonly nativeEvent: { readonly contentOffset: { readonly y: number } } }) => void;
  }, ref) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: () => undefined }));
    return element("div", { "data-scroll-view": "true" }, _props.children);
  });
  return {
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
    Modal: ({ visible, children }: { readonly visible: boolean; readonly children?: ReactNode }) =>
      visible ? element("div", { role: "dialog" }, children) : null,
    Platform: { OS: "web" },
    Pressable: ({ accessibilityLabel, accessibilityRole, accessibilityState, disabled, onPress, children }: {
      readonly accessibilityLabel?: string;
      readonly accessibilityRole?: string;
      readonly accessibilityState?: { readonly selected?: boolean };
      readonly disabled?: boolean;
      readonly onPress?: () => void;
      readonly children?: ReactNode;
    }) => element("button", {
      "aria-label": accessibilityLabel,
      "aria-checked": accessibilityState?.selected,
      role: accessibilityRole,
      disabled,
      onClick: onPress
    }, children),
    ScrollView,
    StyleSheet: { create: (styles: unknown) => styles },
    Switch: ({ accessibilityLabel, disabled, value, onValueChange }: {
      readonly accessibilityLabel?: string;
      readonly disabled?: boolean;
      readonly value: boolean;
      readonly onValueChange: (value: boolean) => void;
    }) => element("input", { "aria-label": accessibilityLabel, type: "checkbox", checked: value, disabled,
      onChange: (event: { readonly currentTarget: { readonly checked: boolean } }) => onValueChange(event.currentTarget.checked) }),
    Text: primitive("span"),
    TextInput: ({ accessibilityLabel, editable, onChangeText, value }: {
      readonly accessibilityLabel?: string;
      readonly editable?: boolean;
      readonly onChangeText: (value: string) => void;
      readonly value: string;
    }) => element("input", { "aria-label": accessibilityLabel, disabled: editable === false, value,
      onInput: (event: { readonly currentTarget: { readonly value: string } }) => onChangeText(event.currentTarget.value),
      onChange: () => undefined }),
    View: primitive("div")
  };
});

vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return {
    SafeAreaView: React.forwardRef(({ children }: { readonly children?: ReactNode }, _ref) =>
      React.createElement("div", {}, children)),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
  };
});

vi.mock("./MobileKeyboardAvoidingView", async () => {
  const React = await import("react");
  return {
    MobileKeyboardAvoidingView: ({ children }: { readonly children?: ReactNode }) => React.createElement("div", {}, children),
    useMobileKeyboardState: () => ({ height: 0, visible: false })
  };
});

import { MobileRuntimeControlsSheet } from "./MobileRuntimeControlsSheet";
import { MobileNewTaskModelSelector } from "./MobileNewTaskModelSelector";

const colors = {
  background: "#fff",
  surface: "#fafafa",
  ink: "#111",
  muted: "#666",
  border: "#ccc",
  accent: "#ff9800",
  negative: "#b00",
  brandBackground: "#fff4df"
};

const controls: MobileRuntimeControls = {
  authorityKey: "authority-one",
  surfaceOwnerKey: "owner-one",
  session: create(SessionSchema, {
    sessionId: "session-one",
    backendId: "backend",
    targetId: "target",
    permissionMode: PermissionMode.ASK
  }),
  backend: create(BackendDescriptorSchema, { backendId: "backend", displayName: "Backend" }),
  models: [{
    key: "alpha/a",
    backendId: "backend",
    providerId: "alpha",
    providerName: "Alpha Provider",
    modelId: "a",
    displayName: "Alpha Model",
    family: "alpha",
    contextWindowTokens: 128_000n,
    maximumOutputTokens: 16_000n,
    efforts: [
      { id: "low", label: "Low", order: 0, default: true },
      { id: "high", label: "High", order: 1, default: false }
    ],
    supportsFastMode: true
  }],
  currentModel: {
    providerId: "alpha",
    providerName: "Alpha Provider",
    modelId: "a",
    displayName: "Alpha Model",
    effortId: "low",
    fastMode: false,
    selectable: true
  },
  canListModels: true,
  canSwitchModel: true,
  canSetEffort: true,
  canSetFastMode: true,
  permissionModes: [PermissionMode.ASK],
  canSetPermission: false,
  canSetPlanMode: false,
  favorites: [{
    favoriteId: "favorite-alpha",
    backendId: "backend",
    providerId: "alpha",
    modelId: "a",
    effortId: "low",
    fastMode: false
  }],
  favoriteRevision: 4n,
  favoritesSeeded: true
};

let host: HTMLDivElement;
let root: Root;
const close = vi.fn();
const setModel = vi.fn(async () => true);
const mutateFavorite = vi.fn(async () => true);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  close.mockReset();
  setModel.mockClear();
  mutateFavorite.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function render(value: MobileRuntimeControls = controls, transport?: MobileProviderUsageTransport, visible = true): Promise<void> {
  await act(async () => root.render(createElement(MobileRuntimeControlsSheet, {
    visible,
    providerUsageTransport: transport,
    controls: value,
    busy: false,
    colors,
    locale: "en",
    onClose: close,
    onSetModel: setModel,
    onMutateFavorite: mutateFavorite,
    newFavoriteId: () => "favorite-new",
    onSetPermission: async () => true,
    onSetPlanMode: async () => true,
    onError: vi.fn()
  })));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  expect(found, label).toBeDefined();
  return found!;
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click());
}

async function clickText(text: string): Promise<void> {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.startsWith(text));
  expect(found, text).toBeDefined();
  await act(async () => found!.click());
}

describe("MobileRuntimeControlsSheet model favorites", () => {
  it("shows reported capacity separately from the estimated working window in the actual model editor", async () => {
    await render({ ...controls, models: controls.models.map(route => ({ ...route, contextWindowMaxTokens: 1_000_000n, contextWindowSource: "estimated" })) });
    await click("Alpha Model, Saved favorite");
    expect(host.textContent).toContain("128K context");
    expect(host.textContent).toContain("Estimated working window");
    expect(host.textContent).toContain("Maximum capacity: 1M context");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("applies the exact new-task source configuration and keeps the selector available after a failed save", async () => {
    const route = { ...controls.models[0]!, backendId: "opaque-device", key: "other-source-model", canSetEffort: true, canSetFastMode: true };
    const select = vi.fn(async () => { throw new Error("Source changed"); });
    await act(async () => root.render(createElement(MobileNewTaskModelSelector, { models: [route], colors, locale: "en", disabled: false,
      favorites: undefined, onSelect: select, onFavorite: async () => undefined })));
    await click("Model"); await click("Alpha Model, Alpha Provider"); await clickText("High");
    await clickText("Apply model");
    expect(select).toHaveBeenCalledExactlyOnceWith({ backendId: "opaque-device", providerId: "alpha", modelId: "a", effortId: "high", fastMode: false });
    expect(host.textContent).toContain("Source changed"); expect(host.querySelector('input[aria-label="Search task models"]')).not.toBeNull();
  });
  it.each(["new task", "existing task"] as const)("shows only the owning Codex weekly quota on %s model rows and favorites", async surface => {
    vi.useFakeTimers();
    const now = Date.now();
    const seconds = BigInt(Math.floor(now / 1000));
    const route = { ...controls.models[0]!, modelId: "gpt-5.3-codex-spark", displayName: "Spark", source: create(ModelSourceDescriptorSchema,
      { kind: ModelSourceKind.LOCAL, nativeAdapterKind: "codex", displayName: "Codex account" }) };
    const models = [route,
      { ...route, key: "other-model", modelId: "unmatched", displayName: "Unmatched" },
      { ...route, key: "other-runtime", displayName: "Other runtime", source: { ...route.source, nativeAdapterKind: "pi" } },
      { ...route, key: "group-route", displayName: "Group", source: { ...route.source, kind: ModelSourceKind.GROUP } },
      { ...route, key: "other-owner", backendId: "other-backend", displayName: "Other Backend" }
    ];
    const provider = create(ProviderDescriptorSchema, { backendId: route.backendId, providerId: route.providerId,
      authenticationState: AuthenticationState.AUTHENTICATED, version: { generation: 0n, revision: { value: 1n } },
      capabilities: { schemaVersion: "joko.provider.v1", capabilities: [{ name: capabilityNames.providerAccountUsage, support: CapabilitySupport.SUPPORTED }] } });
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { providerId: route.providerId, observedAt: { seconds }, buckets: [
      { id: "codex", secondaryWindow: { usedPercent: 20, windowMinutes: 10_080, resetAt: { seconds: seconds + 604_815n } } },
      { id: "spark-bucket", displayName: "GPT-5.3-Codex-Spark", secondaryWindow: { usedPercent: 90, windowMinutes: 10_080,
        resetAt: { seconds: seconds + 20n } } }
    ] });
    const read = vi.fn<MobileProviderUsageTransport["read"]>().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("Read failed"));
    const transport = { ownerKey: "codex-owner", providers: [provider], read };
    if (surface === "new task") {
      await act(async () => root.render(createElement(MobileNewTaskModelSelector, { models, colors, locale: "en", disabled: false,
        providerUsageTransport: transport, favorites: create(ModelFavoriteSettingsSchema, { favorites: [{ favoriteId: "spark-favorite",
          backendId: route.backendId, selection: { model: { providerId: route.providerId, modelId: route.modelId } } }] }),
        onSelect: async () => undefined, onFavorite: async () => undefined })));
      expect(read).not.toHaveBeenCalled();
      await click("Model");
    } else {
      await render({ ...controls, models, favorites: [{ ...controls.favorites[0]!, modelId: route.modelId }] }, transport);
    }
    expect(read).toHaveBeenCalledExactlyOnceWith(route.backendId, route.providerId, expect.any(AbortSignal));
    const row = (prefix: string) => host.querySelector<HTMLButtonElement>(`button[aria-label^="${prefix},"]`);
    for (const prefix of ["Other runtime", "Group", "Other Backend"]) {
      expect(row(prefix)).not.toBeNull();
      expect(row(prefix)?.textContent).not.toContain("remaining");
    }
    const spark = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Spark,"]'));
    expect(spark).toHaveLength(2);
    for (const item of spark) {
      expect(item.textContent).toContain("10% remaining · Resets in 20s");
      expect(item.getAttribute("aria-label")).toContain("10% remaining · Resets in 20s");
    }
    expect(row("Unmatched")?.textContent).toContain("80% remaining · Resets in 7d");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    for (const item of spark) expect(item.textContent).not.toContain("remaining");
    expect(row("Unmatched")?.textContent).toContain("Last known account limits · 80% remaining");
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("keeps a same-owner observation marked stale when the visible quota refresh fails", async () => {
    vi.useFakeTimers();
    const provider = create(ProviderDescriptorSchema, { backendId: "backend", providerId: "alpha", displayName: "Alpha",
      authenticationState: AuthenticationState.AUTHENTICATED, version: { generation: 0n, revision: { value: 1n } },
      capabilities: { schemaVersion: "joko.provider.v1", capabilities: [{ name: capabilityNames.providerAccountUsage, support: CapabilitySupport.SUPPORTED }] } });
    const snapshot = create(ProviderAccountUsageSnapshotSchema, { providerId: "alpha", primaryWindow: { usedPercent: 25 },
      observedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)) } });
    const read = vi.fn<MobileProviderUsageTransport["read"]>().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("Temporary connection failure"));
    await render(controls, { ownerKey: "same-owner", providers: [provider], read });
    expect(host.textContent).toContain("75% remaining");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("75% remaining");
    expect(host.textContent).toContain("Last known account limits");
    expect(host.textContent).toContain("Observed");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("reads catalog account limits only while visible and discards a late response from a retired owner", async () => {
    const provider = create(ProviderDescriptorSchema, { backendId: "backend", providerId: "alpha", displayName: "Alpha",
      authenticationState: AuthenticationState.AUTHENTICATED, version: { generation: 0n, revision: { value: 1n } },
      capabilities: { schemaVersion: "joko.provider.v1", capabilities: [{ name: capabilityNames.providerAccountUsage, support: CapabilitySupport.SUPPORTED }] } });
    let release!: (value: ProviderAccountUsageSnapshot) => void;
    const read = vi.fn((_backendId: string, _providerId: string, _signal: AbortSignal) => new Promise<ProviderAccountUsageSnapshot>(resolve => { release = resolve; }));
    const transport: MobileProviderUsageTransport = { ownerKey: "account-owner-one", providers: [provider], read };
    await render(controls, transport, false);
    expect(read).not.toHaveBeenCalled();
    await render(controls, transport);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("backend", "alpha", expect.any(AbortSignal));
    const replacement = { ...transport, ownerKey: "account-owner-two", read: vi.fn(async () => create(ProviderAccountUsageSnapshotSchema, {
      providerId: "alpha", primaryWindow: { usedPercent: 25 }, observedAt: { seconds: BigInt(Math.floor(Date.now() / 1000)) },
      modelWindows: [{ modelId: "a", displayName: "Alpha Model", window: { usedPercent: 40 } },
        { modelId: "a-other", displayName: "Other Model", window: { usedPercent: 99 } }]
    })) };
    await render({ ...controls, surfaceOwnerKey: "owner-two" }, replacement);
    expect(read.mock.calls[0]![2].aborted).toBe(true);
    expect(host.textContent).toContain("75% remaining");
    expect(host.textContent).toContain("60% remaining");
    expect(host.textContent).not.toContain("1% remaining");
    await act(async () => release(create(ProviderAccountUsageSnapshotSchema, { providerId: "alpha", primaryWindow: { usedPercent: 98 } })));
    expect(host.textContent).not.toContain("2% remaining");
    await render({ ...controls, surfaceOwnerKey: "owner-two" }, replacement, false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(replacement.read).toHaveBeenCalledOnce();
    expect(setModel).not.toHaveBeenCalled();
    expect(mutateFavorite).not.toHaveBeenCalled();
  });

  it("edits a shared favorite without applying it and preserves the search on return", async () => {
    await render();
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search task models"]')!;
    await act(async () => {
      search.value = "Alpha";
      search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await click("Alpha Model, Saved favorite");
    await clickText("High");
    await click("Save favorite");

    expect(mutateFavorite).toHaveBeenCalledExactlyOnceWith("owner-one", 4n, {
      kind: "replace",
      item: {
        favoriteId: "favorite-alpha",
        backendId: "backend",
        providerId: "alpha",
        modelId: "a",
        effortId: "high",
        fastMode: false
      }
    });
    expect(setModel).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Search task models"]')?.value).toBe("Alpha");

    await render({
      ...controls,
      favoriteRevision: 5n,
      favorites: [{ ...controls.favorites[0]!, effortId: "high" }]
    });
    await click("Alpha Model, Saved favorite");
    await click("Apply model settings");
    expect(setModel).toHaveBeenCalledExactlyOnceWith("authority-one", {
      providerId: "alpha",
      modelId: "a",
      effortId: "high",
      fastMode: false
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
