export type LspToolErrorCode =
  | "ABORTED"
  | "DEADLINE_EXCEEDED"
  | "FILE_IGNORED"
  | "FILE_LIMIT_EXCEEDED"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "FILE_UNSAFE"
  | "INTERNAL"
  | "INVALID_ARGUMENT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "POSITION_OUT_OF_RANGE"
  | "UNSUPPORTED_FILE"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_UNSAFE";

export interface LspToolErrorShape {
  readonly code: LspToolErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, boolean | number | string>>;
}

export class LspToolError extends Error {
  readonly code: LspToolErrorCode;
  readonly details: Readonly<Record<string, boolean | number | string>> | undefined;

  constructor(
    code: LspToolErrorCode,
    message: string,
    details?: Readonly<Record<string, boolean | number | string>>
  ) {
    super(message);
    this.name = "LspToolError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }

  toJSON(): LspToolErrorShape {
    return Object.freeze({
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details })
    });
  }
}

export function isLspToolError(value: unknown): value is LspToolError {
  return value instanceof LspToolError;
}
