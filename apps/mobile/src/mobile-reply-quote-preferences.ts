import type { MobilePlainStorageDriver } from './connection-storage';

const key = 'joko.mobile.reply-quotes.v1';
interface ReplyQuotePreferenceState { readonly ready: boolean; readonly visible: boolean; readonly saving: boolean; readonly failed: boolean; }
export class MobileReplyQuotePreferences {
  #state: ReplyQuotePreferenceState = { ready: false, visible: true, saving: false, failed: false };
  #listeners = new Set<() => void>();
  #loading?: Promise<void>;
  constructor(readonly storage: Pick<MobilePlainStorageDriver, 'getItem' | 'setItem'>) {}
  get snapshot() { return this.#state; }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #publish(state: ReplyQuotePreferenceState) { this.#state = state; for (const listener of this.#listeners) listener(); }
  hydrate(): Promise<void> {
    if (this.#state.ready) return Promise.resolve();
    return this.#loading ??= this.storage.getItem(key).then(raw => {
      if (raw !== null && raw !== 'true' && raw !== 'false') throw new Error('Invalid reply display preference.');
      this.#publish({ ready: true, visible: raw !== 'false', saving: false, failed: false });
    }).catch(() => { this.#publish({ ready: true, visible: true, saving: false, failed: true }); });
  }
  async save(visible: boolean): Promise<void> {
    if (!this.#state.ready || this.#state.saving) return;
    const previous = this.#state; this.#publish({ ...previous, saving: true, failed: false });
    try { await this.storage.setItem(key, visible ? 'true' : 'false'); this.#publish({ ready: true, visible, saving: false, failed: false }); }
    catch { this.#publish({ ...previous, saving: false, failed: true }); throw new Error('The reply display preference could not be saved.'); }
  }
}
