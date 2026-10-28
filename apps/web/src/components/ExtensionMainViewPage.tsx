import { Code, ConnectError } from "@connectrpc/connect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ExternalLink, Menu, RefreshCcw } from "lucide-react";
import { createConnectionFetch } from "@joko/connection-transport";
import { parseExtensionSettingsBridgeRequest, type ExtensionSettingsDirectoryChoice } from "@joko/contracts";
import { ExtensionSettingsDirectoryDialog } from "./ExtensionSettingsDirectoryDialog.js";
import { mountIsolatedSurface } from "../isolated-surface.js";
import { bindExtensionSurfaceResources } from "../extension-main-view-resource-bridge.js";
import { bindExtensionViewClose, registerExtensionPageClose } from "../extension-view-lifecycle.js";

import type { AppController } from "../controller.js";
import type {
  ExtensionCatalogEntryView,
  ExtensionLibraryCallView,
  ExtensionLibraryCallResultView,
  ExtensionLibrarySessionView,
  ExtensionMainViewSurfaceView,
  ExtensionSettingsApi
} from "../model.js";
import {
  EXTENSION_LIBRARY_BRIDGE_RESPONSE,
  EXTENSION_LIBRARY_BRIDGE_VERSION,
  extensionLibraryBridgeCapabilities,
  parseExtensionLibraryBridgeRequest
} from "../extension-library-bridge.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Modal, Spinner } from "./ui.js";

type MainViewState =
  | { readonly phase: "loading" | "opening" }
  | { readonly phase: "ready"; readonly extension: ExtensionCatalogEntryView; readonly surface: ExtensionMainViewSurfaceView }
  | { readonly phase: "error" | "revoked"; readonly extension?: ExtensionCatalogEntryView };

