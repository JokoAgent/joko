// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { RuntimeProcessMonitorWindow } from "./RuntimeProcessMonitorWindow.js";

describe("RuntimeProcessMonitorWindow", () => {
  it("renders a bounded reconnect state without issuing runtime calls", async () => {
    const controller = {
      state: {
        ready: true,
        connectionState: "disconnected",
        activeProfile: undefined,
        snapshot: emptySnapshot(),
        preferences: { locale: "en" }
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RuntimeProcessMonitorWindow
      controller={controller}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.querySelector("h1")?.textContent).toBe("Runtime resource usage");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connect a Joko node in the main window");

    await act(async () => root.unmount());
    container.remove();
  });
});
