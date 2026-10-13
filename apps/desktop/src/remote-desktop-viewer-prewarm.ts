interface PrewarmWindow {
  isDestroyed(): boolean;
}

interface PrewarmOptions<Window extends PrewarmWindow> {
  readonly isCurrent: (window: Window) => boolean;
  readonly prewarm: () => void;
}

/** Delay local viewer preparation until the current primary window has shown. */
export class DesktopRemoteDesktopViewerPrewarmScheduler<Window extends PrewarmWindow> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private occurrence = 0;

  constructor(private readonly options: PrewarmOptions<Window>) {}

  schedule(window: Window): void {
    if (window.isDestroyed() || !this.options.isCurrent(window)) return;
    this.cancel();
    const occurrence = this.occurrence;
    this.timer = setTimeout(() => {
      if (occurrence !== this.occurrence) return;
      this.timer = undefined;
      if (window.isDestroyed() || !this.options.isCurrent(window)) return;
      this.options.prewarm();
    }, 1500);
  }

  cancel(): void {
    this.occurrence++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
