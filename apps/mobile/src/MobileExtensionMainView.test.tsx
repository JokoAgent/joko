// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileExtensionMainView } from "./MobileExtensionMainView";
import { create } from "@bufbuild/protobuf";
import { ExtensionOAuthAuthorizationSchema } from "@joko/contracts";
import { decodeMobileLibraryMessage, encodeMobileLibraryMessage } from "./mobile-extension-library-bridge";
import type { MobileExtensionLibrarySession } from "./mobile-extension-library-runtime";
import type {
  MobileExtension,
  MobileExtensionMainViewSurface,
  MobileExtensionTransport
} from "./mobile-extensions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  web: undefined as undefined | Record<string, unknown>, messages: [] as string[], prepare: vi.fn(),
  state: "active", listeners: new Set<(value: string) => void>(), alert: vi.fn(), authorize: vi.fn(),
  documents: [] as Array<{ documentId: string; source: { uri: string }; documentUrl: string; documentUrls: string[]; close: ReturnType<typeof vi.fn> }>
}));
vi.mock("./mobile-extension-oauth", () => ({ authorizeMobileExtensionAccount: native.authorize }));

vi.mock("./mobile-extension-main-view-document", () => ({
  prepareExtensionMainViewDocument: native.prepare,
  allowExtensionDocumentNavigation: (document: { documentUrls: string[] }, value: string) => {
    try { const url = new URL(value); url.hash = ""; return document.documentUrls.includes(url.href); } catch { return false; }
  }
}));

beforeEach(() => {
  native.prepare.mockImplementation(async (_resource, entry: string) => {
    const origin = `http://127.0.0.1:${4400 + native.documents.length}`;
    const source = { uri: `${origin}/__joko/isolated-${native.documents.length}` };
    const documentUrl = `${origin}/${entry}`;
    const document = { documentId: `native-document-${native.documents.length}`, source, documentUrl, documentUrls: [source.uri, documentUrl], close: vi.fn(async () => undefined) };
    native.documents.push(document); return document;
  });
});

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
    Platform: { OS: "android" },
    Alert: { alert: native.alert },
    AppState: { get currentState() { return native.state; }, addEventListener: (_name: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } },
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

async function render(transport: MobileExtensionTransport, extension = fixtureExtension(), settings = false) {
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
      transport,
      settings
    }));
  });
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  native.web = undefined;
  native.messages = [];
  native.documents = [];
  native.prepare.mockReset();
  native.state = "active"; native.listeners.clear(); native.alert.mockReset(); native.authorize.mockReset(); vi.useRealTimers();
});

