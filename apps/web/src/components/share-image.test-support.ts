import { vi, type Mock } from "vitest";
import type { BrowserActionContext } from "../browser-action.js";

interface ShareImageTestSurface {
  readonly action: BrowserActionContext;
  readonly abort: AbortController;
  readonly document: { createElement: Mock<(tag: string) => unknown> };
  readonly canvas: { width: number; height: number; getContext: () => CanvasRenderingContext2D; toBlob: Mock<(callback: BlobCallback, type?: string) => void> };
  readonly click: Mock<() => void>;
  readonly share: Mock<(data: ShareData) => Promise<void>>;
  readonly write: Mock<(items: ClipboardItems) => Promise<void>>;
  readonly window: EventTarget & {
    document: { createElement: Mock<(tag: string) => unknown> };
    closed: boolean;
    navigator: { share: Mock<(data: ShareData) => Promise<void>>; canShare: Mock<() => boolean>; userActivation: { isActive: boolean }; clipboard: { write: Mock<(items: ClipboardItems) => Promise<void>> } };
    File: typeof File;
    ClipboardItem: new (items: Record<string, Blob>) => { readonly items: Record<string, Blob> };
    URL: { createObjectURL: Mock<() => string>; revokeObjectURL: Mock };
    setTimeout: Mock<() => number>;
    clearTimeout: Mock;
  };
}

export function shareImageTestSurface(): ShareImageTestSurface {
  const click: Mock<() => void> = vi.fn();
  const share = vi.fn<(data: ShareData) => Promise<void>>().mockResolvedValue(undefined);
  const write = vi.fn<(items: ClipboardItems) => Promise<void>>().mockResolvedValue(undefined);
  const navigator = { share, canShare: vi.fn(() => true), userActivation: { isActive: true }, clipboard: { write } };
  const canvasContext = new Proxy({ measureText: (value: string) => ({ width: value.length * 8 }) } as unknown as CanvasRenderingContext2D, {
    get: (target, property) => property in target ? Reflect.get(target, property) : vi.fn(),
    set: (target, property, value) => Reflect.set(target, property, value)
  });
  const toBlob: Mock<(callback: BlobCallback, type?: string) => void> = vi.fn((callback) => callback(pngBlob()));
  const canvas = { width: 0, height: 0, getContext: () => canvasContext, toBlob };
  const document = { createElement: vi.fn((tag: string) => tag === "canvas" ? canvas : { click }) };
  const window = Object.assign(new EventTarget(), {
    document,
    closed: false,
    navigator,
    File,
    ClipboardItem: class { constructor(readonly items: Record<string, Blob>) {} },
    URL: { createObjectURL: vi.fn(() => "blob:share-image"), revokeObjectURL: vi.fn() },
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn()
  });
  Object.assign(document, { defaultView: window });
  const abort = new AbortController();
  const action: BrowserActionContext = { ownerDocument: document as unknown as Document, signal: abort.signal };
  return { action, abort, document, window, canvas, click, share, write };
}

export function pngBlob(): Blob {
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: "image/png" });
}

export const shareImageTestPalette = { background: "white", surface: "white", text: "black", secondaryText: "gray", line: "gray", accent: "orange", accentInk: "black", fontFamily: "sans-serif" };

export function deferredShareValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
