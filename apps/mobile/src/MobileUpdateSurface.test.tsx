// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobileForcedUpdateGate,
  MobileUpdatePrompt,
  MobileUpdateSettingsSection,
  type MobileUpdateActions,
  type MobileUpdateSurfaceColors
} from "./MobileUpdateSurface";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileUpdateControllerState } from "./mobile-update-controller";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({ hardwareBack: undefined as (() => boolean) | undefined }));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState, onPress, disabled,
    accessibilityLiveRegion: _live, accessibilityViewIsModal: _modal, selectable: _selectable,
    numberOfLines: _numberOfLines, ellipsizeMode: _ellipsizeMode, ...props }:
    Record<string, unknown> & {
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean };
      accessibilityLiveRegion?: string;
      accessibilityViewIsModal?: boolean;
      selectable?: boolean;
      numberOfLines?: number;
      ellipsizeMode?: string;
      onPress?: () => void;
      disabled?: boolean;
      children?: React.ReactNode;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.selected === undefined ? {} : { "aria-checked": accessibilityState.selected }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(_live ? { "aria-live": _live } : {}),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
      native.hardwareBack = handler;
      return { remove: () => { if (native.hardwareBack === handler) native.hardwareBack = undefined; } };
    } },
    Pressable: element("button"),
    StyleSheet: { create: <T,>(value: T) => value },
    Text: element("span"),
    View: element("div")
  };
});

const colors: MobileUpdateSurfaceColors = {
  background: "#fafafa",
  surface: "#fff",
  ink: "#111",
  muted: "#666",
  border: "#ddd",
  accent: "#f90",
  negative: "#b00",
  brandBackground: "#fff0d0"
};
const target = {
  version: "2.0.0",
  runtimeVersion: "runtime-2",
  installUrl: "https://download.joko.app/mobile",
  releaseNotes: "Safer startup recovery."
};

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  native.hardwareBack = undefined;
  vi.useRealTimers();
});

describe("MobileUpdateSurface", () => {
  it.each([
    ["en", "Updates", "Check for updates"],
    ["zh-CN", "更新", "检查更新"],
    ["zh-TW", "更新", "檢查更新"],
    ["ja", "アップデート", "アップデートを確認"],
    ["ko", "업데이트", "업데이트 확인"]
  ] as const)("renders the complete mounted Settings surface in %s", (locale, heading, check) => {
    const actions = createActions();
    const container = mount(createElement(MobileUpdateSettingsSection, {
      colors,
      locale,
      state: updateState(),
      actions
    }));
    expect(container.textContent).toContain(heading);
    expect(container.textContent).toContain("12345678");
    expect(button(container, check)).not.toBeNull();
  });

  it("publishes beta and manual actions and exposes semantic live status", async () => {
    const actions = createActions();
    const container = mount(createElement(MobileUpdateSettingsSection, {
      colors,
      locale: "en",
      state: updateState({ manualOutcome: "restart-required", pendingRestart: true }),
      actions
    }));
    await act(async () => button(container, "Beta").click());
    await act(async () => button(container, "Check for updates").click());
    expect(actions.onChannelChange).toHaveBeenCalledWith("beta");
    expect(actions.onCheck).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Fully close and reopen Joko");
    expect(container.querySelector("[aria-live=polite]")).not.toBeNull();
  });

  it("keeps an optional whole-bundle prompt dismissible and opens only its verified target", async () => {
    const actions = createActions();
    const container = mount(createElement(MobileUpdatePrompt, {
      colors,
      locale: "en",
      state: updateState({ prompt: target }),
      actions
    }));
    expect(container.querySelector("[role=alert]")).not.toBeNull();
    expect(container.textContent).toContain("Safer startup recovery.");
    expect(native.hardwareBack?.()).toBe(true);
    expect(actions.onDismissPrompt).toHaveBeenCalledOnce();
    actions.onDismissPrompt.mockClear();
    act(() => button(container, "Later").click());
    await act(async () => button(container, "Open install page").click());
    expect(actions.onDismissPrompt).toHaveBeenCalledOnce();
    expect(actions.onOpenUpdate).toHaveBeenCalledWith(target);
  });

  it("makes a forced gate back-proof, recheckable, and leaves the install exit usable after failure", async () => {
    const actions = createActions();
    const container = mount(createElement(MobileForcedUpdateGate, {
      colors,
      locale: "en",
      state: updateState({ forced: target, forcedCheckFailed: true }),
      foreground: true,
      actions
    }));
    expect(native.hardwareBack?.()).toBe(true);
    expect(container.textContent).toContain("remain protected");
    await act(async () => button(container, "Check again").click());
    await act(async () => button(container, "Open install page").click());
    expect(actions.onRecheckForced).toHaveBeenCalledOnce();
    expect(actions.onOpenUpdate).toHaveBeenCalledWith(target);
  });
});

function mount(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = container.querySelector(`button[aria-label="${label}"]`);
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button ${label}`);
  return match;
}

function createActions(): MobileUpdateActions & Record<keyof MobileUpdateActions, ReturnType<typeof vi.fn>> {
  return {
    onChannelChange: vi.fn(async () => undefined),
    onCheck: vi.fn(async () => undefined),
    onReset: vi.fn(async () => undefined),
    onDismissPrompt: vi.fn(() => undefined),
    onOpenUpdate: vi.fn(async () => undefined),
    onRecheckForced: vi.fn(async () => undefined)
  } as MobileUpdateActions & Record<keyof MobileUpdateActions, ReturnType<typeof vi.fn>>;
}

function updateState(patch: Partial<MobileUpdateControllerState> = {}): MobileUpdateControllerState {
  return {
    status: "ready",
    startup: "ready",
    channel: "stable",
    betaEnabled: true,
    channelSaving: false,
    manualPhase: "idle",
    pendingRestart: false,
    running: {
      appVersion: "1.0.0",
      runtimeVersion: "runtime-1",
      updateId: "12345678-aaaa-bbbb-cccc-123456789abc",
      createdAt: new Date(2026, 8, 21, 9, 30),
      isEnabled: true,
      isEmbeddedLaunch: false,
      isEmergencyLaunch: false
    },
    forcedChecking: false,
    forcedCheckFailed: false,
    authorityAvailable: true,
    ...patch
  };
}

const _allLocales: readonly MobileSupportedLocale[] = ["en", "zh-CN", "zh-TW", "ja", "ko"];
void _allLocales;
