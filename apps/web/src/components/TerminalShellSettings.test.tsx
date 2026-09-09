// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { readTerminalShellPreference } from "../terminal-preferences.js";
import { TerminalShellSettings } from "./TerminalShellSettings.js";

it("uses the service shell catalog, retains a client preference and handles missing shells or a changed server without stale results", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);
  const catalog = { support: "supported", shells: [{ id: "one", label: "First shell" }, { id: "two", label: "Second shell" }], defaultShellId: "one" };
  let finishOld!: (value: unknown) => void;
  const getTerminalCapabilities = vi.fn().mockResolvedValueOnce(catalog).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce({ ...catalog, shells: [{ id: "one", label: "Current shell" }] });
  const render = async (id = "server-one") => act(async () => root.render(<TerminalShellSettings controller={{ state: { connectionState: "connected", activeProfile: { id, serverId: id } }, getTerminalCapabilities } as unknown as AppController} t={t} />));
  try {
    await render();
    const select = () => host.querySelector("select")!;
    expect(select().disabled).toBe(false);
    expect(host.textContent).toContain("First shell");
    await act(async () => { select().value = "two"; select().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(readTerminalShellPreference()).toBe("two");
    await render();
    expect(getTerminalCapabilities).toHaveBeenCalledTimes(1);
    await render("server-old");
    await render("server-current");
    expect(select().value).toBe("two");
    expect(select().selectedOptions[0]?.disabled).toBe(true);
    await act(async () => finishOld(catalog));
    expect(host.textContent).toContain("Current shell");
    expect(host.textContent).not.toContain("Second shell");
    await act(async () => host.querySelector("button")!.click());
    expect(readTerminalShellPreference()).toBe("auto");
    expect(select().value).toBe("auto");
    expect(getTerminalCapabilities.mock.calls[0]?.[0]).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.localStorage.clear();
  }
});
