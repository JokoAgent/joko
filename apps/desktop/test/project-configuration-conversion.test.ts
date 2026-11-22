import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { planProjectConfigurationConversion } from "../src/project-configuration-conversion.js";

function inputs(files: Record<string, string | null>) {
  return Object.entries(files).map(([path, text]) => ({ path, text }));
}

describe("local project configuration preview", () => {
  it("plans each Claude-to-Codex group and keeps existing events, settings and server entries", () => {
    const config = "# existing settings\nmodel = \"existing\"\n\n[mcp_servers.existing]\ncommand = \"keep\"\n\n[hooks]\nPreToolUse = []\n";
    const source = inputs({
      "CLAUDE.md": "# Build instructions\n",
      "AGENTS.md": null,
      ".claude/agents/reviewer.md": "---\nname: reviewer\ndescription: Inspect changes\n---\nCheck workspace changes.\n",
      ".codex/agents/reviewer.toml": null,
      ".claude/agents/limited.md": "---\nname: limited\ndescription: Inspect\ntools: Read\n---\nRead only.\n",
      ".codex/agents/limited.toml": null,
      ".claude/settings.json": JSON.stringify({ hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "unchanged" }] }],
        Stop: [{ hooks: [{ type: "command", command: "\"$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh\"" }] }]
      } }),
      ".codex/hooks.json": null,
      ".codex/config.toml": config,
      ".mcp.json": JSON.stringify({ mcpServers: {
        existing: { command: "replace" }, local: { command: "example", args: ["--stdio"] },
        private: { command: "example", env: { API_KEY: "secret" } }
      } })
    });
    const script = { source: ".claude/hooks/check.sh", path: ".codex/hooks/check.sh" };
    const [instructions, agents, hooks, mcp] = planProjectConfigurationConversion("codex", source, [script]);
    expect(instructions).toEqual({ category: "instructions", writes: [{ path: "AGENTS.md", text: "# Build instructions\n" }] });
    expect(parseToml(agents!.writes[0]!.text)).toEqual({ name: "reviewer", description: "Inspect changes", developer_instructions: "Check workspace changes." });
    expect(agents?.writes).toHaveLength(1);
    expect(hooks?.copies).toEqual([script]);
    expect(JSON.parse(hooks!.writes[0]!.text)).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "\"./.codex/hooks/check.sh\"" }] }] } });
    const updatedToml = mcp!.writes[0]!.text;
    expect(updatedToml).toContain("# existing settings");
    expect(parseToml(updatedToml)).toMatchObject({ model: "existing", mcp_servers: {
      existing: { command: "keep" }, local: { enabled: false, command: "example", args: ["--stdio"] }
    } });
    expect(updatedToml).not.toContain("secret");
  });

  it("accepts Codex agents and portable declarations for Claude while leaving inaccessible or existing files alone", () => {
    const source = inputs({
      "CLAUDE.md": "# Existing source",
      "AGENTS.md": "# Keep this file",
      ".claude/agents/reviewer.md": null,
      ".codex/agents/reviewer.toml": "name = \"reviewer\"\ndescription = \"Inspect\"\ndeveloper_instructions = \"Review changes\"",
      ".claude/settings.json": "{\"disableAllHooks\":true,\"hooks\":{}}",
      ".codex/hooks.json": "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"check\"}]}]}}",
      ".codex/config.toml": "[mcp_servers.documented]\nurl=\"https://example.test/mcp\"\n\n[mcp_servers.disabled]\ncommand=\"never\"\nenabled=false\n",
      ".mcp.json": null
    });
    const plan = planProjectConfigurationConversion("claude-code", source, []);
    expect(plan.map(candidate => candidate.category)).toEqual(["agents", "hooks", "mcp"]);
    expect(plan[0]?.writes[0]?.text).toContain("Review changes");
    expect(JSON.parse(plan[1]!.writes[0]!.text)).toMatchObject({ disableAllHooks: true, hooks: { Stop: expect.any(Array) } });
    expect(JSON.parse(plan[2]!.writes[0]!.text)).toEqual({ mcpServers: { documented: { type: "http", url: "https://example.test/mcp" } } });
    expect(planProjectConfigurationConversion("codex", source, []).some(candidate => candidate.category === "instructions")).toBe(false);
    expect(planProjectConfigurationConversion("codex", inputs({ "CLAUDE.md": "Readable", ".claude/settings.json": "{}" }), [])).toEqual([]);
    expect(planProjectConfigurationConversion("codex", inputs({ "CLAUDE.md": "Readable", "AGENTS.md": " \n " }), [])[0]?.category).toBe("instructions");
  });

  it("keeps unreadable hook configuration intact and can retry an empty agent output", () => {
    const files = inputs({ ".claude/settings.json": "{", ".codex/config.toml": null, ".codex/hooks.json": null,
      ".claude/agents/reviewer.md": "---\nname: reviewer\ndescription: Review the changes\n---\nRead the diff.\n",
      ".codex/agents/reviewer.toml": "" });
    const result = planProjectConfigurationConversion("codex", files, [{ source: ".claude/hooks/check.sh", path: ".codex/hooks/check.sh" }]);
    expect(result.map(candidate => candidate.category)).toEqual(["agents"]);
  });
});
