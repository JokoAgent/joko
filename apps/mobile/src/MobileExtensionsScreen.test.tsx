// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileExtensionsScreen, type MobileExtensionsScreenProps } from "./MobileExtensionsScreen";
import type {
  MobileExtension,
  MobileExtensionCatalog,
  MobileExtensionTransport
} from "./mobile-extensions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  width: 390,
  back: undefined as undefined | (() => boolean),
  alert: vi.fn()
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    accessibilityLiveRegion: _accessibilityLiveRegion, selectable: _selectable,
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
    Alert: { alert: native.alert },
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

const colors: MobileExtensionsScreenProps["colors"] = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};
const mail = extensionFixture();
const calendar = extensionFixture({
  extensionId: "extension_11111111111111111111111111111111",
  name: "Calendar",
  description: "Plan meetings.",
  enabled: false,
  mainView: undefined,
  library: undefined,
  sidebarSupported: false,
  sidebarVisible: false,
  tools: [],
  permissions: [],
  commands: [],
  useSupported: false
});

function catalog(extensions: readonly MobileExtension[] = [mail, calendar], recoveredFromCorruption = false): MobileExtensionCatalog {
  return { revision: 4n, recoveredFromCorruption, extensions };
}

function transport(ownerKey = "owner-a", value = catalog()): MobileExtensionTransport {
  return {
    ownerKey,
    pending: [],
    list: vi.fn(async () => value),
    detail: vi.fn(async (expected) => expected),
    setEnabled: vi.fn(async (expected, enabled) => ({
      catalog: catalog(value.extensions.map((extension) => extension.extensionId === expected.extensionId
        ? { ...extension, revision: extension.revision + 1n, enabled } : extension)),
      extension: { ...expected, revision: expected.revision + 1n, enabled }
    })),
    setSidebarVisible: vi.fn(async (expected, sidebarVisible) => ({
      catalog: catalog(value.extensions.map((extension) => extension.extensionId === expected.extensionId
        ? { ...extension, revision: extension.revision + 1n, sidebarVisible } : extension)),
      extension: { ...expected, revision: expected.revision + 1n, sidebarVisible }
    })),
    reconcile: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined)
  };
}

let container: HTMLDivElement;
let root: Root;
const onBack = vi.fn();

