import type { RefObject } from "react";
import type { GamepadAction } from "./gamepad-input.js";
import {
  APP_INPUT_INSPECTOR_COMMANDS,
  APP_INPUT_OWNED_COMMANDS,
  currentAppInputTaskRoot,
  dispatchAppInputOwnedCommand,
  isAppInputInspectorCommand,
  isAppInputOwnedCommand,
  useAppInputCommandOwner,
  type AppInputCommandHandlers,
  type AppInputInspectorCommand,
  type AppInputOwnedCommand,
  type AppInputOwnerKind
} from "./app-input-owners.js";

export const GAMEPAD_INSPECTOR_ACTIONS = APP_INPUT_INSPECTOR_COMMANDS;
export type GamepadInspectorAction = AppInputInspectorCommand;
export interface GamepadInspectorRequest {
  readonly requestId: number;
  readonly action: GamepadInspectorAction;
  readonly sessionId: string;
  readonly sessionGeneration: bigint;
  readonly connectionGeneration: bigint;
  readonly profileId: string;
  readonly navigationRevision: number;
}

export function isGamepadInspectorAction(action: GamepadAction): action is GamepadInspectorAction {
  return isAppInputInspectorCommand(action);
}

export function gamepadInspectorRequestOwned(doc: Document, request: GamepadInspectorRequest): boolean {
  return doc.visibilityState === "visible" && doc.hasFocus()
    && !doc.body.classList.contains("modal-open") && doc.body.dataset.appShortcutRecording !== "1"
    && doc.querySelector("[data-gamepad-preview]") === null
    && currentAppInputTaskRoot(doc)?.dataset.inputSessionId === request.sessionId;
}

export const GAMEPAD_OWNED_ACTIONS = APP_INPUT_OWNED_COMMANDS;
export type GamepadOwnedAction = AppInputOwnedCommand;
export type GamepadActionHandlers = AppInputCommandHandlers;

export const currentGamepadTaskRoot = currentAppInputTaskRoot;

export function isGamepadOwnedAction(action: GamepadAction): action is GamepadOwnedAction {
  return isAppInputOwnedCommand(action);
}

export function dispatchGamepadOwnedAction(doc: Document, action: GamepadOwnedAction): boolean {
  return dispatchAppInputOwnedCommand(doc, action);
}

export function useGamepadActions(
  root: HTMLElement | undefined | RefObject<HTMLElement | null>,
  scope: unknown,
  kind: AppInputOwnerKind,
  handlers: GamepadActionHandlers
): void {
  useAppInputCommandOwner(root, scope, kind, handlers);
}
