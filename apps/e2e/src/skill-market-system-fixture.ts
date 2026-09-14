import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { ResourceUsageEventPayload } from "@joko/core";
import type { PiResourceDescriptor } from "@joko/orchestrator";

import { ExtensionLibrarySystemFixture as SkillMarketSystemFixture } from "./extension-library-system-fixture.js";

export { SkillMarketSystemFixture };

export const MARKET_SLUG = "production-writer";
export const MARKET_NAME = "Production Writer";

export function seedSkillResourceUsage(
  fixture: SkillMarketSystemFixture,
  input: {
    readonly targetId: string;
    readonly previous: PiResourceDescriptor;
    readonly current: PiResourceDescriptor;
  }
): void {
  if (input.previous.backendId !== input.current.backendId) {
    throw new Error("Resource usage fixture versions must belong to the same Backend.");
  }
  const startedAt = Date.now() - 20_000;
  const sessionId = `skill-usage-e2e-${randomUUID()}`;
  const session = fixture.application.store.createSession({
    id: sessionId,
    backendId: input.current.backendId,
    targetId: input.targetId,
    title: "Resource usage evidence",
    binding: { opaqueRef: `native/${sessionId}.jsonl`, generation: 1 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: startedAt - 2,
    updatedAt: startedAt - 2
  }).descriptor;
  const runId = randomUUID();
  fixture.application.store.createRun({
    id: runId,
    sessionId,
    source: "user",
    state: "running",
    createdAt: startedAt - 1
  });
  for (let index = 0; index < 5; index += 1) {
    appendResourceUsageEvidence(fixture, {
      sessionId,
      runId,
      targetId: session.targetId,
      generation: session.binding.generation,
      resource: input.previous,
      emittedAt: startedAt + index,
      occurrenceId: `previous-command-${index}`,
      source: "native_skill_command",
      action: "command_succeeded"
    });
    appendResourceUsageEvidence(fixture, {
      sessionId,
      runId,
      targetId: session.targetId,
      generation: session.binding.generation,
      resource: input.current,
      emittedAt: startedAt + 10 + index,
      occurrenceId: `current-tool-${index}`,
      source: "runtime_tool_call",
      action: index === 4 ? "tool_failed" : "tool_succeeded"
    });
  }
}

export async function writeSkillMarketSource(
  fixture: SkillMarketSystemFixture,
  version: string,
  body: string
): Promise<string> {
  const sourceRoot = join(fixture.rootDirectory, "skill-market-source");
  const manifestRoot = join(sourceRoot, ".agents", "skills");
  await mkdir(manifestRoot, { recursive: true });
  const skillDocument = [
    "---",
    `name: ${MARKET_SLUG}`,
    "description: Production Skill market fixture",
    `version: ${version}`,
    "---",
    body,
    ""
  ].join("\n");
  const archive = makeTgz([
    { path: "package/SKILL.md", content: Buffer.from(skillDocument, "utf8") },
    { path: "package/references/guide.md", content: Buffer.from(`Guide for ${version}\n`, "utf8") }
  ]);
  const archiveName = `${MARKET_SLUG}.tgz`;
  await writeFile(join(sourceRoot, archiveName), archive);
  await writeFile(join(manifestRoot, "marketplace.json"), `${JSON.stringify({
    format: 1,
    name: "production-market",
    displayName: "Production Skill Market",
    entries: [{
      slug: MARKET_SLUG,
      name: MARKET_NAME,
      author: "Joko E2E",
      description: "Production Skill market fixture",
      category: "Writing",
      tags: ["writing", "production"],
      version,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: version === "1.0.0" ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z",
      downloads: 42,
      trendScore: 7,
      archive: archiveName,
      compressedBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex")
    }]
  }, null, 2)}\n`, "utf8");
  return sourceRoot;
}

function makeTgz(entries: readonly { readonly path: string; readonly content: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.content.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, entry.content, Buffer.alloc((512 - entry.content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(target: Buffer, value: number, offset: number, length: number): void {
  target.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

function appendResourceUsageEvidence(
  fixture: SkillMarketSystemFixture,
  input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly targetId: string;
    readonly generation: number;
    readonly resource: PiResourceDescriptor;
    readonly emittedAt: number;
    readonly occurrenceId: string;
    readonly source: ResourceUsageEventPayload["source"];
    readonly action: ResourceUsageEventPayload["action"];
  }
): void {
  const market = input.resource.skillMarket;
  const payload: ResourceUsageEventPayload = {
    type: "resource_usage",
    occurrenceId: input.occurrenceId,
    resourceId: input.resource.id,
    entityRevision: input.resource.versionNumber.toString(10),
    contentRevision: input.resource.discoveredRevision,
    runtimeGeneration: input.generation,
    ...(input.resource.version === undefined ? {} : { version: input.resource.version }),
    ...(market === undefined ? {} : {
      market: {
        sourceId: market.sourceId,
        sourceRevision: market.sourceRevision.toString(10),
        entryId: market.entryId,
        entryRevision: market.entryRevision.toString(10),
        entryContentRevision: market.entryContentRevision,
        installedContentRevision: market.installedContentRevision
      }
    }),
    source: input.source,
    activity: "strong_active",
    action: input.action
  };
  fixture.application.store.appendEvent({
    id: `resource-usage-e2e-${input.occurrenceId}-${input.resource.versionNumber.toString(10)}`,
    backendId: input.resource.backendId,
    targetId: input.targetId,
    sessionId: input.sessionId,
    runId: input.runId,
    generation: input.generation,
    emittedAt: input.emittedAt,
    traceId: `resource-usage:${input.occurrenceId}`,
    payload
  });
}
