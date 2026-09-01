import { describe, expect, it } from "vitest";

import {
  enqueueSettingsSuccessNotice,
  finishSettingsSuccessNotice,
  type SettingsSuccessNotice,
  type SettingsSuccessQueue
} from "./components/SettingsPage.js";

describe("Settings success notification queue", () => {
  it("keeps a three-active stack and FIFO waiting queue", () => {
    let queue: SettingsSuccessQueue = { active: [], waiting: [] };
    const notice = (id: number): SettingsSuccessNotice => ({ id, text: `notice-${id}` });

    for (let id = 1; id <= 5; id += 1) queue = enqueueSettingsSuccessNotice(queue, notice(id));
    expect(queue.active.map((item) => item.id)).toEqual([3, 2, 1]);
    expect(queue.waiting.map((item) => item.id)).toEqual([4, 5]);

    queue = finishSettingsSuccessNotice(queue, 2);
    expect(queue.active.map((item) => item.id)).toEqual([4, 3, 1]);
    expect(queue.waiting.map((item) => item.id)).toEqual([5]);

    queue = finishSettingsSuccessNotice(queue, 3);
    expect(queue.active.map((item) => item.id)).toEqual([5, 4, 1]);
    expect(queue.waiting).toEqual([]);
  });
});
