import { describe, expect, it, vi } from "vitest";

import {
  normalizeRemoteSshHost,
  RemoteSshConnectionController
} from "./connection.js";
import { RemoteSshError } from "./errors.js";
import type {
  AgentAuthConnection,
  AgentAuthConnectorPort,
  RemoteSshHostInput,
  RemoteSshLogger,
  SshHostKeyVerifierPort
} from "./types.js";
import {
  AgentAuthConnectorFailure,
  REMOTE_SSH_MAXIMUM_OUTPUT_BYTES,
  REMOTE_SSH_TEST_TIMEOUT_MS
} from "./types.js";

const scope = Object.freeze({ ownerId: "owner-a", targetId: "target-a" });

describe("remote SSH connection test lifecycle", () => {
  it("moves through disconnected, connecting, authenticating, ready and closes explicitly", async () => {
    const close = vi.fn(async () => undefined);
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1, 2, 3) });
        return { close };
      })
    };
    const verifier: SshHostKeyVerifierPort = {
      verify: vi.fn(async () => ({ fingerprint: validFingerprint(), disposition: "pinned" as const }))
    };
    const now = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(50);
    const controller = new RemoteSshConnectionController(host(), { connector, hostKeyVerifier: verifier, now });
    const states = [controller.snapshot(scope).status];
    controller.onStatus(scope, (snapshot) => states.push(snapshot.status));
    const result = await controller.test(scope);
    expect(result).toMatchObject({ ok: true, snapshot: { status: "ready", statusChangedAt: 40 } });
    expect(states).toEqual(["disconnected", "connecting", "authenticating", "ready"]);
    expect(verifier.verify).toHaveBeenCalledWith({
      hostname: "host.example",
      port: 22,
      algorithm: "ssh-ed25519",
      key: Uint8Array.of(1, 2, 3)
    });
    expect(JSON.stringify(result)).not.toContain("credential-ref-sentinel");
    expect(close).not.toHaveBeenCalled();
    await controller.disconnect(scope);
    expect(close).toHaveBeenCalledOnce();
    expect(controller.snapshot(scope).status).toBe("disconnected");
  });

  it("uses one connection attempt for concurrent tests", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const connector = successfulConnector(async () => gate);
    const controller = controllerWith(connector);
    const first = controller.test(scope);
    const second = controller.test(scope);
    release?.();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(connector.connect).toHaveBeenCalledOnce();
    await controller.disconnect(scope);
  });

  it("times out within the bounded test lifecycle and aborts the connector", async () => {
    let connectorSignal: AbortSignal | undefined;
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        connectorSignal = request.signal;
        return new Promise<AgentAuthConnection>(() => undefined);
      })
    };
    const controller = controllerWith(connector);
    const result = await controller.test(scope, { timeoutMs: 10 });
    expect(result).toMatchObject({
      ok: false,
      snapshot: { status: "failed" },
      error: { code: "CONNECTION_TIMEOUT", retryable: true }
    });
    expect(connectorSignal?.aborted).toBe(true);
    expect(REMOTE_SSH_TEST_TIMEOUT_MS).toBe(20_000);
  });

  it("reports caller cancellation as aborted", async () => {
    const abort = new AbortController();
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async () => new Promise<never>(() => undefined))
    };
    const controller = controllerWith(connector);
    const pending = controller.test(scope, { signal: abort.signal });
    abort.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      snapshot: { status: "failed" },
      error: { code: "ABORTED", retryable: true }
    });
  });

  it("never retries a deterministic authentication failure", async () => {
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async () => {
        throw new AgentAuthConnectorFailure("AUTHENTICATION_FAILED");
      })
    };
    const controller = controllerWith(connector);
    const result = await controller.test(scope);
    expect(result).toMatchObject({
      ok: false,
      snapshot: { status: "failed" },
      error: { code: "AUTHENTICATION_FAILED", retryable: false }
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(connector.connect).toHaveBeenCalledOnce();
  });

  it("fails closed when a connector reaches ready without host-key verification", async () => {
    const close = vi.fn(async () => undefined);
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        return { close };
      })
    };
    const result = await controllerWith(connector).test(scope);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "HOST_KEY_MISSING", retryable: false }
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not publish ready until an unawaited connector verification completes", async () => {
    let releaseVerification: (() => void) | undefined;
    const verifier: SshHostKeyVerifierPort = {
      verify: vi.fn(async () => new Promise<void>((resolve) => { releaseVerification = resolve; }).then(() => ({
        fingerprint: validFingerprint(),
        disposition: "matched" as const
      })))
    };
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        void request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return { close: vi.fn(async () => undefined) };
      })
    };
    const controller = new RemoteSshConnectionController(host(), { connector, hostKeyVerifier: verifier });
    let settled = false;
    const pending = controller.test(scope).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(releaseVerification).toBeDefined());
    expect(settled).toBe(false);
    expect(controller.snapshot(scope).status).toBe("authenticating");
    releaseVerification?.();
    await expect(pending).resolves.toMatchObject({ ok: true, snapshot: { status: "ready" } });
    await controller.disconnect(scope);
  });

  it("applies the same deadline to an unawaited host-key verification", async () => {
    const close = vi.fn(async () => undefined);
    const verifier: SshHostKeyVerifierPort = {
      verify: vi.fn(async () => new Promise<never>(() => undefined))
    };
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        void request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return { close };
      })
    };
    const controller = new RemoteSshConnectionController(host(), { connector, hostKeyVerifier: verifier });
    await expect(controller.test(scope, { timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      error: { code: "CONNECTION_TIMEOUT", retryable: true }
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed when a connector omits the authentication phase", async () => {
    const close = vi.fn(async () => undefined);
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return { close };
      })
    };
    const result = await controllerWith(connector).test(scope);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONNECTOR_PROTOCOL", retryable: false }
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves a host-key refusal even if the connector wraps it", async () => {
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        try {
          await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(2) });
        } catch {
          throw new Error("connector-wrapper-sentinel");
        }
        throw new Error("unreachable");
      })
    };
    const verifier: SshHostKeyVerifierPort = {
      verify: vi.fn(async () => {
        throw new RemoteSshError(
          "HOST_KEY_CHANGED",
          "The remote host key changed. Connection was refused.",
          false
        );
      })
    };
    const result = await new RemoteSshConnectionController(host(), {
      connector,
      hostKeyVerifier: verifier
    }).test(scope);
    expect(result).toMatchObject({ ok: false, error: { code: "HOST_KEY_CHANGED", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("connector-wrapper-sentinel");
  });

  it("redacts connector messages, credential references, and presented key bytes from errors and logs", async () => {
    const logs: unknown[] = [];
    const logger: RemoteSshLogger = {
      warn: (message, fields) => logs.push({ message, fields })
    };
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async () => {
        throw new RemoteSshError(
          "CONNECTION_FAILED",
          "RAW_COMMAND_SENTINEL RAW_KEY_SENTINEL credential-ref-sentinel",
          true,
          { unsafe: "RAW_KEY_SENTINEL" }
        );
      })
    };
    const controller = new RemoteSshConnectionController(host(), {
      connector,
      hostKeyVerifier: acceptingVerifier(),
      logger
    });
    const result = await controller.test(scope);
    const publicOutput = JSON.stringify({ result, logs, snapshot: controller.snapshot(scope) });
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECTION_FAILED", retryable: true } });
    expect(publicOutput).not.toContain("RAW_COMMAND_SENTINEL");
    expect(publicOutput).not.toContain("RAW_KEY_SENTINEL");
    expect(publicOutput).not.toContain("credential-ref-sentinel");
  });

  it("sanitizes a synchronous connector throw", async () => {
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(() => {
        throw new Error("SYNC_CONNECTOR_SENTINEL");
      })
    };
    const result = await controllerWith(connector).test(scope);
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECTION_FAILED", retryable: true } });
    expect(JSON.stringify(result)).not.toContain("SYNC_CONNECTOR_SENTINEL");
  });

  it("fails closed for a malformed connection handle", async () => {
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return undefined as unknown as AgentAuthConnection;
      })
    };
    await expect(controllerWith(connector).test(scope)).resolves.toMatchObject({
      ok: false,
      error: { code: "CONNECTOR_PROTOCOL", retryable: false }
    });
  });

  it("isolates throwing status subscribers from the connection lifecycle", async () => {
    const controller = controllerWith(successfulConnector());
    controller.onStatus(scope, () => {
      throw new Error("STATUS_LISTENER_SENTINEL");
    });
    await expect(controller.test(scope)).resolves.toMatchObject({ ok: true, snapshot: { status: "ready" } });
    await controller.disconnect(scope);
  });

  it("refuses late verification callbacks after the test deadline", async () => {
    let verifyHostKey: ((key: { readonly algorithm: string; readonly key: Uint8Array }) => Promise<void>) | undefined;
    const verifier = acceptingVerifier();
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        verifyHostKey = request.verifyHostKey;
        return new Promise<AgentAuthConnection>(() => undefined);
      })
    };
    const controller = new RemoteSshConnectionController(host(), { connector, hostKeyVerifier: verifier });
    await expect(controller.test(scope, { timeoutMs: 10 })).resolves.toMatchObject({
      ok: false,
      error: { code: "CONNECTION_TIMEOUT" }
    });
    await expect(verifyHostKey?.({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) })).rejects.toEqual(
      expect.objectContaining({ code: "ABORTED" })
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("keeps an explicit disconnect authoritative over a late connection", async () => {
    let resolveConnection: ((value: AgentAuthConnection) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const close = vi.fn(async () => undefined);
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        requestSignal = request.signal;
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return new Promise<AgentAuthConnection>((resolve) => { resolveConnection = resolve; });
      })
    };
    const controller = controllerWith(connector);
    const pending = controller.test(scope);
    await vi.waitFor(() => {
      expect(requestSignal).toBeDefined();
      expect(resolveConnection).toBeDefined();
    });
    await controller.disconnect(scope);
    resolveConnection?.({ close });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      snapshot: { status: "disconnected" },
      error: { code: "ABORTED" }
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
    expect(controller.snapshot(scope).status).toBe("disconnected");
  });
});

