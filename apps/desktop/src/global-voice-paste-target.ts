import type {
  SystemFrontmostInputRunner,
  SystemFrontmostInputTarget
} from "./dedicated-hardware-action/system-frontmost-input.js";

interface CapturedVoicePasteTarget {
  readonly generation: number;
  readonly target: ShortcutVoiceDocumentTarget;
  consumed: boolean;
}

export interface ShortcutVoiceDocumentTarget {
  readonly isCurrent: () => boolean;
  readonly paste: () => boolean | Promise<boolean>;
  readonly dispose: () => void;
}

export interface ShortcutVoiceDocumentEndpoint {
  on(event: "did-navigate", listener: () => void): unknown;
  on(event: "render-process-gone", listener: () => void): unknown;
  on(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "did-navigate", listener: () => void): unknown;
  removeListener(event: "render-process-gone", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
  readonly paste: () => void;
}

export function captureShortcutVoiceDocumentTarget(options: {
  readonly contents: ShortcutVoiceDocumentEndpoint;
  readonly isCurrentDocument: () => boolean;
  readonly focus: () => void;
}): ShortcutVoiceDocumentTarget {
  let retired = false;
  const dispose = (): void => {
    if (retired) return;
    retired = true;
    options.contents.removeListener("did-navigate", dispose);
    options.contents.removeListener("render-process-gone", dispose);
    options.contents.removeListener("destroyed", dispose);
  };
  const isCurrent = (): boolean => !retired && options.isCurrentDocument();
  options.contents.on("did-navigate", dispose);
  options.contents.on("render-process-gone", dispose);
  options.contents.on("destroyed", dispose);
  return {
    isCurrent,
    paste: () => {
      if (!isCurrent()) return false;
      options.focus();
      if (!isCurrent()) return false;
      options.contents.paste();
      return isCurrent();
    },
    dispose
  };
}

/** Owns the exact macOS application instance selected when shortcut dictation starts. */
export class MacShortcutVoicePasteTarget {
  readonly #getRunner: () => SystemFrontmostInputRunner | undefined;
  readonly #captureDocument: (() => ShortcutVoiceDocumentTarget | undefined) | undefined;
  #captured: CapturedVoicePasteTarget | undefined;

  constructor(
    getRunner: () => SystemFrontmostInputRunner | undefined,
    captureDocument?: () => ShortcutVoiceDocumentTarget | undefined
  ) {
    this.#getRunner = getRunner;
    this.#captureDocument = captureDocument;
  }

  capture(generation: number): boolean {
    this.retire();
    if (!Number.isSafeInteger(generation) || generation <= 0) return false;
    try {
      const document = this.#captureDocument?.();
      if (document !== undefined) {
        if (!document.isCurrent()) { document.dispose(); return false; }
        this.#captured = { generation, target: document, consumed: false };
        return true;
      }
      const runner = this.#getRunner();
      if (runner === undefined) return false;
      const target: SystemFrontmostInputTarget = runner.captureTarget();
      if (target.platform !== "darwin") return false;
      this.#captured = {
        generation,
        target: { isCurrent: () => true, paste: async () => { await runner.postPaste(target); return true; }, dispose: () => undefined },
        consumed: false
      };
      return true;
    } catch {
      return false;
    }
  }

  hasTarget(generation: number): boolean {
    const captured = this.#captured;
    if (captured?.generation !== generation || captured.consumed) return false;
    if (captured.target.isCurrent()) return true;
    this.retire(generation);
    return false;
  }

  async paste(generation: number): Promise<boolean> {
    const captured = this.#captured;
    if (captured === undefined || !this.hasTarget(generation)) return false;
    captured.consumed = true;
    try {
      const issued = await captured.target.paste();
      return issued && this.#captured === captured && captured.target.isCurrent();
    } catch {
      return false;
    } finally {
      if (this.#captured === captured) this.retire(generation);
    }
  }

  retire(generation?: number): void {
    const captured = this.#captured;
    if (captured === undefined || (generation !== undefined && captured.generation !== generation)) return;
    this.#captured = undefined;
    captured.target.dispose();
  }
}
