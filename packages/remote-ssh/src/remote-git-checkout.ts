import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

import type { RemoteSshExecutionOptions, RemoteSshExecutionResult } from "./types.js";

/** Stable remote ownership. Revisions record acquisition evidence; a reconnect
 * recaptures transport authority and verifies the stable identity again. */
export interface RemoteGitCheckoutAuthority {
  readonly hostOwnerId: string;
  readonly hostTargetId: string;
  readonly hostId: string;
  readonly hostIdentity: string;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly hostRevision: string;
}

export interface RemoteGitCheckoutPlan {
  readonly format: 1;
  readonly leaseId: string;
  readonly manifestId: string;
  readonly sessionId: string;
  readonly sourceSessionId: string;
  readonly workspaceId: string;
  readonly sourceCwd: string;
  readonly sourceLease?: RemoteGitCheckoutLease;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  /** Content-free digest of the exact source HEAD, index, tracked tree and untracked files. */
  readonly sourceSnapshot: string;
  readonly sourceStrategy: "explicit";
  readonly sourceRefreshed: false;
  readonly storageRoot: string;
  readonly authority: RemoteGitCheckoutAuthority;
  /** Directly projects to SessionWorktreeBinding.remote after acquisition. */
  readonly remote: RemoteGitCheckoutAuthority & { readonly manifestId: string };
}

export interface RemoteGitCheckoutLease {
  readonly id: string;
  readonly sessionId: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly source: {
    readonly ref: string;
    readonly commit: string;
    readonly refreshed: false;
    readonly strategy: "explicit";
  };
  readonly acquiredAt: number;
  readonly remote: RemoteGitCheckoutAuthority & { readonly manifestId: string };
}

export type RemoteGitCheckoutInspection =
  | { readonly status: "absent" | "pending" | "released" }
  | { readonly status: "active"; readonly lease: RemoteGitCheckoutLease };

export class RemoteGitCheckoutError extends Error {
  constructor(
    readonly code: "INVALID_ARGUMENT" | "AUTHORITY_CHANGED" | "NOT_GIT_REPOSITORY" | "SOURCE_UNSAFE" | "SOURCE_CHANGED" |
      "LEASE_CONFLICT" | "CHECKOUT_UNSAFE" | "REMOTE_FAILED" | "UNAVAILABLE" | "OUTCOME_UNKNOWN",
    readonly stateMayHaveChanged = false
  ) {
    super("The remote checkout operation could not be completed safely.");
    this.name = "RemoteGitCheckoutError";
  }
}

export interface RemoteGitCheckoutServiceOptions {
  /** Canonical absolute POSIX root owned by this service, separate from source repositories. */
  readonly storageRoot: string;
  /** Exact authenticated SSH execution. The caller captures one transport generation. */
  readonly execute: (options: RemoteSshExecutionOptions) => Promise<RemoteSshExecutionResult>;
  /** Revalidate Target, Host, runtime and SSH generation before and after every effect.
   * Recovery operations recapture a fresh generation and compare stable identity. */
  readonly assertCurrent: (
    authority: RemoteGitCheckoutAuthority,
    operation: "probe" | "derive" | "inspect" | "assert" | "cleanup" | "release"
  ) => Promise<void> | void;
  /** Fixed remote Node executable supplied by the ready runtime setup. */
  readonly nodeExecutable: string;
}

export class RemoteGitCheckoutService {
  readonly #storageRoot: string;
  readonly #execute: RemoteGitCheckoutServiceOptions["execute"];
  readonly #assertCurrent: RemoteGitCheckoutServiceOptions["assertCurrent"];
  readonly #nodeExecutable: string;

  constructor(options: RemoteGitCheckoutServiceOptions) {
    this.#storageRoot = posixAbsolute(options.storageRoot, "storageRoot");
    this.#nodeExecutable = posixAbsolute(options.nodeExecutable, "nodeExecutable");
    if (typeof options.execute !== "function" || typeof options.assertCurrent !== "function") {
      throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
    }
    this.#execute = options.execute;
    this.#assertCurrent = options.assertCurrent;
  }

