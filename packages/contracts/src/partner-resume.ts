export interface PartnerResumeProfile {
  readonly partnerId: string;
  readonly revision: bigint;
  readonly profileVersion: bigint;
  readonly displayName: string;
  readonly homeTargetId: string;
  readonly canonicalSessionId?: string;
  readonly backendId: string;
  readonly lifecycle: "active" | "paused" | "archived" | "deleted";
  readonly initializationState: "pending" | "ready" | "error";
  readonly pauseCleanupPending?: boolean;
}

export interface PartnerResumeApi<T extends PartnerResumeProfile = PartnerResumeProfile> {
  readonly ownerKey: string;
  read(signal: AbortSignal): Promise<T>;
  resume(current: T, signal: AbortSignal): Promise<T>;
}

export interface PartnerResumeState<T extends PartnerResumeProfile = PartnerResumeProfile> {
  readonly phase: "loading" | "ready" | "resuming" | "unknown" | "error" | "completed" | "suspended";
  readonly profile?: T;
  readonly error?: "changed" | "unavailable" | "unknown";
}

/** A desired-state mutation needs a fresh confirmation after every unknown result. */
export class PartnerResumeEditor<T extends PartnerResumeProfile = PartnerResumeProfile> {
  #state: PartnerResumeState<T> = { phase: "loading" };
  #listeners = new Set<() => void>();
  #request?: AbortController;
  #active = true;
  #disposed = false;
  constructor(readonly api: PartnerResumeApi<T>, readonly initial: T) { this.#validate(initial); }
  get state(): PartnerResumeState<T> { return this.#state; }
  get busy(): boolean { return this.state.phase === "loading" || this.state.phase === "resuming"; }
  get available(): boolean { return this.#active && !this.#disposed && this.state.phase === "ready" && this.state.profile?.lifecycle === "paused"; }
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  snapshot = (): PartnerResumeState<T> => this.#state;
  #set(state: PartnerResumeState<T>): void {
    if (this.#disposed) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  #validate(value: T): void {
    if (value.partnerId !== this.initial.partnerId || value.homeTargetId !== this.initial.homeTargetId
      || value.canonicalSessionId !== this.initial.canonicalSessionId || value.backendId !== this.initial.backendId
      || value.revision < this.initial.revision || value.profileVersion < this.initial.profileVersion
      || value.revision < 1n || value.profileVersion < 1n || !value.canonicalSessionId || !value.backendId
      || value.initializationState !== "ready" || !["active", "paused"].includes(value.lifecycle)
      || (value.lifecycle === "paused") !== (typeof value.pauseCleanupPending === "boolean")) {
      throw new Error("The Partner resume identity changed.");
    }
  }
  #current(request: AbortController): boolean { return this.#active && !this.#disposed && this.#request === request && !request.signal.aborted; }
  async refresh(): Promise<void> {
    if (!this.#active || this.#disposed || this.#request) return;
    const request = new AbortController(); this.#request = request; this.#set({ phase: "loading" });
    try {
      const profile = await this.api.read(request.signal);
      if (!this.#current(request)) return;
      this.#validate(profile);
      this.#set({ phase: profile.lifecycle === "active" ? "completed" : "ready", profile });
    } catch { if (this.#current(request)) this.#set({ phase: "error", error: "unavailable" }); }
    finally { if (this.#request === request) this.#request = undefined; }
  }
  async resume(): Promise<void> {
    if (!this.available || this.#request) return;
    const selected = this.state.profile!;
    const request = new AbortController(); this.#request = request; let dispatched = false;
    this.#set({ phase: "resuming", profile: selected });
    try {
      const fresh = await this.api.read(request.signal);
      if (!this.#current(request)) return;
      this.#validate(fresh);
      if (fresh.lifecycle === "active") { this.#set({ phase: "completed", profile: fresh }); return; }
      if (fresh.revision !== selected.revision || fresh.profileVersion !== selected.profileVersion
        || fresh.displayName !== selected.displayName || fresh.pauseCleanupPending !== selected.pauseCleanupPending) {
        this.#set({ phase: "ready", profile: fresh, error: "changed" }); return;
      }
      request.signal.throwIfAborted(); dispatched = true;
      const resumed = await this.api.resume(fresh, request.signal);
      if (!this.#current(request)) return;
      this.#validate(resumed);
      if (resumed.lifecycle !== "active" || resumed.revision <= fresh.revision) throw new Error("Partner resume was not confirmed.");
      const confirmed = await this.api.read(request.signal);
      if (!this.#current(request)) return;
      this.#validate(confirmed);
      if (confirmed.lifecycle !== "active" || confirmed.revision < resumed.revision) throw new Error("Partner resume could not be read back.");
      this.#set({ phase: "completed", profile: confirmed });
    } catch {
      if (this.#current(request)) this.#set({ phase: dispatched ? "unknown" : "error", error: dispatched ? "unknown" : "unavailable" });
    } finally { if (this.#request === request) this.#request = undefined; }
  }
  suspend(): void {
    this.#active = false; this.#request?.abort(); this.#request = undefined;
    this.#set({ phase: "suspended" });
  }
  activate(): void { if (this.#disposed) return; this.#active = true; void this.refresh(); }
  dispose(): void { this.suspend(); this.#disposed = true; this.#listeners.clear(); }
}

const messages = {
  en: { action: "Resume partner", title: "Resume {name}?", paused: "Paused", body: "This partner can receive messages and run background tasks again. History, memory, and files are preserved. Tasks and routines you paused manually stay paused.",
    cleanup: "Shutdown is still pending. Resuming will finish that cleanup first.", working: "Resuming…", loading: "Checking current status…", refresh: "Check status", cancel: "Cancel", close: "Close", completed: "Partner resumed.", changed: "This partner changed. Review the current status before confirming again.", unavailable: "Current status could not be confirmed. Check status before resuming.", unknown: "The result is unknown. Check status before another attempt.", suspended: "Reconnect and return to this window to check status." },
  "zh-CN": { action: "恢复伙伴", title: "恢复{name}？", paused: "已暂停", body: "该伙伴将重新接收消息并执行后台任务。历史、记忆和文件会保留，手动暂停的任务和例行任务仍保持暂停。",
    cleanup: "停机清理尚未完成，恢复前会先完成清理。", working: "正在恢复…", loading: "正在检查当前状态…", refresh: "检查状态", cancel: "取消", close: "关闭", completed: "伙伴已恢复。", changed: "伙伴状态已变化，请检查当前状态后再次确认。", unavailable: "无法确认当前状态，请先检查状态再恢复。", unknown: "请求结果未知，请检查状态后再尝试。", suspended: "请重新连接并返回此窗口检查状态。" },
  "zh-TW": { action: "恢復夥伴", title: "恢復{name}？", paused: "已暫停", body: "此夥伴將重新接收訊息並執行背景任務。歷史、記憶和檔案會保留，手動暫停的任務和例行任務仍保持暫停。",
    cleanup: "停機清理尚未完成，恢復前會先完成清理。", working: "正在恢復…", loading: "正在檢查目前狀態…", refresh: "檢查狀態", cancel: "取消", close: "關閉", completed: "夥伴已恢復。", changed: "夥伴狀態已變更，請檢查目前狀態後再次確認。", unavailable: "無法確認目前狀態，請先檢查狀態再恢復。", unknown: "請求結果未知，請檢查狀態後再嘗試。", suspended: "請重新連線並返回此視窗檢查狀態。" },
  ja: { action: "パートナーを再開", title: "{name}を再開しますか？", paused: "一時停止中", body: "このパートナーはメッセージの受信とバックグラウンドタスクを再開します。履歴、メモリ、ファイルは保持されます。手動で停止したタスクとルーチンは停止したままです。",
    cleanup: "終了処理が未完了です。再開の前に処理を完了します。", working: "再開中…", loading: "現在の状態を確認中…", refresh: "状態を確認", cancel: "キャンセル", close: "閉じる", completed: "パートナーを再開しました。", changed: "パートナーが変更されました。現在の状態を確認して再度確定してください。", unavailable: "現在の状態を確認できません。再開の前に状態を確認してください。", unknown: "結果が不明です。再試行の前に状態を確認してください。", suspended: "再接続してこの画面に戻り、状態を確認してください。" },
  ko: { action: "파트너 재개", title: "{name}을(를) 재개할까요?", paused: "일시 정지됨", body: "이 파트너가 메시지 수신과 백그라운드 작업을 다시 시작합니다. 기록, 메모리, 파일은 보존됩니다. 수동으로 정지한 작업과 루틴은 그대로 정지 상태를 유지합니다.",
    cleanup: "종료 처리가 아직 끝나지 않았습니다. 재개 전에 처리를 완료합니다.", working: "재개 중…", loading: "현재 상태 확인 중…", refresh: "상태 확인", cancel: "취소", close: "닫기", completed: "파트너가 재개되었습니다.", changed: "파트너가 변경되었습니다. 현재 상태를 확인하고 다시 승인하세요.", unavailable: "현재 상태를 확인할 수 없습니다. 재개 전에 상태를 확인하세요.", unknown: "결과를 알 수 없습니다. 다시 시도하기 전에 상태를 확인하세요.", suspended: "다시 연결한 후 이 화면으로 돌아와 상태를 확인하세요." }
};
export function partnerResumeMessages(locale: string): typeof messages.en { return messages[locale as keyof typeof messages] ?? messages.en; }
