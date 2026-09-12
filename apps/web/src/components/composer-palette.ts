import type {
  ComposerMentionDraft,
  RuntimeCommandView,
  SessionView,
  WorkspaceEntryView
} from "../model.js";
import { activeComposerMentions } from "../message-reference.js";
import { serializeComposerMentionPath } from "./composer-inline-mention.js";

export interface ComposerPaletteItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly meta: string;
  readonly mention?: ComposerMentionDraft;
}

export interface ComposerCommandActivation {
  /** UTF-16 offset of the slash that owns this command run. */
  readonly from: number;
  /** UTF-16 offset after the complete non-whitespace command run. */
  readonly to: number;
  /** The live query between the slash and the caret. */
  readonly query: string;
}

export interface ComposerCommandItemOptions {
  /** Application-owned help surface; independent of the selected Backend. */
  readonly helpSupported?: boolean;
  /** Application-owned exact task navigation command. */
  readonly jumpSessionSupported?: boolean;
  /** Derived from the selected Backend's public runtime.user_shell capability. */
  readonly userShellSupported?: boolean;
  /** Derived from the selected Backend's public session.reset capability. */
  readonly sessionResetSupported?: boolean;
  /** Derived from the selected Backend's public review.isolated capability. */
  readonly reviewSupported?: boolean;
}

export type ComposerBuiltInCommand =
  | { readonly kind: "help" }
  | { readonly kind: "jumpSession"; readonly sessionId: string }
  | { readonly kind: "userShell"; readonly command: string }
  | { readonly kind: "sessionReset" }
  | { readonly kind: "review"; readonly focus: string };

/** Build the exact structured mention projection used by both draft and live composers. */
export function composerMentionItems(
  entries: readonly WorkspaceEntryView[],
  workspaceId: string | undefined,
  indexedPaths: readonly string[] = [],
  sessions: readonly SessionView[] = []
): readonly ComposerPaletteItem[] {
  return uniquePaletteItems([
    ...flattenWorkspaceEntries(entries, workspaceId),
    ...indexedPaths.map((path) => {
      const label = path.split("/").at(-1) ?? path;
      const token = serializeComposerMentionPath(path);
      return {
        id: `file:${workspaceId ?? ""}:${path}`,
        label,
        value: token,
        meta: path,
        mention: {
          id: `workspace:${workspaceId ?? ""}:${path}`,
          kind: "workspace" as const,
          reference: path,
          label,
          token,
          ...(workspaceId === undefined ? {} : { workspaceId })
        }
      };
    }),
    ...sessions.flatMap((session): readonly ComposerPaletteItem[] => {
      if (session.id.trim() === "" || session.name.trim() === "" || session.state === "closed") return [];
      return [{
        id: `session:${session.id}`,
        label: session.name,
        value: serializeComposerMentionPath(session.name),
        meta: session.summary ?? "",
        mention: {
          id: `session:${session.id}`,
          kind: "session",
          reference: session.id,
          label: session.name,
          token: serializeComposerMentionPath(session.name)
        }
      }];
    })
  ]);
}

/** Runtime get_commands is the sole native command authority. */
export function composerCommandItems(
  commands: readonly RuntimeCommandView[],
  options: ComposerCommandItemOptions = {}
): readonly ComposerPaletteItem[] {
  const items: ComposerPaletteItem[] = [
    ...(options.helpSupported === true
      ? [{ id: "builtin:help", label: "/help", value: "/help", meta: "Show every available command and skill" }]
      : []),
    ...(options.jumpSessionSupported === true
      ? [{ id: "builtin:jump-session", label: "/jump-session", value: "/jump-session", meta: "Open an exact task by ID" }]
      : []),
    ...(options.userShellSupported === true
      ? [{ id: "builtin:cmd", label: "/cmd", value: "/cmd", meta: "Run a workspace shell command" }]
      : []),
    ...(options.sessionResetSupported === true
      ? [{ id: "builtin:clear", label: "/clear", value: "/clear", meta: "Clear task context" }]
      : []),
    ...(options.reviewSupported === true
      ? [{ id: "builtin:review", label: "/review", value: "/review", meta: "Review current work in an independent read-only task" }]
      : [])
  ];
  items.push(...commands
    .filter((command) => command.loaded)
    .map((command) => ({
      id: `command:${command.id}`,
      label: slashName(command.name),
      value: slashName(command.name),
      meta: command.description || command.source
    })));
  return uniquePaletteItems(items);
}

/**
 * Detect a typed slash command at the caret without borrowing authority from
 * an incomplete or unrelated token. The returned end covers the whole run so
 * choosing a command after moving the caret into `/command` cannot leave a
 * stale suffix behind.
 */
