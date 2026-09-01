import type {
  AdapterContext,
  BackendAdapter,
  CreateNativeSessionInput,
  NativeSessionForkResult,
  NativeSessionState,
  RuntimeCommand,
  RuntimeResource,
  SessionTree
} from "./adapter.js";
import { JokoError } from "./errors.js";
import type {
  BackendDescriptor,
  BlobRef,
  NativeSessionBinding,
  PermissionMode,
  PromptInput,
  ProviderModel,
  TargetDescriptor
} from "./types.js";

/**
 * Capability-neutral defaults for a production Adapter. Subclasses override
 * only operations their descriptor advertises; every other operation fails
 * explicitly instead of simulating a native feature or silently succeeding.
 */
export abstract class CapabilityDrivenBackendAdapter implements BackendAdapter {
  abstract readonly id: string;
  abstract describe(): Promise<BackendDescriptor>;
  abstract validateTarget(target: TargetDescriptor): Promise<void>;
  abstract createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding>;
  abstract resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState>;
  abstract inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState>;
  abstract send(input: PromptInput, context: AdapterContext): Promise<void>;
  abstract abort(context: AdapterContext): Promise<void>;
  abstract dispose(): Promise<void>;

  closeSession(_binding: NativeSessionBinding, _context: AdapterContext): Promise<void> {
    return this.unsupported("session.detach");
  }

  deleteSession(_binding: NativeSessionBinding, _context: AdapterContext): Promise<void> {
    return this.unsupported("session.delete");
  }

  setModel(_providerId: string, _modelId: string, _context: AdapterContext): Promise<ProviderModel> {
    return this.unsupported("model.switch");
  }

  setEffort(_level: string, _context: AdapterContext): Promise<void> {
    return this.unsupported("model.effort");
  }

  setFastMode(_enabled: boolean, _context: AdapterContext): Promise<void> {
    return this.unsupported("model.fast_mode");
  }

  setPermissionMode(_mode: PermissionMode, _context: AdapterContext): Promise<void> {
    return this.unsupported("permission.change");
  }

  setPlanMode(_enabled: boolean, _context: AdapterContext): Promise<void> {
    return this.unsupported("plan_mode");
  }

  compact(_customInstructions: string | undefined, _context: AdapterContext): Promise<"compacted" | "noop"> {
    return this.unsupported("context.compact");
  }

  setAutoCompaction(_enabled: boolean, _context: AdapterContext): Promise<void> {
    return this.unsupported("context.auto_compact");
  }

  setAutoRetry(_enabled: boolean, _context: AdapterContext): Promise<void> {
    return this.unsupported("context.auto_retry");
  }

  abortRetry(_context: AdapterContext): Promise<void> {
    return this.unsupported("context.auto_retry");
  }

  exportSession(_context: AdapterContext): Promise<BlobRef> {
    return this.unsupported("session.export");
  }

  getTree(_context: AdapterContext): Promise<SessionTree> {
    return this.unsupported("session.tree");
  }

  navigateTree(
    _entryId: string,
    _summarize: boolean,
    _context: AdapterContext,
    _customInstructions?: string
  ): Promise<void> {
    return this.unsupported("session.rewind");
  }

  fork(_entryId: string, _context: AdapterContext): Promise<NativeSessionForkResult> {
    return this.unsupported("session.fork");
  }

  clone(_context: AdapterContext): Promise<NativeSessionBinding> {
    return this.unsupported("session.clone");
  }

  setName(_name: string, _context: AdapterContext): Promise<void> {
    return this.unsupported("session.ai_rename");
  }

  getCommands(_context: AdapterContext): Promise<readonly RuntimeCommand[]> {
    return this.unsupported("runtime.commands");
  }

  getResources(_context: AdapterContext): Promise<readonly RuntimeResource[]> {
    return this.unsupported("runtime.resources");
  }

  protected unsupported<T>(capability: string): Promise<T> {
    return Promise.reject(new JokoError({
      code: "BACKEND_CAPABILITY_UNAVAILABLE",
      message: `The selected Backend does not provide ${capability}.`,
      phase: "capability",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Choose an advertised capability or another Backend instance."
    }));
  }
}
