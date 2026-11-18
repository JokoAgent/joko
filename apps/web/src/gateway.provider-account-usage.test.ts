import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import {
  AuthenticationState, BackendService, CapabilitySupport, EventService, ProviderAccountUsageSnapshotSchema,
  SnapshotSchema, WorkspaceService, capabilityNames, type Snapshot
} from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";

const profile = { id: "connection", deviceId: "device", serverId: "node", name: "Node", origin: "http://127.0.0.1:4318" };
const backendId = "native-codex", providerId = "account";

function quota(usedPercent: number, observedAt: bigint) {
  return create(ProviderAccountUsageSnapshotSchema, { providerId, observedAt: { seconds: observedAt },
    primaryWindow: { usedPercent, windowMinutes: 300 } });
}

function owner(accountUsage: ReturnType<typeof quota> | undefined, {
  cursor = 10n, workspace = false, backendRevision = 1n
} = {}): Snapshot {
  return create(SnapshotSchema, {
    generation: 7n, resumeCursor: { generation: 7n, sequence: cursor, opaqueToken: `cursor-${cursor}` },
    backends: [{ backendId, authenticationState: AuthenticationState.AUTHENTICATED,
      entityVersion: { generation: 2n, revision: { value: backendRevision } } }],
    providers: [{ backendId, providerId, accountUsage, authenticationState: AuthenticationState.AUTHENTICATED,
      version: { generation: 2n, revision: { value: backendRevision } }, capabilities: { capabilities: [
        { name: capabilityNames.providerAccountUsage, support: CapabilitySupport.SUPPORTED }
      ] } }],
    workspaces: workspace ? [{ workspaceId: "workspace", displayName: "Workspace", trusted: true,
      location: { kind: { case: "serviceNode", value: {} } } }] : []
  });
}

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let snapshot = owner(quota(10, 1n));
  const workspaceEntered = pending(), workspaceReply = pending(), usageEntered = pending(), usageReply = pending();
  const transport = createRouterTransport(router => {
    router.service(EventService, { getSnapshot: () => ({ snapshot }) });
    router.service(WorkspaceService, { listWorkspaceEntries: async request => {
      expect(request.workspaceId).toBe("workspace");
      workspaceEntered.resolve(); await workspaceReply.promise;
      return { entries: [], revision: { value: 1n } };
    } });
    router.service(BackendService, { getProviderUsage: async request => {
      expect(request).toMatchObject({ backendId, providerId });
      usageEntered.resolve(); await usageReply.promise;
      return { accountUsage: quota(35, 3n) };
    } });
  });
  const published: AppSnapshot[] = [];
  const gateway = createOrchestratorGateway(profile, "credential", { onSnapshot: value => published.push(value) }, () => transport);
  return { gateway, published, workspaceEntered, workspaceReply, usageEntered, usageReply,
    setSnapshot(value: Snapshot) { snapshot = value; }, close() { workspaceReply.resolve(); usageReply.resolve(); gateway.disconnect(); } };
}

it.each(["same cursor", "advanced cursor", "ordinary snapshot first", "absent quota in the older snapshot"] as const)(
  "adopts the new Provider reply and handles %s", async ordering => {
    const f = fixture();
    const used = () => f.published.at(-1)?.providers[0]?.accountUsage?.primaryWindow?.usedPercent;
    try {
      await f.gateway.connect({ snapshotOnly: true });
      expect(used()).toBe(10);
      const cursor = ordering === "advanced cursor" ? 11n : 10n;
      f.setSnapshot(owner(ordering === "absent quota in the older snapshot" ? undefined : quota(20, 2n), { cursor, workspace: true }));
      const ownerRead = f.gateway.refresh();
      await f.workspaceEntered.promise;
      const quotaRead = f.gateway.refreshProviderAccountUsage(backendId, providerId);
      await f.usageEntered.promise;
      if (ordering === "ordinary snapshot first") {
        f.workspaceReply.resolve(); await ownerRead;
        expect(used()).toBe(20);
      }
      f.usageReply.resolve();
      await vi.waitFor(() => expect(used()).toBe(35));
      const firstFresh = f.published.length - 1;
      f.workspaceReply.resolve();
      await Promise.all([ownerRead, quotaRead]);
      expect(f.published.at(-1)?.cursor).toBe(cursor);
      expect(f.published.slice(firstFresh).map(value => value.providers[0]?.accountUsage?.primaryWindow?.usedPercent))
        .toEqual(Array.from({ length: f.published.length - firstFresh }, () => 35));

      f.setSnapshot(owner(quota(47, 4n), { cursor: cursor + 1n }));
      await f.gateway.refresh();
      expect(used()).toBe(47);
    } finally { f.close(); }
  }
);

it("keeps a replacement account projection when the original Provider read replies late", async () => {
  const f = fixture();
  try {
    await f.gateway.connect({ snapshotOnly: true });
    const old = f.gateway.refreshProviderAccountUsage(backendId, providerId);
    await f.usageEntered.promise;
    f.setSnapshot(owner(quota(55, 2n), { cursor: 11n, backendRevision: 2n }));
    await f.gateway.refresh();
    f.usageReply.resolve(); await old;
    expect(f.published.map(value => value.providers[0]?.accountUsage?.primaryWindow?.usedPercent)).toEqual([10, 55]);
  } finally { f.close(); }
});
