import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
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
async function fixture(agentCommand: SshAgentCommand = async () => ({ code: 2, stdout: "" })) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-ssh-keys-")));
  roots.push(root);
  const directory = join(root, "identity");
  const manager = new SshKeyManager({ directory, agentCommand }); managers.push(manager);
  return { manager, root, directory };
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
  });

  it("preserves public-only collisions, rejects changed pairs and omits hard-linked identities", async () => {
    const { manager, directory } = await fixture();
    await mkdir(directory);
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
  });

  it("rejects linked roots and traversal before opening a key", async () => {
    const { manager, directory, root } = await fixture();
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
  });

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
