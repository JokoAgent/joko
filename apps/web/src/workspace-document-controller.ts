export interface WorkspaceDocumentIdentity {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly path: string;
}

export interface WorkspaceDirtyDocument {
  readonly identity: WorkspaceDocumentIdentity;
  isDirty(): boolean;
  save(): Promise<boolean>;
  discard(): void | Promise<void>;
  focus?(): void;
}

export type WorkspaceLeaveChoice = "save" | "discard" | "cancel";

export type WorkspaceLeaveReason =
  | "switch-file"
  | "close-file"
  | "close-files"
  | "switch-session"
  | "switch-workspace"
  | "route-change"
  | "window-close";

export interface WorkspaceLeavePromptInput {
  readonly document: WorkspaceDocumentIdentity;
  readonly reason: WorkspaceLeaveReason;
  readonly remainingDirtyDocuments: number;
}

export interface WorkspaceLeaveRequest {
  readonly reason: WorkspaceLeaveReason;
  readonly prompt: (input: WorkspaceLeavePromptInput) => Promise<WorkspaceLeaveChoice>;
  readonly matches?: (identity: WorkspaceDocumentIdentity) => boolean;
}

export interface WorkspaceDocumentRegistration {
  update(document: WorkspaceDirtyDocument): void;
  unregister(): void;
}

interface RegisteredDocument {
  readonly registrationId: number;
  document: WorkspaceDirtyDocument;
}

/**
 * Shared client-side guard for document-mode navigation.
 *
 * The controller deliberately owns no modal UI. Routes, tabs, and the Desktop
 * close bridge all ask the same registry whether leaving is safe and provide
 * their localized three-way prompt. A successful save is rechecked because a
 * user may type again while an earlier write is in flight.
 */
export class WorkspaceDocumentController {
  readonly #documents = new Map<string, RegisteredDocument>();
  #nextRegistrationId = 0;
  #leaveTail: Promise<void> = Promise.resolve();

  register(document: WorkspaceDirtyDocument): WorkspaceDocumentRegistration {
    assertDocument(document);
    const key = workspaceDocumentKey(document.identity);
    const registrationId = ++this.#nextRegistrationId;
    this.#documents.set(key, { registrationId, document });
    let registered = true;

    return {
      update: (next) => {
        if (!registered) return;
        assertDocument(next);
        if (workspaceDocumentKey(next.identity) !== key) {
          throw new TypeError("A workspace document registration cannot change identity.");
        }
        const current = this.#documents.get(key);
        if (current?.registrationId === registrationId) current.document = next;
      },
      unregister: () => {
        if (!registered) return;
        registered = false;
        const current = this.#documents.get(key);
        if (current?.registrationId === registrationId) this.#documents.delete(key);
      }
    };
  }

  dirtyDocuments(matches?: (identity: WorkspaceDocumentIdentity) => boolean): readonly WorkspaceDocumentIdentity[] {
    return this.#dirtyEntries(matches).map(([, entry]) => entry.document.identity);
  }

  shouldPreventUnload(matches?: (identity: WorkspaceDocumentIdentity) => boolean): boolean {
    return this.#dirtyEntries(matches).length > 0;
  }

  requestLeave(request: WorkspaceLeaveRequest): Promise<boolean> {
    const run = this.#leaveTail.then(() => this.#requestLeave(request));
    this.#leaveTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #requestLeave(request: WorkspaceLeaveRequest): Promise<boolean> {
    const pendingKeys = this.#dirtyEntries(request.matches).map(([key]) => key);
    for (let index = 0; index < pendingKeys.length; index += 1) {
      const key = pendingKeys[index]!;
      const entry = this.#documents.get(key);
      if (entry === undefined || !safeIsDirty(entry.document)) continue;

      let choice: WorkspaceLeaveChoice;
      try {
        choice = await request.prompt({
          document: entry.document.identity,
          reason: request.reason,
          remainingDirtyDocuments: pendingKeys.length - index
        });
      } catch {
        entry.document.focus?.();
        return false;
      }

      const current = this.#documents.get(key);
      if (current?.registrationId !== entry.registrationId) continue;
      if (choice === "cancel") {
        current.document.focus?.();
        return false;
      }

      try {
        if (choice === "save") {
          const saved = await current.document.save();
          const latest = this.#documents.get(key);
          if (!saved || (latest?.registrationId === current.registrationId && safeIsDirty(latest.document))) {
            latest?.document.focus?.();
            return false;
          }
        } else {
          await current.document.discard();
          const latest = this.#documents.get(key);
          if (latest?.registrationId === current.registrationId && safeIsDirty(latest.document)) {
            latest.document.focus?.();
            return false;
          }
        }
      } catch {
        this.#documents.get(key)?.document.focus?.();
        return false;
      }
    }
    return true;
  }

  #dirtyEntries(matches?: (identity: WorkspaceDocumentIdentity) => boolean): readonly (readonly [string, RegisteredDocument])[] {
    return [...this.#documents.entries()]
      .filter(([, entry]) => (matches?.(entry.document.identity) ?? true) && safeIsDirty(entry.document))
      .sort((left, right) => workspaceDocumentKey(left[1].document.identity).localeCompare(workspaceDocumentKey(right[1].document.identity), "en"));
  }
}

/** One registry shared by the formal Files route, route guard, and Desktop close flow. */
export const workspaceDocumentController = new WorkspaceDocumentController();

export function workspaceDocumentKey(identity: WorkspaceDocumentIdentity): string {
  const sessionId = normalizedIdentityPart(identity.sessionId, "sessionId", false);
  const workspaceId = normalizedIdentityPart(identity.workspaceId, "workspaceId", false);
  const path = canonicalWorkspaceDocumentPath(identity.path);
  return JSON.stringify([sessionId, workspaceId, path]);
}

export function canonicalWorkspaceDocumentPath(value: string): string {
  const normalized = normalizedIdentityPart(value, "path", true).replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized) || /^[a-z][a-z0-9+.-]*:/iu.test(normalized)) {
    throw new TypeError("Workspace document paths must be relative.");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("Workspace document paths must be canonical and traversal-free.");
  }
  return segments.join("/");
}

function normalizedIdentityPart(value: string, label: string, allowSlash: boolean): string {
  if (typeof value !== "string") throw new TypeError(`Workspace document ${label} must be text.`);
  const normalized = value.normalize("NFC").trim();
  if (normalized === "") throw new TypeError(`Workspace document ${label} must not be empty.`);
  if (/[\0\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new TypeError(`Workspace document ${label} contains forbidden control characters.`);
  }
  if (!allowSlash && /[\\/]/u.test(normalized)) {
    throw new TypeError(`Workspace document ${label} must not be path-shaped.`);
  }
  return normalized;
}

function assertDocument(document: WorkspaceDirtyDocument): void {
  workspaceDocumentKey(document.identity);
  if (typeof document.isDirty !== "function" || typeof document.save !== "function" || typeof document.discard !== "function") {
    throw new TypeError("Workspace document callbacks are required.");
  }
}

function safeIsDirty(document: WorkspaceDirtyDocument): boolean {
  try {
    return document.isDirty() === true;
  } catch {
    // A broken editor state must fail closed so navigation cannot silently
    // discard content that the registry can no longer inspect.
    return true;
  }
}
