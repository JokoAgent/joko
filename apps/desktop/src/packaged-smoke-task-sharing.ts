import { parseTaskShareInvitation } from "@joko/contracts";
import type { BrowserWindow } from "electron";
import { PACKAGED_SMOKE_SHARED_TASK_PROMPT, type PackagedSmokeTask } from "./packaged-smoke-task.js";

/** Uses the real packaged management and task surfaces. The invitation stays
 * inside the private OS/clipboard handoff and is never returned as evidence. */
export async function verifyPackagedSmokeTaskSharing(options: {
  readonly window: BrowserWindow;
  readonly task: PackagedSmokeTask;
  readonly serverId: string;
  readonly prepareOwner: () => Promise<boolean>;
  readonly readClipboard: () => string;
  readonly copiedInvitation: (invitation: string) => void;
  readonly offerInvitation: (invitation: string) => boolean;
  readonly createForeignInvitation: () => Promise<{ readonly invitation: string; readonly sessionId: string; readonly hostServerId: string }>;
  readonly recordSurface: (surface: "management" | "guest-ready" | "guest") => Promise<void>;
}): Promise<void> {
  const { window, task } = options;
  if (!await options.prepareOwner()) throw new Error("The shared task owner did not reach its formal task page.");
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
  const focusDeadline = Date.now() + 5_000;
  while (!window.isFocused() && Date.now() < focusDeadline) await pause();
  if (!window.isFocused()) throw new Error("The task sharing clipboard owner did not become focused.");
  const script = async <T>(lines: readonly string[]): Promise<T> => window.webContents.executeJavaScript([
    "(async () => {",
    "  const pause = () => new Promise(resolve => setTimeout(resolve, 50));",
    "  const wait = async (read, label) => { const deadline = Date.now() + 12_000; do { const value = read(); if (value) return value; await pause(); } while (Date.now() < deadline); const root = document.querySelector('[data-task-sharing-session]'); const editor = root?.querySelector('.composer-rich-editor__content'); const send = root?.querySelector('.composer__send .send-button:not(.send-button--stop)'); throw new Error('Shared task surface did not reach ' + label + ' ' + JSON.stringify({ state: root?.getAttribute('data-state'), editorCharacters: editor?.textContent?.length, sendPresent: !!send, sendDisabled: send instanceof HTMLButtonElement ? send.disabled : undefined })); };",
    "  const button = async selector => wait(() => { const node = document.querySelector(selector); return node instanceof HTMLButtonElement && !node.disabled ? node : undefined; }, selector);",
    ...lines,
    "})()"
  ].join("\n"), true) as Promise<T>;
  const openManagement = [
    "  const manage = await button('[data-task-sharing-manage]');",
    "  const details = manage.closest('details');",
    "  if (details && !details.open) details.querySelector('summary')?.click();",
    "  manage.click();",
    "  await wait(() => document.querySelector('[data-task-sharing-management][data-state=ready]'), 'ready management');"
  ];
  const closeManagement = [
    "  const section = document.querySelector('[data-task-sharing-management]');",
    "  const dialog = section?.closest('[role=dialog]');",
    "  if (!(dialog instanceof HTMLElement)) throw new Error('The task sharing management dialog is missing.');",
    "  dialog.focus(); dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));",
    "  await wait(() => !document.querySelector('[data-task-sharing-management]'), 'closed management');"
  ];
  const shareId = await script<string>([
    ...openManagement,
    "  (await button('[data-task-sharing-start]')).click();",
    `  const ownedRow = () => [...document.querySelectorAll('[data-task-sharing-owned]')].find(node => node.getAttribute('data-session-id') === ${JSON.stringify(task.sessionId)});`,
    "  const row = await wait(ownedRow, 'owned task');",
    "  const shareId = row.getAttribute('data-share-id');",
    "  if (!shareId) throw new Error('The owned task omitted its sharing identity.');",
    "  const invite = await wait(() => { const current = ownedRow(); if (current?.getAttribute('data-share-id') !== shareId) return undefined; const node = current.querySelector('[data-task-sharing-invite]'); return node instanceof HTMLButtonElement && !node.disabled ? node : undefined; }, 'invitation for the owned task');",
    "  invite.click(); return shareId;"
  ]);
  let invitation: string | undefined;
  const copyDeadline = Date.now() + 12_000;
  while (Date.now() < copyDeadline) {
    const value = options.readClipboard();
    try {
      const parsed = parseTaskShareInvitation(value);
      if (parsed.hostServerId === options.serverId && parsed.shareId === shareId) {
        invitation = value; options.copiedInvitation(value); break;
      }
    } catch { /* Native clipboard publication may still be in flight. */ }
    await pause();
  }
  if (!invitation) throw new Error("The actual invitation action did not copy this task's invitation.");
  await options.recordSurface("management");
  await script([...closeManagement, "  return true;"]);
  invitation = undefined;
  const foreign = await options.createForeignInvitation();
  const parsed = parseTaskShareInvitation(foreign.invitation);
  if (parsed.hostServerId === options.serverId || parsed.hostServerId !== foreign.hostServerId) {
    throw new Error("The packaged participant needs a different real host service.");
  }
  if (!options.offerInvitation(foreign.invitation)) throw new Error("The OS invitation handoff rejected its canonical value.");
  await script([
    "  await wait(() => document.querySelector('[data-task-sharing-management][data-state=ready] [data-task-sharing-invitation]'), 'invitation preflight');",
    "  const name = await wait(() => { const value = document.querySelector('[data-task-sharing-name]'); return value instanceof HTMLInputElement && !value.disabled ? value : undefined; }, 'participant name');",
    "  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(name, 'Packaged task participant');",
    "  name.dispatchEvent(new Event('input', { bubbles: true }));",
    "  (await button('[data-task-sharing-preview]')).click();",
    "  (await button('[data-task-sharing-join]')).click();",
    `  await wait(() => document.querySelector('[data-task-sharing-session][data-state=ready]')?.getAttribute('data-session-id') === ${JSON.stringify(foreign.sessionId)}, 'joined task');`,
    "  if (document.querySelector('[data-task-sharing-session] [data-task-sharing-manage]')) throw new Error('The participant received an owner management entry.');",
    "  return true;"
  ]);
  await options.recordSurface("guest-ready");
  const text = PACKAGED_SMOKE_SHARED_TASK_PROMPT;
  try {
    await script([
      "  const editor = await wait(() => document.querySelector('[data-task-sharing-session] .composer-rich-editor__content[contenteditable=true]'), 'guest composer');",
      "  if (editor.textContent.trim()) throw new Error('The guest composer inherited an unrelated draft.');",
      "  editor.focus(); window.getSelection()?.selectAllChildren(editor); window.getSelection()?.collapseToEnd();",
      `  if (!document.execCommand('insertText', false, ${JSON.stringify(text)})) throw new Error('The guest composer did not accept input.');`,
      "  (await button('[data-task-sharing-session] .composer__send .send-button:not(.send-button--stop)')).click();",
      `  await wait(() => [...document.querySelectorAll('[data-task-sharing-session] .message-user')].some(node => node.getAttribute('aria-label') === 'Packaged task participant' && node.textContent.includes(${JSON.stringify(text)})), 'canonical attributed input');`,
      "  await wait(() => document.querySelector('[data-task-sharing-session] .message-assistant'), 'guest reply');",
      "  return true;"
    ]);
  } catch (error) {
    await options.recordSurface("guest");
    throw error;
  }
  await options.recordSurface("guest");
  await script([
    "  const leave = await button('[data-task-sharing-session] [data-task-sharing-leave]');",
    "  const details = leave.closest('details'); if (details && !details.open) details.querySelector('summary')?.click();",
    "  leave.click(); (await button('[data-task-sharing-confirm]')).click();",
    `  await wait(() => !document.querySelector('[data-task-sharing-session]') && document.querySelector('.session-pane')?.getAttribute('data-input-session-id') === ${JSON.stringify(task.sessionId)}, 'original task after leave');`,
    "  return true;"
  ]);
  if (!await options.prepareOwner()) throw new Error("The original task did not remain reachable after participant exit.");
  await script([
    ...openManagement,
    "  (await button('[data-task-sharing-end]')).click();",
    "  (await button('[data-task-sharing-confirm]')).click();",
    "  await button('[data-task-sharing-start]');",
    ...closeManagement,
    "  return true;"
  ]);
}
function pause(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 50)); }
