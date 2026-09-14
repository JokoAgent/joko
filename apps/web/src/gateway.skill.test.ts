import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  OperationState,
  ResourceScope,
  ResourceState,
  SkillDiffChangeKind,
  SkillDraftKind,
  SkillFileKind,
  SkillRecoveryStatus
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("Skill gateway", () => {
  it("maps path-private Skill content and revision-fences every mutation", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "listSkills") return {
        skills: [protoSkill()],
        catalogRevision: { value: 11n },
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "openSkill") return { skill: protoSession() };
      if (method === "listSkillFiles") return {
        files: [{ key: "references", name: "references", kind: SkillFileKind.DIRECTORY, size: 0n, editable: false }],
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "readSkillFile") return {
        file: { key: input.key, content: "# Safe preview", revision: "sha256:file", size: 14n, editable: true }
      };
      if (method === "getSkillDiff") return { diff: protoDiff() };
      if (method === "prepareSkillFileEdit") return { draft: protoDraft("edit") };
      if (method === "prepareSkillRename") return { draft: protoDraft("rename") };
      if (method === "listSkillRecoveries") return {
        recoveries: [protoRecovery()],
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "closeSkill") return { closed: true };
      if (method === "submitOperation") return {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED,
          result: {
            payload: {
              case: "skill",
              value: {
                skill: protoSkill(),
                replacedSkillId: input.mutation.payload.case === "applySkillDraft" ? "resource-old" : "",
                recoveryId: input.mutation.payload.case === "deleteSkill" ? "skill_recovery_0123456789abcdef0123456789abcdef" : ""
              }
            }
          }
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });

    const catalog = await gateway.listSkills({ query: "review", backendId: "pi", scope: "global" });
    expect(catalog).toMatchObject({
      revision: 11n,
      skills: [{ id: "resource-skill", sourceLabel: "review-helper", revision: 7n, scope: "global" }]
    });
    const session = await gateway.openSkill(catalog.skills[0]!.id, catalog.skills[0]!.revision);
    expect(session).toMatchObject({
      id: "skill_session_0123456789abcdef0123456789abcdef",
      observedRevision: "sha256:observed",
      metadata: { frontmatter: { description: "Review safely", token: "[redacted]" } },
      files: [{ key: "references", kind: "directory" }],
      diff: { changes: [{ key: "SKILL.md", kind: "modified" }] }
    });
    expect(await gateway.listSkillFiles(session.id, "references")).toMatchObject([{ key: "references", kind: "directory" }]);
    expect(await gateway.readSkillFile(session.id, "SKILL.md")).toMatchObject({ key: "SKILL.md", content: "# Safe preview" });
    expect(await gateway.getSkillDiff(session.id)).toMatchObject({ available: true, changes: [{ kind: "modified" }] });

    const edit = await gateway.prepareSkillFileEdit(session.id, "SKILL.md", "sha256:file", "# Changed");
    const rename = await gateway.prepareSkillRename(session.id, "renamed-review");
    expect(edit.kind).toBe("edit");
    expect(rename.kind).toBe("rename");
    expect(await gateway.applySkillDraft(edit)).toMatchObject({ replacedSkillId: "resource-old", skill: { revision: 7n } });
    expect(await gateway.setSkillEnabled(session.skill, false)).toMatchObject({ skill: { id: "resource-skill" } });
    expect(await gateway.deleteSkill(session, session.skill.name)).toMatchObject({ recoveryId: "skill_recovery_0123456789abcdef0123456789abcdef" });
    expect(await gateway.listSkillRecoveries()).toMatchObject([{ id: "skill_recovery_0123456789abcdef0123456789abcdef", status: "ready" }]);
    await expect(gateway.closeSkill(session.id)).resolves.toBe(true);

    expect(requests.find((request) => request.method === "listSkills")?.input).toMatchObject({
      query: "review",
      backendId: "pi",
      scope: ResourceScope.GLOBAL,
      page: { pageSize: 500, pageToken: "" }
    });
    expect(requests.find((request) => request.method === "openSkill")?.input).toMatchObject({
      skillId: "resource-skill",
      expectedResourceRevision: { value: 7n }
    });
    expect(requests.filter((request) => request.method === "listSkillFiles").map((request) => request.input)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: session.id, parentKey: "", page: { pageSize: 500, pageToken: "" } }),
      expect.objectContaining({ sessionId: session.id, parentKey: "references", page: { pageSize: 500, pageToken: "" } })
    ]));
    expect(requests.find((request) => request.method === "listSkillRecoveries")?.input).toEqual({
      page: { pageSize: 500, pageToken: "" }
    });
    const mutations = requests.filter((request) => request.method === "submitOperation")
      .map((request) => request.input.mutation.payload);
    expect(mutations).toMatchObject([
      { case: "applySkillDraft", value: { draftId: edit.id } },
      { case: "setSkillEnabled", value: { skillId: "resource-skill", expectedResourceRevision: { value: 7n }, enabled: false } },
      { case: "deleteSkill", value: { sessionId: session.id, confirmation: "Review helper" } }
    ]);
    const publicResult = JSON.stringify({ catalog, session, edit, rename }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(publicResult).not.toMatch(/[A-Za-z]:[\\/]|\/home\//u);
    gateway.disconnect();
  });

  it("materializes a complete bounded Skill file page sequence", async () => {
    const tokens: string[] = [];
    const gateway = await mount(async (method, input) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "openSkill") return { skill: protoSession() };
      if (method === "listSkillFiles") {
        const token = input.page?.pageToken ?? "";
        tokens.push(token);
        return token === ""
          ? {
              files: [{ key: "SKILL.md", name: "SKILL.md", kind: SkillFileKind.FILE, size: 10n, editable: true }],
              page: { totalSize: 2n, nextPageToken: "second" }
            }
          : {
              files: [{ key: "references", name: "references", kind: SkillFileKind.DIRECTORY, size: 0n, editable: false }],
              page: { totalSize: 2n, nextPageToken: "" }
            };
      }
      if (method === "closeSkill") return { closed: true };
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = await gateway.openSkill("resource-skill", 7n);
    expect(session.files.map((file) => file.key)).toEqual(["SKILL.md", "references"]);
    expect(tokens).toEqual(["", "second"]);
    gateway.disconnect();
  });

  it("materializes a complete Skill recovery page sequence", async () => {
    const tokens: string[] = [];
    const gateway = await mount(async (method, input) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "listSkillRecoveries") {
        const token = input.page?.pageToken ?? "";
        tokens.push(token);
        return token === ""
          ? {
              recoveries: [protoRecovery()],
              page: { totalSize: 2n, nextPageToken: "second" }
            }
          : {
              recoveries: [{ ...protoRecovery(), recoveryId: "skill_recovery_fedcba9876543210fedcba9876543210" }],
              page: { totalSize: 2n, nextPageToken: "" }
            };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    expect((await gateway.listSkillRecoveries()).map((recovery) => recovery.id)).toEqual([
      "skill_recovery_0123456789abcdef0123456789abcdef",
      "skill_recovery_fedcba9876543210fedcba9876543210"
    ]);
    expect(tokens).toEqual(["", "second"]);
    gateway.disconnect();
  });

  it("fails closed on path-bearing labels and non-portable file keys", async () => {
    let invalid: "label" | "key" | "enum" = "label";
    const gateway = await mount(async (method) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "listSkills") return {
        skills: [{ ...protoSkill(), sourceLabel: "D:\\private\\review" }],
        catalogRevision: { value: 1n },
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "openSkill" && (invalid === "key" || invalid === "enum")) return { skill: protoSession() };
      if (method === "listSkillFiles" && invalid === "key") return {
        files: [{ key: "../secret", name: "secret", kind: SkillFileKind.FILE, size: 2n, editable: true }],
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "listSkillFiles" && invalid === "enum") return {
        files: [{ key: "SKILL.md", name: "SKILL.md", kind: 999, size: 2n, editable: true }],
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "closeSkill") return { closed: true };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(gateway.listSkills()).rejects.toThrow("path-bearing Skill descriptor");
    invalid = "key";
    await expect(gateway.openSkill("resource-skill", 7n)).rejects.toThrow("invalid Skill file entry");
    invalid = "enum";
    await expect(gateway.openSkill("resource-skill", 7n)).rejects.toThrow("invalid Skill file entry");
    gateway.disconnect();
  });
});

