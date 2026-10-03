import { describe, expect, it } from "vitest";

import {
  DEDICATED_HARDWARE_COMMAND_IDS,
  MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_CHARACTERS,
  parseDedicatedHardwareAction,
  parseDedicatedHardwareActionEvent,
  type DedicatedHardwareAction
} from "./actions.js";
import {
  DEDICATED_HARDWARE_COMMANDS,
  type DedicatedHardwareBinding
} from "../dedicated-hardware/settings.js";

const GAMEPAD_COMMANDS_WITHOUT_NONE_OR_VOICE = [
  "activate", "back", "navigate-back", "navigate-forward", "new-task", "toggle-sidebar",
  "focus-composer", "previous-task", "next-task", "previous-panel", "next-panel", "scroll-up",
  "scroll-down", "approve", "reject", "submit", "stop", "toggle-plan", "toggle-fast",
  "effort-increase", "effort-decrease", "toggle-pin", "archive-task", "fork-task",
  "copy-task-link", "copy-conversation-markdown", "add-photos", "add-files", "open-commands",
  "open-settings", "open-skills", "open-schedules", "open-folder", "toggle-inspector",
  "toggle-fullscreen", "open-terminal", "open-browser-tab", "toggle-review-tab", "scroll-bottom",
  "feedback"
] as const;

function settingsBindingToCanonical(
  binding: Exclude<DedicatedHardwareBinding, { kind: "none" }>
): DedicatedHardwareAction {
  return binding;
}

function exactTaskAction(): Extract<DedicatedHardwareAction, { kind: "task" }> {
  return {
    kind: "task",
    profileId: "p".repeat(256),
    serverId: "v".repeat(256),
    connectionGeneration: "8",
    snapshotRevision: "13",
    sessionId: "s".repeat(512),
    sessionGeneration: "21",
    targetId: "t".repeat(512),
    focusWindow: true
  };
}