export function ExtensionMainViewPage({
  controller: liveController,
  extensionId,
  t,
  navigationOpen,
  onOpenNavigation,
  onOpenIndependent,
  embedded = false,
  ownerDocument = document,
  registerCloseGuard,
  settings = false,
  onOpenLibrary
}: {
  readonly controller: AppController;
  readonly extensionId: string;
  readonly t: Translator;
  readonly navigationOpen: boolean;
  readonly onOpenNavigation: () => void;
  readonly onOpenIndependent: (extensionId: string) => void;
  readonly embedded?: boolean;
  readonly ownerDocument?: Document;
  readonly registerCloseGuard?: (guard: () => Promise<boolean>) => () => void;
  readonly settings?: boolean;
  readonly onOpenLibrary?: () => void;
}) {
  const controllerOwner = JSON.stringify([liveController.state.activeProfile?.id, liveController.state.activeProfile?.serverId,
    liveController.state.activeProfile?.origin, liveController.state.activeProfile?.endpointPublicKey,
    liveController.state.activeProfile?.transportKind, liveController.state.connectionGeneration, liveController.state.connectionState]);
  const liveOwnerRef = useRef(controllerOwner); liveOwnerRef.current = controllerOwner;
  // Snapshot refreshes are shared facts, not a new document/credential owner.
  const controller = useMemo(() => liveController, [controllerOwner]);
  const [state, setState] = useState<MainViewState>({ phase: "loading" });
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameRevision, setFrameRevision] = useState(0);
  const [frameEndpoint, setFrameEndpoint] = useState<string>();
  const [retryRevision, setRetryRevision] = useState(0);
  const requestRevision = useRef(0);
  const surfaceRef = useRef<ExtensionMainViewSurfaceView | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const libraryRef = useRef<{ readonly surfaceId: string; readonly extensionRevision: bigint; readonly session: ExtensionLibrarySessionView } | undefined>(undefined);
  const libraryOpeningRef = useRef<{ readonly surfaceId: string; readonly extensionRevision: bigint; readonly promise: Promise<ExtensionLibrarySessionView> } | undefined>(undefined);
  const bridgeEpoch = useRef(0);
  const closeGuard = useRef<() => Promise<boolean>>(async () => true);
  const settingsApi = useRef<ExtensionSettingsApi | undefined>(undefined);
  const settingsSurfaceClosers = useRef(new WeakMap<ExtensionMainViewSurfaceView, (surfaceId: string) => Promise<boolean>>());
  const settingsLibrary = useRef(onOpenLibrary); settingsLibrary.current = onOpenLibrary;
  const [confirmation, setConfirmation] = useState<{ readonly title: string; readonly body: string; readonly finish: (accepted: boolean) => void }>();
  const confirmationRef = useRef(confirmation); confirmationRef.current = confirmation;
  const [directoryChoice, setDirectoryChoice] = useState<{ readonly choice: ExtensionSettingsDirectoryChoice; readonly signal: AbortSignal; readonly finish: (entryId?: string) => void }>();
  const directoryChoiceRef = useRef(directoryChoice); directoryChoiceRef.current = directoryChoice;

  const closeLibrary = useCallback((): void => {
    const current = libraryRef.current;
    libraryRef.current = undefined;
    libraryOpeningRef.current = undefined;
    bridgeEpoch.current += 1;
    if (current !== undefined) void controller.closeExtensionLibrary(current.session.id).catch(() => undefined);
  }, [controller]);

  const releaseSurface = useCallback((surface: ExtensionMainViewSurfaceView | undefined): void => {
    if (surface === undefined) return;
    closeLibrary();
    if (surfaceRef.current === surface) surfaceRef.current = undefined;
    if (settings) {
      const close = settingsSurfaceClosers.current.get(surface); settingsSurfaceClosers.current.delete(surface);
      if (close) void close(surface.id).catch(() => undefined);
    }
    else void controller.closeExtensionMainView(surface.id).catch(() => undefined);
  }, [closeLibrary, controller, settings]);

  useEffect(() => {
    const request = ++requestRevision.current;
    const abort = new AbortController();
    let disposed = false;
    const previous = surfaceRef.current;
    surfaceRef.current = undefined;
    releaseSurface(previous);
    setFrameLoaded(false);
    setState({ phase: "loading" });
    void controller.getExtension(extensionId, undefined, abort.signal).then(async (catalog) => {
      if (disposed || request !== requestRevision.current || liveOwnerRef.current !== controllerOwner || abort.signal.aborted) return;
      const extension = catalog.extensions[0];
      if (extension === undefined || extension.id !== extensionId || (settings
        ? !extension.installed || !extension.settings || extension.owner.kind !== "resource" : !extensionMainViewReady(extension))) {
        if (!disposed && request === requestRevision.current) setState({ phase: "error", ...(extension === undefined ? {} : { extension }) });
        return;
      }
      if (!disposed && request === requestRevision.current) setState({ phase: "opening" });
      const api = settings ? controller.extensionSettingsApi() : undefined;
      if (settings && !api) throw new Error("Plugin author settings are unavailable.");
      settingsApi.current = api;
      const surface = settings ? await api!.open(extension.id, extension.revision, abort.signal)
        : await controller.openExtensionMainView(extension.id, extension.revision, abort.signal);
      if (settings) settingsSurfaceClosers.current.set(surface, id => api!.close(id));
      if (disposed || request !== requestRevision.current || liveOwnerRef.current !== controllerOwner || abort.signal.aborted || surface.extensionId !== extension.id) {
        releaseSurface(surface);
        return;
      }
      if (settings && (surface.purpose !== "settings" || surface.mobileSettings)) {
        releaseSurface(surface); throw new Error("The plugin settings purpose changed.");
      }
      surfaceRef.current = surface;
      setFrameEndpoint(surface.endpoint);
      setState({ phase: "ready", extension, surface });
    }).catch(() => {
      if (!disposed && !abort.signal.aborted && request === requestRevision.current) setState({ phase: "error" });
    });
    const releaseOnPageHide = (): void => releaseSurface(surfaceRef.current);
    const sourceWindow = ownerDocument.defaultView;
    sourceWindow?.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      disposed = true;
      requestRevision.current += 1;
      abort.abort();
      sourceWindow?.removeEventListener("pagehide", releaseOnPageHide);
      releaseSurface(surfaceRef.current);
    };
  }, [controller, controllerOwner, extensionId, releaseSurface, retryRevision, settings, ownerDocument]);

  useEffect(() => {
    if (state.phase !== "ready") return undefined;
    const expected = state.surface;
    const timer = window.setInterval(() => {
      const request = requestRevision.current;
      void controller.getExtensionMainViewSurface(expected.id).then((current) => {
        if (request !== requestRevision.current || surfaceRef.current?.id !== expected.id) return;
        if (!sameExtensionMainViewSurface(expected, current)) {
          releaseSurface(expected);
          setState({ phase: "revoked", extension: state.extension });
          setFrameLoaded(false);
        }
      }).catch(() => {
        if (request !== requestRevision.current || surfaceRef.current?.id !== expected.id) return;
        releaseSurface(expected);
        setState({ phase: "revoked", extension: state.extension });
        setFrameLoaded(false);
      });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [controller, releaseSurface, state]);

  const surfaceUrl = useMemo(() => {
    if (state.phase !== "ready") return undefined;
    const origin = controller.state.activeProfile?.origin ?? window.location.origin;
    try {
      const url = new URL(frameEndpoint ?? state.surface.endpoint, origin);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
      return undefined;
    }
  }, [controller.state.activeProfile?.origin, frameEndpoint, state]);

  useEffect(() => {
    if (state.phase === "ready" && surfaceUrl === undefined) {
      releaseSurface(state.surface);
      setState({ phase: "error", extension: state.extension });
    }
  }, [releaseSurface, state, surfaceUrl]);

  useEffect(() => {
    if (state.phase !== "ready" || surfaceUrl === undefined || frameRef.current === null) return;
    const frame = frameRef.current, profile = controller.state.activeProfile;
    const abort = new AbortController();
    const failed = () => {
      if (abort.signal.aborted || surfaceRef.current?.id !== state.surface.id) return;
      releaseSurface(state.surface); setFrameLoaded(false); setState({ phase: "error", extension: state.extension });
    };
    const current = () => liveOwnerRef.current === controllerOwner && surfaceRef.current?.id === state.surface.id && controller.state.activeProfile?.id === profile?.id
      && controller.state.activeProfile?.serverId === profile?.serverId && controller.state.activeProfile?.endpointPublicKey === profile?.endpointPublicKey
      && controller.state.activeProfile?.origin === profile?.origin;
    let fetcher: typeof globalThis.fetch | undefined;
    try { fetcher = profile === undefined ? undefined : createConnectionFetch(profile); } catch { failed(); return () => abort.abort(); }
    const resourceRoot = new URL(state.surface.endpoint.slice(0, state.surface.endpoint.lastIndexOf("/") + 1), profile?.origin ?? window.location.origin).href;
    const disposeResources = fetcher === undefined ? () => {} : bindExtensionSurfaceResources(frame, { resourceRoot, fetch: fetcher,
      signal: abort.signal, current, navigate: url => { if (current()) { closeLibrary(); setFrameLoaded(false); setFrameEndpoint(new URL(url).pathname + new URL(url).hash); setFrameRevision(value => value + 1); } } });
    const document = (async () => {
      if (profile === undefined || new URL(surfaceUrl).origin !== new URL(profile.origin).origin) throw new Error("Extension surface endpoint changed.");
      const response = await fetcher!(surfaceUrl, { headers: { "x-joko-isolated-document": "1" }, signal: abort.signal });
      if (!response.ok) throw new Error("Extension surface is unavailable.");
      const html = await response.text(), policy = response.headers.get("content-security-policy");
      abort.signal.throwIfAborted();
      if (!current() || !policy) throw new Error("Extension surface authority changed.");
      return { html, policy, baseUrl: surfaceUrl };
    })();
    const dispose = mountIsolatedSurface(frame, document, { signal: abort.signal, failed, bootstrapBaseUrl: window.location.href });
    return () => { abort.abort(); disposeResources(); dispose(); };
  }, [closeLibrary, controller, frameRevision, releaseSurface, state, surfaceUrl, ownerDocument]);

  useEffect(() => {
    const frame = frameRef.current;
    if (state.phase !== "ready" || frame === null) return;
    const expected = state.surface.id;
    const bridge = bindExtensionViewClose(frame, () => surfaceRef.current?.id === expected && frameRef.current === frame && frame.isConnected);
    closeGuard.current = bridge.close;
    const unregister = registerCloseGuard?.(bridge.close);
    const unregisterPage = embedded || settings ? undefined : registerExtensionPageClose(controller.state.activeProfile, extensionId, bridge.close);
    return () => { if (closeGuard.current === bridge.close) closeGuard.current = async () => true; unregister?.(); unregisterPage?.(); bridge.dispose(); };
  }, [state, frameRevision, ownerDocument, registerCloseGuard, embedded, extensionId, controller, settings]);

  useEffect(() => {
    if (settings || state.phase !== "ready" || state.extension.library === undefined || surfaceUrl === undefined) return undefined;
    const frame = frameRef.current;
    if (frame === null) return undefined;
    const epoch = ++bridgeEpoch.current;
    const abort = new AbortController();
    const pending = new Set<string>();
    const desktopLibrary = window.jokoDesktop?.capabilities.includes("extension.libraryGestures") === true
      ? window.jokoDesktop.extensionLibraries
      : undefined;
    const current = (): boolean => bridgeEpoch.current === epoch && surfaceRef.current?.id === state.surface.id
      && frameRef.current === frame && frame.isConnected;
    const ensureLibrary = async (): Promise<ExtensionLibrarySessionView> => {
      const existing = libraryRef.current;
      if (existing?.surfaceId === state.surface.id && existing.extensionRevision === state.extension.revision
        && existing.session.expiresAt > Date.now()) return existing.session;
      const opening = libraryOpeningRef.current;
      if (opening?.surfaceId === state.surface.id && opening.extensionRevision === state.extension.revision) return opening.promise;
      if (existing !== undefined) {
        libraryRef.current = undefined;
        await controller.closeExtensionLibrary(existing.session.id).catch(() => undefined);
      }
      const promise = controller.openExtensionLibrary(state.extension.id, state.extension.revision, state.surface.id, abort.signal).then((opened) => {
        if (!current()) {
          void controller.closeExtensionLibrary(opened.id).catch(() => undefined);
          throw new Error("Extension Library bridge was revoked.");
        }
        libraryRef.current = { surfaceId: state.surface.id, extensionRevision: state.extension.revision, session: opened };
        return opened;
      });
      const record = { surfaceId: state.surface.id, extensionRevision: state.extension.revision, promise };
      libraryOpeningRef.current = record;
      try {
        return await promise;
      } finally {
        if (libraryOpeningRef.current === record) libraryOpeningRef.current = undefined;
      }
    };
    const callLibrary = async (
      session: ExtensionLibrarySessionView,
      call: ExtensionLibraryCallView
    ): Promise<ExtensionLibraryCallResultView> => {
      try {
        return await controller.callExtensionLibrary(session.id, call, abort.signal);
      } catch (error) {
        if (libraryRef.current?.session.id === session.id) {
          libraryRef.current = undefined;
          void controller.closeExtensionLibrary(session.id).catch(() => undefined);
        }
        throw error;
      }
    };
    const liveRoot = async (session: ExtensionLibrarySessionView): Promise<string> => {
      const overview = await controller.getExtensionLibraryOverview(state.extension.id, state.extension.revision, abort.signal);
      if (overview.state === "unavailable" || overview.location === undefined
        || overview.location.generation !== session.bindingGeneration) {
        throw new Error("Extension Library binding changed before its native gesture.");
      }
      return overview.location.path;
    };
    const respond = (id: string, response: { readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }): void => {
      if (!current() || frame.contentWindow === null) return;
      frame.contentWindow.postMessage({
        type: EXTENSION_LIBRARY_BRIDGE_RESPONSE,
        version: EXTENSION_LIBRARY_BRIDGE_VERSION,
        id,
        ...response
      }, "*");
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!current() || event.source !== frame.contentWindow || event.origin !== "null") return;
      const request = parseExtensionLibraryBridgeRequest(event.data);
      if (request === undefined || pending.has(request.id)) return;
      pending.add(request.id);
      void (async () => {
        if (request.command.kind === "capabilities") {
          return extensionLibraryBridgeCapabilities(desktopLibrary === undefined ? [] : ["reveal", "saveAs", "clipboardWrite"]);
        }
        if (request.command.kind === "status") {
          const overview = await controller.getExtensionLibraryOverview(state.extension.id, state.extension.revision, abort.signal);
          return {
            state: overview.state,
            ...(overview.unavailableReason === undefined ? {} : { unavailableReason: overview.unavailableReason }),
            location: overview.location?.kind,
            files: overview.files,
            bytes: overview.bytes,
            ...(overview.diskFreeBytes === undefined ? {} : { diskFreeBytes: overview.diskFreeBytes }),
            softLimitBytes: overview.softLimitBytes,
            softLimitExceeded: overview.softLimitExceeded,
            orphaned: overview.orphaned,
            ...(overview.operation === undefined ? {} : { operation: { ...overview.operation } })
          };
        }
        const session = await ensureLibrary();
        if (request.command.kind === "open") return {
          extensionId: session.extensionId,
          expiresAt: session.expiresAt,
          bindingGeneration: session.bindingGeneration,
          limits: { ...session.limits }
        };
        if (request.command.kind === "reveal") {
          if (desktopLibrary === undefined) throw new Error("Extension Library native gestures are unavailable.");
          const stat = await callLibrary(session, { kind: "stat", path: request.command.path });
          if (stat.kind !== "stat" || stat.entry.kind !== "file") throw new Error("Extension Library reveal requires a file.");
          const root = await liveRoot(session);
          if (!current() || libraryRef.current?.session.id !== session.id) throw new Error("Extension Library bridge was revoked.");
          await desktopLibrary.reveal({ extensionId: state.extension.id, root, path: request.command.path });
          return { path: request.command.path };
        }
        if (request.command.kind === "saveAs") {
          if (desktopLibrary === undefined) throw new Error("Extension Library native gestures are unavailable.");
          const stat = await callLibrary(session, { kind: "stat", path: request.command.path });
          if (stat.kind !== "stat" || stat.entry.kind !== "file") throw new Error("Extension Library save requires a file.");
          const selection = await desktopLibrary.beginSave({
            extensionId: state.extension.id,
            name: request.command.name ?? request.command.path.split("/").at(-1)!
          });
          if (selection.cancelled) return { cancelled: true };
          let committed = false;
          try {
            if (!current() || libraryRef.current?.session.id !== session.id) throw new Error("Extension Library bridge was revoked.");
            const verified = await callLibrary(session, { kind: "stat", path: request.command.path });
            if (verified.kind !== "stat" || verified.entry.kind !== "file") throw new Error("Extension Library save source changed.");
            const root = await liveRoot(session);
            if (!current() || libraryRef.current?.session.id !== session.id) throw new Error("Extension Library bridge was revoked.");
            const bytes = await desktopLibrary.commitSave({
              extensionId: state.extension.id,
              ticketId: selection.ticketId,
              root,
              path: request.command.path
            });
            committed = true;
            return { cancelled: false, path: request.command.path, bytes };
          } finally {
            if (!committed) void desktopLibrary.cancelSave(selection.ticketId).catch(() => undefined);
          }
        }
        if (request.command.kind === "clipboardWrite") {
          if (desktopLibrary === undefined) throw new Error("Extension Library native gestures are unavailable.");
          await liveRoot(session);
          if (!current() || libraryRef.current?.session.id !== session.id) throw new Error("Extension Library bridge was revoked.");
          const bytes = await desktopLibrary.clipboardWrite({ extensionId: state.extension.id, bytes: request.command.content });
          return { bytes };
        }
        if (request.command.kind !== "call") throw new Error("Unsupported Extension Library bridge operation.");
        return callLibrary(session, request.command.call);
      })().then((result) => respond(request.id, { ok: true, result })).catch((cause: unknown) => {
        respond(request.id, { ok: false, error: libraryBridgeFailure(cause) });
      }).finally(() => pending.delete(request.id));
    };
    const bridgeWindow = ownerDocument.defaultView!;
    bridgeWindow.addEventListener("message", onMessage);
    return () => {
      bridgeEpoch.current += 1;
      abort.abort();
      pending.clear();
      bridgeWindow.removeEventListener("message", onMessage);
      closeLibrary();
    };
  }, [closeLibrary, controller, frameRevision, state, surfaceUrl, ownerDocument, settings]);

  useEffect(() => {
    const frame = frameRef.current, api = settingsApi.current, sourceWindow = ownerDocument.defaultView;
    if (!settings || state.phase !== "ready" || state.surface.purpose !== "settings" || !frame || !api || !sourceWindow) return;
    const profile = controller.state.activeProfile, seen = new Set<string>(), pending = new Set<AbortController>();
    let closed = false, faulted = false, queue: Promise<unknown> = Promise.resolve();
    const current = () => !closed && liveOwnerRef.current === controllerOwner && frameRef.current === frame && frame.isConnected && surfaceRef.current?.id === state.surface.id
      && controller.state.activeProfile?.id === profile?.id && controller.state.activeProfile?.serverId === profile?.serverId
      && controller.state.activeProfile?.origin === profile?.origin && controller.state.activeProfile?.endpointPublicKey === profile?.endpointPublicKey;
    const listener = (event: MessageEvent) => {
      if (!current() || ownerDocument.visibilityState === "hidden" || event.source !== frame.contentWindow || event.origin !== "null") return;
      let size: number; try { size = JSON.stringify(event.data).length; } catch { return; }
      if (size > 96 * 1024) return;
      const request = parseExtensionSettingsBridgeRequest(event.data);
      if (!request || seen.has(request.id) || seen.size >= 4096 || pending.size >= 16) return;
      seen.add(request.id);
      const respond = (ok: boolean, result?: unknown) => {
        if (!current()) return;
        const data = { type: "joko:extension-settings-response", version: 1, id: request.id, ok,
          ...(ok ? { result } : { message: "Settings request could not be confirmed. Check its original operation before retrying." }) };
        if (JSON.stringify(data, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value).length > (request.command.kind === "directory.pick" ? 4 * 1024 * 1024 : 192 * 1024)) throw new Error("Settings response exceeds its limit.");
        frame.contentWindow?.postMessage(data, "*");
      };
      if (faulted) { respond(false); return; }
      const abort = new AbortController(); pending.add(abort);
      const timer = setTimeout(() => abort.abort(), request.command.kind === "oauth.connect" ? 310_000 : request.command.kind === "directory.pick" ? 150_000 : 60_000);
      let dispatched = false;
      const work = queue.then(async () => {
        abort.signal.throwIfAborted(); if (!current() || faulted) throw new Error("Settings document retired."); dispatched = true;
        return api.call(state.surface, request.command, {
          locale: ownerDocument.documentElement.lang || "en",
          chooseDirectory: (choice, signal) => new Promise<string | undefined>(resolve => {
            directoryChoiceRef.current?.finish();
            let settled = false;
            const finish = (entryId?: string) => {
              if (settled) return; settled = true; signal.removeEventListener("abort", cancel);
              if (directoryChoiceRef.current?.finish === finish) directoryChoiceRef.current = undefined;
              setDirectoryChoice(value => value?.finish === finish ? undefined : value);
              resolve(current() && !signal.aborted && ownerDocument.visibilityState !== "hidden" ? entryId : undefined);
            };
            const cancel = () => finish();
            const next = { choice, signal, finish }; directoryChoiceRef.current = next; setDirectoryChoice(next);
            signal.addEventListener("abort", cancel, { once: true });
            if (!current() || signal.aborted || ownerDocument.visibilityState === "hidden") cancel();
          }),
          confirm: async (title, body, signal) => {
            if (!current() || signal.aborted || ownerDocument.visibilityState === "hidden") return false;
            return new Promise<boolean>(resolve => {
              confirmationRef.current?.finish(false);
              let settled = false;
              const finish = (accepted: boolean) => {
                if (settled) return; settled = true;
                signal.removeEventListener("abort", cancel);
                if (confirmationRef.current?.finish === finish) confirmationRef.current = undefined;
                setConfirmation(value => value?.finish === finish ? undefined : value);
                resolve(accepted && current() && !signal.aborted && ownerDocument.visibilityState !== "hidden");
              };
              const cancel = () => finish(false);
              const next = { title, body, finish };
              confirmationRef.current = next; setConfirmation(next);
              signal.addEventListener("abort", cancel, { once: true });
              if (signal.aborted || !current()) cancel();
            });
          },
          authorize: async () => { throw new Error("Use the installed native account authorization flow."); },
          openLibrary: async signal => { signal.throwIfAborted(); if (!current() || !settingsLibrary.current) throw new Error("Plugin Library is unavailable."); settingsLibrary.current(); }
        }, abort.signal);
      });
      const stopped = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(new Error("Settings request retired.")), { once: true }));
      const completion = Promise.race([work, stopped]); queue = completion.catch(() => undefined);
      void completion.then(result => respond(true, result), () => {
        if (dispatched && !["context.get", "routing.get", "setup.get", "oauth.get", "connections.get", "secret.check", "library.open"].includes(request.command.kind)) faulted = true;
        respond(false);
      }).catch(() => { faulted = true; }).finally(() => { clearTimeout(timer); abort.abort(); pending.delete(abort); });
    };
    sourceWindow.addEventListener("message", listener);
    return () => { closed = true; sourceWindow.removeEventListener("message", listener); for (const abort of pending) abort.abort(); };
  }, [controller, frameRevision, ownerDocument, settings, state]);

  const extension = "extension" in state ? state.extension : undefined;
  const title = state.phase === "ready"
    ? state.surface.title ?? state.extension.mainView?.title ?? state.extension.name
    : extension?.mainView?.title ?? extension?.name ?? t("extensions.mainView.title");
  const back = (): void => controller.navigate({ kind: "tools", extensionId });
  const retry = (): void => setRetryRevision((value) => value + 1);
  const reload = (): void => {
    if (state.phase !== "ready") return;
    const expected = state.surface;
    void controller.getExtensionMainViewSurface(expected.id).then((current) => {
      if (surfaceRef.current?.id !== expected.id) return;
      if (!sameExtensionMainViewSurface(expected, current)) throw new Error("surface changed");
      closeLibrary();
      setFrameLoaded(false);
      setFrameRevision((value) => value + 1);
    }).catch(() => {
      if (surfaceRef.current?.id !== expected.id) return;
      releaseSurface(expected);
      setState({ phase: "revoked", extension: state.extension });
    });
  };

  return <main className="extension-main-view-page">
    {!embedded && <header className="extension-main-view-page__header">
      <div className="extension-main-view-page__leading">
        {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
        <IconButton label={t("extensions.mainView.back")} onClick={back}><ArrowLeft aria-hidden="true" /></IconButton>
        <div><p className="eyebrow">{t("extensions.mainView.eyebrow")}</p><h1>{title}</h1></div>
      </div>
      <div className="extension-main-view-page__actions">
        {state.phase === "ready" && <IconButton label={t("extensions.mainView.reload")} onClick={reload}><RefreshCcw aria-hidden="true" /></IconButton>}
        {extensionMainViewReady(extension) && <Button tone="ghost" onClick={() => onOpenIndependent(extension.id)}><ExternalLink aria-hidden="true" />{t("extensions.mainView.openWindow")}</Button>}
      </div>
    </header>}
    <section className="extension-main-view-page__surface" aria-busy={state.phase === "loading" || state.phase === "opening" || !frameLoaded}>
      {(state.phase === "loading" || state.phase === "opening") && <div className="extension-main-view-page__status"><Spinner /><p>{state.phase === "loading" ? t("extensions.mainView.loading") : t("extensions.mainView.opening")}</p></div>}
      {(state.phase === "error" || state.phase === "revoked") && <div className="extension-main-view-page__status extension-main-view-page__status--error"><AlertTriangle aria-hidden="true" /><h2>{state.phase === "revoked" ? t("extensions.mainView.revoked") : t("extensions.mainView.unavailable")}</h2><p>{state.phase === "revoked" ? t("extensions.mainView.revokedBody") : t("extensions.mainView.unavailableBody")}</p><div><Button tone="primary" onClick={retry}>{t("common.retry")}</Button><Button tone="ghost" onClick={back}>{t("extensions.mainView.back")}</Button></div></div>}
      {state.phase === "ready" && surfaceUrl !== undefined && <>
        {!frameLoaded && <div className="extension-main-view-page__status"><Spinner /><p>{t("extensions.mainView.loadingContent")}</p></div>}
        <iframe
          ref={frameRef}
          key={`${state.surface.id}:${frameRevision}`}
          className="extension-main-view-page__frame"
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => { if (surfaceRef.current?.id === state.surface.id) setFrameLoaded(true); }}
          onError={() => {
            if (surfaceRef.current?.id !== state.surface.id) return;
            releaseSurface(state.surface);
            setFrameLoaded(false);
            setState({ phase: "error", extension: state.extension });
          }}
        />
      </>}
    </section>
    {confirmation && <Modal open title={confirmation.title} ownerDocument={ownerDocument} dialogRole="alertdialog"
      onClose={() => confirmation.finish(false)} closeLabel={t("common.cancel")} size="small">
      <p style={{ whiteSpace: "pre-wrap" }}>{confirmation.body}</p>
      <div className="modal-actions"><Button tone="ghost" onClick={() => confirmation.finish(false)}>{t("common.cancel")}</Button>
        <Button tone="primary" onClick={() => confirmation.finish(true)}>{t("common.confirm")}</Button></div>
    </Modal>}
    {directoryChoice && <ExtensionSettingsDirectoryDialog choice={directoryChoice.choice} signal={directoryChoice.signal} finish={directoryChoice.finish} t={t} ownerDocument={ownerDocument} />}
  </main>;
}

