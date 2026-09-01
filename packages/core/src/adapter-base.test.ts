import type { AdapterContext, BackendDescriptor, CreateNativeSessionInput, NativeSessionBinding, NativeSessionState, PromptInput, TargetDescriptor } from "./index.js";
import { CapabilityDrivenBackendAdapter } from "./index.js";
import { describe, expect, it } from "vitest";

describe("CapabilityDrivenBackendAdapter", () => {
  it("fails an unadvertised native operation explicitly", async () => {
    const value = new MinimalAdapter();
    await expect(value.setPlanMode(true, {} as AdapterContext)).rejects.toMatchObject({
      publicError: {
        code: "BACKEND_CAPABILITY_UNAVAILABLE",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false
      }
    });
  });
});

class MinimalAdapter extends CapabilityDrivenBackendAdapter {
  readonly id = "minimal";
  describe = async (): Promise<BackendDescriptor> => ({
    id: this.id,
    adapterKind: "minimal",
    instanceGeneration: 0,
    displayName: "Minimal",
    version: "1",
    health: "healthy",
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  validateTarget = async (_target: TargetDescriptor): Promise<void> => undefined;
  createSession = async (_input: CreateNativeSessionInput, _context: AdapterContext): Promise<NativeSessionBinding> => ({ opaqueRef: "native", generation: 1 });
  resumeSession = async (binding: NativeSessionBinding, _context: AdapterContext): Promise<NativeSessionState> => state(binding);
  inspectSession = async (binding: NativeSessionBinding, _context: AdapterContext): Promise<NativeSessionState> => state(binding);
  send = async (_input: PromptInput, _context: AdapterContext): Promise<void> => undefined;
  abort = async (_context: AdapterContext): Promise<void> => undefined;
  dispose = async (): Promise<void> => undefined;
}

function state(binding: NativeSessionBinding): NativeSessionState {
  return {
    binding,
    streaming: false,
    compacting: false,
    pendingMessages: 0,
    fastMode: false,
    permissionMode: "ask"
  };
}
