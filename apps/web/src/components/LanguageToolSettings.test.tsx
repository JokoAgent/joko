// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { LanguageToolSettings } from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("LanguageToolSettings", () => {
  it("renders the default-off Beta gate and persists an optimistic new-task toggle", async () => {
    const update = vi.fn(async () => undefined);
    const success = vi.fn();
    const work: Promise<void>[] = [];
    const container = await render({ updateLanguageToolSettings: update } as unknown as AppController, (action) => {
      work.push(action());
    }, success);

    expect(container.textContent).toContain("Language intelligence (Beta)");
    expect(container.textContent).toContain("Existing tasks are unchanged");
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle language intelligence"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    await act(async () => Promise.all(work));

    expect(update).toHaveBeenCalledWith(true);
    expect(success).toHaveBeenCalledWith("Language intelligence enabled for new tasks");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("rolls back the optimistic state when persistence fails", async () => {
    const update = vi.fn(async () => { throw new Error("offline"); });
    const errors: unknown[] = [];
    const container = await render({ updateLanguageToolSettings: update } as unknown as AppController, (action) => {
      void action().catch((error) => errors.push(error));
    });
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle language intelligence"]')!;

    await act(async () => toggle.click());
    await act(async () => Promise.resolve());

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(errors).toHaveLength(1);
  });
});

async function render(
  controller: AppController,
  runAction: (_action: () => Promise<void>) => void,
  onSuccess: (message: string) => void = () => undefined
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<LanguageToolSettings
    controller={controller}
    snapshot={emptySnapshot()}
    runAction={(_key, action) => runAction(action)}
    onSuccess={onSuccess}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}