function libraryBridgeFailure(cause: unknown): { readonly code: string; readonly message: string } {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return { code: "CANCELLED", message: "Extension Library operation was cancelled." };
  }
  if (!(cause instanceof ConnectError)) {
    return { code: "INTERNAL", message: "Extension Library operation failed." };
  }
  switch (cause.code) {
    case Code.InvalidArgument:
    case Code.OutOfRange:
      return { code: "INVALID_REQUEST", message: "Extension Library request was invalid." };
    case Code.NotFound:
      return { code: "NOT_FOUND", message: "Extension Library item was not found." };
    case Code.AlreadyExists:
      return { code: "ALREADY_EXISTS", message: "Extension Library target already exists." };
    case Code.ResourceExhausted:
      return { code: "LIMIT_EXCEEDED", message: "Extension Library request exceeded a storage or result limit." };
    case Code.Aborted:
      return { code: "CONFLICT", message: "Extension Library changed before the operation completed." };
    case Code.FailedPrecondition:
    case Code.Unavailable:
      return { code: "UNAVAILABLE", message: "Extension Library is unavailable or changed." };
    case Code.PermissionDenied:
    case Code.Unauthenticated:
      return { code: "PERMISSION_DENIED", message: "Extension Library request was not authorized." };
    case Code.Unimplemented:
      return { code: "UNSUPPORTED", message: "Extension Library operation is not supported." };
    case Code.DeadlineExceeded:
      return { code: "TIMEOUT", message: "Extension Library operation timed out." };
    case Code.Canceled:
      return { code: "CANCELLED", message: "Extension Library operation was cancelled." };
    case Code.DataLoss:
      return { code: "CORRUPT", message: "Extension Library data failed integrity verification." };
    default:
      return { code: "INTERNAL", message: "Extension Library operation failed." };
  }
}

export function extensionMainViewReady(extension: ExtensionCatalogEntryView | undefined): extension is ExtensionCatalogEntryView & { readonly mainView: NonNullable<ExtensionCatalogEntryView["mainView"]> } {
  return extension !== undefined && extension.mainView !== undefined && extension.owner.kind === "resource"
    && extension.installed && extension.enabled && extension.sidebarSupported
    && (extension.setup.state === "ready" || extension.setup.state === "notRequired")
    && (extension.installState === "installed" || extension.installState === "updateAvailable");
}

export function sameExtensionMainViewSurface(left: ExtensionMainViewSurfaceView, right: ExtensionMainViewSurfaceView): boolean {
  return left.id === right.id && left.extensionId === right.extensionId && left.endpoint === right.endpoint
    && left.owner.resourceId === right.owner.resourceId && left.owner.resourceRevision === right.owner.resourceRevision
    && left.owner.discoveredRevision === right.owner.discoveredRevision && left.backendId === right.backendId
    && left.backendRevision === right.backendRevision && left.backendGeneration === right.backendGeneration
    && left.expiresAt === right.expiresAt && left.title === right.title && left.icon === right.icon
    && left.purpose === right.purpose && left.mobileSettings === right.mobileSettings;
}
