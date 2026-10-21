import { describe, expect, it, vi } from "vitest";
import { ExtensionCardService, withExtensionCardToken, type ExtensionCardRow, type ExtensionCardScope } from "./service.js";
const scope: ExtensionCardScope = { extensionId: "plugin-one", authorityKey: "installed-generation", sessionId: "task", sessionCreatedAt: 1, targetId: "target", toolUseId: "tool-one" };
function fixture() {
  let now = 1000, available = true;
  const rows: ExtensionCardRow[] = [], broadcast = vi.fn();
  const persist = vi.fn(async (row: ExtensionCardRow) => { rows.push(row); });
  const service = new ExtensionCardService({ now: () => now, available: () => available, persist, broadcast });
  service.registerCall("call-one", scope);
  const publish = (overrides: Record<string, unknown> = {}) => service.handleCardUpdate(scope.extensionId, scope.authorityKey,
    { type: "card-update", version: 1, callId: "call-one", html: "<p>Hello</p>", ...overrides }, () => {});
  return { service, rows, broadcast, persist, publish, tick: (delta: number) => { now += delta; }, revoke: () => { available = false; service.revoke(scope.extensionId); } };
}
describe("extension card publication", () => {
  it("commits before publication and refuses a card token after a failed write", async () => {
    const f = fixture(); let release!: () => void;
    f.persist.mockImplementationOnce(async row => { await new Promise<void>(resolve => { release = resolve; }); f.rows.push(row); });
    const pending = f.publish(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(f.broadcast).not.toHaveBeenCalled(); release(); expect(await pending).toEqual({ accepted: true });
    expect(f.rows).toHaveLength(1); expect(f.broadcast).toHaveBeenCalledOnce();
    const failed = fixture(); failed.persist.mockRejectedValueOnce(new Error("Disk unavailable"));
    expect(await failed.publish()).toEqual({ accepted: false, reason: "commit-failed" });
    expect(await failed.service.finalizeCall("call-one")).toBe(false); expect(failed.broadcast).not.toHaveBeenCalled();
    expect(await failed.publish()).toEqual({ accepted: true });
  });
  it("binds both installed source and task ownership and strips executable content", async () => {
    const f = fixture();
    expect(await f.service.handleCardUpdate("other", scope.authorityKey, { type: "card-update", version: 1, callId: "call-one", html: "<p>Forged</p>" }, () => {})).toMatchObject({ accepted: false });
    expect(await f.service.handleCardUpdate(scope.extensionId, "new-generation", { type: "card-update", version: 1, callId: "call-one", html: "<p>Forged</p>" }, () => {})).toMatchObject({ accepted: false });
    expect(await f.publish({ html: '<p onclick="alert(1)">Hello</p><script>bad()</script><div data-joko-mail="fake"></div>' })).toEqual({ accepted: true });
    expect(f.rows[0]?.html).toBe("<p>Hello</p><div></div>");
    expect(f.service.reopenForAction("call-one", { ...scope, sessionId: "other-task" })).toBe(false);
  });
  it("keeps the original working deadline bounded and rejects expired late updates", async () => {
    const f = fixture(); expect(await f.publish({ state: "working" })).toEqual({ accepted: true });
    await f.service.finalizeCall("call-one"); f.tick(29 * 60_000);
    expect(await f.publish({ state: "working" })).toEqual({ accepted: true }); f.tick(2 * 60_000);
    expect(await f.publish()).toMatchObject({ accepted: false });
    expect(f.service.reopenForAction("call-one", scope)).toBe(true);
    expect(await f.publish()).toEqual({ accepted: true }); f.tick(11 * 60_000);
    expect(await f.publish()).toMatchObject({ accepted: false });
  });
  it("rate-limits updates without consuming the first accepted version", async () => {
    const f = fixture(); expect(await f.publish({ version: 2 })).toMatchObject({ accepted: false });
    expect(await f.publish()).toEqual({ accepted: true });
    expect(await f.publish({ html: "<p>Too soon</p>" })).toEqual({ accepted: false, reason: "rate-limited" });
    f.tick(1000); expect(await f.publish({ html: "<p>Next</p>" })).toEqual({ accepted: true });
    expect(f.rows.map(row => row.html)).toEqual(["<p>Hello</p>", "<p>Next</p>"]);
  });
  it("does not publish a write which outlived explicit source revocation", async () => {
    const f = fixture(); let release!: () => void;
    f.persist.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const pending = f.publish(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.revoke(); release(); expect(await pending).toEqual({ accepted: false, reason: "source-changed" });
    expect(f.broadcast).not.toHaveBeenCalled(); expect(f.service.callInfoOf("call-one")).toBeNull();
  });
  it("bounds intake while a commit is pending", async () => {
    const f = fixture(); let release!: () => void;
    f.persist.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    const pending = Array.from({ length: 8 }, () => f.publish());
    expect(await f.publish()).toEqual({ accepted: false, reason: "busy" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); release(); await Promise.all(pending);
  });
  it("only an active same-source tool can reopen an older card", async () => {
    const f = fixture(); await f.publish(); await f.service.finalizeCall("call-one"); f.tick(20_000);
    f.service.registerCall("new-tool", { ...scope, toolUseId: "two" });
    expect(f.service.reopenForTool(scope.extensionId, scope.authorityKey, "call-one", "new-tool", { ...scope, sessionId: "foreign" })).toBe(false);
    expect(f.service.reopenForTool(scope.extensionId, scope.authorityKey, "call-one", "new-tool", scope)).toBe(true);
    await f.service.finalizeCall("new-tool");
    expect(f.service.reopenForTool(scope.extensionId, scope.authorityKey, "call-one", "new-tool", scope)).toBe(false);
  });
  it("adds an anchor only to successful object results that actually published", () => {
    expect(withExtensionCardToken({ ok: false, result: {} }, true, "one")).toEqual({ ok: false, result: {} });
    expect(withExtensionCardToken({ ok: true, result: [] }, true, "one")).toEqual({ ok: true, result: [] });
    expect(withExtensionCardToken({ ok: true, result: {} }, false, "one")).toEqual({ ok: true, result: {} });
    expect(withExtensionCardToken({ ok: true, result: { text: "done" } }, true, "one")).toEqual({ ok: true, result: { text: "done", joko_card_id: "one" } });
  });
});