describe("dedicated hardware action parser", () => {
  it("keeps every current settings command available as a canonical press event", () => {
    expect(DEDICATED_HARDWARE_COMMAND_IDS).toEqual(GAMEPAD_COMMANDS_WITHOUT_NONE_OR_VOICE);
    expect(DEDICATED_HARDWARE_COMMAND_IDS).toEqual(DEDICATED_HARDWARE_COMMANDS);
    for (const commandId of GAMEPAD_COMMANDS_WITHOUT_NONE_OR_VOICE) {
      expect(parseDedicatedHardwareActionEvent({
        kind: "button",
        phase: "press",
        action: { kind: "command", command: commandId }
      })).toEqual({ kind: "button", phase: "press", action: { kind: "command", command: commandId } });
    }
    const settingsBinding: Exclude<DedicatedHardwareBinding, { kind: "none" }> = {
      kind: "fixed-link",
      linkId: "documentation"
    };
    const canonicalAction = settingsBindingToCanonical(settingsBinding);
    expect(parseDedicatedHardwareAction(canonicalAction)).toEqual(settingsBinding);
  });

  it("accepts exact task and skill identities at their field budgets", () => {
    const task = exactTaskAction();
    expect(parseDedicatedHardwareAction(task)).toEqual(task);
    expect(parseDedicatedHardwareAction({
      kind: "skill",
      serverId: "v".repeat(256),
      resourceId: "r".repeat(512),
      name: "n".repeat(256)
    })).toEqual({
      kind: "skill",
      serverId: "v".repeat(256),
      resourceId: "r".repeat(512),
      name: "n".repeat(256)
    });
  });

  it("accepts only fixed composer keys without text or modifier payloads", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Enter"] as const) {
      expect(parseDedicatedHardwareAction({ kind: "composer-key", key })).toEqual({ kind: "composer-key", key });
    }
    for (const value of [
      { kind: "composer-key", key: "A" }, { kind: "composer-key", key: "ArrowLeft" },
      { kind: "composer-key", key: "Enter", text: "draft" },
      { kind: "composer-key", key: "ArrowUp", shiftKey: true }
    ]) expect(() => parseDedicatedHardwareAction(value)).toThrow(TypeError);
  });

  it("rejects incomplete, overlong, padded, controlled, or extra identity fields", () => {
    for (const value of [
      { kind: "task", profileId: " profile", sessionId: "session" },
      { ...exactTaskAction(), sessionId: "s".repeat(513) },
      { ...exactTaskAction(), snapshotRevision: "01" },
      { ...exactTaskAction(), targetId: "target", title: "unsafe" },
      { kind: "skill", serverId: "s".repeat(257), resourceId: "resource", name: "Skill" },
      { kind: "skill", serverId: "server", resourceId: "resource\n", name: "Skill" },
      { kind: "skill", serverId: "server", resourceId: "resource", name: "" }
    ]) {
      expect(() => parseDedicatedHardwareAction(value)).toThrow(TypeError);
    }
  });

  it("preserves bounded renderer-only composer text but rejects controls and invalid Unicode", () => {
    const text = "a".repeat(MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_CHARACTERS);
    expect(parseDedicatedHardwareAction({ kind: "composer-text", text })).toEqual({
      kind: "composer-text",
      text
    });
    for (const invalid of [
      " ",
      " padded",
      "bad\ntext",
      "bad\ttext",
      "bad\rtext",
      "bad\u0000text",
      "\ud800",
      "a".repeat(MAX_DEDICATED_HARDWARE_COMPOSER_TEXT_CHARACTERS + 1)
    ]) {
      expect(() => parseDedicatedHardwareAction({ kind: "composer-text", text: invalid })).toThrow(TypeError);
    }
  });

  it("allows only fixed link identities and never arbitrary URL, text-injection, or key actions", () => {
    expect(parseDedicatedHardwareAction({ kind: "fixed-link", linkId: "product-feedback" }))
      .toEqual({ kind: "fixed-link", linkId: "product-feedback" });
    expect(parseDedicatedHardwareAction({ kind: "fixed-link", linkId: "documentation" }))
      .toEqual({ kind: "fixed-link", linkId: "documentation" });
    for (const value of [
      { kind: "fixed-link", linkId: "https://example.invalid" },
      { kind: "external-url", url: "https://example.invalid" },
      { kind: "keyboard", key: "A" },
      { kind: "system-text", text: "hello" }
    ]) {
      expect(() => parseDedicatedHardwareAction(value)).toThrow(TypeError);
    }
  });

  it("strictly parses button phases and scroll samples", () => {
    expect(parseDedicatedHardwareActionEvent({
      kind: "button",
      phase: "cancel",
      action: { kind: "voice" }
    })).toEqual({ kind: "button", phase: "cancel", action: { kind: "voice" } });
    expect(parseDedicatedHardwareActionEvent({
      kind: "scroll",
      phase: "move",
      direction: "down",
      distance: 0.75
    })).toEqual({ kind: "scroll", phase: "move", direction: "down", distance: 0.75 });
    expect(parseDedicatedHardwareActionEvent({ kind: "scroll", phase: "release" }))
      .toEqual({ kind: "scroll", phase: "release" });

    for (const value of [
      { kind: "button", phase: "pressed", action: { kind: "voice" } },
      { kind: "button", phase: "press", action: { kind: "voice" }, source: "device" },
      { kind: "scroll", phase: "press", direction: "left", distance: 1 },
      { kind: "scroll", phase: "move", direction: "up", distance: Number.NaN },
      { kind: "scroll", phase: "move", direction: "up", distance: 0.5 },
      { kind: "scroll", phase: "move", direction: "up", distance: 1.01 },
      { kind: "scroll", phase: "release", direction: "up" }
    ]) {
      expect(() => parseDedicatedHardwareActionEvent(value)).toThrow(TypeError);
    }
  });
});