function protoSkill(): object {
  return {
    skillId: "resource-skill",
    backendId: "pi",
    scope: ResourceScope.GLOBAL,
    name: "Review helper",
    sourceLabel: "review-helper",
    state: ResourceState.LOADED,
    enabled: true,
    canToggle: true,
    contentAvailable: true,
    canEdit: true,
    canDelete: true,
    entityVersion: { revision: { value: 7n }, generation: 0n, updatedAt: timestamp() },
    approvedRevision: "sha256:approved",
    updatedAt: timestamp()
  };
}

function protoSession(): object {
  return {
    sessionId: "skill_session_0123456789abcdef0123456789abcdef",
    skill: protoSkill(),
    observedRevision: "sha256:observed",
    dirty: true,
    baselineAvailable: true,
    metadata: {
      name: "Review helper",
      description: "Review safely",
      version: "1.0.0",
      frontmatterJson: JSON.stringify({ description: "Review safely", token: "[redacted]" })
    },
    fileCount: 2n,
    bytes: 256n,
    diff: protoDiff(),
    expiresAt: timestamp(1_800_000_000n)
  };
}

function protoDiff() {
  return {
    available: true,
    changes: [{
      key: "SKILL.md",
      kind: SkillDiffChangeKind.MODIFIED,
      binary: false,
      unifiedDiff: "--- SKILL.md\n+++ SKILL.md\n-old\n+new"
    }],
    truncated: false
  };
}

