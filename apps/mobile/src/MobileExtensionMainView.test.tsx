// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileExtensionMainView } from "./MobileExtensionMainView";
import { decodeMobileLibraryMessage, encodeMobileLibraryMessage } from "./mobile-extension-library-bridge";
import type { MobileExtensionLibrarySession } from "./mobile-extension-library-runtime";
import type {
  MobileExtension,
  MobileExtensionMainViewSurface,
  MobileExtensionTransport
} from "./mobile-extensions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  web: undefined as undefined | Record<string, unknown>, messages: [] as string[]
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    onPress, disabled, numberOfLines: _numberOfLines, pointerEvents: _pointerEvents, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      numberOfLines?: number;
      pointerEvents?: string;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    Pressable: element("button"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    View: element("div")
  };
});

vi.mock("react-native-webview", async () => {
  const React = await import("react");
  return {
    WebView: (props: Record<string, unknown>) => {
      native.web = props;
      React.useImperativeHandle(props.ref as React.Ref<{ postMessage(message: string): void }>, () => ({
        postMessage: (message: string) => native.messages.push(message)
      }));
      return React.createElement("div", { "data-testid": "extension-webview" });
    }
  };
});

const colors = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

let container: HTMLDivElement;
let root: Root;

async function render(transport: MobileExtensionTransport, extension = fixtureExtension()) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root.render(createElement(MobileExtensionMainView, {
      colors,
      extension,
      locale: "en",
      onBack: vi.fn(),
      transport
    }));
  });
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  native.web = undefined;
  native.messages = [];
});

