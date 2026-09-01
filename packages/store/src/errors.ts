export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreError";
  }
}

export class StoreClosedError extends StoreError {
  constructor() {
    super("The operational store is closed.");
    this.name = "StoreClosedError";
  }
}

export class ActiveWriterError extends StoreError {
  constructor(options?: ErrorOptions) {
    super("The operational store is already owned by another active writer.", options);
    this.name = "ActiveWriterError";
  }
}

export class NotFoundError extends StoreError {
  constructor(readonly resource: string, readonly id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class OperationConflictError extends StoreError {
  constructor(
    readonly operationId: string,
    readonly expectedBodyHash: string,
    readonly receivedBodyHash: string
  ) {
    super(`Operation ${operationId} was already used with a different request body.`);
    this.name = "OperationConflictError";
  }
}

export class OperationPreviouslyFailedError extends StoreError {
  constructor(readonly operationId: string, readonly storedError: unknown) {
    super(`Operation ${operationId} previously failed.`);
    this.name = "OperationPreviouslyFailedError";
  }
}

export class OperationInProgressError extends StoreError {
  constructor(readonly operationId: string) {
    super(`Operation ${operationId} is still in progress.`);
    this.name = "OperationInProgressError";
  }
}

export class RevisionConflictError extends StoreError {
  constructor(
    readonly resource: string,
    readonly id: string,
    readonly expectedRevision: bigint,
    readonly actualRevision: bigint
  ) {
    super(
      `${resource} ${id} changed concurrently: expected revision ${expectedRevision}, actual revision ${actualRevision}.`
    );
    this.name = "RevisionConflictError";
  }
}

export class AuthorizationError extends StoreError {
  constructor(message = "The connection is not authorized.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class PairingError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

export class InvalidStateTransitionError extends StoreError {
  constructor(readonly resource: string, readonly from: string, readonly to: string) {
    super(`Invalid ${resource} state transition: ${from} -> ${to}.`);
    this.name = "InvalidStateTransitionError";
  }
}

export class StaleGenerationError extends StoreError {
  constructor(readonly expected: number, readonly received: number) {
    super(`Stale generation: expected ${expected}, received ${received}.`);
    this.name = "StaleGenerationError";
  }
}

export class SensitiveDataError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "SensitiveDataError";
  }
}

export class AsyncTransactionError extends StoreError {
  constructor() {
    super("OperationalStore transactions must be synchronous; external work cannot run under a SQLite transaction.");
    this.name = "AsyncTransactionError";
  }
}
