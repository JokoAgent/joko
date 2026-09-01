import type { AdapterContext, InteractionPayload } from "@joko/core";
import { describe, expect, it, vi } from "vitest";

import { handleExtensionUiRequest } from "./interactions.js";
import type { PiRpcTransport } from "./transport.js";

describe("Pi typed interactions", () => {
  it("round-trips execute, stay, and refine plan decisions with feedback", async () => {
    for (const decision of ["execute", "stay", "refine"] as const) {
      const notify = vi.fn(async () => undefined);
      let opened: InteractionPayload | undefined;
      const context = adapterContext(async (interaction) => {
        opened = interaction;
        return { kind: "plan_review", decision, feedback: `feedback:${decision}` };
      });

      await handleExtensionUiRequest({
        type: "extension_ui_request",
        id: `plan-${decision}`,
        method: "select",
        title: "joko:plan-review\n1. Inspect\n2. Change",
        options: ["Execute plan", "Stay in plan mode", "Refine plan"]
      }, context, transport(notify), () => true);

      expect(opened).toMatchObject({
        kind: "plan_review",
        choices: ["execute", "stay", "refine"]
      });
      expect(notify).toHaveBeenCalledWith({
        type: "extension_ui_response",
        id: `plan-${decision}`,
        value: JSON.stringify({ decision, feedback: `feedback:${decision}` })
      });
    }
  });

  it("round-trips a multi-field typed question without flattening answer types", async () => {
    const descriptor = {
      title: "Pi has questions",
      prompt: "Answer to continue",
      fields: [
        { id: "q1", label: "Branch", description: "Choose a branch", required: true, kind: "single", choices: [
          { id: "q1-option-1", label: "main" },
          { id: "q1-option-2", label: "release", description: "stable" }
        ] },
        { id: "q2", label: "Checks", required: true, kind: "multiple", choices: [
          { id: "q2-option-1", label: "unit" },
          { id: "q2-option-2", label: "e2e" }
        ] },
        { id: "q3", label: "Notes", required: true, kind: "text", multiline: true }
      ]
    };
    const answers = {
      q1: "q1-option-1",
      q2: ["q2-option-1", "q2-option-2"],
      q3: "Keep compatibility"
    } as const;
    const notify = vi.fn(async () => undefined);
    let opened: InteractionPayload | undefined;
    const context = adapterContext(async (interaction) => {
      opened = interaction;
      return { kind: "question", answers };
    });

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "question-one",
      method: "editor",
      title: `joko:question\n${Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url")}`,
      prefill: ""
    }, context, transport(notify), () => true);

    expect(opened).toMatchObject({
      kind: "question",
      title: "Pi has questions",
      fields: [
        { id: "q1", kind: "single" },
        { id: "q2", kind: "multiple", minimumSelections: 1, maximumSelections: 3 },
        { id: "q3", kind: "text", sensitive: false }
      ]
    });
    expect(notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "question-one",
      value: JSON.stringify({ answers })
    });
  });

  it("round-trips skipped fields and one free-form Other answer", async () => {
    const descriptor = {
      title: "Pi has questions",
      prompt: "Answer or skip",
      fields: [
        { id: "q1", label: "Branch", required: false, kind: "single", choices: [{ id: "main", label: "main" }] },
        { id: "q2", label: "Checks", required: false, kind: "multiple", choices: [{ id: "unit", label: "unit" }] },
        { id: "q3", label: "Notes", required: false, kind: "text", multiline: true }
      ]
    };
    const answers = { q1: "a custom branch", q2: ["unit", "a custom check"] } as const;
    const notify = vi.fn(async () => undefined);
    let opened: InteractionPayload | undefined;
    const context = adapterContext(async (interaction) => {
      opened = interaction;
      return { kind: "question", answers };
    });

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "question-skip-other",
      method: "editor",
      title: `joko:question\n${Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url")}`,
      prefill: ""
    }, context, transport(notify), () => true);

    expect(opened).toMatchObject({
      kind: "question",
      fields: [
        { id: "q1", required: false },
        { id: "q2", required: false, minimumSelections: 0, maximumSelections: 2 },
        { id: "q3", required: false }
      ]
    });
    expect(notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "question-skip-other",
      value: JSON.stringify({ answers })
    });
  });

  it("leaves opened and terminal interaction events exclusively to SessionHost", async () => {
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const requestInteraction = vi.fn(async () => ({ kind: "confirmed", confirmed: true } as const));
    const context = { ...adapterContext(requestInteraction), emit };
    const notify = vi.fn(async () => undefined);

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "confirm-one",
      method: "confirm",
      title: "Continue?",
      message: "Proceed"
    }, context, transport(notify), () => true);

    expect(requestInteraction).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "confirm-one",
      confirmed: true
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it.each([
    {
      id: "timed-select",
      event: { method: "select", title: "Choose quickly", options: ["one", "two"] },
      decision: { kind: "selected", value: "two" } as const,
      response: { type: "extension_ui_response", id: "timed-select", value: "two" }
    },
    {
      id: "timed-confirm",
      event: { method: "confirm", title: "Confirm quickly", message: "Proceed" },
      decision: { kind: "confirmed", confirmed: true } as const,
      response: { type: "extension_ui_response", id: "timed-confirm", confirmed: true }
    },
    {
      id: "timed-input",
      event: { method: "input", title: "Answer quickly", placeholder: "value" },
      decision: { kind: "selected", value: "answer" } as const,
      response: { type: "extension_ui_response", id: "timed-input", value: "answer" }
    }
  ])("registers timed $event.method interactions and accepts an answer before Pi expires", async ({ id, event, decision, response }) => {
    const requestInteraction = vi.fn(async (interaction: InteractionPayload) => {
      expect(interaction).toMatchObject({ extensionId: "pi", timeoutMs: 250 });
      return decision;
    });
    const notify = vi.fn(async () => undefined);

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id,
      ...event,
      timeout: 250
    }, adapterContext(requestInteraction), transport(notify), () => true);

    expect(requestInteraction).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(response);
  });

  it.each([
    {
      id: "expired-select",
      event: { method: "select", title: "Choose quickly", options: ["one", "two"] },
      lateDecision: { kind: "selected", value: "two" } as const
    },
    {
      id: "expired-confirm",
      event: { method: "confirm", title: "Confirm quickly", message: "Proceed" },
      lateDecision: { kind: "confirmed", confirmed: true } as const
    },
    {
      id: "expired-input",
      event: { method: "input", title: "Answer quickly", placeholder: "value" },
      lateDecision: { kind: "selected", value: "answer" } as const
    }
  ])("leaves an expired timed $event.method to Pi's native default and ignores a late answer", async ({ id, event, lateDecision }) => {
    vi.useFakeTimers();
    try {
      let resolveDecision: ((decision: typeof lateDecision) => void) | undefined;
      const requestInteraction = vi.fn(() => new Promise<typeof lateDecision>((resolve) => {
        resolveDecision = resolve;
      }));
      const notify = vi.fn(async () => undefined);

      const handled = handleExtensionUiRequest({
        type: "extension_ui_request",
        id,
        ...event,
        timeout: 250
      }, adapterContext(requestInteraction), transport(notify), () => true);

      expect(requestInteraction).toHaveBeenCalledTimes(1);
      expect(notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      await handled;
      expect(notify).not.toHaveBeenCalled();

      resolveDecision?.(lateDecision);
      await Promise.resolve();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects an extension title for the client without renaming Pi's native session", async () => {
    const notify = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ type: "response", success: true }));
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const context = { ...adapterContext(async () => ({ kind: "cancelled" })), emit };

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "title-one",
      method: "setTitle",
      title: "  Native plan session  "
    }, context, transport(notify, request), () => true);

    expect(request).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      { type: "extension_ui_effect", effect: "title", text: "  Native plan session  " },
      expect.objectContaining({ namespace: "pi", fields: expect.objectContaining({ method: "setTitle" }) })
    );
    expect(emit.mock.calls[0]?.[1]?.pi).toEqual({
      rpcEventType: "extension_ui_effect",
      payload: {
        case: "extensionUiEffect",
        value: {
          requestId: "title-one",
          extensionId: "",
          effect: { case: "title", value: { title: "  Native plan session  " } }
        }
      }
    });
  });

  it("redacts runtime-owned credential values before an editor effect becomes durable", async () => {
    const secret = "opaque-managed-credential";
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const context = { ...adapterContext(async () => ({ kind: "cancelled" })), emit };

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "editor-one",
      method: "set_editor_text",
      text: `retry without ${secret}`
    }, context, transport(vi.fn(async () => undefined)), () => true, [secret]);

    expect(emit).toHaveBeenCalledWith(
      { type: "extension_ui_effect", effect: "editor_text", text: "retry without [REDACTED]" },
      expect.objectContaining({ namespace: "pi", fields: expect.objectContaining({ method: "set_editor_text" }) })
    );
    expect(emit.mock.calls[0]?.[1]?.pi?.payload).toEqual({
      case: "extensionUiEffect",
      value: {
        requestId: "editor-one",
        extensionId: "",
        effect: { case: "editorText", value: { text: "retry without [REDACTED]" } }
      }
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
  });

  it("preserves editor whitespace and content beyond the former display limit", async () => {
    const text = `  ${"x".repeat(65_537)}\n`;
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const context = { ...adapterContext(async () => ({ kind: "cancelled" })), emit };

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "editor-complete",
      method: "set_editor_text",
      text
    }, context, transport(vi.fn(async () => undefined)), () => true);

    expect(emit.mock.calls[0]?.[0]).toEqual({
      type: "extension_ui_effect",
      effect: "editor_text",
      text
    });
    expect(emit.mock.calls[0]?.[1]?.pi?.payload).toMatchObject({
      case: "extensionUiEffect",
      value: { effect: { case: "editorText", value: { text } } }
    });
  });

  it("classifies permission risk from the complete summary", async () => {
    const message = `${"safe ".repeat(13_108)} deploy`;
    let opened: InteractionPayload | undefined;
    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "permission-complete",
      method: "confirm",
      title: "joko:permission:inspect",
      message
    }, adapterContext(async (interaction) => {
      opened = interaction;
      return { kind: "confirmed", confirmed: false };
    }), transport(vi.fn(async () => undefined)), () => true);

    expect(opened).toMatchObject({ kind: "permission", risk: "high", summary: message });
  });

  it("preserves complete keyed status and widget state before durable projection", async () => {
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const context = { ...adapterContext(async () => ({ kind: "cancelled" })), emit };
    const lines = Array.from({ length: 65 }, (_, index) => `${index}:${"x".repeat(2_049)}`);
    const key = `  ${"k".repeat(129)}  `;

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "widget-complete",
      method: "setWidget",
      widgetKey: key,
      widgetLines: lines
    }, context, transport(vi.fn(async () => undefined)), () => true);
    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "status-complete",
      method: "setStatus",
      statusKey: key,
      statusText: `  ${"s".repeat(2_049)}  `
    }, context, transport(vi.fn(async () => undefined)), () => true);

    expect(emit.mock.calls[0]?.[0]).toEqual({
      type: "extension_widget",
      key,
      lines,
      placement: "above_editor",
      removed: false
    });
    expect(emit.mock.calls[1]?.[0]).toEqual({
      type: "extension_status",
      key,
      text: `  ${"s".repeat(2_049)}  `
    });
  });

  it("preserves Pi notification kind in typed fire-and-forget metadata without replying", async () => {
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const context = { ...adapterContext(async () => ({ kind: "cancelled" })), emit };
    const notify = vi.fn(async () => undefined);

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "notice-one",
      method: "notify",
      message: "Review required",
      notifyType: "warning"
    }, context, transport(notify), () => true);

    expect(notify).not.toHaveBeenCalled();
    expect(emit.mock.calls[0]?.[1]?.pi).toMatchObject({
      rpcEventType: "extension_ui_effect",
      payload: {
        case: "extensionUiEffect",
        value: {
          requestId: "notice-one",
          extensionId: "",
          effect: { case: "notify", value: { message: "Review required", kind: "warning" } }
        }
      }
    });
  });

  it("projects keyed extension widgets with placement and explicit clear semantics", async () => {
    const emit = vi.fn(async (
      _payload: Parameters<AdapterContext["emit"]>[0],
      _metadata?: Parameters<AdapterContext["emit"]>[1]
    ) => undefined);
    const context = { ...adapterContext(async () => ({ kind: "cancelled" })), emit };
    const notify = vi.fn(async () => undefined);

    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "widget-one",
      method: "setWidget",
      widgetKey: "build-status",
      widgetLines: ["Build", "3 / 4"],
      widgetPlacement: "belowEditor"
    }, context, transport(notify), () => true);
    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "widget-clear",
      method: "setWidget",
      widgetKey: "build-status"
    }, context, transport(notify), () => true);
    await handleExtensionUiRequest({
      type: "extension_ui_request",
      id: "status-one",
      method: "setStatus",
      statusKey: "lint",
      statusText: "Checking"
    }, context, transport(notify), () => true);

    expect(emit.mock.calls.map(([payload]) => payload)).toEqual([
      { type: "extension_widget", key: "build-status", lines: ["Build", "3 / 4"], placement: "below_editor", removed: false },
      { type: "extension_widget", key: "build-status", lines: [], placement: "above_editor", removed: true },
      { type: "extension_status", key: "lint", text: "Checking" }
    ]);
    expect(emit.mock.calls.map(([, metadata]) => metadata?.pi?.payload)).toEqual([
      {
        case: "extensionUiEffect",
        value: {
          requestId: "widget-one",
          extensionId: "",
          effect: {
            case: "widget",
            value: { widgetKey: "build-status", lines: ["Build", "3 / 4"], placement: "below_editor", removed: false }
          }
        }
      },
      {
        case: "extensionUiEffect",
        value: {
          requestId: "widget-clear",
          extensionId: "",
          effect: {
            case: "widget",
            value: { widgetKey: "build-status", lines: [], placement: "above_editor", removed: true }
          }
        }
      },
      {
        case: "extensionUiEffect",
        value: {
          requestId: "status-one",
          extensionId: "",
          effect: { case: "status", value: { statusKey: "lint", statusText: "Checking" } }
        }
      }
    ]);
  });
});

function adapterContext(
  requestInteraction: AdapterContext["requestInteraction"]
): AdapterContext {
  return {
    sessionId: "session-one",
    generation: 4,
    target: {
      id: "target-one",
      backendId: "pi",
      displayName: "Workspace",
      workspaceRoot: "D:\\workspace",
      managed: false,
      trusted: true
    },
    signal: new AbortController().signal,
    emit: async () => undefined,
    requestInteraction,
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async () => ({ id: "unused", sha256: "a".repeat(64), byteLength: 0, mimeType: "text/plain" })
  };
}

function transport(
  notify: ReturnType<typeof vi.fn>,
  request: ReturnType<typeof vi.fn> = vi.fn(async () => ({ type: "response", success: true }))
): PiRpcTransport {
  return { notify, request, closed: false } as unknown as PiRpcTransport;
}
