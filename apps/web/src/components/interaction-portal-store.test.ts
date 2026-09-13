import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getInteractionPromptSlot,
  registerInteractionPromptSlot,
  subscribeInteractionPromptSlot
} from "./interaction-portal-store.js";

const slots: (() => void)[] = [];

afterEach(() => {
  while (slots.length > 0) slots.pop()?.();
});

describe("interaction prompt slot", () => {
  it("publishes one active target and cleans it up on route unmount", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInteractionPromptSlot(listener);
    const element = {} as HTMLElement;
    const cleanup = registerInteractionPromptSlot(element);
    slots.push(cleanup);

    expect(getInteractionPromptSlot()).toBe(element);
    expect(listener).toHaveBeenCalledTimes(1);

    cleanup();
    slots.pop();
    expect(getInteractionPromptSlot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not let an older route cleanup clear the current slot", () => {
    const first = {} as HTMLElement;
    const second = {} as HTMLElement;
    const cleanupFirst = registerInteractionPromptSlot(first);
    const cleanupSecond = registerInteractionPromptSlot(second);
    slots.push(cleanupSecond, cleanupFirst);

    cleanupFirst();
    slots.pop();
    expect(getInteractionPromptSlot()).toBe(second);

    cleanupSecond();
    slots.pop();
    expect(getInteractionPromptSlot()).toBeNull();
  });
});
