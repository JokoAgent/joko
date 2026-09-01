import type { DesktopSessionDragPreviewRequest } from "./channels.js";
import { isDesktopSessionDragPreviewRequest } from "./channels.js";
import {
  pointIsInsideAnyRectangle,
  sessionDragPreviewBounds,
  type DesktopPoint,
  type DesktopRectangle
} from "./session-window-drop.js";

export const SESSION_DRAG_PREVIEW_INTERVAL_MS = 16;
export const SESSION_DRAG_PREVIEW_TIMEOUT_MS = 30_000;
export const SESSION_DRAG_NATIVE_RESULT_TTL_MS = 30_000;

export interface NativeSessionDragPreviewWindow {
  isDestroyed(): boolean;
  setBounds(bounds: DesktopRectangle): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
}

export interface SessionDragPreviewEnvironment {
  getCursorPoint(): DesktopPoint;
  getWorkArea(point: DesktopPoint): DesktopRectangle;
  getVisibleApplicationBounds(): readonly DesktopRectangle[];
  onStop?(): void;
}

interface ActiveSessionDrag<Owner extends object> {
  readonly owner: Owner;
  readonly request: DesktopSessionDragPreviewRequest;
  readonly preview: NativeSessionDragPreviewWindow;
  interval: ReturnType<typeof setInterval> | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  visible: boolean;
}

export type SessionDragPreviewCompletion =
  | { readonly kind: "inside" }
  | { readonly kind: "outside"; readonly point: DesktopPoint; readonly sessionId: string };

export type TrustedSessionDragPreviewCompletion<Owner extends object> = SessionDragPreviewCompletion & {
  readonly owner: Owner;
  readonly gestureId: string;
};

interface SessionDragNativeResultEntry<Owner extends object, Result> {
  readonly owner: Owner;
  readonly gestureId: string;
  readonly firstAttempt: Promise<{ readonly ok: true; readonly value: Result } | { readonly ok: false }>;
  readonly cancellation: Promise<void>;
  readonly signalCancellation: () => void;
  readonly retry: () => Promise<Result>;
  readonly onClear: (() => void) | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  consuming: boolean;
  cancelled: boolean;
}

/** Retains one trusted native open result until the matching renderer dragend consumes it. */
export class SessionDragNativeResultFence<Owner extends object, Result> {
  private entry: SessionDragNativeResultEntry<Owner, Result> | undefined;

  start(input: {
    readonly owner: Owner;
    readonly gestureId: string;
    readonly firstAttempt: () => Promise<Result>;
    readonly retry: () => Promise<Result>;
    readonly onClear?: () => void;
  }): void {
    this.clearEntry();
    let attempt: Promise<Result>;
    try {
      attempt = input.firstAttempt();
    } catch {
      attempt = Promise.reject(new Error("Native task-window open failed."));
    }
    let signalCancellation = (): void => undefined;
    const cancellation = new Promise<void>((resolve) => { signalCancellation = resolve; });
    const entry: SessionDragNativeResultEntry<Owner, Result> = {
      owner: input.owner,
      gestureId: input.gestureId,
      firstAttempt: attempt.then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const })
      ),
      cancellation,
      signalCancellation,
      retry: input.retry,
      onClear: input.onClear,
      timeout: undefined,
      consuming: false,
      cancelled: false
    };
    this.entry = entry;
    entry.timeout = setTimeout(() => this.clearMatchingEntry(entry), SESSION_DRAG_NATIVE_RESULT_TTL_MS);
  }

  async consume(owner: Owner, gestureId: string): Promise<Result | undefined> {
    const entry = this.entry;
    if (entry === undefined || entry.owner !== owner || entry.gestureId !== gestureId || entry.consuming) {
      return undefined;
    }
    entry.consuming = true;
    const first = await Promise.race([
      entry.firstAttempt,
      entry.cancellation.then(() => undefined)
    ]);
    if (first === undefined) return undefined;
    if (first.ok) {
      this.clearMatchingEntry(entry);
      return first.value;
    }
    if (entry.cancelled || this.entry !== entry) return undefined;
    try {
      return await Promise.race([
        entry.retry(),
        entry.cancellation.then(() => undefined)
      ]);
    } finally {
      this.clearMatchingEntry(entry);
    }
  }

  endOwner(owner: Owner): boolean {
    if (this.entry?.owner !== owner) return false;
    this.clearEntry();
    return true;
  }

  dispose(): void {
    this.clearEntry();
  }

  private clearMatchingEntry(entry: SessionDragNativeResultEntry<Owner, Result>): void {
    if (this.entry !== entry) return;
    this.clearEntry();
  }

  private clearEntry(): void {
    const entry = this.entry;
    this.entry = undefined;
    if (entry === undefined) return;
    entry.cancelled = true;
    entry.signalCancellation();
    if (entry.timeout !== undefined) clearTimeout(entry.timeout);
    try {
      entry.onClear?.();
    } catch {
      // The result fence remains cleared even if an owner-listener cleanup is unavailable.
    }
  }
}