  /** A read-only remote Git probe fixes the complete source snapshot and repository identity.
   * Persist the returned plan before derive changes any remote checkout. */
  async plan(input: {
    readonly sessionId: string;
    readonly sourceSessionId: string;
    readonly workspaceId: string;
    readonly sourceCwd: string;
    readonly sourceLease?: RemoteGitCheckoutLease;
    readonly authority: RemoteGitCheckoutAuthority;
  }, signal?: AbortSignal): Promise<RemoteGitCheckoutPlan> {
    const sessionId = identifier(input.sessionId);
    const sourceSessionId = identifier(input.sourceSessionId);
    const workspaceId = identifier(input.workspaceId);
    if (sessionId === sourceSessionId) throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
    const sourceCwd = posixAbsolute(input.sourceCwd, "sourceCwd");
    const authority = validateAuthority(input.authority);
    if (input.sourceLease !== undefined) {
      validateLease(input.sourceLease);
      if (input.sourceLease.sessionId !== sourceSessionId || input.sourceLease.path !== sourceCwd ||
        !sameStableAuthority(input.sourceLease.remote, authority)) {
        throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
      }
    }
    const probe = await this.#invoke("probe", { authority, sourceCwd, sourceLease: input.sourceLease }, false, signal);
    if (probe.status !== "source" || typeof probe.repositoryRoot !== "string" ||
      typeof probe.sourceCommit !== "string" || !/^[a-f0-9]{40,64}$/u.test(probe.sourceCommit) ||
      typeof probe.sourceSnapshot !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(probe.sourceSnapshot)) {
      throw new RemoteGitCheckoutError("REMOTE_FAILED");
    }
    const repositoryRoot = posixAbsolute(probe.repositoryRoot, "repositoryRoot");
    const leaseId = randomUUID();
    const manifestId = randomUUID();
    const branch = `joko/remote-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}-${leaseId.slice(0, 8)}`;
    return Object.freeze({
      format: 1,
      leaseId,
      manifestId,
      sessionId,
      sourceSessionId,
      workspaceId,
      sourceCwd,
      ...(input.sourceLease === undefined ? {} : { sourceLease: input.sourceLease }),
      path: posix.join(this.#storageRoot, "checkouts", leaseId),
      repositoryRoot,
      branch,
      sourceRef: probe.sourceCommit,
      sourceCommit: probe.sourceCommit,
      sourceSnapshot: probe.sourceSnapshot,
      sourceStrategy: "explicit",
      sourceRefreshed: false,
      storageRoot: this.#storageRoot,
      authority,
      remote: { ...authority, manifestId }
    });
  }

  async derive(plan: RemoteGitCheckoutPlan, signal?: AbortSignal): Promise<RemoteGitCheckoutLease> {
    this.#validatePlan(plan);
    const response = await this.#invoke("derive", plan, true, signal);
    if (response.status !== "active" || response.lease === undefined) {
      throw new RemoteGitCheckoutError("OUTCOME_UNKNOWN", true);
    }
    const lease = validateLease(response.lease);
    this.#assertLeaseMatchesPlan(lease, plan);
    return lease;
  }

  async inspectExact(plan: RemoteGitCheckoutPlan, signal?: AbortSignal): Promise<RemoteGitCheckoutInspection> {
    this.#validatePlan(plan);
    const response = await this.#invoke("inspect", plan, false, signal);
    if (response.status === "active" && response.lease !== undefined) {
      const lease = validateLease(response.lease);
      this.#assertLeaseMatchesPlan(lease, plan);
      return { status: "active", lease };
    }
    if (response.status === "absent" || response.status === "pending" || response.status === "released") {
      return { status: response.status };
    }
    throw new RemoteGitCheckoutError("REMOTE_FAILED");
  }

  async assertExact(lease: RemoteGitCheckoutLease, signal?: AbortSignal): Promise<void> {
    validateLease(lease);
    const response = await this.#invoke("assert", lease, false, signal);
    if (response.status !== "active" || response.lease === undefined ||
      !sameLease(lease, validateLease(response.lease))) {
      throw new RemoteGitCheckoutError("LEASE_CONFLICT");
    }
  }

  /** Retire only an unadopted preparing manifest. Dirty or ambiguous state is retained. */
  async cleanupPending(plan: RemoteGitCheckoutPlan, signal?: AbortSignal): Promise<"absent" | "released" | "preserved"> {
    this.#validatePlan(plan);
    const response = await this.#invoke("cleanup", plan, true, signal);
    if (response.status === "absent" || response.status === "released" || response.status === "preserved") {
      return response.status;
    }
    throw new RemoteGitCheckoutError("OUTCOME_UNKNOWN", true);
  }

  /** A dirty or uncertain checkout retains its exact lease and branch. */
  async releaseExact(lease: RemoteGitCheckoutLease, signal?: AbortSignal): Promise<"released" | "preserved"> {
    validateLease(lease);
    const response = await this.#invoke("release", lease, true, signal);
    if (response.status === "released" || response.status === "preserved") return response.status;
    throw new RemoteGitCheckoutError("OUTCOME_UNKNOWN", true);
  }

  #validatePlan(plan: RemoteGitCheckoutPlan): void {
    if (plan?.format !== 1 || !isUuid(plan.leaseId) || !isUuid(plan.manifestId) ||
      identifier(plan.sessionId) === identifier(plan.sourceSessionId) || !identifier(plan.workspaceId) ||
      posixAbsolute(plan.sourceCwd, "sourceCwd") !== plan.sourceCwd ||
      posixAbsolute(plan.repositoryRoot, "repositoryRoot") !== plan.repositoryRoot ||
      plan.sourceRef !== plan.sourceCommit || plan.sourceStrategy !== "explicit" ||
      plan.sourceRefreshed !== false || !/^[a-f0-9]{40,64}$/u.test(plan.sourceCommit) ||
      !/^sha256:[a-f0-9]{64}$/u.test(plan.sourceSnapshot) ||
      posixAbsolute(plan.storageRoot, "storageRoot") !== this.#storageRoot ||
      plan.path !== posix.join(this.#storageRoot, "checkouts", plan.leaseId) ||
      plan.branch !== `joko/remote-${createHash("sha256").update(plan.sessionId).digest("hex").slice(0, 12)}-${plan.leaseId.slice(0, 8)}`) {
      throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
    }
    validateAuthority(plan.authority);
    if (plan.remote?.manifestId !== plan.manifestId ||
      !sameStableAuthority(plan.remote, plan.authority) ||
      plan.remote.targetRevision !== plan.authority.targetRevision ||
      plan.remote.hostRevision !== plan.authority.hostRevision) {
      throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
    }
    if (plan.sourceLease !== undefined) {
      validateLease(plan.sourceLease);
      if (plan.sourceLease.path !== plan.sourceCwd ||
        plan.sourceLease.sessionId !== plan.sourceSessionId ||
        !sameStableAuthority(plan.sourceLease.remote, plan.authority)) {
        throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
      }
    }
  }

  #assertLeaseMatchesPlan(lease: RemoteGitCheckoutLease, plan: RemoteGitCheckoutPlan): void {
    if (lease.id !== plan.leaseId || lease.sessionId !== plan.sessionId ||
      lease.path !== plan.path || lease.branch !== plan.branch ||
      lease.repositoryRoot !== plan.repositoryRoot || lease.source.commit !== plan.sourceCommit ||
      lease.remote.manifestId !== plan.manifestId ||
      lease.remote.targetRevision !== plan.remote.targetRevision ||
      lease.remote.hostRevision !== plan.remote.hostRevision ||
      !sameStableAuthority(lease.remote, plan.authority)) {
      throw new RemoteGitCheckoutError("LEASE_CONFLICT");
    }
  }