describe("controlled SSH command execution", () => {
  it("executes only on a ready scoped connection with fixed transport limits", async () => {
    const execute = vi.fn(async () => ({
      stdout: "done",
      stderr: "",
      exitCode: 0,
      outputCapped: false
    }));
    const close = vi.fn(async () => undefined);
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return { close, execute };
      })
    };
    const controller = controllerWith(connector);
    await controller.test(scope);
    await expect(controller.execute(scope, {
      command: "printf done",
      cwd: "/srv/project",
      input: "stdin",
      timeoutMs: 5_000
    })).resolves.toEqual({
      stdout: "done",
      stderr: "",
      exitCode: 0,
      outputCapped: false
    });
    expect(execute).toHaveBeenCalledWith({
      command: "printf done",
      cwd: "/srv/project",
      input: "stdin",
      timeoutMs: 5_000,
      maxOutputBytes: REMOTE_SSH_MAXIMUM_OUTPUT_BYTES,
      signal: expect.any(AbortSignal)
    });
    expect(close).not.toHaveBeenCalled();
    await controller.disconnect(scope);
  });

  it("fails closed when the connector does not declare command execution", async () => {
    const controller = controllerWith(successfulConnector());
    await controller.test(scope);
    await expect(controller.execute(scope, { command: "RAW_COMMAND_SENTINEL" })).rejects.toEqual(
      expect.objectContaining({ code: "EXECUTION_UNAVAILABLE", retryable: false })
    );
    await expect(controller.execute({ ownerId: "owner-b", targetId: "target-a" }, {
      command: "RAW_COMMAND_SENTINEL"
    })).rejects.toEqual(expect.objectContaining({ code: "OWNER_SCOPE_MISMATCH" }));
    await controller.disconnect(scope);
  });

  it("aborts and closes the connection at the command deadline", async () => {
    let executionSignal: AbortSignal | undefined;
    const close = vi.fn(async () => undefined);
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return {
          close,
          execute: vi.fn(async (execution) => {
            executionSignal = execution.signal;
            return new Promise<never>(() => undefined);
          })
        };
      })
    };
    const controller = controllerWith(connector);
    await controller.test(scope);
    await expect(controller.execute(scope, { command: "long-running", timeoutMs: 10 }))
      .rejects.toEqual(expect.objectContaining({ code: "EXECUTION_TIMEOUT", retryable: true }));
    expect(executionSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(controller.snapshot(scope).status).toBe("disconnected");
  });

  it("caps malformed oversized results and sanitizes connector failures", async () => {
    let call = 0;
    const execute = vi.fn(async () => {
      if (call++ > 0) throw new Error("RAW_EXECUTOR_ERROR RAW_COMMAND_SENTINEL");
      return {
        stdout: "x".repeat(REMOTE_SSH_MAXIMUM_OUTPUT_BYTES + 100),
        stderr: "",
        exitCode: 0,
        outputCapped: false
      };
    });
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return { close: vi.fn(async () => undefined), execute };
      })
    };
    const controller = controllerWith(connector);
    await controller.test(scope);
    const capped = await controller.execute(scope, { command: "large" });
    expect(Buffer.byteLength(capped.stdout, "utf8")).toBe(REMOTE_SSH_MAXIMUM_OUTPUT_BYTES);
    expect(capped.outputCapped).toBe(true);
    const failure = await controller.execute(scope, { command: "RAW_COMMAND_SENTINEL" })
      .catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ code: "EXECUTION_FAILED", retryable: true }));
    expect(JSON.stringify(failure)).not.toContain("RAW_EXECUTOR_ERROR");
    expect(JSON.stringify(failure)).not.toContain("RAW_COMMAND_SENTINEL");
    await controller.disconnect(scope);
  });

  it("rejects unsafe command inputs before invoking the transport", async () => {
    const execute = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      outputCapped: false
    }));
    const connector: AgentAuthConnectorPort = {
      connect: vi.fn(async (request) => {
        request.onAuthenticating();
        await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
        return { close: vi.fn(async () => undefined), execute };
      })
    };
    const controller = controllerWith(connector);
    await controller.test(scope);
    await expect(controller.execute(scope, { command: "" })).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
    await expect(controller.execute(scope, { command: "pwd", cwd: "relative" })).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
    expect(execute).not.toHaveBeenCalled();
    await controller.disconnect(scope);
  });
});

