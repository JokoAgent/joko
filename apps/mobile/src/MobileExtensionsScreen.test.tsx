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
    Modal: element("div"),
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, onChangeText, value, editable = true, secureTextEntry = false, testID,
      ...props }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      value?: string;
      editable?: boolean;
      secureTextEntry?: boolean;
      testID?: string;
    }) => React.createElement("input", { ...props, value, disabled: !editable,
      type: secureTextEntry ? "password" : "text", "data-testid": testID, "aria-label": accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value), style: undefined }),
    View: element("div"),
    useWindowDimensions: () => ({ width: native.width, height: 844, scale: 1, fontScale: 1 })
  };
});

vi.mock("./MobileExtensionMainView", async () => {
  const React = await import("react");
  return {
    MobileExtensionMainView: ({ extension, onBack }: { readonly extension: MobileExtension; readonly onBack: () => void }) =>
      React.createElement("section", { "data-testid": "main-view" },
        React.createElement("span", {}, `Surface ${extension.name}`),
        React.createElement("button", { "aria-label": "Back to Extension details", onClick: onBack }, "Back"))
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
    beginSetup: vi.fn(async (expected) => ({ catalog: value, extension: expected })),
    submitSetupInteraction: vi.fn(async (expected) => ({ catalog: value, extension: expected })),
    saveSetupCredential: vi.fn(async (expected) => ({ catalog: value, extension: expected })),
    completeSetup: vi.fn(async (expected) => ({ catalog: value, extension: expected })),
    cancelSetup: vi.fn(async (expected) => ({ catalog: value, extension: expected })),
    revokeSetup: vi.fn(async (expected) => ({ catalog: value, extension: expected })),
    tasks: vi.fn(() => []),
    useCommand: vi.fn(async (_expected, _command, destination) => destination.kind === "newTask"
      ? { kind: "newTask" as const }
      : { kind: "task" as const, sessionId: destination.sessionId }),
    openMainView: vi.fn(async () => { throw new Error("No main-view fixture was configured."); }),
    probeMainView: vi.fn(async () => { throw new Error("No main-view fixture was configured."); }),
    closeMainView: vi.fn(async () => true),
    reconcile: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined)
  };
}

let container: HTMLDivElement;
let root: Root;
const onBack = vi.fn();
const onOpenNewTask = vi.fn();
const onOpenTask = vi.fn();

async function render(active?: MobileExtensionTransport) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root.render(createElement(MobileExtensionsScreen, {
      colors, locale: "en", transport: active, onBack, onOpenNewTask, onOpenTask
    }));
  });
}

