// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import { ProviderFlowBackButton, ProviderFlowFooter, ProviderWizardProgress } from "./ProviderFlow.js";
import { Modal } from "./ui.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("provider flow chrome", () => {
  it("uses compact numbered progress with Back in the title bar and actions only in the footer", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<Modal
      open
      title="Add Ollama"
      onClose={() => undefined}
      className="provider-flow-modal"
      headerLeading={<ProviderFlowBackButton onBack={() => undefined} t={(key, values) => translate("en", key, values)} />}
      headerTrailing={<ProviderWizardProgress activeStep={2} t={(key, values) => translate("en", key, values)} />}
    ><ProviderFlowFooter><button type="button">Continue</button></ProviderFlowFooter></Modal>));

    expect(document.querySelectorAll(".provider-wizard-progress li")).toHaveLength(3);
    const back = document.querySelector<HTMLButtonElement>(".modal__header .provider-flow-header-back");
    expect(back?.getAttribute("aria-label")).toBe("Back");
    expect(document.querySelector(".provider-flow-footer .provider-flow-header-back")).toBeNull();
    expect(document.querySelector(".provider-flow-footer")?.textContent).toBe("Continue");

    await act(async () => root.unmount());
  });
});
