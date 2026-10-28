import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { EXTENSION_VIEW_LIFECYCLE_SCRIPT } from "./extension-view-lifecycle.js";

describe("actual Extension page close bootstrap", () => {
  it("joins registered vetoes, bounds registration, and ignores forged parent requests", async () => {
    const replies: unknown[] = []; let receive!: (event: { source: object; data: unknown }) => void;
    const parent = { postMessage: (value: unknown) => { replies.push(value); } };
    const page = { parent, addEventListener: (_event: string, callback: typeof receive) => { receive = callback; } } as unknown as { parent: typeof parent; addEventListener: unknown; jokoView: { onBeforeClose(callback: () => unknown): () => void } };
    runInNewContext(EXTENSION_VIEW_LIFECYCLE_SCRIPT.toString(), { window: page });
    expect(replies).toEqual([{ type: "joko:extension-close-ready", version: 1 }]);
    const remove = page.jokoView.onBeforeClose(() => false), id = `close_${"a".repeat(32)}`;
    receive({ source: {}, data: { type: "joko:extension-close", version: 1, id } }); expect(replies).toHaveLength(1);
    receive({ source: parent, data: { type: "joko:extension-close", version: 1, id } });
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ type: "joko:extension-close-result", version: 1, id, allowed: false }));
    remove(); receive({ source: parent, data: { type: "joko:extension-close", version: 1, id } });
    await vi.waitFor(() => expect(replies.at(-1)).toEqual({ type: "joko:extension-close-result", version: 1, id, allowed: true }));
    for (let index = 0; index < 16; index++) page.jokoView.onBeforeClose(() => true);
    expect(() => page.jokoView.onBeforeClose(() => true)).toThrow();
  });
});