async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  expect(button, `Missing accessible button ${label}`).toBeTruthy();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function changeInput(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  expect(input, `Missing accessible input ${label}`).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function pressTestId(testID: string) {
  const button = container.querySelector(`[testid="${testID}"], [data-testid="${testID}"]`);
  expect(button, `Missing test control ${testID}`).toBeTruthy();
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
  onOpenNewTask.mockReset();
  onOpenTask.mockReset();
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

  it("opens a ready Resource main view in the narrow detail pane and returns without losing detail", async () => {
    const active = transport();
    await render(active);
    await press("View Mail");

    await press("Open main view");
    expect(container.querySelector('[data-testid="main-view"]')?.textContent).toContain("Surface Mail");
    act(() => expect(native.back?.()).toBe(true));
    expect(container.querySelector('[data-testid="main-view"]')).toBeNull();
    expect(container.textContent).toContain("Review messages that need attention");

    const unavailable = transport("owner-disabled", catalog([{ ...mail, enabled: false }]));
    await render(unavailable);
    await press("View Mail");
    expect((container.querySelector('[testid="extensions.mainView.open"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the Extension directory available beside a wide main view and retires it on another selection", async () => {
    native.width = 900;
    const active = transport();
    await render(active);
    await press("View Mail");
    await press("Open main view");

    expect(container.querySelector('[data-testid="main-view"]')).not.toBeNull();
    expect(container.querySelector('[testid="extensions.directory"]')).not.toBeNull();
    await press("View Calendar");
    expect(container.querySelector('[data-testid="main-view"]')).toBeNull();
    expect(container.textContent).toContain("Plan meetings");
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

  it("configures fields, clears protected input before upload, completes, revokes, and cancels setup", async () => {
    const setupFields: MobileExtension["setup"]["fields"] = [
      { fieldId: "region", label: "Region", description: "Choose a region", kind: "text", required: true,
        configured: false, options: ["east", "west"] },
      { fieldId: "terms", label: "Terms", description: "Accept the terms", kind: "confirmation", required: true,
        configured: false, options: [] },
      { fieldId: "token", label: "Token", description: "Protected token", kind: "secret", required: true,
        configured: false, options: [] }
    ];
    let current = extensionFixture({ setup: { state: "required", revision: 0n, fields: setupFields } });
    const active = transport("owner-setup", catalog([current, calendar]));
    vi.mocked(active.detail).mockImplementation(async () => current);
    const result = (next: MobileExtension) => {
      current = next;
      return { catalog: catalog([current, calendar]), extension: current };
    };
    vi.mocked(active.beginSetup).mockImplementation(async (expected) => result({
      ...expected,
      revision: expected.revision + 1n,
      setup: { state: "inProgress", attemptId: "attempt-1", revision: 1n, fields: setupFields }
    }));
    vi.mocked(active.submitSetupInteraction).mockImplementation(async (expected, fieldId, value) => result({
      ...expected,
      revision: expected.revision + 1n,
      setup: { ...expected.setup, revision: expected.setup.revision + 1n,
        fields: expected.setup.fields.map((field) => field.fieldId === fieldId
          ? { ...field, configured: field.kind === "confirmation" ? value === true : true }
          : field) }
    }));
    let finishCredential!: () => void;
    vi.mocked(active.saveSetupCredential).mockImplementation((expected, fieldId, kind, secret) => {
      expect({ fieldId, kind, secret }).toEqual({
        fieldId: "token", kind: "headerSecret", secret: "temporary-private-value"
      });
      return new Promise((resolve) => { finishCredential = () => resolve(result({
        ...expected,
        revision: expected.revision + 1n,
        setup: { ...expected.setup, revision: expected.setup.revision + 1n,
          fields: expected.setup.fields.map((field) => field.fieldId === fieldId
            ? { ...field, configured: true }
            : field) }
      })); });
    });
    vi.mocked(active.completeSetup).mockImplementation(async (expected) => result({
      ...expected,
      revision: expected.revision + 1n,
      setup: { ...expected.setup, state: "ready", revision: expected.setup.revision + 1n }
    }));
    vi.mocked(active.revokeSetup).mockImplementation(async (expected) => result({
      ...expected,
      revision: expected.revision + 1n,
      setup: { state: "required", revision: expected.setup.revision + 1n,
        fields: expected.setup.fields.map((field) => ({ ...field, configured: false })) }
    }));
    vi.mocked(active.cancelSetup).mockImplementation(async (expected) => result({
      ...expected,
      revision: expected.revision + 1n,
      setup: { ...expected.setup, state: "cancelled", revision: expected.setup.revision + 1n }
    }));

    await render(active);
    await press("View Mail");
    expect(container.textContent).toContain("must be configured");
    await press("Begin setup");
    expect(active.beginSetup).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.objectContaining({ state: "required" }) }),
      expect.any(AbortSignal));
    expect(container.textContent).toContain("Choose a region");
    expect((container.querySelector('[testid="extensions.setup.complete"]') as HTMLButtonElement).disabled).toBe(true);

    await press("west");
    await pressTestId("extensions.setup.save.region");
    expect(active.submitSetupInteraction).toHaveBeenLastCalledWith(expect.anything(), "region", "west", expect.any(AbortSignal));
    await press("Confirm");
    expect(active.submitSetupInteraction).toHaveBeenLastCalledWith(expect.anything(), "terms", true, expect.any(AbortSignal));
    await press("Header secret");
    await changeInput("Token", "temporary-private-value");
    await pressTestId("extensions.setup.save.token");
    expect((container.querySelector('input[aria-label="Token"]') as HTMLInputElement).value).toBe("");
    expect(container.textContent).toContain("Saving Extension change");
    await act(async () => finishCredential());
    expect(active.saveSetupCredential).toHaveBeenCalledOnce();
    expect((container.querySelector('[testid="extensions.setup.complete"]') as HTMLButtonElement).disabled).toBe(false);

    await press("Complete setup");
    expect(container.textContent).toContain("Setup is ready");
    await press("Revoke setup");
    expect(native.alert).toHaveBeenCalledOnce();
    const revokeButtons = native.alert.mock.calls[0]?.[2] as undefined | { onPress?: () => void }[];
    await act(async () => revokeButtons?.[1]?.onPress?.());
    expect(active.revokeSetup).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("must be configured");

    await press("Begin setup");
    await press("Cancel setup");
    expect(active.cancelSetup).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("previous setup attempt was cancelled");
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

  it("prefills a new task through the exact command handoff without sending", async () => {
    const usable = extensionFixture({
      commands: [{ name: "review", description: "Review mail", sessionId: "advertising-task" }]
    });
    const active = transport("owner-use-new", catalog([usable]));
    vi.mocked(active.tasks).mockReturnValue([{ sessionId: "advertising-task", displayName: "Inbox", targetName: "Mail project" }]);
    await render(active);
    await press("View Mail");
    await press("Use /review");

    expect(container.textContent).toContain("never sent automatically");
    expect(container.textContent).toContain("Inbox");
    await press("Use in new task");

    expect(active.useCommand).toHaveBeenCalledExactlyOnceWith(
      usable,
      usable.commands[0],
      { kind: "newTask" },
      expect.any(AbortSignal)
    );
    expect(onOpenNewTask).toHaveBeenCalledOnce();
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("searches applicable live tasks and opens the selected command draft", async () => {
    const usable = extensionFixture({
      commands: [{ name: "review", description: "Review mail", sessionId: "advertising-task" }]
    });
    const active = transport("owner-use-task", catalog([usable]));
    vi.mocked(active.tasks).mockReturnValue([
      { sessionId: "task-alpha", displayName: "Alpha", targetName: "Project One" },
      { sessionId: "task-beta", displayName: "Beta", targetName: "Project Two" }
    ]);
    await render(active);
    await press("View Mail");
    await press("Use /review");
    await changeInput("Search current tasks", "beta");

    expect(container.textContent).not.toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    await press("Use /review in Beta");

    expect(active.useCommand).toHaveBeenCalledExactlyOnceWith(
      usable,
      usable.commands[0],
      { kind: "task", sessionId: "task-beta" },
      expect.any(AbortSignal)
    );
    expect(onOpenTask).toHaveBeenCalledOnce();
    expect(onOpenNewTask).not.toHaveBeenCalled();
  });

  it("keeps a failed handoff actionable and retires an in-flight handoff with its owner", async () => {
    const usable = extensionFixture({
      commands: [{ name: "review", description: "Review mail", sessionId: "advertising-task" }]
    });
    const active = transport("owner-use-old", catalog([usable]));
    vi.mocked(active.tasks).mockReturnValue([{ sessionId: "task-one", displayName: "Inbox", targetName: "Mail project" }]);
    vi.mocked(active.useCommand).mockRejectedValueOnce(new Error("runtime changed"));
    await render(active);
    await press("View Mail");
    await press("Use /review");
    await press("Use /review in Inbox");
    expect(container.textContent).toContain("runtime changed");
    expect(onOpenTask).not.toHaveBeenCalled();

    let fail!: (error: Error) => void;
    vi.mocked(active.useCommand).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await press("Use /review in Inbox");
    const signal = vi.mocked(active.useCommand).mock.calls.at(-1)?.[3];
    const next = transport("owner-use-new", catalog([calendar]));
    await render(next);
    expect(signal?.aborted).toBe(false);
    await act(async () => fail(new Error("owner changed")));
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("runtime changed");
  });

  it("keeps an authenticated task handoff alive through its intentional selection refresh", async () => {
    const usable = extensionFixture({
      commands: [{ name: "review", description: "Review mail", sessionId: "advertising-task" }]
    });
    const active = transport("owner-use-refresh", catalog([usable]));
    vi.mocked(active.tasks).mockReturnValue([{ sessionId: "task-one", displayName: "Inbox", targetName: "Mail project" }]);
    let finish!: (value: { readonly kind: "task"; readonly sessionId: string }) => void;
    vi.mocked(active.useCommand).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render(active);
    await press("View Mail");
    await press("Use /review");
    await press("Use /review in Inbox");
    const signal = vi.mocked(active.useCommand).mock.calls[0]?.[3];

    await render(undefined);
    expect(signal?.aborted).toBe(false);
    expect(container.textContent).toContain("Preparing the command draft");
    await act(async () => finish({ kind: "task", sessionId: "task-one" }));

    expect(onOpenTask).toHaveBeenCalledOnce();
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
