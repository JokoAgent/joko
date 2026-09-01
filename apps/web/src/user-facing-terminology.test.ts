import { describe, expect, it } from "vitest";

import { presentJokoServiceTerminology } from "./user-facing-terminology.js";

describe("presentJokoServiceTerminology", () => {
  it("uses the public node and local-service vocabulary without duplicating service words", () => {
    expect(presentJokoServiceTerminology("Connect to Orchestrator node."))
      .toBe("Connect to Joko node.");
    expect(presentJokoServiceTerminology("The bundled Orchestrator could not stop."))
      .toBe("The local Joko service could not stop.");
    expect(presentJokoServiceTerminology("Run this on the Orchestrator service node."))
      .toBe("Run this on the Joko service node.");
    expect(presentJokoServiceTerminology("请连接 Orchestrator 节点；进程在 Orchestrator 服务节点运行。"))
      .toBe("请连接 Joko 节点；进程在 Joko 服务节点运行。");
    expect(presentJokoServiceTerminology("Orchestrator 是权威来源。"))
      .toBe("Joko 服务是权威来源。");
    expect(presentJokoServiceTerminology("The orchestrator node is unavailable."))
      .toBe("The Joko node is unavailable.");
  });
});
