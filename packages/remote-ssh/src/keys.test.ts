import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ssh2 from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SshKeyError, SshKeyManager, sshKeyInstallCommand, type SshAgentCommand } from "./keys.js";
import { encodeAgentPrivateKey } from "./agent-private-key.js";
import { createPrivateFile } from "./create-private-file.js";

const roots: string[] = [];
const managers: SshKeyManager[] = [];
const signal = (): AbortSignal => new AbortController().signal;
afterEach(async () => {
  managers.splice(0).forEach(manager => manager.close());
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(agentCommand: SshAgentCommand = async () => ({ code: 2, stdout: "" }), prepareDirectory = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-ssh-keys-")));
  roots.push(root);
  const directory = join(root, "identity");
  if (process.platform === "win32") {
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); [System.IO.Directory]::SetAccessControl($env:JOKO_ACL_FIXTURE, $acl)"], { windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: root } });
    if (prepareDirectory) await mkdir(directory);
  }
  const manager = new SshKeyManager({ directory, agentCommand }); managers.push(manager);
  return { manager, root, directory };
}
async function allowEveryone(path: string, rights: "Read" | "CreateFiles", directory: boolean): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$acl = if ($env:JOKO_ACL_DIRECTORY -eq '1') { [System.IO.Directory]::GetAccessControl($env:JOKO_ACL_FIXTURE) } else { [System.IO.File]::GetAccessControl($env:JOKO_ACL_FIXTURE) }; $sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $env:JOKO_ACL_RIGHTS, 'None', 'None', 'Allow'))); if ($env:JOKO_ACL_DIRECTORY -eq '1') { [System.IO.Directory]::SetAccessControl($env:JOKO_ACL_FIXTURE, $acl) } else { [System.IO.File]::SetAccessControl($env:JOKO_ACL_FIXTURE, $acl) }"], {
    windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path, JOKO_ACL_RIGHTS: rights, JOKO_ACL_DIRECTORY: directory ? "1" : "0" }
  });
}
async function toggleDirectoryArchive(path: string): Promise<void> {
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$before = [System.IO.File]::GetAttributes($env:JOKO_ACL_FIXTURE); $after = [System.IO.FileAttributes]([int]$before -bxor [int][System.IO.FileAttributes]::Archive); [System.IO.File]::SetAttributes($env:JOKO_ACL_FIXTURE, $after); if ([System.IO.File]::GetAttributes($env:JOKO_ACL_FIXTURE) -ne $after) { exit 4 }"], {
    windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path }
  });
}