async function render(active?: MobileExtensionTransport) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root.render(createElement(MobileExtensionsScreen, {
      colors, locale: "en", transport: active, onBack
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
  native.alert.mockReset();
  onBack.mockReset();
});

describe("MobileExtensionsScreen", () => {
  it("browses, searches, and loads authoritative Extension detail", async () => {
    const active = transport();
    await render(active);
    expect(container.textContent).toContain("Mail");
    expect(container.textContent).toContain("Calendar");
    expect(container.textContent).toContain("Ready");

    await press("View Mail");
    expect(active.detail).toHaveBeenCalledWith(mail, expect.any(AbortSignal));
    expect(container.textContent).toContain("Review messages that need attention");
    expect(container.textContent).toContain("Main view");
    expect(container.textContent).toContain("Library");
    expect(container.textContent).toContain("search");
    expect(container.textContent).toContain("Read mail");
    expect(container.textContent).toContain("/review");

    act(() => expect(native.back?.()).toBe(true));
    const input = container.querySelector('input[aria-label="Search Extensions"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "calendar");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Review Mail");
    expect(container.textContent).toContain("Calendar");
  });

  it("keeps the authoritative descriptor visible while enabled and sidebar changes are pending", async () => {
    const active = transport();
    let finish!: (value: Awaited<ReturnType<MobileExtensionTransport["setEnabled"]>>) => void;
    vi.mocked(active.setEnabled).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(active);
    await press("View Mail");

    await press("Disable Extension");
    expect(active.setEnabled).toHaveBeenCalledWith(mail, false, expect.any(AbortSignal));
    expect(container.textContent).toContain("Saving Extension change");
    expect(container.textContent).toContain("Enabled");
    expect((container.querySelector('button[aria-label="Disable Extension"]') as HTMLButtonElement).disabled).toBe(true);

    const disabled = { ...mail, revision: 2n, enabled: false };
    await act(async () => finish({ catalog: catalog([disabled, calendar]), extension: disabled }));
    expect(container.textContent).toContain("Disabled");
    expect(container.textContent).not.toContain("Saving Extension change");

    await press("Hide from sidebar");
    expect(active.setSidebarVisible).toHaveBeenCalledWith(disabled, false, expect.any(AbortSignal));
    expect(container.textContent).toContain("Hidden from sidebar");
  });

  it("keeps the previous state and exposes an actionable error when a change fails", async () => {
    const active = transport();
    vi.mocked(active.setEnabled).mockRejectedValueOnce(new Error("revision conflict"));
    await render(active);
    await press("View Mail");
    await press("Disable Extension");

    expect(container.textContent).toContain("Extension change failed: revision conflict");
    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).not.toContain("Disabled");
  });

  it("shows unresolved receipts, checks them without replay, and confirms authoritative clearing", async () => {
    const active = {
      ...transport(),
      pending: [{ operationId: "extension-operation", extensionId: mail.extensionId,
        kind: "enabled" as const, state: "unknown" as const }]
    } satisfies MobileExtensionTransport;
    await render(active);
    await press("View Mail");
    expect(container.textContent).toContain("unknown durable result");
    expect((container.querySelector('button[aria-label="Disable Extension"]') as HTMLButtonElement).disabled).toBe(true);

    await press("Check result");
    expect(active.reconcile).toHaveBeenCalledWith("extension-operation", expect.any(AbortSignal));
    expect(active.setEnabled).not.toHaveBeenCalled();

    await press("Verify and clear");
    expect(native.alert).toHaveBeenCalledOnce();
    const buttons = native.alert.mock.calls[0]?.[2] as undefined | { onPress?: () => void }[];
    await act(async () => buttons?.[1]?.onPress?.());
    expect(active.dismiss).toHaveBeenCalledWith("extension-operation", expect.any(AbortSignal));
    expect(active.setEnabled).not.toHaveBeenCalled();
  });

  it("shows recovery evidence and does not adopt a late directory from a retired owner", async () => {
    let finish!: (value: MobileExtensionCatalog) => void;
    const old = transport("owner-old");
    vi.mocked(old.list).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old);
    const next = transport("owner-new", catalog([calendar], true));
    await render(next);
    expect(container.textContent).toContain("recovered its Extension catalog");
    expect(container.textContent).toContain("Calendar");

    await act(async () => finish(catalog([mail])));
    expect(container.textContent).not.toContain("Review Mail");
    expect(container.textContent).toContain("Calendar");
  });

  it("retires a late detail response and unwinds the narrow detail with Android back", async () => {
    let finish!: (value: MobileExtension) => void;
    const old = transport("owner-old");
    vi.mocked(old.detail).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old);
    await press("View Mail");

    const next = transport("owner-new", catalog([calendar]));
    await render(next);
    await act(async () => finish(mail));
    expect(container.textContent).not.toContain("Review messages that need attention");
    await press("View Calendar");
    act(() => expect(native.back?.()).toBe(true));
    expect(container.querySelector('input[aria-label="Search Extensions"]')).not.toBeNull();
    act(() => expect(native.back?.()).toBe(true));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("does not adopt a late mutation result from a retired owner", async () => {
    let finish!: (value: Awaited<ReturnType<MobileExtensionTransport["setEnabled"]>>) => void;
    const old = transport("owner-old");
    vi.mocked(old.setEnabled).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old);
    await press("View Mail");
    await press("Disable Extension");

    const next = transport("owner-new", catalog([calendar]));
    await render(next);
    const disabled = { ...mail, revision: 2n, enabled: false };
    await act(async () => finish({ catalog: catalog([disabled]), extension: disabled }));
    expect(container.textContent).toContain("Calendar");
    expect(container.textContent).not.toContain("Review messages that need attention");
  });

  it("shows a bounded offline state", async () => {
    await render(undefined);
    expect(container.textContent).toContain("Reconnect to browse Extensions");
  });
});

function extensionFixture(overrides: Partial<MobileExtension> = {}): MobileExtension {
  return {
    extensionId: "extension_0123456789abcdef0123456789abcdef",
    revision: 1n,
    owner: {
      kind: "resource",
      resourceId: "resource-mail",
      discoveredRevision: `sha256:${"a".repeat(64)}`,
      resourceRevision: 3n
    },
    source: "local",
    installed: true,
    installState: "updateAvailable",
    name: "Mail",
    version: "1.4.0",
    author: "Joko Labs",
    description: "Review messages that need attention.",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: true,
    mainView: { title: "Mail", icon: "layout" },
    library: { schemaVersion: 1 },
    tools: [{ name: "search", description: "Search mail", requiresPermission: true }],
    permissions: [{ permissionId: "mail.read", label: "Read mail", description: "Reads selected mail.",
      required: true, granted: true }],
    commands: [{ name: "review", description: "Review mail", sessionId: "" }],
    setup: { state: "ready", revision: 0n, fields: [] },
    useSupported: true,
    updateAvailable: true,
    ...overrides
  };
}
