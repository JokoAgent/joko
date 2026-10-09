import { mkdir, mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PiNativePreviewCatalog } from "./native-session-preview.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("discovers only granted projects and reads current exact entries without starting a runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-pi-preview-")); roots.push(root);
  const project = join(root, "project"); const native = join(root, "native"); await mkdir(project); await mkdir(native);
  const path = join(native, "session.jsonl");
  await writeFile(path, [
    { type: "session", id: "native-one", cwd: project, timestamp: "2026-10-09T00:00:00Z" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Project purpose" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "Internal tool" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Current result" }, { type: "thinking", thinking: "Private reasoning" }] } }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  const catalog = new PiNativePreviewCatalog([native]);
  expect((await catalog.scan([])).entries).toEqual([]);
  const entry = (await catalog.scan([project])).entries[0]!;
  expect((await catalog.read(entry)).messages.map((item) => item.text)).toEqual(["Project purpose", "Current result"]);
  await expect(catalog.read({ ...entry })).rejects.toThrow();
  await appendFile(path, "{}\n");
  await expect(catalog.read(entry)).rejects.toThrow();
});