describe("MobileExtensionMainView", () => {
  it("opens the exact lease, hardens WebView navigation, probes before reload, and closes on leave", async () => {
    const extension = fixtureExtension();
    const surface = fixtureSurface(extension);
    const active = fixtureTransport(surface);
    await render(active, extension);

    expect(active.openMainView).toHaveBeenCalledWith(extension, expect.any(AbortSignal));
    expect(native.web).toMatchObject({
      source: native.documents[0]!.source,
      originWhitelist: ["*"],
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      javaScriptCanOpenWindowsAutomatically: false,
      setSupportMultipleWindows: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      domStorageEnabled: false,
      incognito: false,
      cacheEnabled: false,
      mixedContentMode: "never"
    });
    expect(native.web?.onHttpError).toBeTypeOf("function");
    const allow = native.web!.onShouldStartLoadWithRequest as (request: { readonly url: string }) => boolean;
    expect(allow({ url: native.documents[0]!.source.uri })).toBe(true);
    expect(allow({ url: native.documents[0]!.documentUrl })).toBe(true);
    expect(allow({ url: "https://node.example/v1/other" })).toBe(false);
    expect(allow({ url: "https://attacker.example/" })).toBe(false);

    await act(async () => (native.web!.onLoadEnd as () => void)());
    expect(container.textContent).not.toContain("Loading Extension content");
    await act(async () => {
      expect(allow({ url: surface.url.replace("index.html", "nested/page.html#loaded") })).toBe(false);
    });
    expect(active.readMainViewResource).toHaveBeenCalledWith(surface, surface.url.replace("index.html", "nested/page.html#loaded"), "document", expect.any(AbortSignal));
    expect(native.web).toMatchObject({ source: { uri: native.documents[1]!.source.uri + "#loaded" } });
    expect(native.documents[0]!.close).toHaveBeenCalledOnce();
    const reload = container.querySelector('button[aria-label="Reload main view"]') as HTMLButtonElement;
    await act(async () => reload.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(active.probeMainView).toHaveBeenCalledWith(surface, expect.any(AbortSignal));

    await act(async () => root.unmount());
    expect(active.closeMainView).toHaveBeenCalledWith(surface);
    expect(native.documents.at(-1)!.close).toHaveBeenCalledOnce();
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
    expect(native.web).toMatchObject({ source: native.documents.at(-1)!.source });
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
        id: "read", operation: { kind: "read", path: "mail" } } }), url: native.documents[0]!.documentUrl } };
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

  it("retires settings that are still opening when the app enters background", async () => {
    const extension = { ...fixtureExtension(), settings: { height: 400, mobileCustom: true } };
    const surface: MobileExtensionMainViewSurface = { ...fixtureSurface(extension), purpose: "settings", mobileSettings: true };
    const active = fixtureTransport(surface);
    let finish!: (surface: MobileExtensionMainViewSurface) => void;
    active.openSettings = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    await render(active, extension, true);
    const opening = vi.mocked(active.openSettings).mock.calls[0]![1];
    await act(async () => { native.state = "background"; native.listeners.forEach(listener => listener("background")); });
    expect(opening.aborted).toBe(true);
    await act(async () => finish(surface));
    expect(active.closeMainView).toHaveBeenCalledWith(surface);
    expect(active.readMainViewResource).not.toHaveBeenCalled(); expect(native.prepare).not.toHaveBeenCalled();
    expect(container.textContent).toContain("changed, expired, or lost its owner");
  });

  it.each(["owner", "background", "expired"])("does not accept an old settings confirmation after %s retirement", async reason => {
    const extension = { ...fixtureExtension(), settings: { height: 400, mobileCustom: true } };
    const surface: MobileExtensionMainViewSurface = { ...fixtureSurface(extension), purpose: "settings", mobileSettings: true };
    const active = fixtureTransport(surface), effect = vi.fn();
    active.openSettings = vi.fn(async () => surface);
    active.callSettings = vi.fn(async (_surface, _call, host, signal) => {
      if (await host.confirm("Clear credential", "Private token", signal)) effect();
      return { accepted: true };
    });
    if (reason === "expired") vi.useFakeTimers();
    await render(active, extension, true);
    const frame = native.web!;
    const receive = frame.onMessage as (event: { nativeEvent: { data: string; url: string } }) => void;
    await act(async () => receive({ nativeEvent: { url: native.documents[0]!.documentUrl,
      data: JSON.stringify({ frameId: `${surface.surfaceId}:0`, surfaceId: surface.surfaceId,
        request: { type: "joko:extension-settings-request", version: 1, id: "clear-original", command: { kind: "secret.clear", fieldId: "token" } } }) } }));
    expect(native.alert).toHaveBeenCalledOnce();
    const buttons = native.alert.mock.calls[0]![2] as Array<{ onPress?: () => void }>;
    if (reason === "owner") await render({ ...active, ownerKey: "owner-next" }, extension, true);
    else if (reason === "background") await act(async () => {
      native.state = "background"; native.listeners.forEach(listener => listener("background"));
      native.state = "active"; native.listeners.forEach(listener => listener("active"));
    });
    else await act(async () => vi.advanceTimersByTimeAsync(60_001));
    await act(async () => buttons[1]!.onPress?.());
    expect(effect).not.toHaveBeenCalled();
  });

  it("accepts settings SDK messages only from the current exact frame and document", async () => {
    const extension = { ...fixtureExtension(), library: { schemaVersion: 1 as const }, settings: { height: 400, mobileCustom: true } };
    const surface: MobileExtensionMainViewSurface = { ...fixtureSurface(extension), purpose: "settings", mobileSettings: true };
    const active = fixtureTransport(surface); active.openSettings = vi.fn(async () => surface);
    active.callSettings = vi.fn(async () => ({ context: { locale: "en" } }));
    await render(active, extension, true);
    const old = native.web!;
    const deliver = (web: Record<string, unknown>, id: string, frameId: string, url: string) => (web.onMessage as (event: unknown) => void)({
      nativeEvent: { url, data: JSON.stringify({ surfaceId: surface.surfaceId, frameId,
        request: { type: "joko:extension-settings-request", version: 1, id, command: { kind: "context.get" } } }) }
    });
    await act(async () => deliver(old, "first", `${surface.surfaceId}:0`, native.documents[0]!.documentUrl));
    expect(active.callSettings).toHaveBeenCalledOnce();
    const reload = container.querySelector('button[aria-label="Reload main view"]') as HTMLButtonElement;
    await act(async () => reload.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => {
      deliver(old, "retired", `${surface.surfaceId}:0`, native.documents[0]!.documentUrl);
      deliver(native.web!, "wrong-frame", `${surface.surfaceId}:0`, native.documents[1]!.documentUrl);
      deliver(native.web!, "wrong-document", `${surface.surfaceId}:1`, native.documents[0]!.documentUrl);
      deliver(native.web!, "wrong-origin", `${surface.surfaceId}:1`, "https://attacker.example/index.html");
    });
    expect(active.callSettings).toHaveBeenCalledOnce();
    await act(async () => deliver(native.web!, "second", `${surface.surfaceId}:1`, native.documents[1]!.documentUrl));
    expect(active.callSettings).toHaveBeenCalledTimes(2); expect(active.callLibrary).not.toHaveBeenCalled();
  });

  it("keeps a replacement native authorization owned when the retired authorization finishes late", async () => {
    const extension = { ...fixtureExtension(), settings: { height: 400, mobileCustom: true } };
    const first: MobileExtensionMainViewSurface = { ...fixtureSurface(extension), purpose: "settings", mobileSettings: true };
    const second = { ...first, surfaceId: `extension_surface_${"2".repeat(32)}`, url: first.url.replace(first.surfaceId, `extension_surface_${"2".repeat(32)}`) };
    const authorization = create(ExtensionOAuthAuthorizationSchema, { authorizeUrl: "https://accounts.example/authorize", callbackUrl: "http://127.0.0.1:4411/callback", state: "original-state-123456" });
    const pending: Array<{ finish: (value: { state: string; code: string }) => void; signal: AbortSignal }> = [];
    native.authorize.mockImplementation((_authorization, _expiry, signal: AbortSignal) => new Promise(resolve => pending.push({ finish: resolve, signal })));
    const active = fixtureTransport(first);
    active.openSettings = vi.fn(async () => first);
    active.callSettings = vi.fn(async (_surface, _call, host, signal) => { await host.authorize(authorization, Date.now() + 60_000, signal); return { connected: true }; });
    const deliver = (surface: MobileExtensionMainViewSurface, documentUrl: string) => (native.web!.onMessage as (event: unknown) => void)({ nativeEvent: {
      url: documentUrl, data: JSON.stringify({ surfaceId: surface.surfaceId, frameId: `${surface.surfaceId}:0`,
        request: { type: "joko:extension-settings-request", version: 1, id: "authorize-original", command: { kind: "oauth.connect", key: "mail" } } })
    } });
    await render(active, extension, true); await act(async () => deliver(first, native.documents[0]!.documentUrl));
    expect(pending).toHaveLength(1);
    const replacement = { ...fixtureTransport(second), ownerKey: "owner-next", openSettings: vi.fn(async () => second), callSettings: active.callSettings };
    await render(replacement, extension, true); await act(async () => deliver(second, native.documents[1]!.documentUrl));
    expect(pending).toHaveLength(2); expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => pending[0]!.finish({ state: authorization.state, code: "retired-code" }));
    await act(async () => { native.state = "background"; native.listeners.forEach(listener => listener("background")); });
    expect(pending[1]!.signal.aborted).toBe(false); expect(replacement.closeMainView).not.toHaveBeenCalled();
    await act(async () => { native.state = "active"; native.listeners.forEach(listener => listener("active")); pending[1]!.finish({ state: authorization.state, code: "current-code" }); });
    expect(native.messages.some(message => message.includes("retired-code"))).toBe(false);
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

  it("retires a native document prepared after its owner was unmounted", async () => {
    const surface = fixtureSurface(fixtureExtension()), active = fixtureTransport(surface);
    let complete!: (value: { documentId: string; source: { uri: string }; documentUrl: string; documentUrls: string[]; close: ReturnType<typeof vi.fn> }) => void;
    native.prepare.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await render(active);
    await act(async () => root.unmount()); root = undefined as unknown as Root;
    const late = { documentId: "late", source: { uri: "http://127.0.0.1:4409/__joko/late" }, documentUrl: "http://127.0.0.1:4409/index.html", documentUrls: [], close: vi.fn(async () => undefined) };
    await act(async () => complete(late));
    expect(late.close).toHaveBeenCalledOnce();
    expect(active.closeMainView).toHaveBeenCalledWith(surface);
  });

  it("loads permitted dynamic media over the owner transport and cancels a late resource when navigating", async () => {
    const surface = fixtureSurface(fixtureExtension()), active = fixtureTransport(surface);
    await render(active);
    const old = native.web!, source = native.documents[0]!.documentUrl;
    const receive = old.onMessage as (event: { nativeEvent: { data: string; url: string } }) => void;
    const resource = (id: string, url: string, kind = "media", text?: string) => ({ nativeEvent: { url: source,
      data: JSON.stringify({ type: "joko:extension-resource", version: 1, documentId: native.documents[0]!.documentId, id, kind, url, ...(text === undefined ? {} : { text }) }) } });
    vi.mocked(active.readMainViewResource).mockResolvedValueOnce({ bytes: Uint8Array.of(137, 80, 78, 71), mimeType: "image/png" });
    const media = surface.url.replace("index.html", "images/chart.png");
    await act(async () => receive(resource("image", media)));
    expect(active.readMainViewResource).toHaveBeenCalledWith(surface, media, "media", expect.any(AbortSignal), undefined);
    expect(JSON.parse(native.messages[0]!)).toMatchObject({ id: "image", ok: true, dataUrl: "data:image/png;base64,iVBORw==" });
    vi.mocked(active.readMainViewResource).mockResolvedValueOnce({ bytes: new TextEncoder().encode("export const x=1;"), mimeType: "text/javascript" });
    const moduleUrl = surface.url.replace("index.html", "chunks/lazy.js");
    await act(async () => receive(resource("module", moduleUrl, "module")));
    expect(active.readMainViewResource).toHaveBeenCalledWith(surface, moduleUrl, "module", expect.any(AbortSignal), undefined);
    expect(JSON.parse(native.messages[1]!)).toMatchObject({ id: "module", ok: true, dataUrl: expect.stringContaining("data:text/javascript;base64,") });
    vi.mocked(active.readMainViewResource).mockResolvedValueOnce({ bytes: new TextEncoder().encode("body{color:red}"), mimeType: "text/css" });
    await act(async () => receive(resource("style", surface.url, "style-text", "body{color:red}")));
    expect(active.readMainViewResource).toHaveBeenCalledWith(surface, surface.url, "style-text", expect.any(AbortSignal), "body{color:red}");
    await act(async () => receive(resource("external", "https://attacker.example/secret")));
    expect(active.readMainViewResource).toHaveBeenCalledTimes(4);
    let finish!: (value: { bytes: Uint8Array; mimeType: string }) => void;
    vi.mocked(active.readMainViewResource).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => receive(resource("late", media)));
    const request = vi.mocked(active.readMainViewResource).mock.calls.at(-1)![3];
    await act(async () => (old.onShouldStartLoadWithRequest as (request: { url: string }) => boolean)({ url: surface.url.replace("index.html", "next.html") }));
    expect(request.aborted).toBe(true);
    await act(async () => finish({ bytes: Uint8Array.of(9), mimeType: "image/png" }));
    expect(native.messages.some(message => JSON.parse(message).id === "late")).toBe(false);
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
    readMainViewResource: vi.fn(async () => ({ bytes: new TextEncoder().encode("<!doctype html><p>Isolated</p>"), mimeType: "text/html" })),
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
