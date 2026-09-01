// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  isComposerBlankPointerTarget,
  resolveComposerBlankFocusIntent
} from "./composer-blank-focus.js";

describe("composer blank-surface focus", () => {
  it("accepts only unclaimed points inside the visible card", () => {
    const container = document.createElement("div");
    const blank = document.createElement("span");
    const editor = document.createElement("div");
    const editorText = document.createElement("p");
    const button = document.createElement("button");
    const buttonIcon = document.createElement("span");
    const draggable = document.createElement("div");
    draggable.draggable = true;
    const dragChild = document.createElement("span");
    editor.append(editorText);
    button.append(buttonIcon);
    draggable.append(dragChild);
    container.append(blank, editor, button, draggable);
    document.body.append(container);
    container.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 210,
      bottom: 120,
      width: 200,
      height: 100,
      toJSON: () => ({})
    });

    expect(isComposerBlankPointerTarget(blank, container, editor, { clientX: 20, clientY: 30 })).toBe(true);
    expect(isComposerBlankPointerTarget(editorText, container, editor, { clientX: 20, clientY: 30 })).toBe(false);
    expect(isComposerBlankPointerTarget(buttonIcon, container, editor, { clientX: 20, clientY: 30 })).toBe(false);
    expect(isComposerBlankPointerTarget(dragChild, container, editor, { clientX: 20, clientY: 30 })).toBe(false);
    expect(isComposerBlankPointerTarget(blank, container, editor, { clientX: 9, clientY: 30 })).toBe(false);
    expect(isComposerBlankPointerTarget(null, container, editor, { clientX: 20, clientY: 30 })).toBe(false);
    container.remove();
  });

  it("preserves an established caret and sends an untouched caret to the document end", () => {
    expect(resolveComposerBlankFocusIntent(null)).toBe("none");
    expect(resolveComposerBlankFocusIntent({ isDestroyed: true, isEditable: true, isFocused: false, caretAtDocStart: true })).toBe("none");
    expect(resolveComposerBlankFocusIntent({ isDestroyed: false, isEditable: false, isFocused: false, caretAtDocStart: true })).toBe("none");
    expect(resolveComposerBlankFocusIntent({ isDestroyed: false, isEditable: true, isFocused: true, caretAtDocStart: true })).toBe("none");
    expect(resolveComposerBlankFocusIntent({ isDestroyed: false, isEditable: true, isFocused: false, caretAtDocStart: false })).toBe("keep-caret");
    expect(resolveComposerBlankFocusIntent({ isDestroyed: false, isEditable: true, isFocused: false, caretAtDocStart: true })).toBe("doc-end");
  });
});
