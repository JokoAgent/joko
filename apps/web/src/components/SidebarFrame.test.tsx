import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { translate } from "../i18n.js";
import { SidebarFrame } from "./SidebarFrame.js";

const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);
const server = { name: "Orchestrator", version: "1.2.3", health: "healthy" as const };
const noop = (): void => undefined;
const probeRuntimeActivity = async (): Promise<boolean> => false;

describe("SidebarFrame", () => {
  it("keeps Joko brand chrome and Orchestrator state around a feature-owned body", () => {
    const markup = renderToStaticMarkup(<SidebarFrame
      server={server}
      open
      mode="expanded"
      width={312}
      probeRuntimeActivity={probeRuntimeActivity}
      t={t}
      expandedBody={<div>Expanded files tree</div>}
      railBody={<div>Files rail</div>}
      onHome={noop}
      onNewTask={noop}
      onSearch={noop}
      onCloseDrawer={noop}
      onHide={noop}
      onCollapse={noop}
      onExpand={noop}
      onResizePointerDown={noop}
      onResizePointerMove={noop}
      onResizePointerUp={noop}
      onResizePointerCancel={noop}
      onResizeKeyDown={noop}
      onResetWidth={noop}
      onDisconnect={noop}
    />);

    expect(markup).toContain("Expanded files tree");
    expect(markup).toContain("Files rail");
    expect(markup).toContain("Orchestrator");
    expect(markup).toContain("v1.2.3");
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-valuenow="312"');
  });

  it("keeps both feature bodies mounted in rail mode so Files tree state survives", () => {
    const markup = renderToStaticMarkup(<SidebarFrame
      server={server}
      open
      mode="rail"
      width={78}
      probeRuntimeActivity={probeRuntimeActivity}
      t={t}
      expandedBody={<div>Preserved expanded state</div>}
      railBody={<div>Visible rail state</div>}
      onHome={noop}
      onNewTask={noop}
      onSearch={noop}
      onCloseDrawer={noop}
      onHide={noop}
      onCollapse={noop}
      onExpand={noop}
      onResizePointerDown={noop}
      onResizePointerMove={noop}
      onResizePointerUp={noop}
      onResizePointerCancel={noop}
      onResizeKeyDown={noop}
      onResetWidth={noop}
      onDisconnect={noop}
    />);

    expect(markup).toContain("Preserved expanded state");
    expect(markup).toContain("Visible rail state");
  });
});
