// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type ScheduleDraft, type ScheduleHookPreparationView, type SchedulePreRunResultView } from "../model.js";
import { translate } from "../i18n.js";
import { scheduleDraft } from "./SchedulesPage.js";
import { ScheduleHookEditor } from "./ScheduleHookEditor.js";

let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); window.localStorage.clear(); document.body.innerHTML = '<div id="root"></div>'; root = createRoot(document.getElementById("root")!); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const passed: SchedulePreRunResultView = { status: "passed", decision: "run", exitCode: 0, durationMs: 4, stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false };
describe("mounted Schedule pre-run editor", () => {
  it("preserves the draft after a lost test receipt and queries the original operation before explicit retry", async () => {
    const test = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(passed);
    const lookup = vi.fn().mockResolvedValueOnce({ state: "running" }).mockResolvedValue({ state: "failed", error: "Interrupted" });
    const controller = fixture({ testScheduleHook: test, getScheduleHookOperation: lookup });
    await render(controller);
    await click("Test check");
    expect(input("Check command").value).toBe("node check.mjs"); expect(test).toHaveBeenCalledOnce();
    const id = test.mock.calls[0]![3]; expect(typeof id).toBe("string");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(test).toHaveBeenCalledOnce(); expect(button("Test check").disabled).toBe(true);
    await click("Check previous operation"); expect(lookup).toHaveBeenCalledWith(id, expect.any(AbortSignal)); expect(button("Test check").disabled).toBe(true);
    await click("Check previous operation"); expect(button("Test check").disabled).toBe(false);
    await click("Test check"); expect(test).toHaveBeenCalledTimes(2); expect(test.mock.calls[1]![3]).not.toBe(id);
    expect(document.body.textContent).toContain("Check passed");
  });
  it("keeps edited script and generation description on failure and adopts a recovered preparation", async () => {
    const prepared: ScheduleHookPreparationView = { hook: { command: "joko-node 'gate.mjs'", filePath: "gate.mjs" }, content: "process.exit(2)", test: { ...passed, status: "skipped", decision: "skip", exitCode: 2 } };
    const prepare = vi.fn().mockRejectedValue(new Error("Generation result lost"));
    const controller = fixture({ prepareScheduleHook: prepare, getScheduleHookOperation: vi.fn().mockResolvedValue({ state: "completed", preparation: prepared }) });
    await render(controller); await changeTextarea("Describe the check to generate or change", "Skip when idle"); await click("Generate with AI");
    expect(textarea("Describe the check to generate or change").value).toBe("Skip when idle"); expect(prepare).toHaveBeenCalledOnce();
    await click("Check previous operation"); expect(input("Check command").value).toBe(prepared.hook.command);
    expect(textarea("JavaScript check content").value).toBe(prepared.content); expect(document.body.textContent).toContain("Check skipped");
    await changeTextarea("JavaScript check content", "process.exit(0)");
    expect(button("Modify with AI").disabled).toBe(true);
    await click("Use script and test"); expect(textarea("JavaScript check content").value).toBe("process.exit(0)");
  });
  it("removes a hook explicitly and ignores old owner results", async () => {
    let finish!: (value: SchedulePreRunResultView) => void;
    const test = vi.fn(() => new Promise<SchedulePreRunResultView>(resolve => { finish = resolve; }));
    const controller = fixture({ testScheduleHook: test }); await render(controller);
    await click("Test check");
    const changed = fixture({ testScheduleHook: vi.fn().mockResolvedValue(passed) }, "other-node");
    await render(changed); await act(async () => { finish(passed); });
    expect(document.body.textContent).not.toContain("Check passed");
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => checkbox.click()); expect(document.querySelector('input[maxlength="32768"]')).toBeNull();
  });
});
function fixture(methods: Record<string, unknown>, serverId = "node"): AppController {
  return { state: { activeProfile: { id: "profile", serverId }, connectionGeneration: 1, connectionState: "connected", snapshot: emptySnapshot() }, ...methods } as unknown as AppController;
}
async function render(controller: AppController): Promise<void> {
  function Harness() { const [draft, update] = useState<ScheduleDraft>(() => ({ ...scheduleDraft(undefined, [], [], []), targetId: "target", backendId: "backend", preRunHook: { command: "node check.mjs", filePath: "" } }));
    return <ScheduleHookEditor controller={controller} draft={draft} open saving={false} t={(key, args) => translate("en", key, args)} onChange={hook => update(current => ({ ...current, preRunHook: hook }))} onBusyChange={() => undefined} onValidityChange={() => undefined} />; }
  await act(async () => root.render(<Harness />));
}
function button(label: string): HTMLButtonElement { const element = [...document.querySelectorAll("button")].find(item => item.textContent === label); if (!element) throw new Error(`Button missing: ${label}`); return element; }
async function click(label: string): Promise<void> { await act(async () => { button(label).click(); }); }
function input(label: string): HTMLInputElement { return [...document.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.querySelector("input")!; }
function textarea(label: string): HTMLTextAreaElement { return [...document.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))!.querySelector("textarea")!; }
async function changeTextarea(label: string, value: string): Promise<void> { await act(async () => { const element = textarea(label); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
