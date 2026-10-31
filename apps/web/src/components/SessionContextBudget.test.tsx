// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { SessionContextBudgetViewSchema, type SessionContextBudgetView } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { SessionView } from "../model.js";
import { translate } from "../i18n.js";
import { SessionContextBudget } from "./SessionContextBudget.js";
const roots: Root[] = [];
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function fixture() {
  let view = create(SessionContextBudgetViewSchema, { sessionId: "one", generation: 1n, target: { backendId: "pi", providerId: "provider", modelId: "model" }, canConfigure: true,
    defaultWindowTokens: 1_000_000n, maximumWindowTokens: 1_000_000n, effectiveWindowTokens: 1_000_000n, sourceRevision: "catalog-one", revision: { value: 1n } });
  const read = vi.fn(async (_sessionId: string, _generation: bigint, _signal?: AbortSignal): Promise<SessionContextBudgetView> => view);
  const save = vi.fn(async (_original: SessionContextBudgetView, tokens: number | undefined) => { view = create(SessionContextBudgetViewSchema, { ...view, budgetTokens: tokens === undefined ? undefined : BigInt(tokens),
    effectiveWindowTokens: BigInt(tokens ?? 1_000_000), revision: { value: (view.revision?.value ?? 0n) + 1n } }); });
  const controller = { getSessionContextBudget: read, setSessionContextBudget: save } as unknown as AppController;
  const session = { id: "one", generation: 1n, backendId: "pi", model: { providerId: "provider", modelId: "model" }, context: { usedTokens: 600_000, contextWindow: 1_000_000 } } as SessionView;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  const render = async (target = session) => { await act(async () => root.render(<SessionContextBudget controller={controller} session={target} supported t={t} />)); };
  const open = async () => { await act(async () => host.querySelector("button")!.click()); };
  return { controller, read, save, host, root, render, open, session, view: () => view };
}
it("saves an exact percentage for this task and clears the override when choosing model default", async () => {
  const f = fixture(); await f.render(); expect(f.read).not.toHaveBeenCalled(); await f.open();
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Task context budget"]')!;
  expect([...select.options].map(option => option.value)).toEqual(["default", "250000", "500000"]);
  const original = f.view(); await act(async () => { select.value = "500000"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(f.save).toHaveBeenCalledWith(original, 500_000, expect.any(AbortSignal)); expect(select.value).toBe("500000");
  expect(document.body.textContent).toContain(t("contextBudget.compactSoon"));
  expect(f.session.context?.contextWindow).toBe(1_000_000);
  await act(async () => { select.value = "default"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ budgetTokens: 500_000n }), undefined, expect.any(AbortSignal));
});
it("cancels an old task read and ignores its late result after switching tasks", async () => {
  const f = fixture(); let finish!: (view: SessionContextBudgetView) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await f.render(); await f.open();
  const signal = f.read.mock.calls[0]![2]!;
  await f.render({ ...f.session, id: "two" }); expect(signal.aborted).toBe(true);
  await act(async () => finish(create(SessionContextBudgetViewSchema, { ...f.view(), budgetTokens: 333_333n })));
  expect(document.body.textContent).not.toContain("333.3"); expect(f.save).not.toHaveBeenCalled();
});
it("preserves the selection after a rejected save and requires reading the current setting before another edit", async () => {
  const f = fixture(); f.save.mockRejectedValueOnce(new Error("conflict")); await f.render(); await f.open();
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Task context budget"]')!;
  await act(async () => { select.value = "250000"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(select.disabled).toBe(true); expect(select.value).toBe("default"); expect(document.querySelector('[role="alert"]')?.textContent).toBe(t("contextBudget.failed"));
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("common.retry"))!;
  await act(async () => retry.click()); expect(document.querySelector<HTMLSelectElement>('select[aria-label="Task context budget"]')?.disabled).toBe(false); expect(f.save).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledTimes(2);
});
