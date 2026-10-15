import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readRegisteredBackgroundTaskOutput } from "./background-task-output.js";

it("reads only a bounded complete tail and preserves a single long UTF-8 line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-background-output-")), file = join(directory, "task.output");
  try {
    await writeFile(file, "older line\ncurrent line\n");
    expect(await readRegisteredBackgroundTaskOutput(file, 13)).toMatchObject({ status: "available", text: "current line\n", totalBytes: 24, truncated: true });
    await writeFile(file, "界".repeat(100));
    const output = await readRegisteredBackgroundTaskOutput(file, 8);
    expect(output.status).toBe("available"); expect(output.text).toBe("界界"); expect(output.totalBytes).toBe(300);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects unregistered path forms, other extensions, directories and missing output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-background-output-"));
  try {
    const folder = join(directory, "folder.output"); await mkdir(folder);
    for (const path of ["relative.output", join(directory, "other.txt"), folder, join(directory, "missing.output")]) {
      expect((await readRegisteredBackgroundTaskOutput(path, 16_384)).status).not.toBe("available");
    }
    expect((await readRegisteredBackgroundTaskOutput(join(directory, "missing.output"), 262_145)).status).toBe("unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
