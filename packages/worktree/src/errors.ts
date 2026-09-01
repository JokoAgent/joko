export type WorktreeErrorCode =
  | "ABORTED"
  | "CLEANUP_FAILED"
  | "CWD_IS_WORKTREE"
  | "CWD_UNSAFE"
  | "DISPOSED"
  | "GIT_FAILED"
  | "GIT_NOT_FOUND"
  | "INTERNAL"
  | "INVALID_ARGUMENT"
  | "NOT_GIT_REPOSITORY"
  | "NOT_INITIALIZED"
  | "OPERATION_TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PATH_UNSAFE"
  | "REPOSITORY_UNSAFE"
  | "SESSION_CONFLICT"
  | "SOURCE_NOT_FOUND"
  | "STATE_CORRUPT"
  | "STORAGE_UNSAFE";

export interface WorktreeErrorShape {
  readonly code: WorktreeErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, boolean | number | string>>;
}

export class WorktreeServiceError extends Error {
  readonly code: WorktreeErrorCode;
  readonly details: Readonly<Record<string, boolean | number | string>> | undefined;

  constructor(
    code: WorktreeErrorCode,
    message: string,
    details?: Readonly<Record<string, boolean | number | string>>
  ) {
    super(message);
    this.name = "WorktreeServiceError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }

  toJSON(): WorktreeErrorShape {
    return Object.freeze({
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details })
    });
  }
}

export function isWorktreeServiceError(value: unknown): value is WorktreeServiceError {
  return value instanceof WorktreeServiceError;
}
