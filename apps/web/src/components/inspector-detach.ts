export const INSPECTOR_DETACH_CAPABILITY = "inspector.detach";
export const INSPECTOR_WINDOW_FRAME_NAME = "joko-inspector-window";
export const INSPECTOR_WINDOW_URL = "about:blank";
export const INSPECTOR_WINDOW_FEATURES = "popup,width=520,height=860";

export interface DetachedInspectorHost {
  readonly window: Window;
  readonly root: HTMLElement;
}

export function inspectorDetachAvailable(desktop: JokoDesktopApi | undefined): boolean {
  return Array.isArray(desktop?.capabilities) &&
    desktop.capabilities.includes(INSPECTOR_DETACH_CAPABILITY) &&
    typeof desktop.inspectorWindow?.onClosed === "function";
}

export function openDetachedInspectorWindow(
  openWindow: (url?: string | URL, target?: string, features?: string) => Window | null = window.open.bind(window)
): Window | null {
  return openWindow(INSPECTOR_WINDOW_URL, INSPECTOR_WINDOW_FRAME_NAME, INSPECTOR_WINDOW_FEATURES);
}

export function initializeDetachedInspectorHost(
  child: Window,
  source: Document,
  title: string
): DetachedInspectorHost {
  if (child.jokoDesktop !== undefined) {
    throw new Error("The detached Inspector inherited the full Desktop bridge.");
  }
  const control = child.jokoInspectorDesktop;
  if (
    control === undefined ||
    typeof control.platform !== "string" ||
    typeof control.window?.ready !== "function" ||
    typeof control.window.minimize !== "function" ||
    typeof control.window.toggleMaximize !== "function" ||
    typeof control.window.close !== "function"
  ) {
    throw new Error("The detached Inspector control bridge is unavailable.");
  }

  const target = child.document;
  target.head.replaceChildren();
  const charset = target.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  target.head.append(charset);
  for (const node of source.head.querySelectorAll("style, link[rel='stylesheet']")) {
    if (node instanceof HTMLStyleElement) {
      const style = target.createElement("style");
      style.textContent = node.textContent;
      target.head.append(style);
      continue;
    }
    if (node instanceof HTMLLinkElement) {
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = node.href;
      if (node.media !== "") link.media = node.media;
      if (node.integrity !== "") link.integrity = node.integrity;
      if (node.crossOrigin !== null) link.crossOrigin = node.crossOrigin;
      link.referrerPolicy = node.referrerPolicy;
      target.head.append(link);
    }
  }

  const root = target.createElement("div");
  root.id = "joko-inspector-root";
  target.body.replaceChildren(root);
  target.title = title;
  syncDetachedInspectorDocument(child, source);

  // The portal retains an explicit Document reference. Severing the ambient
  // opener prevents any future script in the child realm from reaching the
  // main renderer's broader Desktop bridge (especially credentials).
  child.opener = null;
  return { window: child, root };
}

export function syncDetachedInspectorDocument(child: Window, source: Document): void {
  const sourceRoot = source.documentElement;
  const targetRoot = child.document.documentElement;
  targetRoot.lang = sourceRoot.lang;
  targetRoot.dir = sourceRoot.dir;
  targetRoot.style.cssText = sourceRoot.style.cssText;
  child.document.body.style.cssText = source.body.style.cssText;
  const theme = sourceRoot.dataset["theme"];
  if (theme === undefined) delete targetRoot.dataset["theme"];
  else targetRoot.dataset["theme"] = theme;
  const platform = child.jokoInspectorDesktop?.platform;
  if (platform === undefined) delete targetRoot.dataset["desktopPlatform"];
  else targetRoot.dataset["desktopPlatform"] = platform;
}

export function detachedInspectorHostAlive(host: DetachedInspectorHost | undefined): host is DetachedInspectorHost {
  return host !== undefined && !host.window.closed && host.root.isConnected;
}
