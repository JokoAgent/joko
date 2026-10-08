// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileExtensionLibrary } from "./MobileExtensionLibrary";
import type {
  MobileExtensionLibraryLocationValidation,
  MobileExtensionLibrarySnapshot
} from "./mobile-extension-library";
import type { MobileExtension, MobileExtensionTransport } from "./mobile-extensions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    accessibilityLiveRegion: _accessibilityLiveRegion, selectable: _selectable,
    onPress, disabled, contentContainerStyle: _contentContainerStyle, keyboardShouldPersistTaps: _keyboard,
    ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { checked?: boolean; disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      contentContainerStyle?: unknown;
      keyboardShouldPersistTaps?: string;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.checked === undefined ? {} : { "aria-checked": accessibilityState.checked }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    Modal: ({ visible, children }: { readonly visible: boolean; readonly children?: React.ReactNode }) =>
      visible ? React.createElement("div", { "data-modal": true }, children) : null,
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, onChangeText, value, editable = true, testID,
      autoCorrect: _autoCorrect, autoCapitalize: _autoCapitalize, ...props }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      value?: string;
      editable?: boolean;
      testID?: string;
      autoCorrect?: boolean;
      autoCapitalize?: string;
    }) => React.createElement("input", { ...props, value, disabled: !editable,
      "data-testid": testID, "aria-label": accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value), style: undefined }),
    View: element("div")
  };
});

const colors = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

let container: HTMLDivElement;
let root: Root;

async function render(
  active: MobileExtensionTransport,
  extension = fixtureExtension(),
  onBack = vi.fn()
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(MobileExtensionLibrary, {
      colors,
      extension,
      locale: "en",
      onBack,
      transport: active
    }));
  });
  return onBack;
}

async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label) as HTMLButtonElement | undefined;
  expect(button, `Missing accessible button ${label}`).toBeTruthy();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function pressLast(label: string) {
  const buttons = Array.from(container.querySelectorAll("button"))
    .filter((candidate) => candidate.getAttribute("aria-label") === label) as HTMLButtonElement[];
  expect(buttons.length, `Missing accessible button ${label}`).toBeGreaterThan(0);
  await act(async () => buttons.at(-1)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

async function changeInput(label: string, value: string) {
  const input = container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  expect(input, `Missing accessible input ${label}`).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
});

describe("MobileExtensionLibrary", () => {
  it("loads authoritative state, validates a remote path, warns about cloud sync, and submits the exact snapshot", async () => {
    const extension = fixtureExtension();
    const snapshot = fixtureSnapshot(extension);
    const validation: MobileExtensionLibraryLocationValidation = {
      libraryRoot: "E:\\Libraries\\mail",
      warnings: ["cloud_sync_location"],
      diskFreeBytes: 6_000n
    };
    const active = fixtureTransport(snapshot);
    vi.mocked(active.validateLibraryLocation).mockResolvedValue(validation);
    await render(active, extension);

    expect(active.loadLibrary).toHaveBeenCalledWith(extension, expect.any(AbortSignal));
    expect(container.textContent).toContain("D:\\Joko\\Libraries\\mail");
    expect(container.textContent).toContain("2.0 KiB");
    await press("Move Library");
    await changeInput("Parent folder on node", " E:\\Libraries ");
    await press("Validate path");
    expect(active.validateLibraryLocation).toHaveBeenCalledWith(
      extension,
      "E:\\Libraries",
      expect.any(AbortSignal)
    );
    expect(container.textContent).toContain("Cloud-synced location");
    await press("Confirm move");
    expect(active.mutateLibrary).toHaveBeenCalledWith(extension, snapshot, {
      kind: "relocate",
      destination: { kind: "custom", candidate: "E:\\Libraries", validation }
    }, expect.any(AbortSignal));
  });

  it("requires the exact name for trash and never changes visible state before authoritative completion", async () => {
    const extension = fixtureExtension();
    const snapshot = fixtureSnapshot(extension);
    const active = fixtureTransport(snapshot);
    let finish!: (value: MobileExtensionLibrarySnapshot) => void;
    vi.mocked(active.mutateLibrary).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(active, extension);

    await press("Move to trash");
    const confirm = Array.from(container.querySelectorAll('button[aria-label="Move to trash"]')).at(-1) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await changeInput("Type Mail to confirm", "Mail");
    await pressLast("Move to trash");
    expect(active.mutateLibrary).toHaveBeenCalledWith(extension, snapshot, {
      kind: "trash",
      confirmation: "Mail"
    }, expect.any(AbortSignal));
    expect(container.textContent).toContain("D:\\Joko\\Libraries\\mail");
    await act(async () => finish({ ...snapshot, overview: { ...snapshot.overview!, location: undefined },
      trash: [...snapshot.trash, fixtureTrash(extension, "d")] }));
    expect(container.textContent).toContain("Unbound");
  });

  it("keeps recovery available while the active Extension is not ready and binds restore to the exact entry", async () => {
    const extension = { ...fixtureExtension(), enabled: false };
    const trash = fixtureTrash(extension, "e");
    const snapshot: MobileExtensionLibrarySnapshot = { trash: [trash], grace: [] };
    const active = fixtureTransport(snapshot);
    await render(active, extension);

    expect(container.textContent).toContain("Active Library unavailable");
    expect(container.textContent).toContain("No previous Library location");
    await press("Restore");
    await changeInput("Type Mail to confirm", "Mail");
    await pressLast("Restore");
    expect(active.mutateLibrary).toHaveBeenCalledWith(extension, snapshot, {
      kind: "restore",
      entry: trash,
      confirmation: "Mail",
      destination: "original"
    }, expect.any(AbortSignal));
  });

  it("aborts loading and ignores a response that arrives after leaving", async () => {
    const extension = fixtureExtension();
    const snapshot = fixtureSnapshot(extension);
    const active = fixtureTransport(snapshot);
    let finish!: (value: MobileExtensionLibrarySnapshot) => void;
    let signal: AbortSignal | undefined;
    vi.mocked(active.loadLibrary).mockImplementation((_expected, current) => {
      signal = current;
      return new Promise((resolve) => { finish = resolve; });
    });
    await render(active, extension);
    await act(async () => root.unmount());
    root = undefined as unknown as Root;
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(snapshot));
    expect(container.textContent).toBe("");
  });
});

