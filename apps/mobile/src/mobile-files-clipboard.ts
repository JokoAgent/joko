export interface MobileFilesClipboardLease {
  readonly text: string;
  readonly kind: "path" | "file-name" | "source";
  assertCurrent(signal?: AbortSignal): void;
}
export type MobileFilesClipboardResult = "copied" | "failed" | "retired" | "unknown" | "busy";

/** One native clipboard writer; a cancelled dispatched effect keeps its slot until it settles. */
export class MobileFilesClipboard {
  #active?: { readonly controller: AbortController };
  constructor(private readonly write: (text: string) => Promise<boolean>) {}
  cancel(): void { this.#active?.controller.abort(); }
  async copy(lease: MobileFilesClipboardLease, cancellation?: AbortSignal): Promise<MobileFilesClipboardResult> {
    if (this.#active) return "busy";
    const current = { controller: new AbortController() }; this.#active = current;
    const cancel = () => current.controller.abort();
    cancellation?.addEventListener("abort", cancel, { once: true }); if (cancellation?.aborted) cancel();
    const signal = current.controller.signal; let timer: ReturnType<typeof setTimeout> | undefined; let abort!: () => void;
    let raw: Promise<boolean> | undefined;
    try {
      lease.assertCurrent(signal); signal.throwIfAborted();
      raw = this.write(lease.text);
      void raw.then(() => { if (this.#active === current) this.#active = undefined; }, () => { if (this.#active === current) this.#active = undefined; });
      const result = await Promise.race([raw, new Promise<"retired" | "unknown">((resolve) => {
        abort = () => resolve("retired"); signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(() => resolve("unknown"), 10_000);
      })]);
      lease.assertCurrent(signal); signal.throwIfAborted();
      return result === "unknown" ? "unknown" : result === true ? "copied" : "failed";
    } catch {
      try { lease.assertCurrent(signal); signal.throwIfAborted(); return "failed"; } catch { return "retired"; }
    } finally {
      if (timer) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort);
      cancellation?.removeEventListener("abort", cancel);
      if (!raw && this.#active === current) this.#active = undefined;
    }
  }
}