export function detectComposerCommandActivation(
  text: string,
  caret: number,
  options: { readonly isComposing: boolean; readonly bashMode: boolean }
): ComposerCommandActivation | undefined {
  if (options.isComposing || options.bashMode || !Number.isInteger(caret) || caret < 0 || caret > text.length) {
    return undefined;
  }
  let from = caret;
  while (from > 0 && !/\s/u.test(text[from - 1] ?? "")) from -= 1;
  const prefix = text.slice(from, caret);
  if (!prefix.startsWith("/") || prefix.slice(1).includes("/")) return undefined;

  let to = caret;
  while (to < text.length && !/\s/u.test(text[to] ?? "")) to += 1;
  return { from, to, query: prefix.slice(1) };
}

export function filterComposerPaletteItems(
  items: readonly ComposerPaletteItem[],
  query: string,
  limit = 20
): readonly ComposerPaletteItem[] {
  const normalized = query.toLocaleLowerCase();
  return items
    .filter((item) => `${item.label} ${item.meta}`.toLocaleLowerCase().includes(normalized))
    .slice(0, Math.max(0, limit));
}

export function replaceComposerCommandRun(
  text: string,
  activation: ComposerCommandActivation,
  value: string
): { readonly text: string; readonly caret: number; readonly replacement: string } | undefined {
  if (
    activation.from < 0
    || activation.to < activation.from
    || activation.to > text.length
    || text[activation.from] !== "/"
  ) return undefined;
  const run = text.slice(activation.from, activation.to);
  if (
    !/^\/\S*$/u.test(run)
    || !run.slice(1).startsWith(activation.query)
    || activation.from > 0 && !/\s/u.test(text[activation.from - 1] ?? "")
    || activation.to < text.length && !/\s/u.test(text[activation.to] ?? "")
  ) return undefined;
  const separator = activation.to < text.length && /\s/u.test(text[activation.to] ?? "") ? "" : " ";
  const replacement = `${value}${separator}`;
  return {
    text: `${text.slice(0, activation.from)}${replacement}${text.slice(activation.to)}`,
    caret: activation.from + replacement.length,
    replacement
  };
}

/**
 * Recognize only the complete built-in command. Callers execute the returned
 * typed operation instead of sending the command text through SendInput.
 */
export function composerBuiltInCommand(
  text: string,
  options: ComposerCommandItemOptions = {}
): ComposerBuiltInCommand | undefined {
  if (options.helpSupported === true && /^\/help\s*$/iu.test(text)) return { kind: "help" };
  if (options.jumpSessionSupported === true) {
    const jump = text.match(/^\/jump-session(?:\s+([^\s]+))?\s*$/iu);
    if (jump !== null) return { kind: "jumpSession", sessionId: (jump[1] ?? "").trim() };
  }
  if (options.userShellSupported === true) {
    const shell = text.match(/^\/cmd(?:\s+([\s\S]*?))?\s*$/iu);
    if (shell !== null) return { kind: "userShell", command: (shell[1] ?? "").trim() };
  }
  if (options.reviewSupported === true) {
    // Desktop commands must begin in column zero. Do not steal a Pi
    // skill whose name merely shares the prefix.
    const review = text.match(/^\/review(?:\s+([\s\S]*?))?\s*$/iu);
    if (review !== null) return { kind: "review", focus: (review[1] ?? "").trim() };
  }
  if (options.sessionResetSupported === true && /^\s*\/clear\s*$/u.test(text)) return { kind: "sessionReset" };
  return undefined;
}

export function insertComposerPaletteValue(
  text: string,
  typedTrigger: "/" | "@" | undefined,
  item: ComposerPaletteItem
): string {
  return typedTrigger !== undefined && text === typedTrigger
    ? `${item.value} `
    : `${text}${text !== "" && !text.endsWith(" ") ? " " : ""}${item.value} `;
}

export function mentionsStillPresent(text: string, mentions: readonly ComposerMentionDraft[]): readonly ComposerMentionDraft[] {
  return activeComposerMentions(text, mentions);
}

function flattenWorkspaceEntries(
  entries: readonly WorkspaceEntryView[],
  workspaceId: string | undefined,
  parent = ""
): readonly ComposerPaletteItem[] {
  return entries.flatMap((entry) => {
    const path = entry.path || `${parent}/${entry.name}`.replace(/^\//u, "");
    const token = serializeComposerMentionPath(path);
    const current: readonly ComposerPaletteItem[] = entry.kind === "file"
      ? [{
          id: `file:${workspaceId ?? ""}:${path}`,
          label: entry.name,
          value: token,
          meta: path,
          mention: {
            id: `workspace:${workspaceId ?? ""}:${path}`,
            kind: "workspace",
            reference: path,
            label: entry.name,
            token,
            ...(workspaceId === undefined ? {} : { workspaceId })
          }
        }]
      : [];
    return [...current, ...flattenWorkspaceEntries(entry.children ?? [], workspaceId, path)];
  });
}

function slashName(value: string): string {
  return `/${value.replace(/^\/+/, "")}`;
}

function uniquePaletteItems(items: readonly ComposerPaletteItem[]): readonly ComposerPaletteItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.id.startsWith("session:") ? item.id : item.value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
