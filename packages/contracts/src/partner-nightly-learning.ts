import type { MessageInitShape } from "@bufbuild/protobuf";
import type { GetPartnerNightlyLearningResponse, UpdatePartnerNightlyLearningRequest, UpdatePartnerNightlyLearningRequestSchema,
  UpdatePartnerNightlyLearningResponse } from "./gen/joko/v1/partner_routine_pb.js";

type NightlyState = GetPartnerNightlyLearningResponse;
type NightlyAction = UpdatePartnerNightlyLearningRequest["action"];

export interface PartnerNightlyLearningApi {
  readonly ownerKey: string;
  readonly partnerId: string;
  readonly read: (signal: AbortSignal) => Promise<NightlyState>;
  readonly update: (state: NightlyState, action: NightlyAction, signal: AbortSignal) => Promise<NightlyState>;
  readonly newRequestId: () => string;
}

export function createPartnerNightlyLearningApi(input: { readonly ownerKey: string; readonly partnerId: string;
  readonly newRequestId: () => string; readonly assertCurrent: (signal: AbortSignal) => void; readonly rpc: {
    getPartnerNightlyLearning(request: { partnerId: string }, options: { signal: AbortSignal }): Promise<NightlyState>;
    updatePartnerNightlyLearning(request: MessageInitShape<typeof UpdatePartnerNightlyLearningRequestSchema>, options: { signal: AbortSignal }): Promise<UpdatePartnerNightlyLearningResponse>;
  } }): PartnerNightlyLearningApi {
  const { partnerId, ownerKey, newRequestId, rpc } = input;
  const current = (signal: AbortSignal): void => { signal.throwIfAborted(); input.assertCurrent(signal); };
  const verify = (value: NightlyState | undefined, signal: AbortSignal): NightlyState => {
    current(signal);
    if (!value || value.partnerId !== partnerId || !value.partnerRevision?.value || !value.stateRevision || !value.scheduleRevision
      || !value.schedule || !value.timezone) throw new Error("The Nightly learning owner changed.");
    return value;
  };
  return { partnerId, ownerKey, newRequestId,
    read: async (signal) => { current(signal); return verify(await rpc.getPartnerNightlyLearning({ partnerId }, { signal }), signal); },
    update: async (state, action, signal) => {
      const captured = verify(state, signal);
      return verify((await rpc.updatePartnerNightlyLearning({ partnerId, expectedPartnerRevision: captured.partnerRevision,
        expectedStateRevision: captured.stateRevision, expectedScheduleRevision: captured.scheduleRevision, action }, { signal })).state, signal);
    }
  };
}

interface EditorState { readonly value?: NightlyState; readonly busy: boolean; readonly failed: boolean; }

export class PartnerNightlyLearningEditor {
  #state: EditorState = { busy: false, failed: false };
  readonly #listeners = new Set<() => void>();
  #request?: AbortController;
  #disposed = false;
  #runRequestId?: string;
  constructor(readonly api: PartnerNightlyLearningApi) {}

  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = (): EditorState => this.#state;

  refresh = async (): Promise<void> => this.#perform(signal => this.api.read(signal), false);
  apply = async (action: NightlyAction): Promise<void> => {
    const current = this.#state.value;
    if (!current?.writable || current.running && action.case !== "schedule" || this.#state.failed) return;
    await this.#perform(signal => this.api.update(current, action, signal), true);
  };
  run = async (): Promise<void> => {
    const current = this.#state.value;
    if (!current?.writable || current.running || this.#state.failed) return;
    const requestId = this.#runRequestId ??= this.api.newRequestId();
    await this.#perform(async signal => {
      const result = await this.api.update(current, { case: "runRequestId", value: requestId }, signal);
      this.#runRequestId = undefined;
      return result;
    }, true);
  };

  suspend(): void { this.#request?.abort(); this.#request = undefined; this.#set({ ...this.#state, busy: false }); }
  dispose(): void { this.#disposed = true; this.suspend(); this.#listeners.clear(); }

  async #perform(action: (signal: AbortSignal) => Promise<NightlyState>, mutation: boolean): Promise<void> {
    if (this.#disposed || this.#request) return;
    const request = new AbortController(); this.#request = request;
    if (mutation || this.#state.value === undefined) this.#set({ ...this.#state, busy: true, failed: false });
    try {
      const value = await action(request.signal);
      if (this.#request === request) this.#set({ value, busy: false, failed: false });
    } catch {
      if (this.#request === request) this.#set({ ...this.#state, busy: false, failed: true });
    } finally { if (this.#request === request) this.#request = undefined; }
  }

  #set(value: EditorState): void {
    if (this.#disposed) return;
    this.#state = value;
    for (const listener of this.#listeners) listener();
  }
}

export function nightlyLearningMessages(locale: string) {
  return locale === "zh-CN" ? {
    title: "夜间学习", pending: "待整理对话", daily: "每天", weekly: "每周一", automatic: "自动整理", frequency: "整理频率", run: "现在整理",
    time: "当地 03:30", history: "学习记录", observations: "观察中的做法", approve: "采纳", dismiss: "移除观察",
    undo: "撤回", redo: "恢复", busy: "正在整理", failed: "无法读取或更改夜间学习。请刷新后重试。",
    emptyHistory: "还没有整理记录。", emptyObservations: "没有观察中的做法。", memoryOff: "此伙伴的记忆已关闭。",
    refresh: "刷新", kinds: ["", "记忆", "技能"], actions: ["", "新增", "更新", "移除", "停用"]
  } : {
    title: "Nightly learning", pending: "Conversations to review", daily: "Daily", weekly: "Mondays", automatic: "Automatic review", frequency: "Review frequency", run: "Review now",
    time: "03:30 local time", history: "Learning history", observations: "Observed methods", approve: "Adopt", dismiss: "Dismiss observation",
    undo: "Undo", redo: "Restore", busy: "Reviewing", failed: "Nightly learning could not be read or changed. Refresh and try again.",
    emptyHistory: "No reviews yet.", emptyObservations: "No observed methods.", memoryOff: "Memory is off for this Partner.",
    refresh: "Refresh", kinds: ["", "Memory", "Skill"], actions: ["", "Created", "Updated", "Removed", "Disabled"]
  };
}
