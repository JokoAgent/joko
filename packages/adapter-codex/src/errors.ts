import { JokoError } from "@joko/core";

export type CodexFailurePhase = "probe" | "provision" | "dispatch" | "stream" | "interaction" | "shutdown";

export function adapterError(input: {
  readonly code: string;
  readonly message: string;
  readonly phase: CodexFailurePhase;
  readonly retryable?: boolean;
  readonly stateMayHaveChanged?: boolean;
  readonly recovery: string;
}): JokoError {
  return new JokoError({
    code: input.code,
    message: input.message,
    phase: input.phase,
    retryable: input.retryable ?? false,
    stateMayHaveChanged: input.stateMayHaveChanged ?? false,
    recovery: input.recovery
  });
}

export class TransportFault extends Error {
  readonly code: "not_started" | "spawn_failed" | "request_timeout" | "protocol_violation" | "buffer_overflow" | "process_exited" | "write_failed" | "closed" | "shutdown_unconfirmed";
  readonly stateMayHaveChanged: boolean;

  constructor(
    code: TransportFault["code"],
    message: string,
    options: { readonly stateMayHaveChanged?: boolean } = {}
  ) {
    super(message);
    this.name = "TransportFault";
    this.code = code;
    this.stateMayHaveChanged = options.stateMayHaveChanged ?? false;
  }
}

export class RpcRemoteFault extends Error {
  readonly rpcCode: number;

  constructor(rpcCode: number) {
    super("The Codex app-server rejected the request.");
    this.name = "RpcRemoteFault";
    this.rpcCode = rpcCode;
  }
}

export function isAmbiguousDispatchFailure(error: unknown): boolean {
  return error instanceof TransportFault && error.stateMayHaveChanged;
}
