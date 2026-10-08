// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { BackendDescriptorSchema, PermissionMode, SessionSchema } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileRuntimeControls } from "./mobile-runtime-controls";

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
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function render(value: MobileRuntimeControls = controls): Promise<void> {
  await act(async () => root.render(createElement(MobileRuntimeControlsSheet, {
    visible: true,
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
