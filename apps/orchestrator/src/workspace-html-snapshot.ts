import { createHash } from "node:crypto";
import type { OperationalStore } from "@joko/store";
import type { WorkspacePreviewAuthority, WorkspaceService } from "./workspace-service.js";
import { WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, WorkspaceFilePreviewError } from "./workspace-service.js";

export interface WorkspaceHtmlSource {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly expectedRevision: string;
}

/** The file remains a Workspace read, never a browser-owned filesystem read. */
export async function readWorkspaceHtmlSnapshot(input: {
  readonly store: OperationalStore;
  readonly workspaces: WorkspaceService;
  readonly sessionId: string;
  readonly source: WorkspaceHtmlSource;
  readonly assertConnection: () => void;
  readonly signal?: AbortSignal;
  readonly authority?: WorkspacePreviewAuthority;
  readonly readSignal?: AbortSignal;
}): Promise<WorkspaceHtmlSnapshot> {
  const { store, source } = input;
  const session = store.getSession(input.sessionId).descriptor;
  const target = store.getTarget(session.targetId);
  const metadata = target.metadata as { workspaceId?: unknown };
  const workspaceId = session.worktree?.workspaceId ?? (typeof metadata.workspaceId === "string" ? metadata.workspaceId : target.descriptor.id);
  if (source.workspaceId !== workspaceId || !/\.html?$/iu.test(source.relativePath)) {
    throw new WorkspaceFilePreviewError("The HTML file does not belong to this task workspace.", "invalid");
  }
  let authority = input.authority;
  const guard = (): void => {
    input.signal?.throwIfAborted();
    input.assertConnection();
    authority?.assertCurrent();
    const current = store.getSession(session.id).descriptor;
    if (current.targetId !== session.targetId || current.binding.generation !== session.binding.generation
      || current.binding.opaqueRef !== session.binding.opaqueRef || current.worktree?.workspaceId !== session.worktree?.workspaceId
      || current.archived || current.deletedAt !== undefined || store.findPendingSessionLifecycleCleanup(session.id) !== undefined
      || store.getTarget(session.targetId).revision !== target.revision) {
      throw new WorkspaceFilePreviewError("The HTML preview owner changed. Open the file again.", "stale");
    }
  };
  guard();
  const readSignal = input.signal === undefined ? input.readSignal : input.readSignal === undefined ? input.signal : AbortSignal.any([input.signal, input.readSignal]);
  readSignal?.throwIfAborted();
  authority ??= await input.workspaces.capturePreviewAuthority(source.workspaceId, readSignal);
  guard();
  readSignal?.throwIfAborted();
  const reader = authority;
  const preview = await reader.preview(source.relativePath, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, readSignal);
  guard();
  readSignal?.throwIfAborted();
  if (preview.text === undefined || preview.truncated || preview.mediaType !== "text/html"
    || Buffer.byteLength(preview.text, "utf8") > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
    throw new WorkspaceFilePreviewError("HTML previews require a complete UTF-8 file of at most 2 MiB.", "unsupported");
  }
  const revision = `workspace-html:${createHash("sha256").update(JSON.stringify([reader.identity, preview.entry.path, preview.entry.revision])).digest("hex")}`;
  if (source.expectedRevision !== "" && source.expectedRevision !== revision) {
    throw new WorkspaceFilePreviewError("The HTML file changed. Open the file again.", "stale");
  }
  return {
    file: { workspaceId, relativePath: preview.entry.path, expectedRevision: revision }, html: preview.text, assertCurrent: guard,
    reload: async (signal) => {
      guard(); signal.throwIfAborted();
      const next = await readWorkspaceHtmlSnapshot({ ...input, authority, readSignal: signal, source: { ...source, expectedRevision: "" } });
      guard(); signal.throwIfAborted();
      return next;
    },
    readDocument: async (path, signal) => {
      const currentSignal = input.signal === undefined ? signal : AbortSignal.any([input.signal, signal]);
      guard(); currentSignal.throwIfAborted();
      if (!validHtmlPath(path)) {
        throw new WorkspaceFilePreviewError("Invalid HTML document path.", "invalid");
      }
      const document = await reader.preview(path, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, currentSignal);
      guard(); currentSignal.throwIfAborted();
      if (document.text === undefined || document.truncated || document.mediaType !== "text/html"
        || Buffer.byteLength(document.text, "utf8") > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
        throw new WorkspaceFilePreviewError("HTML previews require a complete UTF-8 file of at most 2 MiB.", "unsupported");
      }
      return { html: document.text, mediaType: "text/html" as const };
    },
    readResource: async (path, signal) => {
      const currentSignal = input.signal === undefined ? signal : AbortSignal.any([input.signal, signal]);
      guard(); currentSignal.throwIfAborted();
      if (!validWorkspaceReadPath(path)) {
        throw new WorkspaceFilePreviewError("Invalid HTML resource path.", "invalid");
      }
      const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
      const mediaType = HTML_RESOURCE_MEDIA.get(extension);
      if (mediaType === undefined) throw new WorkspaceFilePreviewError("Unsupported HTML resource type.", "unsupported");
      const resource = await reader.preview(path, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, currentSignal);
      guard(); currentSignal.throwIfAborted();
      const body = resource.bytes ?? (resource.text === undefined ? undefined : Buffer.from(resource.text, "utf8"));
      if (resource.truncated || body === undefined || body.byteLength > 2 * 1024 * 1024) {
        throw new WorkspaceFilePreviewError("HTML resources require complete files of at most 2 MiB.", "unsupported");
      }
      return { body, mediaType };
    }
  };
}

export interface WorkspaceHtmlSnapshot {
  readonly file: WorkspaceHtmlSource;
  readonly html: string;
  readonly assertCurrent: () => void;
  readonly reload: (signal: AbortSignal) => Promise<WorkspaceHtmlSnapshot>;
  readonly readDocument: (path: string, signal: AbortSignal) => Promise<{ readonly html: string; readonly mediaType: "text/html" }>;
  readonly readResource: (path: string, signal: AbortSignal) => Promise<{ readonly body: Buffer; readonly mediaType: string }>;
}

function validWorkspaceReadPath(path: string): boolean {
  return path.length > 0 && path.length <= 4_096 && !path.startsWith("/") && !/[\\:\x00-\x1f]/u.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validHtmlPath(path: string): boolean {
  return validWorkspaceReadPath(path) && /\.html?$/iu.test(path);
}

const HTML_RESOURCE_MEDIA = new Map([
  [".css", "text/css"], [".js", "text/javascript"], [".mjs", "text/javascript"],
  [".json", "application/json"], [".wasm", "application/wasm"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"],
  [".webp", "image/webp"], [".bmp", "image/bmp"], [".ico", "image/x-icon"], [".svg", "image/svg+xml"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"], [".oga", "audio/ogg"],
  [".m4a", "audio/mp4"], [".aac", "audio/aac"], [".flac", "audio/flac"], [".opus", "audio/ogg"],
  [".mp4", "video/mp4"], [".m4v", "video/x-m4v"], [".mov", "video/quicktime"],
  [".webm", "video/webm"], [".avi", "video/x-msvideo"], [".mkv", "video/x-matroska"]
]);
