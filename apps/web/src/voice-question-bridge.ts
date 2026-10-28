export interface VoiceQuestionTarget {
  readonly serverId: string; readonly sessionId: string; readonly runId: string; readonly stepKey: string;
  receive(text: string): void; isCurrent(): boolean;
}
const targets = new Map<string, VoiceQuestionTarget>();
const ownerKey = (serverId: string, sessionId: string) => JSON.stringify([serverId, sessionId]);
/** Installed only by the visible, owned ordinary Question step. Permissions,
 * plan approvals and plugin setup never install a voice answer target. */
export function registerVoiceQuestionTarget(input: { readonly serverId: string; readonly sessionId: string; readonly runId: string;
  readonly stepKey: string; readonly root: HTMLFormElement; readonly receive: (text: string) => void }): () => void {
  let active = true;
  const key = ownerKey(input.serverId, input.sessionId);
  const target: VoiceQuestionTarget = { serverId: input.serverId, sessionId: input.sessionId, runId: input.runId, stepKey: input.stepKey,
    isCurrent: () => {
      const { root } = input;
      const modal = [...root.ownerDocument.querySelectorAll('[aria-modal="true"]')].at(-1);
      return active && targets.get(key) === target && root.isConnected && !root.closest('[inert]')
        && !root.querySelector('[data-question-dictating="true"]')
        && root.ownerDocument.visibilityState === 'visible' && (!modal || modal.contains(root));
    }, receive: text => { if (target.isCurrent()) input.receive(text); } };
  targets.set(key, target);
  return () => { active = false; if (targets.get(key) === target) targets.delete(key); };
}
export function currentVoiceQuestionTarget(serverId: string, sessionId: string, runId: string): VoiceQuestionTarget | undefined {
  const value = targets.get(ownerKey(serverId, sessionId)); return value?.runId === runId && value.isCurrent() ? value : undefined;
}

type Selection =
  | { kind: 'select'; indices: number[] }
  | { kind: 'ambiguous' }
  | { kind: 'confirm' | 'cancel' | 'unknown' };

const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/[。.!！?？]+$/u, '').replace(/\s+/gu, '').trim();

function ordinal(value: string): number | null {
  const cardinal = /^(?:option)?(one|two|three|four|five|six|seven|eight|nine|ten)$/u.exec(value);
  if (cardinal) return ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(cardinal[1]!);
  const english = /^(?:the)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:option|one)?$/u.exec(value);
  if (english) return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'].indexOf(english[1]!);
  const korean = /^(첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)번째(?:옵션)?$/u.exec(value);
  if (korean) return ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'].indexOf(korean[1]!);
  const match = /^(?:第([一二两三四五六七八九十\d]+)(?:个|项|個|項)?|(?:选项|選項|option)([一二两三四五六七八九十\d]+)|([一二三四五六七八九十\d]+)番(?:目)?|(\d+)(?:번)?)$/u.exec(value);
  if (!match) return null;
  const number = match[1] ?? match[2] ?? match[3] ?? match[4];
  if (!number) return null;
  const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return (chinese[number] ?? Number(number)) - 1;
}

/** Whole-utterance grammar only: never extract a choice from a negation,
 * quotation or a longer request. Unknown/ambiguous speech stays on the card.
 */
export function parseVoiceQuestionSelection(text: string, labels: readonly string[]): Selection {
  const normalized = normalize(text);
  // An option named "确认" or "取消" remains a real option.
  const exact = labels.flatMap((label, index) => normalize(label) === normalized ? [index] : []);
  if (exact.length) return exact.length === 1 ? { kind: 'select', indices: exact } : { kind: 'ambiguous' };
  if (/^(确认|确认选择|确认提交|提交选择|確認|確認選擇|確認提交|選択を確定|선택확인|confirm|confirmselection)$/u.test(normalized)) return { kind: 'confirm' };
  if (/^(取消|取消选择|重新选择|取消選擇|重新選擇|選択を取り消し|선택취소|cancel|cancelselection)$/u.test(normalized)) return { kind: 'cancel' };
  const value = normalized.replace(/^(?:我选择|我要选|我选|选择|选|我選擇|我要選|我選|選擇|選|select|choose)/u, '');
  // Try the entire label before separators: names can contain "和" or commas.
  const full = labels.flatMap((label, index) => normalize(label) === value ? [index] : []);
  if (full.length) return full.length === 1 ? { kind: 'select', indices: full } : { kind: 'ambiguous' };
  const parts = value.split(/(?:或者|还是|或|和|以及|还有|、|，|,|and|or)/u);
  const indices: number[] = [];
  for (const part of parts) {
    const matches = labels.flatMap((label, index) => normalize(label) === part ? [index] : []);
    if (matches.length > 1) return { kind: 'ambiguous' };
    const index = matches[0] ?? ordinal(part);
    if (index === null || !Number.isInteger(index) || index < 0 || index >= labels.length) return { kind: 'unknown' };
    indices.push(index);
  }
  if (/(?:或者|还是|或|or)/u.test(value) && parts.length > 1) return { kind: 'ambiguous' };
  return { kind: 'select', indices: [...new Set(indices)] };
}
