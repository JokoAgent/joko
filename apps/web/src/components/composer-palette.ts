import type {
  ComposerMentionDraft,
  ResourceView,
  RuntimeCommandView,
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
  resources: readonly ResourceView[],
  indexedPaths: readonly string[] = []
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
    ...resources.map((resource) => {
      const token = `@${resource.name}`;
      return {
        id: `resource:${resource.id}`,
        label: resource.name,
        value: token,
        meta: resource.kind,
        mention: {
          id: `resource:${resource.id}`,
          kind: "resource" as const,
          reference: resource.id,
          label: resource.name,
          token
        }
      };
    })
  ]);
}

/**
 * Runtime get_commands remains authoritative. A loaded skill/prompt resource
 * is also useful on the delayed-create route, where no Session exists yet to
 * request a session-scoped command catalog.
 */
export function composerCommandItems(
  commands: readonly RuntimeCommandView[],
  resources: readonly ResourceView[] = [],
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
  const representedResources = new Set(commands.flatMap((command) => command.resourceId === undefined ? [] : [command.resourceId]));
  for (const resource of resources) {
    if (
      !resource.enabled
      || resource.state !== "loaded"
      || (resource.kind !== "skill" && resource.kind !== "prompt")
      || representedResources.has(resource.id)
    ) continue;
    const value = slashName(resource.name.replace(/\s+/gu, "-"));
    items.push({ id: `resource-command:${resource.id}`, label: value, value, meta: resource.kind });
  }
  return uniquePaletteItems(items);
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
    const key = item.value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
