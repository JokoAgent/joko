import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativeFileActionRequestId, nativeFileActionSequence } from "@joko/contracts";
import { NativeFileActionRequests } from "../src/native-file-action-requests.js";

const scope = () => ({ id: randomUUID(), isCurrent: () => true });
const id = (sequence: number) => nativeFileActionRequestId(sequence, randomUUID());

describe("Document native file action receipts", () => {
  it("keeps exact out-of-order receipts and rejects an ordinal reused with another identity or content", async () => {
    const requests = new NativeFileActionRequests<string>();
    const caller = scope(), first = id(1), second = id(2);
    const a = Promise.resolve("opened"), b = Promise.resolve("unknown");
    requests.add(caller, second, "b", new AbortController(), b);
    expect(requests.replay(caller, first, "a")).toBeUndefined();
    requests.add(caller, first, "a", new AbortController(), a);
    expect(requests.replay(caller, first, "a")).toBe(a);
    expect(requests.replay(caller, second, "b")).toBe(b);
    expect(() => requests.replay(caller, first, "changed")).toThrow("different content");
    expect(() => requests.replay(caller, id(1), "a")).toThrow("different content");
    expect(requests.replay(scope(), first, "a")).toBeUndefined();
    await Promise.all([a, b]);
    expect(requests.pendingCount).toBe(0);
  });

  it("retains old pending and unknown receipts until settlement and rejects retired IDs even with new entropy", async () => {
    const requests = new NativeFileActionRequests<string>();
    const caller = scope(), first = id(1), next = id(1_025), abort = new AbortController();
    let finish!: (value: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    requests.add(caller, first, "a", abort, pending);
    requests.add(caller, next, "b", new AbortController(), Promise.resolve("opened"));
    expect(requests.replay(caller, first, "a")).toBe(pending);
    requests.cancel(caller.id, id(1));
    expect(abort.signal.aborted).toBe(false);
    requests.cancel(caller.id, first);
    expect(abort.signal.aborted).toBe(true);
    finish("unknown");
    await expect(pending).resolves.toBe("unknown");
    expect(requests.replay(caller, first, "a")).toBe(false);
    expect(requests.replay(caller, id(1), "different")).toBe(false);
    expect(requests.replay(caller, id(2), "new")).toBeUndefined();
    const active = new AbortController();
    requests.add(caller, id(1_026), "c", active, new Promise(() => undefined));
    requests.retireScope(caller.id);
    expect(active.signal.aborted).toBe(true);
    expect(requests.replay(caller, next, "b")).toBe(false);
    expect(requests.replay(caller, id(1_027), "new")).toBe(false);
    requests.cancelPending();
  });

  it("encodes a bounded positive ordinal without timestamps and rejects unordered or exhausted identities", () => {
    for (const sequence of [1, 1_024, 0xffff_ffff_ffff]) expect(nativeFileActionSequence(id(sequence))).toBe(sequence);
    for (const sequence of [0, -1, 0.5, 0x1_0000_0000_0000, Number.NaN]) {
      expect(() => id(sequence)).toThrow("Invalid");
    }
    expect(nativeFileActionSequence(randomUUID())).toBeUndefined();
    expect(nativeFileActionSequence("00000000-0000-8000-8000-000000000001")).toBeUndefined();
    expect(() => nativeFileActionRequestId(1, "not-a-uuid")).toThrow("Invalid");
  });
});