describe("owner and input boundaries", () => {
  it("derives retryability from stable error codes", () => {
    expect(new RemoteSshError("AUTHENTICATION_FAILED", "safe", true).retryable).toBe(false);
    expect(new RemoteSshError("HOST_KEY_CHANGED", "safe", true).retryable).toBe(false);
    expect(new RemoteSshError("CONNECTION_FAILED", "safe", false).retryable).toBe(true);
    expect(new RemoteSshError("CONNECTION_TIMEOUT", "safe", false).retryable).toBe(true);
  });

  it("rejects a different owner or target before calling the connector", async () => {
    const connector = successfulConnector();
    const controller = controllerWith(connector);
    expect(() => controller.snapshot({ ownerId: "owner-b", targetId: "target-a" })).toThrowError(
      expect.objectContaining({ code: "OWNER_SCOPE_MISMATCH", retryable: false })
    );
    await expect(controller.test({ ownerId: "owner-a", targetId: "target-b" })).rejects.toEqual(
      expect.objectContaining({ code: "OWNER_SCOPE_MISMATCH", retryable: false })
    );
    expect(connector.connect).not.toHaveBeenCalled();
  });

  it("normalizes only credential references and rejects unsafe host input", () => {
    expect(normalizeRemoteSshHost(host())).toEqual({
      ...scope,
      id: "alpha",
      hostname: "host.example",
      port: 22,
      user: "deploy",
      credentialRef: { id: "credential-ref-sentinel" },
      source: "manual"
    });
    expect(() => normalizeRemoteSshHost(host({ hostname: "host.example; unsafe" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
    expect(() => normalizeRemoteSshHost(host({ id: "*" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
    expect(() => normalizeRemoteSshHost(host({ credentialRef: { id: "" } }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" })
    );
  });
});

function controllerWith(connector: AgentAuthConnectorPort): RemoteSshConnectionController {
  return new RemoteSshConnectionController(host(), {
    connector,
    hostKeyVerifier: acceptingVerifier()
  });
}

function successfulConnector(beforeReady?: () => Promise<void>): AgentAuthConnectorPort & { connect: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async (request) => {
      request.onAuthenticating();
      await request.verifyHostKey({ algorithm: "ssh-ed25519", key: Uint8Array.of(1) });
      await beforeReady?.();
      return { close: vi.fn(async () => undefined) };
    })
  };
}

function acceptingVerifier(): SshHostKeyVerifierPort {
  return {
    verify: vi.fn(async () => ({ fingerprint: validFingerprint(), disposition: "matched" as const }))
  };
}

function validFingerprint(): string {
  return "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
}

function host(overrides: Partial<RemoteSshHostInput> = {}): RemoteSshHostInput {
  return {
    ...scope,
    id: "alpha",
    hostname: "host.example",
    port: 22,
    user: "deploy",
    credentialRef: { id: "credential-ref-sentinel" },
    ...overrides
  };
}
