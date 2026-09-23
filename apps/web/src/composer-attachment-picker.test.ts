// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerAttachmentPicker, type ComposerAttachmentPickerAdmission } from "./composer-attachment-picker.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function admission(overrides: Partial<ComposerAttachmentPickerAdmission> = {}): ComposerAttachmentPickerAdmission {
  return {
    owner: overrides.owner ?? {},
    epoch: overrides.epoch ?? {},
    connected: overrides.connected ?? true,
    locked: overrides.locked ?? false,
    images: overrides.images ?? true,
    files: overrides.files ?? true
  };
}

function input(): HTMLInputElement {
  const element = document.createElement("input");
  element.type = "file";
  document.body.append(element);
  return element;
}

describe("ComposerAttachmentPicker", () => {
  it("admits each action only for its exact live capability and connection requirement", () => {
    const picker = new ComposerAttachmentPicker();
    const element = input();
    const click = vi.spyOn(element, "click").mockImplementation(() => undefined);
    const owner = {};
    const epoch = {};

    expect(picker.open(element, admission({ owner, epoch, images: false }), "images", true)).toBe(false);
    expect(picker.open(element, admission({ owner, epoch, files: false }), "files", true)).toBe(false);
    expect(picker.open(element, admission({ owner, epoch, connected: false }), "files", true)).toBe(false);
    expect(picker.open(element, admission({ owner, epoch, locked: true }), "files", true)).toBe(false);
    expect(click).not.toHaveBeenCalled();

    expect(picker.open(element, admission({ owner, epoch, images: false }), "files", true)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(picker.consume(element, [new File(["notes"], "notes.txt", { type: "text/plain" })], admission({ owner, epoch, images: false })))
      .toHaveLength(1);
  });

  it("discards cancellation and any late result after owner, epoch, input, lifecycle, or admission drift", () => {
    const picker = new ComposerAttachmentPicker();
    const element = input();
    vi.spyOn(element, "click").mockImplementation(() => undefined);
    const owner = {};
    const epoch = {};
    const state = admission({ owner, epoch });
    const file = new File(["late"], "late.txt", { type: "text/plain" });

    expect(picker.open(element, state, "files", true)).toBe(true);
    expect(picker.consume(element, [], state)).toEqual([]);
    expect(picker.consume(element, [file], state)).toEqual([]);

    for (const changed of [
      admission({ owner: {}, epoch }),
      admission({ owner, epoch: {} }),
      admission({ owner, epoch, connected: false }),
      admission({ owner, epoch, locked: true }),
      admission({ owner, epoch, files: false })
    ]) {
      expect(picker.open(element, state, "files", true)).toBe(true);
      expect(picker.consume(element, [file], changed)).toEqual([]);
    }

    const replacement = input();
    expect(picker.open(element, state, "files", true)).toBe(true);
    expect(picker.consume(replacement, [file], state)).toEqual([]);
    expect(picker.open(element, state, "files", true)).toBe(true);
    element.remove();
    expect(picker.consume(element, [file], state)).toEqual([]);

    document.body.append(element);
    expect(picker.open(element, state, "files", true)).toBe(true);
    picker.retire();
    expect(picker.consume(element, [file], state)).toEqual([]);
  });
});
