import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore, PartnerStore, type PartnerCapabilitiesRecord } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerToolBridgeProvider } from "./partner-tool-provider.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];
const PROFILE = {
  ...PI_LIKE_PROFILE,
  capabilities: [
    ...PI_LIKE_PROFILE.capabilities.map((capability) => capability.key === "permission.modes"
      ? { key: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }
      : capability),
    { key: "permission.change", supported: true }
  ]
} as const;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("PartnerToolBridgeProvider", () => {
  it("exposes only public partner data to an exact active canonical task", async () => {
    const fixture = await createFixture();
    const caller = await fixture.manager.createPartner(input(fixture.partnerStore, "Aster"));
    const target = await fixture.manager.createPartner(input(fixture.partnerStore, "Beryl"));
    const callerContext = context(fixture.operationalStore, caller.canonicalSessionId!, "a");

    expect(fixture.provider.includeForTarget(caller.homeTargetId)).toBe(true);
    expect(fixture.provider.includeForTarget("ordinary-target")).toBe(false);
    const listed = resultData(await fixture.provider.callTool("list_partners", {}, undefined, callerContext)) as {
      partners: readonly Record<string, unknown>[];
    };
    expect(listed.partners).toEqual([
      expect.objectContaining({ id: target.id, display_name: "Beryl", ready: true })
    ]);
    expect(JSON.stringify(listed)).not.toContain(target.identitySource);
    expect(JSON.stringify(listed)).not.toContain(target.homeTargetId);

    expect(errorData(await fixture.provider.callTool("list_partners", {}, undefined, {
      ...callerContext,
      generation: callerContext.generation + 1
    }))).toMatchObject({ errorCode: "STALE_SCOPE" });
    expect(errorData(await fixture.provider.callTool("list_partners", { unknown: true }, undefined, callerContext)))
      .toMatchObject({ errorCode: "INVALID_ARGS" });
  });

  it("delivers private messages and creates a target-owned delegation through direct tools", async () => {
    const fixture = await createFixture();
    const caller = await fixture.manager.createPartner(input(fixture.partnerStore, "Aster"));
    const target = await fixture.manager.createPartner(input(fixture.partnerStore, "Beryl"));
    const callerContext = context(fixture.operationalStore, caller.canonicalSessionId!, "c");
    const deliveryContext = context(fixture.operationalStore, caller.canonicalSessionId!, "a");

    const delivery = resultData(await fixture.provider.callTool("send_private_message", {
      target_partner_id: target.id,
      message: "Please verify the recovery boundary."
    }, undefined, deliveryContext)) as Record<string, unknown>;
    expect(delivery).toMatchObject({
      delivery_status: "delivered",
      remaining_messages: 11,
      conversation_ended: false,
      target_partner: { id: target.id, display_name: target.displayName }
    });
    const deliveryReplay = resultData(await fixture.provider.callTool("send_private_message", {
      target_partner_id: target.id,
      message: "Please verify the recovery boundary."
    }, undefined, deliveryContext)) as Record<string, unknown>;
    expect(deliveryReplay).toMatchObject({
      thread_id: delivery.thread_id,
      message_id: delivery.message_id,
      delivery_status: "delivered",
      remaining_messages: 11
    });
    expect(fixture.manager.getPrivateThread(String(delivery.thread_id), caller.id).messages).toHaveLength(1);

    const delegationContext = context(fixture.operationalStore, caller.canonicalSessionId!, "b");
    const started = resultData(await fixture.provider.callTool("start_delegation", {
      target_partner_id: target.id,
      title: "Recovery audit",
      objective: "Audit the recovery boundary and report the result."
    }, undefined, delegationContext)) as {
      id: string;
      requester_partner_id: string;
      target_partner_id: string;
      parent_session_id: string;
      target_profile_version: string;
      child_session_id: string;
      status: string;
    };
    expect(started).toMatchObject({
      requester_partner_id: caller.id,
      target_partner_id: target.id,
      parent_session_id: caller.canonicalSessionId,
      target_profile_version: target.profileVersion.toString()
    });
    expect(started.child_session_id).toBeDefined();
    expect(["queued", "running", "completed"]).toContain(started.status);
    expect(fixture.partnerStore.getSessionLink(started.child_session_id)).toMatchObject({
      partnerId: target.id,
      role: "delegation"
    });
    const startedReplay = resultData(await fixture.provider.callTool("start_delegation", {
      target_partner_id: target.id,
      title: "Recovery audit",
      objective: "Audit the recovery boundary and report the result."
    }, undefined, delegationContext)) as { id: string; child_session_id: string };
    expect(startedReplay).toMatchObject({ id: started.id, child_session_id: started.child_session_id });

    await vi.waitFor(async () => {
      const result = resultData(await fixture.provider.callTool("get_delegation", {
        delegation_id: started.id
      }, undefined, callerContext)) as { status: string };
      expect(result.status).toBe("completed");
    });
    const listed = resultData(await fixture.provider.callTool("list_delegations", {}, undefined, callerContext)) as {
      delegations: readonly { id: string; status: string; result_summary?: string }[];
    };
    expect(listed.delegations).toEqual([
      expect.objectContaining({ id: started.id, status: "completed", result_summary: expect.stringContaining("Reply from") })
    ]);
    expect(errorData(await fixture.provider.callTool("cancel_delegation", {
      delegation_id: started.id
    }, undefined, callerContext))).toMatchObject({ errorCode: "INVALID_ARGS" });

    const childContext = context(fixture.operationalStore, started.child_session_id);
    expect(errorData(await fixture.provider.callTool("list_partners", {}, undefined, childContext)))
      .toMatchObject({ errorCode: "PARTNER_SESSION_INACTIVE" });
  });
});

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-partner-tools-"));
  const operationalStore = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository: new OperationalArtifactRepository(operationalStore),
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const sessionHost = new SessionHost(operationalStore, artifacts, [new FakeBackendAdapter(PROFILE)]);
  await sessionHost.initialize();
  const manager = new PartnerManager({
    store: partnerStore,
    operationalStore,
    sessionHost,
    workspaceService: { register: async (input) => input },
    homesRoot: join(directory, "partner-homes")
  });
  const provider = new PartnerToolBridgeProvider({ store: operationalStore, partners: manager });
  cleanups.push(async () => {
    await sessionHost.dispose();
    partnerStore.close();
    operationalStore.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { operationalStore, partnerStore, sessionHost, manager, provider };
}

function input(store: PartnerStore, displayName: string) {
  return {
    expectedDirectoryRevision: store.directoryState().revision,
    displayName,
    avatar: "orbit",
    identitySource: `You are ${displayName}, a long-lived work partner.`,
    templateId: "general",
    capabilities: capabilities(),
    usesDirectoryDefaults: false
  } as const;
}

function capabilities(): PartnerCapabilitiesRecord {
  return {
    modelChain: [{
      backendId: PROFILE.id,
      providerId: "test",
      modelId: "text",
      effort: "medium",
      fastMode: false
    }],
    permissionMode: "ask",
    planMode: false
  };
}

function context(store: OperationalStore, sessionId: string, seed = "a"): BridgeToolCallContext {
  const session = store.getSession(sessionId).descriptor;
  return {
    sessionId,
    targetId: session.targetId,
    generation: session.binding.generation,
    providerGeneration: 1,
    requestIdentity: seed.repeat(64),
    effectIdentity: seed.repeat(64),
    requestBodyHash: `sha256:${seed.repeat(64)}`
  };
}

function resultData(result: McpCallResult): unknown {
  expect(result.isError).toBe(false);
  return result.structuredContent?.["data"];
}

function errorData(result: McpCallResult): Readonly<Record<string, unknown>> {
  expect(result.isError).toBe(true);
  return result.structuredContent ?? {};
}