/** Owns exactly one bounded native task-drag gesture without trusting renderer coordinates. */
export class SessionDragPreviewCoordinator<Owner extends object> {
  private active: ActiveSessionDrag<Owner> | undefined;

  constructor(private readonly environment: SessionDragPreviewEnvironment) {}

  begin(
    owner: Owner,
    request: DesktopSessionDragPreviewRequest,
    preview: NativeSessionDragPreviewWindow
  ): boolean {
    if (this.active !== undefined && this.active.owner !== owner) return false;
    this.stopActive();
    const active: ActiveSessionDrag<Owner> = {
      owner,
      request,
      preview,
      interval: undefined,
      timeout: undefined,
      visible: false
    };
    this.active = active;
    this.update(active);
    active.interval = setInterval(() => this.update(active), SESSION_DRAG_PREVIEW_INTERVAL_MS);
    active.timeout = setTimeout(() => {
      if (this.active === active) this.stopActive();
    }, SESSION_DRAG_PREVIEW_TIMEOUT_MS);
    return true;
  }

  end(owner: Owner, gestureId: string): boolean {
    if (!this.matches(owner, gestureId)) return false;
    this.stopActive();
    return true;
  }

  endOwner(owner: Owner): boolean {
    if (this.active?.owner !== owner) return false;
    this.stopActive();
    return true;
  }

  finish(owner: Owner, gestureId: string): SessionDragPreviewCompletion | undefined {
    const active = this.active;
    if (active === undefined || active.owner !== owner || active.request.gestureId !== gestureId) return undefined;
    return this.finishActiveGesture(active);
  }

  finishNativeRelease(): TrustedSessionDragPreviewCompletion<Owner> | undefined {
    const active = this.active;
    if (active === undefined) return undefined;
    const completion = this.finishActiveGesture(active);
    return { ...completion, owner: active.owner, gestureId: active.request.gestureId };
  }

  private finishActiveGesture(active: ActiveSessionDrag<Owner>): SessionDragPreviewCompletion {
    const point = this.environment.getCursorPoint();
    const inside = pointIsInsideAnyRectangle(point, this.environment.getVisibleApplicationBounds());
    const sessionId = active.request.sessionId;
    this.stopActive();
    return inside ? { kind: "inside" } : { kind: "outside", point, sessionId };
  }

  dispose(): void {
    this.stopActive();
  }

  private matches(owner: Owner, gestureId: string): boolean {
    return this.active?.owner === owner && this.active.request.gestureId === gestureId;
  }

  private update(active: ActiveSessionDrag<Owner>): void {
    if (this.active !== active) return;
    if (active.preview.isDestroyed()) {
      this.stopActive();
      return;
    }
    const point = this.environment.getCursorPoint();
    if (pointIsInsideAnyRectangle(point, this.environment.getVisibleApplicationBounds())) {
      if (active.visible) active.preview.hide();
      active.visible = false;
      return;
    }
    active.preview.setBounds(sessionDragPreviewBounds(point, this.environment.getWorkArea(point)));
    if (!active.visible) active.preview.showInactive();
    active.visible = true;
  }

  private stopActive(): void {
    const active = this.active;
    this.active = undefined;
    if (active === undefined) return;
    if (active.interval !== undefined) clearInterval(active.interval);
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    if (!active.preview.isDestroyed()) {
      active.preview.hide();
      active.preview.destroy();
    }
    this.environment.onStop?.();
  }
}

export function buildSessionDragPreviewDocument(request: DesktopSessionDragPreviewRequest): string {
  if (!isDesktopSessionDragPreviewRequest(request)) throw new TypeError("Task drag preview request is invalid.");
  const label = escapeHtml(request.label);
  const hint = escapeHtml(request.hint);
  const { surface, border, text, muted, accent } = request.palette;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body><main><span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M15 3h6v6M21 3l-9 9M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span><span class="copy"><strong>${label}</strong><small>${hint}</small></span></main><style>:root{color-scheme:light dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}body{-webkit-font-smoothing:antialiased;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}main{position:absolute;inset:8px;display:flex;align-items:center;gap:9px;overflow:hidden;border:1px solid ${border};border-radius:12px;padding:0 12px 0 10px;background:${surface};color:${text}}.icon{width:28px;height:28px;display:grid;place-items:center;flex:0 0 auto;border-radius:8px;background:color-mix(in srgb,${accent} 14%,transparent);color:${accent}}svg{width:17px;height:17px}path{stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}.copy{min-width:0;display:grid;gap:2px}.copy>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}strong{font-size:13px;font-weight:600;line-height:1.25}small{color:${muted};font-size:11px;line-height:1.2}</style></body></html>`;
}

export function sessionDragPreviewDataUrl(request: DesktopSessionDragPreviewRequest): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildSessionDragPreviewDocument(request))}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;"
  })[character] ?? character);
}