  async #invoke(
    operation: "probe" | "derive" | "inspect" | "assert" | "cleanup" | "release",
    data: RemoteGitCheckoutPlan | RemoteGitCheckoutLease | {
      readonly authority: RemoteGitCheckoutAuthority;
      readonly sourceCwd: string;
      readonly sourceLease?: RemoteGitCheckoutLease;
    },
    mutating: boolean,
    signal?: AbortSignal
  ): Promise<RemoteResponse> {
    const authority = "authority" in data ? data.authority : data.remote;
    try {
      await this.#assertCurrent(authority, operation);
    } catch {
      throw new RemoteGitCheckoutError("AUTHORITY_CHANGED");
    }
    let result: RemoteSshExecutionResult;
    try {
      result = await this.#execute({
        command: `${shellQuote(this.#nodeExecutable)} -e ${shellQuote(REMOTE_HELPER)}`,
        input: JSON.stringify({ operation, data, storageRoot: this.#storageRoot }),
        timeoutMs: 120_000,
        ...(signal === undefined ? {} : { signal })
      });
    } catch {
      throw new RemoteGitCheckoutError(mutating ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", mutating);
    }
    try {
      await this.#assertCurrent(authority, operation);
    } catch {
      throw new RemoteGitCheckoutError(mutating ? "OUTCOME_UNKNOWN" : "AUTHORITY_CHANGED", mutating);
    }
    if (result.exitCode !== 0 || result.outputCapped || result.signal !== undefined ||
      Buffer.byteLength(result.stdout, "utf8") > 64_000) {
      throw new RemoteGitCheckoutError(mutating ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", mutating);
    }
    let response: RemoteResponse;
    try { response = JSON.parse(result.stdout) as RemoteResponse; }
    catch { throw new RemoteGitCheckoutError(mutating ? "OUTCOME_UNKNOWN" : "REMOTE_FAILED", mutating); }
    if (response?.format !== 1 || typeof response.status !== "string") {
      throw new RemoteGitCheckoutError(mutating ? "OUTCOME_UNKNOWN" : "REMOTE_FAILED", mutating);
    }
    if (response.status === "error") {
      throw new RemoteGitCheckoutError(remoteErrorCode(response.code), response.stateMayHaveChanged === true);
    }
    return response;
  }
}

interface RemoteResponse {
  readonly format: 1;
  readonly status: string;
  readonly lease?: RemoteGitCheckoutLease;
  readonly code?: string;
  readonly stateMayHaveChanged?: boolean;
  readonly repositoryRoot?: string;
  readonly sourceCommit?: string;
  readonly sourceSnapshot?: string;
}

function identifier(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
  return value;
}

function posixAbsolute(value: string, _name: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 4_096 ||
    !value.startsWith("/") || value.includes("\0") || /[\r\n]/u.test(value) ||
    posix.normalize(value) !== value || value === "/") throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
  return value;
}

function validateAuthority(value: RemoteGitCheckoutAuthority): RemoteGitCheckoutAuthority {
  if (value === null || typeof value !== "object") throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
  for (const field of ["hostOwnerId", "hostTargetId", "hostId", "hostIdentity", "targetId"] as const) identifier(value[field]);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.hostIdentity) ||
    typeof value.targetRevision !== "string" || !/^[1-9][0-9]*$/u.test(value.targetRevision) ||
    typeof value.hostRevision !== "string" || !/^[1-9][0-9]*$/u.test(value.hostRevision)) {
    throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
  }
  return value;
}

function validateLease(value: RemoteGitCheckoutLease): RemoteGitCheckoutLease {
  if (value === null || typeof value !== "object" || !isUuid(value.id) ||
    !isUuid(value.remote?.manifestId) || typeof value.sessionId !== "string" ||
    posixAbsolute(value.path, "path") !== value.path ||
    posixAbsolute(value.repositoryRoot, "repositoryRoot") !== value.repositoryRoot ||
    typeof value.branch !== "string" || !/^joko\/remote-[a-f0-9]{12}-[a-f0-9]{8}$/u.test(value.branch) ||
    value.source?.strategy !== "explicit" || value.source.refreshed !== false ||
    !/^[a-f0-9]{40,64}$/u.test(value.source.commit) || value.source.ref !== value.source.commit ||
    !Number.isSafeInteger(value.acquiredAt) || value.acquiredAt < 0) throw new RemoteGitCheckoutError("INVALID_ARGUMENT");
  identifier(value.sessionId);
  validateAuthority(value.remote);
  return value;
}

function sameStableAuthority(left: RemoteGitCheckoutAuthority, right: RemoteGitCheckoutAuthority): boolean {
  return left.hostOwnerId === right.hostOwnerId && left.hostTargetId === right.hostTargetId &&
    left.hostId === right.hostId && left.hostIdentity === right.hostIdentity && left.targetId === right.targetId;
}

