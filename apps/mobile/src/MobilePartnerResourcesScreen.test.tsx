// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobilePartnerResourcesScreen,
  type MobilePartnerResourcesScreenProps
} from "./MobilePartnerResourcesScreen";
import type {
  MobilePartnerResourcePreview,
  MobilePartnerResourceTransport
} from "./mobile-partner-resources";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  width: 390,
  back: undefined as undefined | (() => boolean)
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    onPress, disabled, numberOfLines: _numberOfLines, contentContainerStyle: _contentContainerStyle,
    ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      numberOfLines?: number;
      contentContainerStyle?: unknown;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.selected === undefined ? {} : { "aria-selected": accessibilityState.selected }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
      native.back = handler;
      return { remove: () => { if (native.back === handler) native.back = undefined; } };
    } },
    FlatList: ({ data, renderItem, ListEmptyComponent }: {
      data: readonly unknown[];
      renderItem: (value: { item: unknown; index: number }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) => React.createElement("div", {}, data.length === 0 ? ListEmptyComponent
      : data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))),
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, onChangeText, value, ...props }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      value?: string;
    }) => React.createElement("input", { ...props, value, "aria-label": accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value), style: undefined }),
    View: element("div"),
    useWindowDimensions: () => ({ width: native.width, height: 844, scale: 1, fontScale: 1 })
  };
});

const colors: MobilePartnerResourcesScreenProps["colors"] = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};
const ada = { partnerId: "ada", revision: 2n, displayName: "Ada", avatar: "A", lifecycle: "active" as const,
  initializationState: "ready" as const, canonicalSessionId: "session-ada", profileVersion: 2 };
const pending = { partnerId: "pending", revision: 2n, displayName: "Pending", avatar: "P", lifecycle: "active" as const,
  initializationState: "pending" as const, profileVersion: 1 };
const preview: MobilePartnerResourcePreview = {
  resourceKey: "ada\u001f2\u001fsession-ada\u001factive\u001fready",
  partner: ada,
  session: { sessionId: "session-ada", displayName: "Ada task", profileVersion: 2,
    createdAt: 1_000, lastActivityAt: 2_000 },
  artifacts: [{ artifactId: "report", title: "Report", fileName: "report.txt",
    mediaType: "text/plain", byteSize: 1_024, createdAt: 2_000 }],
  artifactRevision: "artifacts-r1"
};

function transport(ownerKey = "owner-a"): MobilePartnerResourceTransport {
  return {
    ownerKey,
    list: vi.fn(async () => [ada, pending]),
    preview: vi.fn(async () => preview),
    open: vi.fn(async () => "session-ada")
  };
}

let container: HTMLDivElement;
let root: Root;
const onBack = vi.fn();
const onOpenTask = vi.fn();

async function render(active?: MobilePartnerResourceTransport) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root.render(createElement(MobilePartnerResourcesScreen, {
      colors, locale: "en", transport: active, onBack, onOpenTask
    }));
  });
}

async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  expect(button, `Missing accessible button ${label}`).toBeTruthy();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  native.width = 390;
  native.back = undefined;
  onBack.mockReset();
  onOpenTask.mockReset();
});

describe("MobilePartnerResourcesScreen", () => {
  it("browses, previews canonical metadata, and opens through the transport", async () => {
    const active = transport();
    await render(active);
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).toContain("Setting up");
    expect((container.querySelector('[aria-label="Preview Pending"]') as HTMLButtonElement).disabled).toBe(true);

    await press("Preview Ada");
    expect(active.preview).toHaveBeenCalledWith("ada", expect.any(AbortSignal));
    expect(container.textContent).toContain("Ada task");
    expect(container.textContent).toContain("Report");
    expect(container.textContent).toContain("text/plain · 1.0 KB");

    await press("Open canonical task");
    expect(active.open).toHaveBeenCalledWith(preview, expect.any(AbortSignal));
    expect(onOpenTask).toHaveBeenCalledOnce();
  });

  it("does not adopt a late directory from a retired owner", async () => {
    let finish!: (value: ReadonlyArray<typeof ada>) => void;
    const old = transport("owner-old");
    vi.mocked(old.list).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old);
    const next = transport("owner-new");
    vi.mocked(next.list).mockResolvedValue([{ ...ada, partnerId: "new", displayName: "New owner" }]);
    await render(next);
    expect(container.textContent).toContain("New owner");
    await act(async () => finish([ada]));
    expect(container.textContent).not.toContain("Preview Ada");
    expect(container.textContent).toContain("New owner");
  });

  it("shows a bounded offline state and unwinds detail with Android back", async () => {
    await render(undefined);
    expect(container.textContent).toContain("Reconnect to browse Partner Resources");
    const active = transport();
    await render(active);
    await press("Preview Ada");
    act(() => expect(native.back?.()).toBe(true));
    expect(container.querySelector('input[aria-label="Search Partner Resources"]')).not.toBeNull();
    act(() => expect(native.back?.()).toBe(true));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
