import { requireOptionalNativeModule } from "expo";
import type { EventSubscription } from "expo-modules-core";

interface MobileScreenshotNativeModule {
  addListener(event: "onScreenshot", listener: (value: unknown) => void): EventSubscription;
}
let native: MobileScreenshotNativeModule | null = null;
try { native = requireOptionalNativeModule<MobileScreenshotNativeModule>("JokoScreenshotMonitor"); } catch { /* Native builds may omit this optional platform capability. */ }

export function subscribeMobileScreenshots(listener: () => void, source: MobileScreenshotNativeModule | null = native): () => void {
  let active = true;
  const subscription = source?.addListener("onScreenshot", (value) => {
    if (!active || !value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Number.isFinite(record["capturedAt"]) || (record["capturedAt"] as number) < 1) return;
    listener();
  });
  return () => { active = false; subscription?.remove(); };
}

export interface MobileScreenshotSelectionScope {
  readonly owner?: string;
  readonly foreground: boolean;
  readonly blocked: boolean;
  readonly selectionActive: boolean;
}

export class MobileScreenshotSelectionController {
  #pending?: AbortController;
  #lastActivation = -Infinity;
  #disposed = false;
  constructor(
    private readonly scope: () => MobileScreenshotSelectionScope,
    private readonly visible: (signal: AbortSignal) => Promise<readonly string[]>,
    private readonly enter: (owner: string, ids: readonly string[]) => void,
    private readonly now: () => number = () => performance.now()
  ) {}

  capture(): void {
    const scope = this.scope();
    const now = this.now();
    if (this.#disposed || !scope.owner || !scope.foreground || scope.blocked || scope.selectionActive
      || this.#pending || now - this.#lastActivation < 1_200) return;
    this.#lastActivation = now;
    const pending = new AbortController(); this.#pending = pending;
    const timeout = setTimeout(() => pending.abort(), 600);
    void this.visible(pending.signal).then((ids) => {
      const next = this.scope();
      if (this.#disposed || pending.signal.aborted || this.#pending !== pending || next.owner !== scope.owner
        || !next.foreground || next.blocked || next.selectionActive) return;
      const unique = [...new Set(ids)];
      if (unique.length > 0) this.enter(scope.owner!, unique);
    }).catch(() => undefined).finally(() => {
      clearTimeout(timeout); if (this.#pending === pending) this.#pending = undefined;
    });
  }

  retire(): void { this.#pending?.abort(); this.#pending = undefined; }
  dispose(): void { this.#disposed = true; this.retire(); }
}

export interface MobileScreenshotFrame { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface MobileScreenshotMeasurable { measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void }

export async function readMobileScreenshotVisibleMessages(
  viewport: MobileScreenshotMeasurable | null,
  messages: ReadonlyMap<string, MobileScreenshotMeasurable>,
  signal: AbortSignal
): Promise<readonly string[]> {
  if (!viewport || signal.aborted) return [];
  const entries = [...messages];
  const frame = await measureMobileScreenshotFrame(viewport, signal);
  if (!frame) return [];
  const measured = await Promise.all(entries.map(async ([id, view]) => ({ id, frame: await measureMobileScreenshotFrame(view, signal) })));
  if (signal.aborted) return [];
  return measured.filter((item): item is { id: string; frame: MobileScreenshotFrame } => {
    if (!item.frame) return false;
    const visibleHeight = Math.max(0, Math.min(item.frame.y + item.frame.height, frame.y + frame.height) - Math.max(item.frame.y, frame.y));
    const visibleWidth = Math.min(item.frame.x + item.frame.width, frame.x + frame.width) - Math.max(item.frame.x, frame.x);
    return visibleWidth > 0 && visibleHeight / item.frame.height >= 0.1;
  }).sort((left, right) => left.frame.y - right.frame.y).map((item) => item.id);
}

function measureMobileScreenshotFrame(view: MobileScreenshotMeasurable, signal: AbortSignal): Promise<MobileScreenshotFrame | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let completed = false;
    const finish = (frame?: MobileScreenshotFrame) => {
      if (completed) return;
      completed = true; clearTimeout(timeout); signal.removeEventListener("abort", abort); resolve(frame);
    };
    const abort = () => finish();
    const timeout = setTimeout(abort, 200);
    signal.addEventListener("abort", abort, { once: true });
    try { view.measureInWindow((x, y, width, height) => {
      finish(!signal.aborted && [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : undefined);
    }); } catch { finish(); }
  });
}