function sameLease(left: RemoteGitCheckoutLease, right: RemoteGitCheckoutLease): boolean {
  return left.id === right.id && left.sessionId === right.sessionId &&
    left.path === right.path && left.repositoryRoot === right.repositoryRoot &&
    left.branch === right.branch && left.source.ref === right.source.ref &&
    left.source.commit === right.source.commit && left.source.refreshed === right.source.refreshed &&
    left.source.strategy === right.source.strategy && left.acquiredAt === right.acquiredAt &&
    left.remote.manifestId === right.remote.manifestId &&
    sameStableAuthority(left.remote, right.remote) &&
    left.remote.targetRevision === right.remote.targetRevision &&
    left.remote.hostRevision === right.remote.hostRevision;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function remoteErrorCode(value: unknown): RemoteGitCheckoutError["code"] {
  if (value === "NOT_GIT_REPOSITORY" || value === "SOURCE_UNSAFE" || value === "SOURCE_CHANGED" || value === "LEASE_CONFLICT" ||
    value === "CHECKOUT_UNSAFE" || value === "AUTHORITY_CHANGED" || value === "OUTCOME_UNKNOWN") return value;
  return "REMOTE_FAILED";
}

/** Runs only on the authenticated POSIX host. All untrusted values arrive as
 * JSON on stdin, never as shell fragments or Git options. */
const REMOTE_HELPER = String.raw`
const fs = require('node:fs');
const path = require('node:path').posix;
const crypto = require('node:crypto');
const cp = require('node:child_process');
const read = () => fs.readFileSync(0, 'utf8');
const respond = (value) => process.stdout.write(JSON.stringify({format:1,...value}));
class Stop extends Error { constructor(code, changed=false) { super(code); this.code=code; this.changed=changed; } }
const fail = (code, changed=false) => { throw new Stop(code,changed); };
const ordinary = (p) => { try { const s=fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || fs.realpathSync(p)!==p) fail('CHECKOUT_UNSAFE'); } catch(e) { if(e instanceof Stop) throw e; fail('CHECKOUT_UNSAFE'); } };
const inside = (root,p) => p.startsWith(root+'/');
const absolute = (p) => typeof p==='string' && p.length>1 && p.length<=4096 && p[0]==='/' && path.normalize(p)===p && !p.includes('\0');
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const utf8 = (v) => { try { return new TextDecoder('utf-8',{fatal:true}).decode(v); } catch { fail('SOURCE_UNSAFE'); } };
const gitEnv = {PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'/',LC_ALL:'C',
  GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GIT_OPTIONAL_LOCKS:'0',
  GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'false',
  GIT_CONFIG_KEY_1:'core.untrackedCache',GIT_CONFIG_VALUE_1:'false',
  GIT_AUTHOR_NAME:'Joko Workspace',GIT_AUTHOR_EMAIL:'workspace@invalid.example',
  GIT_COMMITTER_NAME:'Joko Workspace',GIT_COMMITTER_EMAIL:'workspace@invalid.example'};
function git(cwd,args,options={}) {
  const result=cp.spawnSync('git',args,{cwd,encoding:'buffer',maxBuffer:16*1024*1024,timeout:30000,
    env:{...gitEnv,...options.env}});
  if(result.error || result.status!==0 || result.signal) fail(options.code||'REMOTE_FAILED',options.changed===true);
  return result.stdout;
}
const out=(cwd,args,opts) => git(cwd,args,opts).toString('utf8').trim();
function optional(cwd,args) { const r=cp.spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:gitEnv}); return r.status===0?r.stdout.trim():undefined; }
const oid=(v) => typeof v==='string' && /^[a-f0-9]{40,64}$/.test(v);
function metadata(cwd) {
  ordinary(cwd);
  const probe=cp.spawnSync('git',['rev-parse','--show-toplevel'],{cwd,encoding:'utf8',timeout:30000,
    maxBuffer:1024*1024,env:gitEnv});
  if(probe.error||probe.signal) fail('REMOTE_FAILED');
  if(probe.status!==0) {
    let at=cwd, found=false;
    while(true) {
      if(fs.existsSync(path.join(at,'.git'))) { found=true; break; }
      if(at==='/') break;
      at=path.dirname(at);
    }
    fail(found?'SOURCE_UNSAFE':'NOT_GIT_REPOSITORY');
  }
  const root=probe.stdout.trim();
  const common=fs.realpathSync(path.resolve(cwd,out(cwd,['rev-parse','--git-common-dir'])));
  const dir=fs.realpathSync(path.resolve(cwd,out(cwd,['rev-parse','--git-dir'])));
  const commonStat=fs.statSync(common,{bigint:true}),dirStat=fs.statSync(dir,{bigint:true});
  if(!commonStat.isDirectory()||!dirStat.isDirectory()) fail('SOURCE_UNSAFE');
  const head=out(cwd,['rev-parse','--verify','HEAD^{commit}']);
  if(!absolute(root)||!oid(head)||(!inside(root,cwd)&&cwd!==root)) fail('SOURCE_UNSAFE');
  ordinary(root);
  return {root,common,dir,commonDev:String(commonStat.dev),commonIno:String(commonStat.ino),
    dirDev:String(dirStat.dev),dirIno:String(dirStat.ino),head,branch:optional(cwd,['symbolic-ref','--quiet','--short','HEAD'])};
}
function filePaths(cwd) {
  const tracked=utf8(git(cwd,['ls-files','-v','-z'])).split('\0');
  if(tracked.some(v=>v.length>2 && v[1]===' ' && (v[0]==='S'||v[0]!==v[0].toUpperCase()))) fail('SOURCE_UNSAFE');
  const stages=utf8(git(cwd,['ls-files','--stage','-z'])).split('\0');
  if(stages.some(v=>{
    if(!v) return false;
    const row=/^(100644|100755|120000) ([a-f0-9]{40,64}) 0\t/.exec(v);
    return !row||/^0+$/.test(row[2]);
  })) fail('SOURCE_UNSAFE');
  const status=utf8(git(cwd,['status','--porcelain=v2','-z','--untracked-files=all','--ignored=matching'])).split('\0');
  if(status.some(v=>v.startsWith('! ')||v.startsWith('u ')||((v.startsWith('1 ')||v.startsWith('2 '))&&v.split(' ')[2]?.startsWith('S')))) fail('SOURCE_UNSAFE');
  const names=utf8(git(cwd,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  if(names.length>10000) fail('SOURCE_UNSAFE');
  let totalBytes=0;
  return names.map(name=>{
    if(name[0]==='/'||name.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')) fail('SOURCE_UNSAFE');
    let p=cwd;
    const parts=name.split('/');
    for(const part of parts.slice(0,-1)) { p=path.join(p,part); const s=fs.lstatSync(p); if(!s.isDirectory()||s.isSymbolicLink()) fail('SOURCE_UNSAFE'); }
    p=path.join(p,parts.at(-1)); const s=fs.lstatSync(p);
    if(!s.isFile()||s.isSymbolicLink()||s.size>64*1024*1024) fail('SOURCE_UNSAFE');
    totalBytes+=s.size; if(totalBytes>512*1024*1024) fail('SOURCE_UNSAFE');
    let fd;
    try { fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); } catch { fail('SOURCE_CHANGED'); }
    try {
      const opened=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.lstatSync(p);
      if(!opened.isFile()||opened.dev!==s.dev||opened.ino!==s.ino||after.ino!==s.ino||after.dev!==s.dev||
        opened.size!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||
        (after.mode&0o777)!==(s.mode&0o777)) fail('SOURCE_CHANGED');
      return {name,mode:s.mode&0o777,size:s.size,sha:hash(bytes)};
    } finally { fs.closeSync(fd); }
  });
}
function snapshotTracked(root,name) {
  if(!name||name[0]==='/'||name.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')) fail('SOURCE_UNSAFE');
  let at=root;
  for(const part of name.split('/').slice(0,-1)) {
    at=path.join(at,part);
    let parent;
    try { parent=fs.lstatSync(at); } catch(e) { if(e.code==='ENOENT') return {name,kind:'missing'}; fail('SOURCE_CHANGED'); }
    if(!parent.isDirectory()||parent.isSymbolicLink()) fail('SOURCE_UNSAFE');
  }
  const p=path.join(root,name);
  let before;
  try { before=fs.lstatSync(p); } catch(e) { if(e.code==='ENOENT') return {name,kind:'missing'}; fail('SOURCE_CHANGED'); }
  if(before.isSymbolicLink()) {
    let link,after;
    try { link=fs.readlinkSync(p,{encoding:'buffer'}); after=fs.lstatSync(p); } catch { fail('SOURCE_CHANGED'); }
    if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs) fail('SOURCE_CHANGED');
    return {name,kind:'symlink',size:before.size,sha:hash(link)};
  }
  if(!before.isFile()||before.size>64*1024*1024) fail('SOURCE_UNSAFE');
  let fd;
  try { fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); } catch { fail('SOURCE_CHANGED'); }
  try {
    const opened=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.lstatSync(p);
    if(opened.dev!==before.dev||opened.ino!==before.ino||after.dev!==before.dev||after.ino!==before.ino||
      opened.size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||
      (after.mode&0o777)!==(before.mode&0o777)) fail('SOURCE_CHANGED');
    return {name,kind:'file',mode:before.mode&0o777,size:before.size,sha:hash(bytes)};
  } finally { fs.closeSync(fd); }
}
function sourceSnapshot(meta) {
  const h=crypto.createHash('sha256');
  const feed=(tag,value) => {
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value),'utf8');
    h.update(tag+'\0'+bytes.length+'\0'); h.update(bytes);
  };
  feed('version',1);
  feed('repository',{root:meta.root,common:meta.common,dir:meta.dir,commonDev:meta.commonDev,
    commonIno:meta.commonIno,dirDev:meta.dirDev,dirIno:meta.dirIno,head:meta.head,branch:meta.branch});
  const index=git(meta.root,['ls-files','--stage','-z']);
  const flags=git(meta.root,['ls-files','-v','-z']);
  const names=utf8(git(meta.root,['ls-files','--cached','-z'])).split('\0').filter(Boolean);
  if(new Set(names).size!==names.length) fail('SOURCE_UNSAFE');
  feed('index',index); feed('flags',flags);
  for(const name of names) feed('tracked',snapshotTracked(meta.root,name));
  for(const file of filePaths(meta.root)) feed('untracked',file);
  return 'sha256:'+h.digest('hex');
}
function capture(cwd) {
  const meta=metadata(cwd); const untracked=filePaths(meta.root);
  const stash=out(meta.root,['stash','create','joko-remote-checkout']);
  if(stash && !oid(stash)) fail('SOURCE_UNSAFE');
  const worktreeTree=stash?out(meta.root,['rev-parse',stash+'^{tree}']):out(meta.root,['rev-parse','HEAD^{tree}']);
  const indexTree=stash?out(meta.root,['rev-parse',stash+'^2^{tree}']):out(meta.root,['write-tree']);
  if(!oid(worktreeTree)||!oid(indexTree)) fail('SOURCE_UNSAFE');
  return {...meta,stash,worktreeTree,indexTree,untracked};
}
function equalCapture(a,b) {
  return a.root===b.root&&a.common===b.common&&a.dir===b.dir&&a.commonDev===b.commonDev&&
    a.commonIno===b.commonIno&&a.dirDev===b.dirDev&&a.dirIno===b.dirIno&&a.head===b.head&&a.branch===b.branch&&
    a.worktreeTree===b.worktreeTree&&a.indexTree===b.indexTree&&JSON.stringify(a.untracked)===JSON.stringify(b.untracked);
}
function manifestPath(root,id) { return path.join(root,'leases',id+'.json'); }
function readManifest(root,id) {
  if(!fs.existsSync(root)) return undefined;
  ordinary(root);
  if(!fs.existsSync(path.join(root,'leases'))) return undefined;
  ordinary(path.join(root,'leases'));
  const p=manifestPath(root,id); if(!fs.existsSync(p)) return undefined;
  const s=fs.lstatSync(p); if(!s.isFile()||s.isSymbolicLink()||s.size>65536) fail('LEASE_CONFLICT');
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch { fail('LEASE_CONFLICT'); }
}
function saveManifest(root,m,exclusive=false) {
  const p=manifestPath(root,m.plan.leaseId);
  if(exclusive && fs.existsSync(p)) fail('LEASE_CONFLICT');
  if(!exclusive) {
    const previous=readManifest(root,m.plan.leaseId);
    if(!previous||!samePlan(previous.plan,m.plan)||!
      ((previous.phase==='preparing'&&['active','cleaning','released'].includes(m.phase))||
       (previous.phase==='active'&&m.phase==='releasing')||
       (previous.phase==='releasing'&&['active','released'].includes(m.phase))||
       (previous.phase==='cleaning'&&['cleaning','released'].includes(m.phase)))) fail('LEASE_CONFLICT');
  }
  const tmp=p+'.'+crypto.randomUUID()+'.tmp';
  const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
  try { fs.writeFileSync(fd,JSON.stringify(m)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if(exclusive) { fs.linkSync(tmp,p); fs.unlinkSync(tmp); }
    else fs.renameSync(tmp,p);
    const dir=fs.openSync(path.dirname(p),'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if(fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function sameOwner(a,b) {
  return a.hostOwnerId===b.hostOwnerId&&a.hostTargetId===b.hostTargetId&&a.hostId===b.hostId&&
    a.hostIdentity===b.hostIdentity&&a.targetId===b.targetId;
}
function samePlan(a,b) { return a.leaseId===b.leaseId&&a.manifestId===b.manifestId&&a.sessionId===b.sessionId&&
  a.sourceSessionId===b.sourceSessionId&&a.workspaceId===b.workspaceId&&a.sourceCwd===b.sourceCwd&&
  a.path===b.path&&a.repositoryRoot===b.repositoryRoot&&a.branch===b.branch&&
  a.sourceRef===b.sourceRef&&a.sourceCommit===b.sourceCommit&&a.sourceStrategy===b.sourceStrategy&&
  a.sourceRefreshed===b.sourceRefreshed&&a.sourceSnapshot===b.sourceSnapshot&&
  a.storageRoot===b.storageRoot&&sameOwner(a.authority,b.authority)&&
  a.authority.targetRevision===b.authority.targetRevision&&a.authority.hostRevision===b.authority.hostRevision&&
  ((!a.sourceLease&&!b.sourceLease)||(a.sourceLease&&b.sourceLease&&sameLease(a.sourceLease,b.sourceLease))); }
function sameLease(a,b) { return a.id===b.id&&a.sessionId===b.sessionId&&a.path===b.path&&
  a.repositoryRoot===b.repositoryRoot&&a.branch===b.branch&&a.source.ref===b.source.ref&&
  a.source.commit===b.source.commit&&a.source.refreshed===b.source.refreshed&&
  a.source.strategy===b.source.strategy&&a.acquiredAt===b.acquiredAt&&
  a.remote.manifestId===b.remote.manifestId&&sameOwner(a.remote,b.remote)&&
  a.remote.targetRevision===b.remote.targetRevision&&a.remote.hostRevision===b.remote.hostRevision; }
function checkLayout(root,p) {
  if(!absolute(root)||!absolute(p)||!inside(path.join(root,'checkouts'),p)||path.dirname(p)!==path.join(root,'checkouts')) fail('CHECKOUT_UNSAFE');
  ordinary(root); ordinary(path.join(root,'checkouts')); ordinary(path.join(root,'leases'));
}
function verifyActive(root,m) {
  if((m.phase!=='active'&&m.phase!=='releasing')||!m.lease) fail('LEASE_CONFLICT');
  const l=m.lease; checkLayout(root,l.path); ordinary(l.path);
  const meta=metadata(l.path); const source=metadata(l.repositoryRoot);
  if(meta.root!==l.path||meta.dir===meta.common||meta.common!==source.common||source.dir!==source.common||
    source.root!==l.repositoryRoot||meta.branch!==l.branch||
    source.common!==m.repositoryCommon||source.commonDev!==m.repositoryCommonDev||
    source.commonIno!==m.repositoryCommonIno||meta.dir!==m.checkoutGitDirectory||
    meta.dirDev!==m.checkoutGitDevice||meta.dirIno!==m.checkoutGitInode) fail('LEASE_CONFLICT');
  if(!sameOwner(l.remote,m.plan.authority)||l.remote.manifestId!==m.plan.manifestId||
    l.id!==m.plan.leaseId||l.path!==m.plan.path||l.branch!==m.plan.branch||l.sessionId!==m.plan.sessionId) fail('LEASE_CONFLICT');
  return l;
}
function ensureRoot(root) {
  if(!absolute(root)) fail('CHECKOUT_UNSAFE');
  let at='/';
  for(const segment of root.slice(1).split('/')) {
    at=path.join(at,segment);
    if(!fs.existsSync(at)) {
      fs.mkdirSync(at,{mode:0o700});
      const parent=fs.openSync(path.dirname(at),'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
    ordinary(at);
  }
  for(const part of ['checkouts','leases']) {
    const dir=path.join(root,part);
    if(!fs.existsSync(dir)) {
      fs.mkdirSync(dir,{mode:0o700});
      const parent=fs.openSync(root,'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
    ordinary(dir);
  }
}
function ensureChildParent(root,name) {
  let at=root;
  for(const part of name.split('/').slice(0,-1)) {
    at=path.join(at,part);
    if(!fs.existsSync(at)) fs.mkdirSync(at,{mode:0o700});
    ordinary(at);
  }
}
function readExactUntracked(root,file) {
  let at=root;
  for(const part of file.name.split('/').slice(0,-1)) { at=path.join(at,part); ordinary(at); }
  const p=path.join(root,file.name), before=fs.lstatSync(p);
  if(!before.isFile()||before.isSymbolicLink()||before.size!==file.size||
    (before.mode&0o777)!==file.mode) fail('SOURCE_CHANGED',true);
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const opened=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.lstatSync(p);
    if(opened.dev!==before.dev||opened.ino!==before.ino||after.dev!==before.dev||after.ino!==before.ino||
      opened.size!==file.size||after.size!==file.size||hash(bytes)!==file.sha) fail('SOURCE_CHANGED',true);
    return bytes;
  } finally { fs.closeSync(fd); }
}
function probeSource(input,root) {
  const current=metadata(input.sourceCwd);
  if(input.sourceLease) {
    const prior=readManifest(root,input.sourceLease.id);
    if(!prior||prior.phase!=='active'||JSON.stringify(verifyActive(root,prior))!==JSON.stringify(input.sourceLease)||
      current.root!==input.sourceLease.path||current.dir===current.common||current.branch!==input.sourceLease.branch) fail('SOURCE_CHANGED');
  } else if(current.dir!==current.common) fail('SOURCE_UNSAFE');
  if(root===current.root||inside(root,current.root)||inside(current.root,root)) fail('SOURCE_UNSAFE');
  return current;
}
function prepareSource(plan,root) {
  const current=probeSource(plan,root);
  if(current.root!==plan.repositoryRoot||current.head!==plan.sourceCommit||plan.sourceRef!==current.head) fail('SOURCE_CHANGED');
  if(sourceSnapshot(current)!==plan.sourceSnapshot) fail('SOURCE_CHANGED');
  return capture(current.root);
}
function registered(root,checkout) {
  const listing=out(root,['worktree','list','--porcelain']).split('\n');
  return listing.some(line=>line==='worktree '+checkout);
}
function branchPresent(root,branch) {
  const result=cp.spawnSync('git',['show-ref','--verify','--quiet','refs/heads/'+branch],{
    cwd:root,encoding:'buffer',timeout:30000,maxBuffer:1024*1024,env:gitEnv});
  if(result.error||result.signal||(result.status!==0&&result.status!==1)) fail('CHECKOUT_UNSAFE');
  return result.status===0;
}
function orphaned(plan) {
  if(fs.existsSync(plan.path)) return true;
  return branchPresent(plan.repositoryRoot,plan.branch);
}
function derive(root,plan) {
  if(readManifest(root,plan.leaseId)) fail('LEASE_CONFLICT');
  if(orphaned(plan)) fail('LEASE_CONFLICT');
  const source=prepareSource(plan,root);
  if(!equalCapture(source,capture(source.root))) fail('SOURCE_CHANGED');
  if(sourceSnapshot(probeSource(plan,root))!==plan.sourceSnapshot) fail('SOURCE_CHANGED');
  ensureRoot(root);
  const record={format:1,phase:'preparing',plan,sourceHead:source.head,repositoryRoot:source.root,
    repositoryCommon:source.common,repositoryCommonDev:source.commonDev,repositoryCommonIno:source.commonIno};
  saveManifest(root,record,true);
  git(source.root,['worktree','add','-b',plan.branch,plan.path,source.head],{changed:true});
  if(source.stash) git(plan.path,['stash','apply','--index',source.stash],{changed:true});
  for(const file of source.untracked) {
    const to=path.join(plan.path,file.name);
    const bytes=readExactUntracked(source.root,file);
    ensureChildParent(plan.path,file.name);
    if(fs.existsSync(to)) fail('CHECKOUT_UNSAFE',true);
    const fd=fs.openSync(to,'wx',file.mode);
    try { fs.writeFileSync(fd,bytes); fs.fchmodSync(fd,file.mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  if(!equalCapture(source,capture(source.root))) fail('SOURCE_CHANGED',true);
  if(sourceSnapshot(probeSource(plan,root))!==plan.sourceSnapshot) fail('SOURCE_CHANGED',true);
  const made=capture(plan.path);
  if(made.head!==source.head||made.worktreeTree!==source.worktreeTree||made.indexTree!==source.indexTree||
    JSON.stringify(made.untracked)!==JSON.stringify(source.untracked)||made.branch!==plan.branch) fail('SOURCE_CHANGED',true);
  const lease={id:plan.leaseId,sessionId:plan.sessionId,path:plan.path,repositoryRoot:source.root,branch:plan.branch,
    source:{ref:source.head,commit:source.head,refreshed:false,strategy:'explicit'},acquiredAt:Date.now(),
    remote:{...plan.authority,manifestId:plan.manifestId}};
  saveManifest(root,{...record,phase:'active',lease,checkoutGitDirectory:made.dir,
    checkoutGitDevice:made.dirDev,checkoutGitInode:made.dirIno});
  return lease;
}
function cleanup(root,plan) {
  const m=readManifest(root,plan.leaseId);
  if(!m) { if(orphaned(plan)) fail('LEASE_CONFLICT'); return 'absent'; }
  if(!samePlan(m.plan,plan)) fail('LEASE_CONFLICT');
  if(m.phase==='released') return 'released';
  if((m.phase!=='preparing'&&m.phase!=='cleaning')||m.lease) fail('LEASE_CONFLICT');
  if(!fs.existsSync(plan.path)) {
    if(registered(m.repositoryRoot,plan.path)) fail('OUTCOME_UNKNOWN',true);
    saveManifest(root,{...m,phase:'released'}); return 'released';
  }
  checkLayout(root,plan.path); ordinary(plan.path);
  const meta=metadata(plan.path), source=metadata(m.repositoryRoot);
  if(meta.root!==plan.path||meta.dir===meta.common||meta.common!==source.common||
    source.root!==m.repositoryRoot||meta.branch!==plan.branch||meta.head!==m.sourceHead||
    source.common!==m.repositoryCommon||source.commonDev!==m.repositoryCommonDev||
    source.commonIno!==m.repositoryCommonIno) return 'preserved';
  const state=git(plan.path,['status','--porcelain=v2','-z','--untracked-files=all','--ignored=matching']).toString('utf8');
  if(state.length>0) return 'preserved';
  saveManifest(root,{...m,phase:'cleaning'});
  git(m.repositoryRoot,['worktree','remove',plan.path],{changed:true});
  if(fs.existsSync(plan.path)||registered(m.repositoryRoot,plan.path)) fail('OUTCOME_UNKNOWN',true);
  saveManifest(root,{...m,phase:'released'}); return 'released';
}
function release(root,lease) {
  const m=readManifest(root,lease.id);
  if(!m||!m.lease||!sameLease(m.lease,lease)) fail('LEASE_CONFLICT');
  if(m.phase==='released') return 'released';
  if(m.phase==='releasing'&&!fs.existsSync(lease.path)) {
    if(registered(lease.repositoryRoot,lease.path)) fail('OUTCOME_UNKNOWN',true);
    saveManifest(root,{...m,phase:'released'}); return 'released';
  }
  verifyActive(root,m);
  const state=git(lease.path,['status','--porcelain=v2','-z','--untracked-files=all','--ignored=matching']).toString('utf8');
  if(state.length>0) { if(m.phase==='releasing') saveManifest(root,{...m,phase:'active'}); return 'preserved'; }
  saveManifest(root,{...m,phase:'releasing'});
  git(lease.repositoryRoot,['worktree','remove',lease.path],{changed:true});
  if(fs.existsSync(lease.path)||registered(lease.repositoryRoot,lease.path)) fail('OUTCOME_UNKNOWN',true);
  saveManifest(root,{...m,phase:'released'});
  return 'released';
}
try {
  const request=JSON.parse(read()); const root=request.storageRoot;
  if(!absolute(root)) fail('CHECKOUT_UNSAFE');
  if(request.operation==='probe') {
    const source=probeSource(request.data,root);
    const snapshot=sourceSnapshot(source);
    const repeated=probeSource(request.data,root);
    if(sourceSnapshot(repeated)!==snapshot) fail('SOURCE_CHANGED');
    respond({status:'source',repositoryRoot:repeated.root,sourceCommit:repeated.head,sourceSnapshot:snapshot});
  } else if(request.operation==='derive') {
    const plan=request.data;
    if(plan.storageRoot!==root||plan.path!==path.join(root,'checkouts',plan.leaseId)) fail('CHECKOUT_UNSAFE');
    respond({status:'active',lease:derive(root,plan)});
  } else if(request.operation==='inspect') {
    if(fs.existsSync(root)) ordinary(root);
    const plan=request.data; const m=readManifest(root,plan.leaseId);
    if(!m) { if(orphaned(plan)) fail('LEASE_CONFLICT'); respond({status:'absent'}); }
    else if(!samePlan(m.plan,plan)) fail('LEASE_CONFLICT');
    else if(m.phase==='active') respond({status:'active',lease:verifyActive(root,m)});
    else if(m.phase==='released') respond({status:'released'});
    else respond({status:'pending'});
  } else if(request.operation==='assert') {
    ordinary(root); const lease=request.data; const m=readManifest(root,lease.id);
    if(!m||m.phase!=='active'||!m.lease||!sameLease(m.lease,lease)) fail('LEASE_CONFLICT');
    respond({status:'active',lease:verifyActive(root,m)});
  } else if(request.operation==='cleanup') {
    if(!fs.existsSync(root)) {
      if(orphaned(request.data)) fail('LEASE_CONFLICT');
      respond({status:'absent'});
    }
    else { ordinary(root); respond({status:cleanup(root,request.data)}); }
  } else if(request.operation==='release') {
    ordinary(root); respond({status:release(root,request.data)});
  } else fail('REMOTE_FAILED');
} catch(e) {
  respond({status:'error',code:e instanceof Stop?e.code:'REMOTE_FAILED',stateMayHaveChanged:e instanceof Stop?e.changed:true});
}
`;