describe("MobileExtensionMainView", () => {
  it("opens the exact lease, hardens WebView navigation, probes before reload, and closes on leave", async () => {
    const extension = fixtureExtension();
    const surface = fixtureSurface(extension);
    const active = fixtureTransport(surface);
    await render(active, extension);

    expect(active.openMainView).toHaveBeenCalledWith(extension, expect.any(AbortSignal));
    expect(native.web).toMatchObject({
      source: { uri: surface.url },
      originWhitelist: ["https://node.example"],
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      domStorageEnabled: false,
      incognito: true,
      cacheEnabled: false,
      mixedContentMode: "never"
    });
    expect(native.web?.onHttpError).toBeTypeOf("function");
    const allow = native.web!.onShouldStartLoadWithRequest as (request: { readonly url: string }) => boolean;
    expect(allow({ url: surface.url })).toBe(true);
    expect(allow({ url: "https://node.example/v1/other" })).toBe(false);
    expect(allow({ url: "https://attacker.example/" })).toBe(false);

    await act(async () => (native.web!.onLoadEnd as () => void)());
    expect(container.textContent).not.toContain("Loading Extension content");
    await act(async () => {
      expect(allow({ url: surface.url.replace("index.html", "asset.js#loaded") })).toBe(false);
    });
    expect(native.web).toMatchObject({ source: { uri: surface.url.replace("index.html", "asset.js#loaded") } });
    const reload = container.querySelector('button[aria-label="Reload main view"]') as HTMLButtonElement;
    await act(async () => reload.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(active.probeMainView).toHaveBeenCalledWith(surface, expect.any(AbortSignal));

    await act(async () => root.unmount());
    expect(active.closeMainView).toHaveBeenCalledWith(surface);
    root = undefined as unknown as Root;
  });

  it("retires a revoked or crashed surface and can explicitly retry with a fresh lease", async () => {
    const extension = fixtureExtension();
    const first = fixtureSurface(extension);
    const second = { ...first, surfaceId: "extension_surface_22222222222222222222222222222222",
      url: first.url.replace(first.surfaceId, "extension_surface_22222222222222222222222222222222") };
    const active = fixtureTransport(first);
    vi.mocked(active.probeMainView).mockRejectedValueOnce(new Error("revoked"));
    vi.mocked(active.openMainView).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await render(active, extension);

    const reload = container.querySelector('button[aria-label="Reload main view"]') as HTMLButtonElement;
    await act(async () => reload.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.textContent).toContain("changed, expired, or lost its owner");
    expect(active.closeMainView).toHaveBeenCalledWith(first);

    const retry = container.querySelector('button[aria-label="Retry"]') as HTMLButtonElement;
    await act(async () => retry.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(native.web).toMatchObject({ source: { uri: second.url } });
    await act(async () => (native.web!.onRenderProcessGone as () => void)());
    expect(container.textContent).toContain("changed, expired, or lost its owner");
    expect(active.closeMainView).toHaveBeenCalledWith(second);
  });

  it("delivers Library results to the current document and retires requests before reload or navigation", async () => {
    const extension = { ...fixtureExtension(), library: { schemaVersion: 1 as const } };
    const surface = fixtureSurface(extension), active = fixtureTransport(surface);
    const session: MobileExtensionLibrarySession = { id: `library_session_${"c".repeat(32)}`, extensionId: extension.extensionId,
      expiresAt: Date.now() + 60_000, bindingGeneration: 1n, limits: {
        maximumReadBytes: 16n * 1024n ** 2n, maximumWriteBytes: 16n * 1024n ** 2n, maximumStreamBytes: 8n * 1024n ** 3n,
        maximumPathCharacters: 512, maximumPathSegments: 32, maximumListPageSize: 500, maximumFiles: 50_000,
        softLimitBytes: 8n * 1024n ** 3n, diskReserveBytes: 1024n ** 3n
      } };
    vi.mocked(active.openLibrary).mockResolvedValue(session);
    vi.mocked(active.callLibrary).mockResolvedValue({ kind: "read", path: "mail", content: Uint8Array.of(128), sha256: "a".repeat(64) });
    await render(active, extension);
    const old = native.web!;
    const onMessage = old.onMessage as (event: { nativeEvent: { data: string; url: string } }) => void;
    const request = { nativeEvent: { data: encodeMobileLibraryMessage({ surfaceId: surface.surfaceId,
      frameId: `${surface.surfaceId}:0`, request: { type: "joko:extension-library-request", version: 1,
        id: "read", operation: { kind: "read", path: "mail" } } }), url: surface.url } };
    await act(async () => onMessage(request));
    expect(active.callLibrary).toHaveBeenCalledWith(extension, surface, session, { kind: "read", path: "mail" }, expect.any(AbortSignal));
    expect(decodeMobileLibraryMessage(native.messages[0]!)).toMatchObject({ frameId: `${surface.surfaceId}:0`,
      response: { ok: true, result: { kind: "read", content: Uint8Array.of(128) } } });
    const reload = container.querySelector('button[aria-label="Reload main view"]') as HTMLButtonElement;
    await act(async () => reload.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(active.closeLibrary).toHaveBeenCalledWith(session);
    await act(async () => {
      onMessage(request);
      (old.onError as () => void)();
    });
    expect(active.callLibrary).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("unavailable");
    expect(native.web!.injectedJavaScriptBeforeContentLoaded).toContain(`${surface.surfaceId}:1`);
  });

  it("closes a lease that arrives after the surface has been unmounted", async () => {
    const extension = fixtureExtension();
    const surface = fixtureSurface(extension);
    const active = fixtureTransport(surface);
    let finish!: (value: MobileExtensionMainViewSurface) => void;
    vi.mocked(active.openMainView).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(active, extension);
    await act(async () => root.unmount());
    root = undefined as unknown as Root;
    await act(async () => finish(surface));
    expect(active.closeMainView).toHaveBeenCalledWith(surface);
  });
});

function fixtureExtension(): MobileExtension {
  return {
    extensionId: "extension_0123456789abcdef0123456789abcdef",
    revision: 3n,
    owner: { kind: "resource", resourceId: "resource-main", discoveredRevision: `sha256:${"a".repeat(64)}`,
      resourceRevision: 5n },
    source: "local",
    installed: true,
    installState: "installed",
    name: "Mail",
    description: "Review mail.",
    enabled: true,
    sidebarSupported: true,
    sidebarVisible: true,
    mainView: { title: "Review", icon: "layout" },
    tools: [],
    permissions: [],
    commands: [],
    setup: { state: "notRequired", revision: 0n, fields: [] },
    useSupported: true,
    updateAvailable: false
  };
}

function fixtureSurface(extension: MobileExtension): MobileExtensionMainViewSurface {
  if (extension.owner.kind !== "resource") throw new Error("Resource Extension fixture required.");
  const surfaceId = "extension_surface_11111111111111111111111111111111";
  return {
    surfaceId,
    extensionId: extension.extensionId,
    owner: extension.owner,
    backendId: "backend-main",
    backendRevision: 8n,
    backendGeneration: 4,
    url: `https://node.example/v1/extensions/main-views/${surfaceId}/${"b".repeat(64)}/index.html`,
    title: "Review",
    icon: "layout",
    expiresAt: Date.now() + 60_000
  };
}

function fixtureTransport(surface: MobileExtensionMainViewSurface): MobileExtensionTransport {
  return {
    ownerKey: "owner-main",
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
    openMainView: vi.fn(async () => surface),
    probeMainView: vi.fn(async () => surface),
    closeMainView: vi.fn(async () => true),
    openLibrary: vi.fn(async () => { throw new Error("unused"); }),
    callLibrary: vi.fn(async () => { throw new Error("unused"); }),
    closeLibrary: vi.fn(async () => true),
    libraryStatus: vi.fn(async () => { throw new Error("unused"); }),
    loadLibrary: vi.fn(async () => ({ trash: [], grace: [] })),
    validateLibraryLocation: vi.fn(async () => { throw new Error("unused"); }),
    mutateLibrary: vi.fn(async (_expected, snapshot) => snapshot),
    reconcile: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined)
  };
}
