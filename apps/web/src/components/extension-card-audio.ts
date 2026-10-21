// Adapted from the fixed host-owned audio slots. See public/licenses/mcp-apps/NOTICE.txt.
// Media elements stay in the host document across inert poster replacements.
import { registerExclusiveMediaPlayback } from "../media-playback.js";
import type { ExtensionCardApi } from "../model.js";
import type { Translator } from "./types.js";

type Source = Awaited<ReturnType<ExtensionCardApi["loadMedia"]>>;
interface Player { readonly audio: HTMLAudioElement; readonly abort: AbortController; readonly unregister?: () => void; source?: Source; pending?: Promise<void> }
export class ExtensionCardAudioHost {
  readonly #players = new Map<string, Player>();
  constructor(private readonly load: (uri: string, signal: AbortSignal) => Promise<Source>, private readonly allowed: () => boolean) {}
  bind(document: Document, t: Translator): () => void {
    const cleanups: Array<() => void> = [], present = new Set<string>();
    for (const slot of document.querySelectorAll<HTMLElement>("div[data-joko-audio]")) {
      const uri = slot.getAttribute("data-joko-audio") ?? "";
      if (!/^joko-media:\/\/blobs\/[a-f0-9]{64}\.(mp3|wav|m4a)$/u.test(uri)) continue;
      present.add(uri);
      let player = this.#players.get(uri);
      if (!player) {
        const audio = window.document.createElement("audio"); audio.preload = "metadata";
        player = { audio, abort: new AbortController(), unregister: registerExclusiveMediaPlayback(audio) }; this.#players.set(uri, player);
      }
      const current = player, audio = current.audio;
      slot.replaceChildren(); slot.style.cssText += ";display:flex;align-items:center;gap:12px;min-width:0;padding:8px 0";
      const button = document.createElement("button"), clock = document.createElement("span"), seek = document.createElement("input");
      button.type = "button"; button.style.cssText = "flex:0 0 auto;width:36px;height:36px;border:0;border-radius:50%;background:var(--text);color:var(--surface);cursor:pointer";
      seek.type = "range"; seek.min = "0"; seek.max = "0"; seek.value = "0"; seek.step = "0.1"; seek.setAttribute("aria-label", t("extensionCards.audioProgress"));
      seek.style.cssText = "flex:1;min-width:0;accent-color:var(--accent)"; clock.style.cssText = "flex:0 0 auto;color:var(--text-soft);font-size:12px;font-variant-numeric:tabular-nums";
      slot.append(button, seek, clock);
      const render = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : Number(slot.getAttribute("data-joko-audio-duration")) || 0;
        button.textContent = audio.paused ? "▶" : "Ⅱ"; button.setAttribute("aria-label", t(audio.paused ? "extensionCards.audioPlay" : "extensionCards.audioPause"));
        seek.max = String(duration); seek.value = String(audio.currentTime); seek.disabled = duration <= 0;
        clock.textContent = `${time(audio.currentTime)} / ${time(duration)}`;
      };
      const play = async (event: Event) => {
        event.preventDefault(); event.stopPropagation(); if (!event.isTrusted || !this.allowed() || current.abort.signal.aborted) return;
        if (!audio.paused) { audio.pause(); return; }
        button.disabled = true;
        try {
          if (!current.source) {
            current.pending ??= this.load(uri, current.abort.signal).then(source => {
              if (current.abort.signal.aborted) { source.release(); return; }
              current.source = source; audio.src = source.url;
            }).finally(() => { current.pending = undefined; });
            await current.pending;
          }
          current.abort.signal.throwIfAborted(); if (!this.allowed()) return; await audio.play();
        } catch { if (!current.abort.signal.aborted) { clock.textContent = t("extensionCards.failed"); button.setAttribute("aria-label", t("common.retry")); } }
        finally { button.disabled = false; }
      };
      const scrub = (event: Event) => { event.stopPropagation(); if (event.isTrusted && Number.isFinite(audio.duration)) audio.currentTime = Math.min(audio.duration, Math.max(0, Number(seek.value))); };
      const stop = (event: Event) => event.stopPropagation();
      button.addEventListener("click", play); seek.addEventListener("input", scrub); seek.addEventListener("click", stop);
      for (const name of ["loadedmetadata", "timeupdate", "play", "pause", "ended"]) audio.addEventListener(name, render);
      render(); cleanups.push(() => { button.removeEventListener("click", play); seek.removeEventListener("input", scrub); seek.removeEventListener("click", stop); for (const name of ["loadedmetadata", "timeupdate", "play", "pause", "ended"]) audio.removeEventListener(name, render); });
    }
    for (const [uri, player] of this.#players) if (!present.has(uri)) { this.#release(player); this.#players.delete(uri); }
    return () => cleanups.forEach(cleanup => cleanup());
  }
  dispose(): void { for (const player of this.#players.values()) this.#release(player); this.#players.clear(); }
  pause(): void { for (const player of this.#players.values()) player.audio.pause(); }
  #release(player: Player): void { player.abort.abort(); player.unregister?.(); player.audio.pause(); player.audio.removeAttribute("src"); player.audio.load(); player.source?.release(); }
}
function time(seconds: number): string { const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
