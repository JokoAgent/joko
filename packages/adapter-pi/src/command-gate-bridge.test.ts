import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { describe, expect, it, vi } from "vitest";

import { COMMAND_GATE_REQUEST_PREFIX, handleCommandGateExtensionRequest } from "./command-gate-bridge.js";

const request = (id: string, action: "acquire" | "release", toolCallId: string) => ({
  type: "extension_ui_request",
  id,
  method: "input",
  title: `${COMMAND_GATE_REQUEST_PREFIX}${action}/${Buffer.from(toolCallId).toString("base64url")}`
});

describe("managed command gate bridge", () => {
  it("holds an extension response until the shared service gate admits the command", async () => {
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1 });
    await gate.acquire({ commandId: "session-a:1:first", sessionId: "session-a" });
    const notify = vi.fn(async () => undefined);
    const handled = handleCommandGateExtensionRequest(request("request-1", "acquire", "second"), {
      gate,
      sessionId: "session-b",
      generation: 2,
      transport: { closed: false, notify },
      isCurrent: () => true
    });
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
    gate.release("session-a:1:first", "done");
    await expect(handled).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "request-1",
      value: "admitted"
    });
    gate.close();
  });

  it("releases idempotently and consumes malformed reserved requests", async () => {
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1 });
    await gate.acquire({ commandId: "session:3:tool", sessionId: "session" });
    const notify = vi.fn(async () => undefined);
    const options = {
      gate,
      sessionId: "session",
      generation: 3,
      transport: { closed: false, notify },
      isCurrent: () => true
    };
    await handleCommandGateExtensionRequest(request("release-1", "release", "tool"), options);
    await handleCommandGateExtensionRequest(request("release-2", "release", "tool"), options);
    expect(gate.snapshot()).toEqual({ running: 0, queued: 0 });
    await expect(handleCommandGateExtensionRequest({
      id: "bad",
      method: "input",
      title: `${COMMAND_GATE_REQUEST_PREFIX}acquire/not+base64`
    }, options)).resolves.toBe(true);
    expect(notify).toHaveBeenLastCalledWith({ type: "extension_ui_response", id: "bad", cancelled: true });
    gate.close();
  });
});
