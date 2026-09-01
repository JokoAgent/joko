export const SESSION_WINDOW_DRAG_PREVIEW_TIMEOUT_MS = 30_000;

interface SessionWindowDragPreviewStart {
  readonly dataTransfer: DataTransfer;
  readonly row: HTMLElement;
  readonly sessionId: string;
  readonly label: string;
  readonly hint: string;
  readonly ownerWindow: Window;
}

interface ActiveSessionWindowDragPreview {
  readonly gestureId: string;
  readonly sessionId: string;
  readonly row: HTMLElement;
  readonly ownerWindow: Window;
  readonly dragImage: HTMLCanvasElement;
  readonly onKeyDown: (event: globalThis.KeyboardEvent) => void;
  readonly onDragEnd: () => void;
  readonly timeout: number;
}

let activePreview: ActiveSessionWindowDragPreview | undefined;
let fallbackGestureSequence = 0;

export function sessionWindowDragPreviewAvailable(ownerWindow: Window): boolean {
  const desktop = ownerWindow.jokoDesktop;
  const api = desktop?.sessionWindows;
  return desktop?.capabilities.includes("session.windows") === true && api !== undefined &&
    typeof api.beginDragPreview === "function" &&
    typeof api.endDragPreview === "function" && typeof api.openIfDroppedOutside === "function";
}

export function startSessionWindowDragPreview(request: SessionWindowDragPreviewStart): boolean {
  if (!sessionWindowDragPreviewAvailable(request.ownerWindow) ||
    typeof request.dataTransfer.setDragImage !== "function") return false;
  const palette = resolvePreviewPalette(request.ownerWindow);
  const label = boundedPreviewText(request.label, 160);
  const hint = boundedPreviewText(request.hint, 160);
  if (palette === undefined || label === undefined || hint === undefined) return false;

  cancelSessionWindowDragPreview();
  const gestureId = createGestureId(request.ownerWindow);
  const dragImage = request.ownerWindow.document.createElement("canvas");
  dragImage.width = 1;
  dragImage.height = 1;
  dragImage.setAttribute("aria-hidden", "true");
  dragImage.style.cssText = "position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none";
  request.ownerWindow.document.body.append(dragImage);
  try {
    request.dataTransfer.setDragImage(dragImage, 0, 0);
  } catch {
    dragImage.remove();
    return false;
  }

  const onKeyDown = (event: globalThis.KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    cancelSessionWindowDragPreview(request.ownerWindow);
  };
  const onDragEnd = (): void => { finishSessionWindowDragPreview(request.ownerWindow); };
  const timeout = request.ownerWindow.setTimeout(
    () => cancelSessionWindowDragPreview(request.ownerWindow),
    SESSION_WINDOW_DRAG_PREVIEW_TIMEOUT_MS
  );
  const active: ActiveSessionWindowDragPreview = {
    gestureId,
    sessionId: request.sessionId,
    row: request.row,
    ownerWindow: request.ownerWindow,
    dragImage,
    onKeyDown,
    onDragEnd,
    timeout
  };
  activePreview = active;
  request.row.classList.add("is-session-dragging");
  request.ownerWindow.addEventListener("keydown", onKeyDown, true);
  request.ownerWindow.addEventListener("dragend", onDragEnd, true);

  const api = request.ownerWindow.jokoDesktop?.sessionWindows;
  try {
    void api?.beginDragPreview({ gestureId, sessionId: request.sessionId, label, hint, palette })
      .then((started) => {
        if (!started && activePreview === active) cancelSessionWindowDragPreview(request.ownerWindow);
      })
      .catch(() => {
        if (activePreview === active) cancelSessionWindowDragPreview(request.ownerWindow);
      });
  } catch {
    if (activePreview === active) cancelSessionWindowDragPreview(request.ownerWindow);
    return false;
  }
  return true;
}

export function finishSessionWindowDragPreview(ownerWindow?: Window): void {
  const active = takeActivePreview(ownerWindow);
  if (active === undefined) return;
  cleanupActivePreview(active);
  try {
    void active.ownerWindow.jokoDesktop?.sessionWindows.openIfDroppedOutside(active.gestureId).catch(() => undefined);
  } catch {
    // A renderer teardown can invalidate the bridge between dragend and this call.
  }
}

export function cancelSessionWindowDragPreview(ownerWindow?: Window): void {
  const active = takeActivePreview(ownerWindow);
  if (active === undefined) return;
  cleanupActivePreview(active);
  try {
    void active.ownerWindow.jokoDesktop?.sessionWindows.endDragPreview(active.gestureId).catch(() => undefined);
  } catch {
    // The native owner may already have torn down and cleared the gesture.
  }
}

export function cancelSessionWindowDragPreviewForSession(sessionId: string): void {
  if (activePreview?.sessionId === sessionId) cancelSessionWindowDragPreview(activePreview.ownerWindow);
}

function takeActivePreview(ownerWindow?: Window): ActiveSessionWindowDragPreview | undefined {
  const active = activePreview;
  if (active === undefined || (ownerWindow !== undefined && active.ownerWindow !== ownerWindow)) return undefined;
  activePreview = undefined;
  return active;
}

function cleanupActivePreview(active: ActiveSessionWindowDragPreview): void {
  active.ownerWindow.clearTimeout(active.timeout);
  active.ownerWindow.removeEventListener("keydown", active.onKeyDown, true);
  active.ownerWindow.removeEventListener("dragend", active.onDragEnd, true);
  active.row.classList.remove("is-session-dragging");
  active.dragImage.remove();
}

function createGestureId(ownerWindow: Window): string {
  try {
    const generated = ownerWindow.crypto.randomUUID();
    if (/^[a-zA-Z0-9_-]{16,128}$/u.test(generated)) return generated;
  } catch {
    // A deterministic per-renderer fallback remains bounded and opaque to the host.
  }
  fallbackGestureSequence = (fallbackGestureSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `gesture_${Date.now().toString(36)}_${fallbackGestureSequence.toString(36).padStart(8, "0")}`;
}

function boundedPreviewText(value: string, maximum: number): string | undefined {
  const bounded = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum).trim();
  return bounded === "" ? undefined : bounded;
}

function resolvePreviewPalette(ownerWindow: Window): JokoDesktopSessionDragPreviewRequest["palette"] | undefined {
  const rootStyle = ownerWindow.getComputedStyle(ownerWindow.document.documentElement);
  const surface = safeTokenColor(rootStyle.getPropertyValue("--surface-raised"));
  const border = safeTokenColor(rootStyle.getPropertyValue("--line"));
  const text = safeTokenColor(rootStyle.getPropertyValue("--text"));
  const muted = safeTokenColor(rootStyle.getPropertyValue("--text-soft"));
  const accent = safeTokenColor(rootStyle.getPropertyValue("--accent"));
  if (surface === undefined || border === undefined || text === undefined || muted === undefined || accent === undefined) {
    return undefined;
  }
  return Object.freeze({ surface, border, text, muted, accent });
}

function safeTokenColor(value: string): string | undefined {
  const color = value.trim();
  return color.length >= 1 && color.length <= 128 &&
    /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([0-9a-z+.,%/\s-]+\))$/iu.test(color)
    ? color
    : undefined;
}