describe("node SSH keys", () => {
  it("creates an owner-only file exclusively without changing a colliding identity", async () => {
    const { root } = await fixture();
    const original = join(root, "private"); const foreign = join(root, "foreign");
    await writeFile(foreign, "untouched identity", { mode: 0o640 });
    const held = await createPrivateFile(original, signal());
    try {
      if (process.platform === "win32") {
        const acl = async (path: string): Promise<string> => (await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$acl = [System.IO.File]::GetAccessControl($env:JOKO_ACL_FIXTURE); $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ConvertTo-Json -Compress @{ protected = $acl.AreAccessRulesProtected; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current = $sid.Value; rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; type = [string]$_.AccessControlType; rights = [string]$_.FileSystemRights } }) }"], {
          windowsHide: true, env: { ...process.env, JOKO_ACL_FIXTURE: path }
        })).stdout;
        const created = JSON.parse(await acl(original));
        expect(created).toEqual({ protected: true, owner: created.current, current: created.current, rules: [{ sid: created.current, inherited: false, type: "Allow", rights: "FullControl" }] });
        const before = await acl(foreign);
        await expect(createPrivateFile(foreign, signal())).rejects.toMatchObject({ code: "exists" });
        expect(await acl(foreign)).toBe(before);
        const uncertain = join(root, "uncertain");
        const prototype = Object.getPrototypeOf(held) as FileHandle;
        const inspect = vi.spyOn(prototype, "stat").mockRejectedValueOnce(new Error("Fixture cannot inspect the reopened file"));
        try { await expect(createPrivateFile(uncertain, signal())).rejects.toMatchObject({ code: "outcome_unknown" }); }
        finally { inspect.mockRestore(); }
        expect(await readFile(uncertain, "utf8")).toBe("");
        await expect(createPrivateFile(uncertain, signal())).rejects.toMatchObject({ code: "exists" });
      } else {
        const before = (await stat(foreign)).mode;
        expect((await held.stat()).mode & 0o777).toBe(0o600);
        await expect(createPrivateFile(foreign, signal())).rejects.toMatchObject({ code: "exists" });
        expect((await stat(foreign)).mode).toBe(before);
      }
      expect(await readFile(foreign, "utf8")).toBe("untouched identity");
      expect((await held.stat()).size).toBe(0);
      const canceled = new AbortController(); canceled.abort();
      await expect(createPrivateFile(join(root, "canceled"), canceled.signal)).rejects.toMatchObject({ code: "aborted" });
      expect(await readdir(root)).not.toContain("canceled");
    } finally { await held.close(); }
  });

  it("serializes supported identities to one native OpenSSH stdin shape preserving public key, comment and signing", () => {
    const pairs = [ssh2.utils.generateKeyPairSync("ed25519", { comment: "ED key" }),
      ssh2.utils.generateKeyPairSync("rsa", { bits: 2048, comment: "RSA key" }),
      ...([256, 384, 521] as const).map(bits => ssh2.utils.generateKeyPairSync("ecdsa", { bits, comment: "EC key" }))];
    for (const pair of pairs) {
      const original = ssh2.utils.parseKey(pair.private);
      if (original instanceof Error) throw original;
      const bytes = encodeAgentPrivateKey(original);
      try {
        const decoded = ssh2.utils.parseKey(bytes);
        if (decoded instanceof Error) throw decoded;
        expect(decoded.getPublicSSH().equals(original.getPublicSSH())).toBe(true);
        expect(decoded.comment).toBe(original.comment);
        const challenge = Buffer.from("local signing proof");
        const signature = decoded.sign(challenge);
        if (signature instanceof Error) throw signature;
        expect(original.verify(challenge, signature)).toBe(true);
      } finally { bytes.fill(0); }
    }
  });

  it("creates encrypted Ed25519 identities exclusively and adds only verified plaintext through stdin", async () => {
    let publicKey = "";
    let inputKey = "";
    const agent = vi.fn<SshAgentCommand>(async (args, input) => {
      if (args[0] === "-L") return { code: 0, stdout: publicKey };
      expect(args).toEqual(["-"]);
      inputKey = input!.toString();
      expect(inputKey).not.toContain("a sample passphrase");
      return { code: 0, stdout: "" };
    });
    const { manager, directory } = await fixture(agent);
    const first = await manager.generate({ name: "id_joko", comment: "Work key", passphrase: "a sample passphrase" }, signal());
    const original = await readFile(join(directory, first.id), "utf8");
    expect(ssh2.utils.parseKey(original)).toBeInstanceOf(Error);
    expect(ssh2.utils.parseKey(original, "a sample passphrase")).not.toBeInstanceOf(Error);
    const second = await manager.generate({ name: "id_joko", comment: "Another key" }, signal());
    expect(second.id).toBe("id_joko_1");
    expect(await readFile(join(directory, first.id), "utf8")).toBe(original);
    if (process.platform !== "win32") expect((await stat(join(directory, first.id))).mode & 0o777).toBe(0o600);
    publicKey = await manager.readPublic(first.id, first.sha256Fingerprint, signal());
    await expect(manager.addToAgent(first.id, first.sha256Fingerprint, "incorrect", signal())).rejects.toMatchObject({ code: "bad_passphrase" });
    expect(agent).not.toHaveBeenCalled();
    await manager.addToAgent(first.id, first.sha256Fingerprint, "a sample passphrase", signal());
    const parsed = ssh2.utils.parseKey(inputKey);
    expect(parsed).not.toBeInstanceOf(Error);
    if (!(parsed instanceof Error)) {
      expect(parsed.isPrivateKey()).toBe(true);
      expect(parsed.comment).toBe("Work key");
    }
    const catalog = await manager.list(signal());
    expect(catalog.agentState).toBe("ready");
    expect(catalog.keys.find(key => key.id === first.id)).toMatchObject({ inAgent: true, comment: "Work key", algorithm: "ssh-ed25519" });
    expect(JSON.stringify(catalog)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(catalog)).not.toContain(directory);
  }, 20_000);

  it("preserves public-only collisions, rejects changed pairs and omits hard-linked identities", async () => {
    const { manager, directory } = await fixture();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "id_joko.pub"), "reserved public file");
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    expect(key.id).toBe("id_joko_1");
    expect(await readFile(join(directory, "id_joko.pub"), "utf8")).toBe("reserved public file");
    expect(await readdir(directory)).not.toContain("id_joko");
    const replacement = ssh2.utils.generateKeyPairSync("ed25519");
    await writeFile(join(directory, `${key.id}.pub`), replacement.public);
    await expect(manager.readPublic(key.id, key.sha256Fingerprint, signal())).rejects.toMatchObject({ code: "key_changed" });
    const replacementKey = (await manager.list(signal())).keys[0]!;
    await expect(manager.addToAgent(key.id, replacementKey.sha256Fingerprint, undefined, signal())).rejects.toMatchObject({ code: "key_changed" });
    await link(join(directory, key.id), join(directory, "other-private"));
    expect((await manager.list(signal())).keys).toEqual([]);
  }, 25_000);

  it.skipIf(process.platform !== "win32")("rejects a private key whose DACL admits other users before reading or dispatching it", async () => {
    const agent = vi.fn<SshAgentCommand>(async () => ({ code: 0, stdout: "" }));
    const { manager, directory } = await fixture(agent);
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    await allowEveryone(join(directory, key.id), "Read", false);
    const sample = await open(join(directory, key.id), "r");
    const read = vi.spyOn(Object.getPrototypeOf(sample) as FileHandle, "read");
    await sample.close();
    try {
      expect((await manager.list(signal())).keys).toEqual([]);
      await expect(manager.readPublic(key.id, key.sha256Fingerprint, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
      await expect(manager.addToAgent(key.id, key.sha256Fingerprint, "incorrect", signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
      // Each operation reads its public file once; the rejected private file is never read.
      expect(read).toHaveBeenCalledTimes(3);
      expect(agent).toHaveBeenCalledTimes(1);
      expect(agent).toHaveBeenCalledWith(["-L"], undefined, expect.any(AbortSignal));
    } finally { read.mockRestore(); }
  }, 25_000);

  it.skipIf(process.platform !== "win32")("rejects a writable SSH directory for catalog reads and generation", async () => {
    const { manager, directory } = await fixture();
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    await allowEveryone(directory, "CreateFiles", true);
    await expect(manager.list(signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
    await expect(manager.readPublic(key.id, key.sha256Fingerprint, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
    await expect(manager.generate({ name: "another", comment: "" }, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
    expect(await readdir(directory)).not.toContain("another");
  }, 25_000);

  it.skipIf(process.platform !== "win32")("rechecks a directory DACL widened after reading the private key but before agent dispatch", async () => {
    const agent = vi.fn<SshAgentCommand>(async () => ({ code: 0, stdout: "" }));
    const { manager, directory } = await fixture(agent);
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    const sample = await open(join(directory, key.id), "r");
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    const originalRead = prototype.read;
    await sample.close();
    let reads = 0;
    const interception = vi.spyOn(prototype, "read").mockImplementation(function (this: FileHandle, ...args) {
      reads += 1;
      if (reads === 3) return allowEveryone(directory, "CreateFiles", true).then(() => Reflect.apply(originalRead, this, args));
      return Reflect.apply(originalRead, this, args);
    });
    try {
      await expect(manager.addToAgent(key.id, key.sha256Fingerprint, undefined, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
      expect(reads).toBe(3);
      expect(agent).not.toHaveBeenCalled();
    } finally { interception.mockRestore(); }
  }, 25_000);

  it.skipIf(process.platform !== "win32")("does not mistake an ordinary directory attribute update for an identity replacement", async () => {
    const agent = vi.fn<SshAgentCommand>(async () => ({ code: 0, stdout: "" }));
    const { manager, directory } = await fixture(agent);
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    const sample = await open(join(directory, key.id), "r");
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    const originalRead = prototype.read;
    await sample.close();
    let reads = 0;
    const interception = vi.spyOn(prototype, "read").mockImplementation(function (this: FileHandle, ...args) {
      reads += 1;
      if (reads === 3) return toggleDirectoryArchive(directory).then(() => Reflect.apply(originalRead, this, args));
      return Reflect.apply(originalRead, this, args);
    });
    try {
      await manager.addToAgent(key.id, key.sha256Fingerprint, undefined, signal());
      expect(reads).toBe(3);
      expect(agent).toHaveBeenCalledOnce();
      expect(agent).toHaveBeenCalledWith(["-"], expect.any(Buffer), expect.any(AbortSignal));
    } finally { interception.mockRestore(); }
  }, 25_000);

  it.skipIf(process.platform === "win32")("accepts ordinary POSIX directory read access but rejects writable directories and readable private keys", async () => {
    const agent = vi.fn<SshAgentCommand>(async () => ({ code: 2, stdout: "" }));
    const { manager, directory } = await fixture(agent);
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    await chmod(directory, 0o755);
    expect(await manager.readPublic(key.id, key.sha256Fingerprint, signal())).toMatch(/^ssh-ed25519 /u);
    await chmod(join(directory, key.id), 0o644);
    expect((await manager.list(signal())).keys).toEqual([]);
    await expect(manager.readPublic(key.id, key.sha256Fingerprint, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
    await expect(manager.addToAgent(key.id, key.sha256Fingerprint, undefined, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
    expect(agent).toHaveBeenCalledTimes(1);
    await chmod(join(directory, key.id), 0o600);
    await chmod(directory, 0o775);
    await expect(manager.list(signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
    await expect(manager.generate({ name: "another", comment: "" }, signal())).rejects.toMatchObject({ code: "unsafe_permissions" });
  });

  it("rejects linked roots and traversal before opening a key", async () => {
    const { manager, directory, root } = await fixture(undefined, false);
    for (const name of ["../outside", "..", "C:\\key", "key.pub", "NUL", "CON.txt"]) {
      await expect(manager.generate({ name, comment: "" }, signal())).rejects.toMatchObject({ code: "invalid_name" });
    }
    const outside = join(root, "outside"); await mkdir(outside);
    await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    await expect(manager.generate({ name: "id_joko", comment: "" }, signal())).rejects.toMatchObject({ code: "io_failed" });
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(["rewrite", "replace"])("preserves files and reports an unknown result after a private file %s", async (change) => {
    const { manager, root, directory } = await fixture();
    const probe = await open(join(root, "probe"), "wx");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const sync = prototype.sync;
    await probe.close();
    const path = join(directory, "id_joko");
    let changed = false;
    const interception = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
      await sync.call(this);
      if (changed) return;
      const held = await this.stat();
      const current = await stat(path);
      if (held.dev !== current.dev || held.ino !== current.ino || held.size === 0) return;
      changed = true;
      if (change === "replace") await rename(path, `${path}.retained`);
      await writeFile(path, "replacement identity");
    });
    try {
      await expect(manager.generate({ name: "id_joko", comment: "", passphrase: "boundary fixture" }, signal()))
        .rejects.toMatchObject({ code: "outcome_unknown" });
      expect(changed).toBe(true);
      expect(await readFile(path, "utf8")).toBe("replacement identity");
      expect(await readdir(directory)).toContain("id_joko.pub");
      if (change === "replace") {
        expect((await stat(`${path}.retained`)).size).toBeGreaterThan(0);
      }
    } finally { interception.mockRestore(); }
  });

  it("distinguishes an empty agent from unavailable and rejected observations", async () => {
    for (const [code, stdout, state] of [[1, "The agent has no identities.\n", "ready"], [2, "", "unavailable"], [1, "untrusted process text", "failed"], [0, "malformed public key", "failed"]] as const) {
      const { manager } = await fixture(async () => ({ code, stdout }));
      expect(await manager.list(signal())).toEqual({ keys: [], agentState: state, generationSupported: true });
    }
  }, 15_000);

  it("does not queue concurrent changes and retires an in-flight agent call when the node closes", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const agent: SshAgentCommand = async (_args, _input, active) => new Promise((_, reject) => {
      started();
      active.addEventListener("abort", () => reject(new SshKeyError("aborted")), { once: true });
    });
    const { manager } = await fixture(agent);
    const key = await manager.generate({ name: "id_joko", comment: "" }, signal());
    const add = manager.addToAgent(key.id, key.sha256Fingerprint, undefined, signal());
    await ready;
    await expect(manager.generate({ name: "other", comment: "" }, signal())).rejects.toMatchObject({ code: "busy" });
    manager.close();
    await expect(add).rejects.toMatchObject({ code: "outcome_unknown" });
    await expect(manager.list(signal())).rejects.toMatchObject({ code: "aborted" });
  });

  it("keeps quotes and substitutions in copied commands as inert public data", async () => {
    const publicKey = ssh2.utils.generateKeyPairSync("ed25519", { comment: "O'Brien $(Write-Output injected); & echo" }).public.trim();
    const shell = process.platform === "win32" ? "powershell" : "posix";
    const command = sshKeyInstallCommand(publicKey, { hostname: "example.test", user: "builder", port: 2202 }, shell);
    const script = shell === "powershell"
      ? `function ssh { ConvertTo-Json -Compress -InputObject @($args) }; ${command}`
      : `ssh() { printf '%s\\n' "$@"; }; ${command}`;
    const result = await promisify(execFile)(shell === "powershell" ? "powershell.exe" : "/bin/sh", shell === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-c", script], { windowsHide: true });
    // PowerShell functions consume '--'; native ssh receives it as its option terminator.
    const args = shell === "powershell" ? (JSON.parse(result.stdout) as unknown[]).map(String) : result.stdout.trim().split("\n");
    expect(args.slice(0, shell === "powershell" ? 3 : 4)).toEqual(shell === "powershell" ? ["-p", "2202", "builder@example.test"] : ["-p", "2202", "--", "builder@example.test"]);
    expect(args).toHaveLength(shell === "powershell" ? 4 : 5);
    expect(args.at(-1)).toContain(publicKey.split(" ").slice(0, 2).join(" "));
    expect(args.at(-1)).not.toContain("injected");
    expect(result.stderr).toBe("");
  });
});
