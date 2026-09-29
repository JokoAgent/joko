import { execFile } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { RemoteHostAuthenticationMode, RemoteHostService, SshAgentState, SshInstallShell, SshKeyPassphrasePurpose, SshKeyService } from "@joko/contracts";
import { CredentialManager, CredentialVault, RemoteHostRegistry } from "@joko/orchestrator";
import { SshKeyManager } from "@joko/remote-ssh";
import { expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";

it("uses authenticated single-use passphrase uploads and current Host authority through the SSH HTTP service", async () => {
  let identityDirectory = "";
  let agentInputCount = 0;
  const fixture = await OrchestratorE2eFixture.start({ createAuxiliaryServices: async (store, dataDirectory) => {
    identityDirectory = join(dataDirectory, "node-identity");
    await mkdir(identityDirectory, { mode: 0o700 });
    if (process.platform === "win32") await powershellKeyAcl("$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); [System.IO.Directory]::SetAccessControl($env:JOKO_KEY_ACL_PATH, $acl)", identityDirectory);
    const vault = await CredentialVault.open(join(dataDirectory, "credential-master.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(dataDirectory, "credential-records.json") });
    await credentials.initialize();
    return { credentials, remoteHosts: new RemoteHostRegistry({ store, ownerId: "orchestrator-e2e" }),
      sshKeys: new SshKeyManager({ directory: identityDirectory, agentCommand: async (args, input) => {
        if (args[0] === "-") { expect(input?.toString()).toContain("PRIVATE KEY"); agentInputCount++; return { code: 0, stdout: "" }; }
        return { code: 1, stdout: "The agent has no identities." };
      } }) };
  } });
  try {
    const first = await fixture.pair("SSH key manager");
    const second = await fixture.pair("Second key manager");
    const client = (authKey?: string) => createClient(SshKeyService, createConnectTransport({ baseUrl: fixture.baseUrl, httpVersion: "1.1",
      interceptors: authKey === undefined ? [] : [next => request => { request.header.set("authorization", `Bearer ${authKey}`); return next(request); }] }));
    const api = client(first.authKey);
    const other = client(second.authKey);
    await expect(client().listSshKeys({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(await api.listSshKeys({})).toMatchObject({ keys: [], agentState: SshAgentState.READY });
    const ticket = (await api.beginSshKeyPassphraseUpload({ purpose: SshKeyPassphrasePurpose.GENERATE })).ticket!;
    const secret = "temporary key passphrase";
    const upload = (authKey: string, value: string) => fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), {
      method: "PUT", headers: { authorization: `Bearer ${authKey}`, "content-type": "application/octet-stream" }, body: Buffer.from(value)
    });
    expect((await upload(second.authKey, secret)).ok).toBe(false);
    expect((await upload(first.authKey, secret)).ok).toBe(true);
    await expect(other.generateSshKey({ name: "id_joko", passphraseUploadTicketId: ticket.ticketId })).rejects.toMatchObject({ code: Code.InvalidArgument });
    const key = (await api.generateSshKey({ name: "id_joko", comment: "Work identity", passphraseUploadTicketId: ticket.ticketId })).key!;
    expect(key.algorithm).toBe("ssh-ed25519");
    await expect(api.generateSshKey({ name: "id_joko", passphraseUploadTicketId: ticket.ticketId })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect((await api.listSshKeys({})).keys).toHaveLength(1);
    expect(fixture.application.credentials!.list()).toEqual([]);
    const publicKey = (await api.readSshPublicKey({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint })).publicKey;
    expect(publicKey).toContain("Work identity");
    expect(publicKey).not.toContain(secret);
    const addTicket = (await api.beginSshKeyPassphraseUpload({ purpose: SshKeyPassphrasePurpose.AGENT_ADD, keyId: key.id, expectedFingerprint: key.sha256Fingerprint })).ticket!;
    expect((await fetch(new URL(addTicket.relativeEndpoint, fixture.baseUrl), { method: "PUT", headers: { authorization: `Bearer ${first.authKey}`, "content-type": "application/octet-stream" }, body: Buffer.from(secret) })).ok).toBe(true);
    await expect(fixture.application.credentials!.commitUpload({ credentialUploadTicketId: addTicket.ticketId, connectionId: first.connectionId, kind: "ssh_private_key", displayName: "Wrong destination" })).rejects.toThrow("cannot be committed");
    await api.addSshKeyToAgent({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint, passphraseUploadTicketId: addTicket.ticketId });
    expect(agentInputCount).toBe(1);
    const targetId = [...fixture.targets.values()][0]!;
    const draftRecipe = await api.getSshKeyInstallCommand({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint,
      destination: { case: "draftHost", value: { hostname: "unsaved.example.test", user: "draft-user", port: 2222 } }, shell: SshInstallShell.POSIX });
    expect(draftRecipe.command).toContain("draft-user@unsaved.example.test");
    expect(draftRecipe.command).toContain("-p 2222");
    expect(fixture.application.remoteHosts!.list(targetId)).toEqual([]);
    await expect(api.getSshKeyInstallCommand({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint,
      destination: { case: "draftHost", value: { hostname: "-invalid", user: "draft-user", port: 2222 } }, shell: SshInstallShell.POSIX })).rejects.toMatchObject({ code: Code.InvalidArgument });
    const hostApi = createClient(RemoteHostService, createConnectTransport({ baseUrl: fixture.baseUrl, httpVersion: "1.1",
      interceptors: [next => request => { request.header.set("authorization", `Bearer ${first.authKey}`); return next(request); }] }));
    const saved = (await hostApi.createRemoteHost({ requestId: "save-selected-node-key", hostId: "build-host", targetId, hostname: "build.example.test", user: "builder", port: 22,
      authenticationMode: RemoteHostAuthenticationMode.NODE_KEY, nodeKey: { id: key.id, expectedFingerprint: key.sha256Fingerprint } })).host!;
    expect(saved.nodeKey).toMatchObject({ id: key.id, expectedFingerprint: key.sha256Fingerprint });
    expect(saved.credentialReferenceId).toBeUndefined();
    const host = fixture.application.remoteHosts!.get(targetId, saved.hostId);
    expect(host.nodeKey).toEqual({ id: key.id, expectedFingerprint: key.sha256Fingerprint });
    const request = { keyId: key.id, expectedFingerprint: key.sha256Fingerprint, destination: { case: "savedHost" as const, value: { targetId, hostId: host.id, expectedRevision: { value: host.revision } } }, shell: SshInstallShell.POWERSHELL };
    expect((await api.getSshKeyInstallCommand(request)).command).toContain("builder@build.example.test");
    fixture.application.remoteHosts!.update({ id: host.id, targetId, hostname: "replacement.example.test", user: host.user, port: host.port, expectedRevision: host.revision, authenticationMode: "system_agent", credentialReferenceId: null, nodeKey: null });
    await expect(api.getSshKeyInstallCommand(request)).rejects.toMatchObject({ code: Code.Aborted });
    const privatePath = join(identityDirectory, key.id);
    if (process.platform === "win32") await powershellKeyAcl("$acl = [System.IO.File]::GetAccessControl($env:JOKO_KEY_ACL_PATH); $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'None', 'None', 'Allow'))); [System.IO.File]::SetAccessControl($env:JOKO_KEY_ACL_PATH, $acl)", privatePath);
    else await chmod(privatePath, 0o644);
    expect((await api.listSshKeys({})).keys).toEqual([]);
    await expect(api.readSshPublicKey({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint }))
      .rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "ssh_key.unsafe_permissions" });
    await expect(api.addSshKeyToAgent({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint }))
      .rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "ssh_key.unsafe_permissions" });
    expect(agentInputCount).toBe(1);
    fixture.application.connections.revoke(first.connectionId);
    await expect(api.readSshPublicKey({ keyId: key.id, expectedFingerprint: key.sha256Fingerprint })).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(await readFile(join(identityDirectory, key.id), "utf8")).not.toContain(secret);
    expect(JSON.stringify(fixture.application.store.listSettings())).not.toContain(secret);
  } finally { await fixture.close(); }
}, 60_000);

async function powershellKeyAcl(command: string, path: string): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, env: { ...process.env, JOKO_KEY_ACL_PATH: path }
  });
}
