import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, ExternalLink, Menu, RefreshCcw } from "lucide-react";

import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView, ExtensionMainViewSurfaceView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Spinner } from "./ui.js";

type MainViewState =
  | { readonly phase: "loading" | "opening" }
  | { readonly phase: "ready"; readonly extension: ExtensionCatalogEntryView; readonly surface: ExtensionMainViewSurfaceView }
  | { readonly phase: "error" | "revoked"; readonly extension?: ExtensionCatalogEntryView };

export function ExtensionMainViewPage({
  controller,
  extensionId,
  t,
  navigationOpen,
  onOpenNavigation,
  onOpenIndependent
}: {
  readonly controller: AppController;
  readonly extensionId: string;
  readonly t: Translator;
  readonly navigationOpen: boolean;
  readonly onOpenNavigation: () => void;
  readonly onOpenIndependent: (extensionId: string) => void;
}) {
  const [state, setState] = useState<MainViewState>({ phase: "loading" });
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [frameRevision, setFrameRevision] = useState(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const requestRevision = useRef(0);
  const surfaceRef = useRef<ExtensionMainViewSurfaceView | undefined>(undefined);

  const releaseSurface = useCallback((surface: ExtensionMainViewSurfaceView | undefined): void => {
    if (surface === undefined) return;
    if (surfaceRef.current?.id === surface.id) surfaceRef.current = undefined;
    void controller.closeExtensionMainView(surface.id).catch(() => undefined);
  }, [controller]);

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
      const extension = catalog.extensions[0];
      if (extension === undefined || extension.id !== extensionId || !extensionMainViewReady(extension)) {
        if (!disposed && request === requestRevision.current) setState({ phase: "error", ...(extension === undefined ? {} : { extension }) });
        return;
      }
      if (!disposed && request === requestRevision.current) setState({ phase: "opening" });
      const surface = await controller.openExtensionMainView(extension.id, extension.revision, abort.signal);
      if (disposed || request !== requestRevision.current || surface.extensionId !== extension.id) {
        releaseSurface(surface);
        return;
      }
      surfaceRef.current = surface;
      setState({ phase: "ready", extension, surface });
    }).catch(() => {
      if (!disposed && !abort.signal.aborted && request === requestRevision.current) setState({ phase: "error" });
    });
    const releaseOnPageHide = (): void => releaseSurface(surfaceRef.current);
    window.addEventListener("pagehide", releaseOnPageHide);
    return () => {
      disposed = true;
      requestRevision.current += 1;
      abort.abort();
      window.removeEventListener("pagehide", releaseOnPageHide);
      releaseSurface(surfaceRef.current);
    };
  }, [controller, extensionId, releaseSurface, retryRevision]);

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
      const url = new URL(state.surface.endpoint, origin);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
      return undefined;
    }
  }, [controller.state.activeProfile?.origin, state]);

  useEffect(() => {
    if (state.phase === "ready" && surfaceUrl === undefined) {
      releaseSurface(state.surface);
      setState({ phase: "error", extension: state.extension });
    }
  }, [releaseSurface, state, surfaceUrl]);

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
      setFrameLoaded(false);
      setFrameRevision((value) => value + 1);
    }).catch(() => {
      if (surfaceRef.current?.id !== expected.id) return;
      releaseSurface(expected);
      setState({ phase: "revoked", extension: state.extension });
    });
  };

  return <main className="extension-main-view-page">
    <header className="extension-main-view-page__header">
      <div className="extension-main-view-page__leading">
        {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
        <IconButton label={t("extensions.mainView.back")} onClick={back}><ArrowLeft aria-hidden="true" /></IconButton>
        <div><p className="eyebrow">{t("extensions.mainView.eyebrow")}</p><h1>{title}</h1></div>
      </div>
      <div className="extension-main-view-page__actions">
        {state.phase === "ready" && <IconButton label={t("extensions.mainView.reload")} onClick={reload}><RefreshCcw aria-hidden="true" /></IconButton>}
        {extensionMainViewReady(extension) && <Button tone="ghost" onClick={() => onOpenIndependent(extension.id)}><ExternalLink aria-hidden="true" />{t("extensions.mainView.openWindow")}</Button>}
      </div>
    </header>
    <section className="extension-main-view-page__surface" aria-busy={state.phase === "loading" || state.phase === "opening" || !frameLoaded}>
      {(state.phase === "loading" || state.phase === "opening") && <div className="extension-main-view-page__status"><Spinner /><p>{state.phase === "loading" ? t("extensions.mainView.loading") : t("extensions.mainView.opening")}</p></div>}
      {(state.phase === "error" || state.phase === "revoked") && <div className="extension-main-view-page__status extension-main-view-page__status--error"><AlertTriangle aria-hidden="true" /><h2>{state.phase === "revoked" ? t("extensions.mainView.revoked") : t("extensions.mainView.unavailable")}</h2><p>{state.phase === "revoked" ? t("extensions.mainView.revokedBody") : t("extensions.mainView.unavailableBody")}</p><div><Button tone="primary" onClick={retry}>{t("common.retry")}</Button><Button tone="ghost" onClick={back}>{t("extensions.mainView.back")}</Button></div></div>}
      {state.phase === "ready" && surfaceUrl !== undefined && <>
        {!frameLoaded && <div className="extension-main-view-page__status"><Spinner /><p>{t("extensions.mainView.loadingContent")}</p></div>}
        <iframe
          key={`${state.surface.id}:${frameRevision}`}
          className="extension-main-view-page__frame"
          src={surfaceUrl}
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
  </main>;
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
    && left.expiresAt === right.expiresAt && left.title === right.title && left.icon === right.icon;
}