function fixtureExtension(): MobileExtension {
  return {
    extensionId: `extension_${"1".repeat(32)}`,
    revision: 3n,
    owner: {
      kind: "resource",
      resourceId: "resource-mail",
      discoveredRevision: `sha256:${"a".repeat(64)}`,
      resourceRevision: 5n
    },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Mail",
    description: "Mail Library",
    enabled: true,
    sidebarSupported: false,
    sidebarVisible: false,
    library: { schemaVersion: 1 },
    tools: [],
    permissions: [],
    commands: [],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: false,
    updateAvailable: false
  };
}

function fixtureTrash(extension: MobileExtension, seed = "2") {
  return {
    id: `library_trash_${seed.repeat(32)}`,
    extensionId: extension.extensionId,
    name: extension.name,
    deletedAt: 1_000,
    expiresAt: Date.now() + 86_400_000,
    files: 1,
    bytes: 512n
  };
}

function fixtureSnapshot(extension: MobileExtension): MobileExtensionLibrarySnapshot {
  return {
    overview: {
      extensionId: extension.extensionId,
      name: extension.name,
      state: "ready",
      location: { kind: "default", path: "D:\\Joko\\Libraries\\mail", generation: 4n },
      files: 4,
      bytes: 2_048n,
      diskFreeBytes: 8_192n,
      softLimitBytes: 4_096n,
      softLimitExceeded: false,
      orphaned: false,
      trashCount: 1,
      graceCount: 1
    },
    trash: [fixtureTrash(extension)],
    grace: [{
      id: `library_grace_${"3".repeat(32)}`,
      extensionId: extension.extensionId,
      name: extension.name,
      createdAt: 1_000,
      expiresAt: Date.now() + 86_400_000,
      files: 4,
      bytes: 2_048n
    }]
  };
}

function fixtureTransport(snapshot: MobileExtensionLibrarySnapshot): MobileExtensionTransport {
  return {
    ownerKey: "owner-library",
    pending: [],
    list: vi.fn(async () => ({ revision: 1n, recoveredFromCorruption: false, extensions: [] })),
    detail: vi.fn(async (expected) => expected),
    setEnabled: vi.fn(async () => { throw new Error("unused"); }),
    setSidebarVisible: vi.fn(async () => { throw new Error("unused"); }),
    beginSetup: vi.fn(async () => { throw new Error("unused"); }),
    submitSetupInteraction: vi.fn(async () => { throw new Error("unused"); }),
    saveSetupCredential: vi.fn(async () => { throw new Error("unused"); }),
    completeSetup: vi.fn(async () => { throw new Error("unused"); }),
    cancelSetup: vi.fn(async () => { throw new Error("unused"); }),
    revokeSetup: vi.fn(async () => { throw new Error("unused"); }),
    tasks: vi.fn(() => []),
    useCommand: vi.fn(async () => { throw new Error("unused"); }),
    openMainView: vi.fn(async () => { throw new Error("unused"); }),
    probeMainView: vi.fn(async () => { throw new Error("unused"); }),
    closeMainView: vi.fn(async () => true),
    loadLibrary: vi.fn(async () => snapshot),
    validateLibraryLocation: vi.fn(async () => { throw new Error("unused"); }),
    mutateLibrary: vi.fn(async () => snapshot),
    reconcile: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined)
  };
}