function protoDraft(kind: "edit" | "rename"): object {
  return {
    draftId: kind === "edit" ? "skill_draft_0123456789abcdef0123456789abcdef" : "skill_draft_fedcba9876543210fedcba9876543210",
    sessionId: "skill_session_0123456789abcdef0123456789abcdef",
    skillId: "resource-skill",
    kind: kind === "edit" ? SkillDraftKind.EDIT : SkillDraftKind.RENAME,
    name: kind === "edit" ? "Review helper" : "renamed-review",
    resourceRevision: { value: 7n },
    observedRevision: "sha256:observed",
    changes: protoDiff().changes,
    expiresAt: timestamp(1_800_000_000n)
  };
}

function protoRecovery(): object {
  return {
    recoveryId: "skill_recovery_0123456789abcdef0123456789abcdef",
    skillId: "resource-skill",
    backendId: "pi",
    scope: ResourceScope.GLOBAL,
    name: "Review helper",
    revision: "sha256:observed",
    files: 2n,
    bytes: 256n,
    createdAt: timestamp(),
    status: SkillRecoveryStatus.READY
  };
}

function timestamp(seconds = 1_700_000_000n): { readonly seconds: bigint; readonly nanos: number } {
  return { seconds, nanos: 0 };
}

async function mount(handler: (method: string, input: any) => Promise<object>): Promise<ReturnType<typeof createOrchestratorGateway>> {
  const transport = {
    unary: vi.fn(async (method: any, _signal: AbortSignal | undefined, _timeout: unknown, _headers: Headers, input: any) =>
      response(method, create(method.output, await handler(method.localName, input)))),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(
    { id: "connection", deviceId: "device", name: "Desktop", origin: "https://orchestrator.example", serverId: "server" },
    "auth-key",
    {},
    () => transport
  );
  await gateway.connect();
  return gateway;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
