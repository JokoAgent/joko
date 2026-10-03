import { describe, expect, it } from "vitest";
import {
  extractAliveYieldCellsFromCodexItem,
  extractSettledYieldCellIdsFromCodexItem,
  extractYieldedExecCellIds,
  extractYieldedExecCellsFromCodexItem,
  formatYieldContinuationPrompt
} from "./yielded-exec-cell.js";

describe("extractYieldedExecCellIds", () => {
  it("accepts only executor status headers and deduplicates cells", () => {
    expect(extractYieldedExecCellIds([
      "Script running with cell ID 226\r\nWall time 1.0 seconds",
      "Script running with cell ID 229 Wall time 11.0 seconds Output:",
      "Script running with cell ID 226\nWall time 2.0 seconds"
    ].join("\n"))).toEqual(["226", "229"]);

    expect(extractYieldedExecCellIds([
      "src/x.ts:14: Script running with cell ID 11\nWall time 1 second",
      "  'Script running with cell ID 12\\nWall time 1 second'",
      "Script running with cell ID 13"
    ].join("\n"))).toEqual([]);
  });
});

describe("extractYieldedExecCellsFromCodexItem", () => {
  it.each([0, 1])("prefers numeric exit code %s over quoted marker text", (exitCode) => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: "commandExecution",
      id: "report-read",
      command: "cat REPORT.md",
      status: exitCode === 0 ? "completed" : "failed",
      exitCode,
      aggregatedOutput: "Script running with cell ID 42\nWall time 1 second\n"
    })).toEqual([]);
  });

  it("reads command and proxy function-call output", () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: "commandExecution",
      id: "item-1",
      command: "pnpm check",
      aggregatedOutput: "Script running with cell ID 226 Wall time 11.0 seconds Output:"
    })).toEqual([{ cellId: "226", command: "pnpm check" }]);

    expect(extractYieldedExecCellsFromCodexItem({
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pnpm test" }),
      content: [{ type: "output_text", text: "Script running with cell ID 229\nWall time 10.0 seconds\nOutput:\n" }]
    })).toEqual([{ cellId: "229", command: "pnpm test" }]);
  });

  it("finds a marker at the bounded tail of long output", () => {
    expect(extractYieldedExecCellsFromCodexItem({
      type: "commandExecution",
      command: "pnpm check",
      aggregatedOutput: `${"x".repeat(20_000)}\nScript running with cell ID 226\nWall time 30.0 seconds\nOutput:\n`
    })).toEqual([{ cellId: "226", command: "pnpm check" }]);
  });
});

describe("wait observations", () => {
  it("settles only a completed wait for the requested cell", () => {
    expect(extractSettledYieldCellIdsFromCodexItem({
      type: "function_call",
      name: "wait",
      arguments: JSON.stringify({ cell_id: "11" }),
      content: [{ type: "output_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }]
    })).toEqual(["11"]);
    expect(extractSettledYieldCellIdsFromCodexItem({
      type: "function_call",
      name: "wait",
      arguments: JSON.stringify({ cell_id: "11" }),
      content: [{ type: "output_text", text: "Script running with cell ID 11\nWall time 1.0 seconds\nOutput:\n" }]
    })).toEqual([]);
  });

  it("keeps an explicitly alive wait outstanding", () => {
    expect(extractAliveYieldCellsFromCodexItem({
      type: "function_call",
      name: "wait",
      arguments: JSON.stringify({ cell_id: "226" }),
      content: [{ type: "output_text", text: "Script running with cell ID 226\nWall time 1.0 seconds\nOutput:\n" }]
    })).toEqual([{ cellId: "226" }]);
  });
});

describe("formatYieldContinuationPrompt", () => {
  it("waits the existing cells without permitting command replay", () => {
    const prompt = formatYieldContinuationPrompt([
      { cellId: "226", command: "pnpm check" },
      { cellId: "229" },
      { cellId: "226", command: "pnpm check" }
    ]);
    expect(prompt).toContain("Wait for:");
    expect(prompt).toContain("cell ID 226");
    expect(prompt).toContain("cell ID 229");
    expect(prompt).toContain("Do not start a new task");
    expect(prompt).toContain("Do not rerun the command");
    expect(prompt.match(/cell ID 226/g)).toHaveLength(1);
  });
});
