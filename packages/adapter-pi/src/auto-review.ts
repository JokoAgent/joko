/*
 * Auto-review policy and current-model delegate with Apache-2.0 licensed portions.
 * Copyright 2026 XD Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_AUTO_REVIEW_TIMEOUT_MS = 20_000;
export const MAX_AUTO_REVIEW_TIMEOUT_MS = 20_000;
export const DEFAULT_AUTO_REVIEW_CACHE_SIZE = 128;

export type AutoReviewTier = "green" | "red" | "gray";
export type AutoReviewVerdict = "allow" | "block" | "ask";

export interface AutoReviewApprovedRoot {
  readonly path: string;
  readonly access: "read_only" | "read_write";
}

export interface AutoReviewControl {
  readonly policyGeneration: number;
  readonly permissionMode: "ask" | "auto" | "bypassPermissions";
  readonly approvedRoots: readonly AutoReviewApprovedRoot[];
}

export interface AutoReviewToolCall {
  readonly toolName: string;
  readonly input: unknown;
}

export interface AutoReviewModel {
  readonly provider?: string;
  readonly id?: string;
  readonly api?: string;
}

export interface AutoReviewCompletion {
  readonly content?: readonly unknown[];
  readonly stopReason?: string;
  readonly usage?: unknown;
}

export interface AutoReviewRuntimeContext {
  readonly cwd: string;
  readonly model?: AutoReviewModel;
  readonly modelRegistry?: {
    complete(
      model: AutoReviewModel,
      context: {
        readonly systemPrompt: string;
        readonly messages: readonly [{ readonly role: "user"; readonly content: readonly [{ readonly type: "text"; readonly text: string }]; readonly timestamp: number }];
      },
      options: { readonly signal: AbortSignal; readonly maxTokens: number; readonly cacheRetention: "none" },
    ): Promise<AutoReviewCompletion>;
  };
  readonly sessionManager?: {
    getBranch(): readonly unknown[];
  };
  readonly signal?: AbortSignal;
}

export interface AutoReviewUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
}

export interface AutoReviewClassification {
  readonly tier: AutoReviewTier;
  readonly reason: string;
  readonly evidence: string;
}

export interface AutoReviewDecision {
  readonly verdict: AutoReviewVerdict;
  readonly reason: string;
  readonly safeAlternative?: string;
  readonly source: "policy" | "reviewer" | "cache" | "system";
  readonly tier: AutoReviewTier;
  readonly code?:
    | "reviewer_unavailable"
    | "reviewer_timeout"
    | "reviewer_aborted"
    | "policy_changed"
    | "policy_unavailable"
    | "insufficient_evidence";
  readonly unavailable?: boolean;
  readonly usage?: AutoReviewUsage;
}

export interface PiAutoReviewRequest {
  readonly ctx: AutoReviewRuntimeContext;
  readonly event: AutoReviewToolCall;
  readonly control: AutoReviewControl;
  readonly workspaceRoot: string;
  /** Must read the authoritative generation-scoped control file. */
  readonly readControl: () => AutoReviewControl;
  /** Receives a generic, secret-free notice at most once per unavailable episode. */
  readonly notifyUnavailable?: (message: string) => void;
}

export interface PiAutoReviewerOptions {
  readonly timeoutMs?: number;
  readonly cacheSize?: number;
  readonly platform?: "win32" | "darwin" | "linux" | string;
  readonly now?: () => number;
  /** Runtime may supply realpath-aware resolution; the default is lexical and fail-closed. */
  readonly resolvePath?: (target: string, cwd: string) => string | undefined;
}

export interface PiAutoReviewer {
  classify(request: Pick<PiAutoReviewRequest, "event" | "control" | "workspaceRoot" | "ctx">): AutoReviewClassification;
  review(request: PiAutoReviewRequest): Promise<AutoReviewDecision>;
  clear(): void;
  readonly cacheSize: number;
}

/**
 * The implementation is deliberately closure-free. auto-review-runtime.ts
 * serializes this factory into the immutable Pi runtime generation, so the
 * generated extension has no dependency on Joko source files at execution time.
 */
export function createPiAutoReviewer(options: PiAutoReviewerOptions = {}): PiAutoReviewer {
  const timeoutMs = Math.max(1, Math.min(20_000, Number.isFinite(options.timeoutMs) ? Math.trunc(options.timeoutMs ?? 20_000) : 20_000));
  const cacheLimit = Math.max(1, Math.min(256, Number.isFinite(options.cacheSize) ? Math.trunc(options.cacheSize ?? 128) : 128));
  const platform = options.platform ?? (typeof process === "object" ? process.platform : "linux");
  const now = options.now ?? Date.now;
  const cache = new Map<string, AutoReviewDecision>();
  let activeStateKey: string | undefined;
  let unavailableNotifiedFor: string | undefined;

  const credentialPath = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker[\\/]config\.json|\.config[\\/](?:gcloud|gh)|credentials?(?:\.[^\\/]*)?|secrets?(?:\.[^\\/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|auth\.json|keychain|\.npmrc|\.netrc)(?:$|[\\/])/i;
  const credentialKey = /(?:^|[_-])(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|authorization|cookie|private[_-]?key)(?:$|[_-])|(?:apiKey|apiToken|accessToken|refreshToken|privateKey)$/i;
  const credentialValue = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk-|ghp_|github_pat_|glpat-|npm_|pypi-|xox[baprs]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|https?:\/\/[^/@:\s]+:[^/@\s]+@|[?&](?:api[_-]?key|access[_-]?token|token|secret|password|authorization)=[^&#\s]+|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|passwd|authorization)\s*(?::|=|\bis\b)\s*[^\s,;]+|--?(?:api-key|token|secret|password|authorization)(?:=|\s+)\S+)/i;
  const urlPattern = /\b(?:https?|ftp|file|gopher):\/\/[^\s"'<>]+/gi;
  const destructiveCommand = /(?:^|[;&|\s])(?:sudo|doas|runas)(?:\s|$)|(?:^|[;&|\s])(?:rm|rmdir|rd|del|erase|shred|srm|unlink)(?:\s|$)|\b(?:Remove-Item|Clear-Content|Clear-Disk|Remove-Partition|Stop-Computer|Restart-Computer)\b|\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f|push\b[^\r\n]*--force|restore\b|branch\s+-[dD]\b|checkout\b[^\r\n]*--\s)|\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart|format|shutdown|reboot|halt|poweroff|truncate)\b|\bdd\b[^\r\n]*\bof\s*=|\b(?:DROP|TRUNCATE)\s+(?:DATABASE|SCHEMA|TABLE)\b|\b(?:chmod|chown)\b[^\r\n]*(?:\/etc|\/usr|\/bin|\/sbin|\/System|[A-Za-z]:[\\/]Windows)/i;
  const destructiveOperation = /(?:^|[_-])(?:delete|destroy|drop|erase|purge|remove|revoke|terminate|truncate|unpublish|wipe)(?:$|[_-])/i;
  const systemPathInText = /(?:^|[\s"'=])(?:\/(?:private\/)?(?:etc|bin|sbin|boot|dev|proc|sys|root|System|Library)(?:\/[^\s"']*)?|\/(?:private\/)?var\/(?:lib|db|run)(?:\/[^\s"']*)?|[A-Za-z]:[\\/](?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:[\\/][^\s"']*)?)(?=$|[\s"'])/i;
  const safeShell = /^(?:pwd|whoami|hostname|uname(?:\s+-[a-z]+)?|git\s+(?:status(?:\s+--(?:short|porcelain(?:=v\d)?))?|diff(?:\s+--stat)?|log(?:\s+--oneline)?|show(?:\s+--stat)?))$/i;

  function boundedText(value: string, limit: number, pathLike = false): string {
    const redacted = value
      .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-|ghp_|github_pat_|glpat-|npm_|pypi-|xox[baprs]-)[A-Za-z0-9_-]{8,}/gi, "[REDACTED_TOKEN]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_ACCESS_KEY]")
      .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|secret|password|passwd|authorization)\s*(?::|=|\bis\b)\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/(--?(?:api-key|token|secret|password|authorization)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
      .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@")
      .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
      .replace(pathLike ? /\b[A-Za-z0-9+_=-]{40,}\b/g : /\b[A-Za-z0-9+/_=-]{40,}\b/g, "[REDACTED_HIGH_ENTROPY_VALUE]");
    if (redacted.length <= limit) return redacted;
    const head = Math.max(1, Math.floor((limit - 24) / 2));
    return redacted.slice(0, head) + "\n...[bounded omission]...\n" + redacted.slice(-head);
  }

  function stableEvidence(value: unknown): string {
    const seen = new WeakSet<object>();
    function clean(candidate: unknown, key: string, depth: number): unknown {
      if (depth > 6) return "[depth omitted]";
      if (candidate === null || typeof candidate === "boolean") return candidate;
      if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : "[non-finite]";
      if (typeof candidate === "string") return credentialKey.test(key) ? "[REDACTED]" : boundedText(candidate, 500);
      if (typeof candidate !== "object") return `[${typeof candidate} omitted]`;
      if (seen.has(candidate)) return "[cycle omitted]";
      seen.add(candidate);
      if (Array.isArray(candidate)) return candidate.slice(0, 20).map((item) => clean(item, key, depth + 1)).concat(candidate.length > 20 ? ["[items omitted]"] : []);
      const record = candidate as Record<string, unknown>;
      const keys = Object.keys(record).sort().slice(0, 40);
      const output: Record<string, unknown> = {};
      for (const childKey of keys) output[boundedText(childKey, 80)] = clean(record[childKey], childKey, depth + 1);
      if (Object.keys(record).length > keys.length) output["[fields omitted]"] = true;
      return output;
    }
    try {
      const serialized = JSON.stringify(clean(value, "", 0));
      if (serialized.length <= 4_096) return serialized;
      return JSON.stringify({ bounded: true, preview: boundedText(serialized, 3_500) });
    } catch {
      return JSON.stringify("[unserializable arguments]");
    }
  }

  function sensitiveEvidence(value: unknown, depth = 0, key = ""): boolean {
    if (depth > 8) return true;
    if (typeof value === "string") return credentialKey.test(key) || credentialPath.test(value) || credentialValue.test(value);
    if (!value || typeof value !== "object") return credentialKey.test(key) && value != null;
    if (Array.isArray(value)) return value.some((entry) => sensitiveEvidence(entry, depth + 1, key));
    return Object.entries(value as Record<string, unknown>).some(([childKey, child]) => sensitiveEvidence(child, depth + 1, childKey));
  }

  function normalizePath(target: string, cwd: string): string | undefined {
    if (options.resolvePath) {
      const supplied = options.resolvePath(target, cwd);
      if (!supplied) return undefined;
      return supplied.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    }
    const raw = target.trim().replace(/\\/g, "/");
    if (!raw || /[%$][{(]?\w/.test(raw) || raw.includes("*")) return undefined;
    const absolute = raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:\//.test(raw);
    const combined = absolute ? raw : cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + raw;
    const prefixMatch = combined.match(/^(?:([A-Za-z]:)|\/\/[^/]+\/[^/]+|\/)/);
    const prefix = prefixMatch?.[0] ?? "";
    if (!prefix) return undefined;
    const body = combined.slice(prefix.length);
    const parts: string[] = [];
    for (const part of body.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (parts.length === 0) return undefined;
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    const normalized = prefix.replace(/\/$/, "") + "/" + parts.join("/");
    return normalized.replace(/\/+$/, "") || "/";
  }

  function sameOrInside(target: string, root: string): boolean {
    const fold = (value: string) => platform === "win32" ? value.toLowerCase() : value;
    const normalizedTarget = fold(target.replace(/\/+$/, ""));
    const normalizedRoot = fold(root.replace(/\/+$/, ""));
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + "/");
  }

  function protectedSystemPath(target: string): boolean {
    const path = target.replace(/\\/g, "/").replace(/^\/private\/(?=(?:etc|bin|sbin|var|tmp)(?:\/|$))/, "/");
    if (/^[A-Za-z]:\/(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:\/|$)/i.test(path)) return true;
    return /^\/(?:etc|bin|sbin|boot|dev|proc|sys|root|System|Library)(?:\/|$)/.test(path) || /^\/var\/(?:lib|db|run)(?:\/|$)/.test(path);
  }

  function internalTarget(raw: string): boolean {
    function internalHost(rawHost: string): boolean {
      const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
      if (host === "localhost" || host.endsWith(".localhost") || host === "0" || host === "::" || host === "::1") return true;
      if (host === "metadata.google.internal" || host.endsWith(".internal")) return true;
      if (host.startsWith("::ffff:")) return internalHost(host.slice("::ffff:".length));
      const ipv4 = host.split(".").map(Number);
      if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
        const [a = 0, b = 0] = ipv4;
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
      }
      return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
    }
    const candidate = raw.trim();
    if (/^(?:localhost|metadata\.google\.internal|(?:\d{1,3}\.){3}\d{1,3}|\[?[0-9a-f:]+(?:\d{1,3}\.){0,3}\d{0,3}\]?)(?::\d+)?$/i.test(candidate)) {
      const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
      const bareHost = bracketed?.[1] ?? (/^[^:]+:\d+$/.test(candidate) ? candidate.slice(0, candidate.lastIndexOf(":")) : candidate);
      return internalHost(bareHost);
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return false;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (!["http:", "https:"].includes(url.protocol)) return true;
    return internalHost(url.hostname);
  }

  function hasInternalTarget(value: unknown, depth = 0): boolean {
    if (depth > 8) return true;
    if (typeof value === "string") {
      const urls = value.match(urlPattern) ?? [];
      if (urls.some(internalTarget)) return true;
      return value.split(/[\s,;]+/).some((candidate) => internalTarget(candidate));
    }
    if (!value || typeof value !== "object") return false;
    return Object.values(value as Record<string, unknown>).some((entry) => hasInternalTarget(entry, depth + 1));
  }

  function hasDestructiveEvidence(value: unknown, depth = 0): boolean {
    if (depth > 8) return true;
    if (typeof value === "string") return destructiveCommand.test(value);
    if (!value || typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
      (destructiveOperation.test(key) && entry !== false && entry != null) || hasDestructiveEvidence(entry, depth + 1));
  }

  function hasSystemPathEvidence(value: unknown, depth = 0): boolean {
    if (depth > 8) return true;
    if (typeof value === "string") return systemPathInText.test(value);
    if (!value || typeof value !== "object") return false;
    return Object.values(value as Record<string, unknown>).some((entry) => hasSystemPathEvidence(entry, depth + 1));
  }

  function field(input: unknown, names: readonly string[]): string | undefined {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    for (const name of names) {
      const value = record[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  }

  function pathHazard(input: unknown, cwd: string): boolean {
    if (!input || typeof input !== "object") return false;
    const pathKey = /(?:^|[_-])(?:path|file|filename|dir|directory|cwd|root|target|destination|dest)(?:$|[_-])/i;
    function visit(value: unknown, key: string, depth: number): boolean {
      if (depth > 8) return true;
      if (typeof value === "string" && (pathKey.test(key) || /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(value))) {
        const normalized = normalizePath(value, cwd);
        if (!normalized) return true;
        if (credentialPath.test(normalized)) return true;
        if (protectedSystemPath(normalized)) return true;
        return false;
      }
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some((entry) => visit(entry, key, depth + 1));
      return Object.entries(value as Record<string, unknown>).some(([childKey, child]) => visit(child, childKey, depth + 1));
    }
    return visit(input, "", 0);
  }

  function classify(request: Pick<PiAutoReviewRequest, "event" | "control" | "workspaceRoot" | "ctx">): AutoReviewClassification {
    const name = request.event.toolName.trim().toLowerCase();
    const input = request.event.input;
    const containsCredential = sensitiveEvidence(input);
    const evidence = containsCredential
      ? stableEvidence({ toolName: request.event.toolName, arguments: "[REDACTED_CREDENTIAL_BEARING_INPUT]" })
      : stableEvidence({ toolName: request.event.toolName, arguments: input });
    const roots: readonly AutoReviewApprovedRoot[] = [
      { path: request.workspaceRoot, access: "read_write" as const },
      ...request.control.approvedRoots.filter((root) => root.path !== request.workspaceRoot),
    ];
    const cwd = request.ctx.cwd || request.workspaceRoot;

    if (!name || evidence === JSON.stringify("[unserializable arguments]")) return { tier: "gray", reason: "Tool evidence is incomplete", evidence };
    if (containsCredential) return { tier: "red", reason: "Credential-bearing data requires explicit user consent", evidence };
    if (hasInternalTarget(input)) return { tier: "red", reason: "Local, private, metadata, or non-HTTP network targets require explicit user consent", evidence };
    if (destructiveOperation.test(name) || hasDestructiveEvidence(input)) return { tier: "red", reason: "Destructive or privileged operations require explicit user consent", evidence };
    if (hasSystemPathEvidence(input)) return { tier: "red", reason: "Protected system paths require explicit user consent", evidence };
    if (pathHazard(input, cwd)) return { tier: "red", reason: "Protected system paths require explicit user consent", evidence };

    if (name === "ask_user_question") return { tier: "green", reason: "The tool itself obtains explicit user input and has no other side effect", evidence };

    if (["read", "grep", "find", "ls"].includes(name)) {
      const target = field(input, ["path", "file", "directory"]) ?? ".";
      const normalized = normalizePath(target, cwd);
      if (!normalized) return { tier: "gray", reason: "Read target could not be resolved", evidence };
      const readable = roots.some((root) => {
        const normalizedRoot = normalizePath(root.path, cwd);
        return normalizedRoot ? sameOrInside(normalized, normalizedRoot) : false;
      });
      return readable
        ? { tier: "green", reason: "Read is confined to an approved root", evidence }
        : { tier: "gray", reason: "Read is outside approved roots", evidence };
    }

    if (["write", "edit"].includes(name)) {
      const target = field(input, ["path", "file"]);
      if (!target) return { tier: "gray", reason: "Write target is missing", evidence };
      const normalized = normalizePath(target, cwd);
      if (!normalized) return { tier: "gray", reason: "Write target could not be resolved", evidence };
      const writable = roots.some((root) => {
        if (root.access !== "read_write") return false;
        const normalizedRoot = normalizePath(root.path, cwd);
        return normalizedRoot ? sameOrInside(normalized, normalizedRoot) : false;
      });
      if (writable) return { tier: "green", reason: "Write is confined to a writable approved root", evidence };
      if (protectedSystemPath(normalized)) return { tier: "red", reason: "Protected system paths require explicit user consent", evidence };
      return { tier: "gray", reason: "Write is outside writable approved roots", evidence };
    }

    if (name === "bash") {
      const command = field(input, ["command"]);
      if (!command) return { tier: "gray", reason: "Shell command is missing", evidence };
      if (/[><`]|\$\(|\|\||&&|;|\n|\r/.test(command)) return { tier: "gray", reason: "Compound shell command requires contextual review", evidence };
      if (safeShell.test(command.trim())) return { tier: "green", reason: "Command is a narrowly scoped read-only inspection", evidence };
      return { tier: "gray", reason: "Shell command requires contextual review", evidence };
    }

    return { tier: "gray", reason: "Tool semantics require contextual review", evidence };
  }

  function messageText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const record = message as { role?: unknown; content?: unknown };
    if (record.role !== "user") return "";
    if (typeof record.content === "string") return record.content;
    if (!Array.isArray(record.content)) return "";
    return record.content
      .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text)
      .join("\n");
  }

  function latestUserIntent(ctx: AutoReviewRuntimeContext): string {
    let branch: readonly unknown[];
    try {
      branch = ctx.sessionManager?.getBranch() ?? [];
    } catch {
      return "";
    }
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { type?: unknown; message?: unknown };
      if (record.type !== "message") continue;
      const text = messageText(record.message).trim();
      if (text) return boundedText(text, 2_000);
    }
    return "";
  }

  function modelKey(model: AutoReviewModel | undefined): string {
    if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) return "";
    return `${model.provider}/${model.id}/${typeof model.api === "string" ? model.api : ""}`;
  }

  function stateKey(request: PiAutoReviewRequest, intent: string): string {
    return `${request.control.policyGeneration}\u001f${request.control.permissionMode}\u001f${modelKey(request.ctx.model)}\u001f${intent}`;
  }

  async function secureDigest(value: unknown): Promise<string | undefined> {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return undefined;
    }
    if (serialized === undefined || !globalThis.crypto?.subtle) return undefined;
    try {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      return undefined;
    }
  }

  function stateStillCurrent(request: PiAutoReviewRequest, expectedState: string): "current" | "changed" | "unavailable" {
    let current: AutoReviewControl;
    try {
      current = request.readControl();
    } catch {
      return "unavailable";
    }
    const currentIntent = latestUserIntent(request.ctx);
    const currentKey = `${current.policyGeneration}\u001f${current.permissionMode}\u001f${modelKey(request.ctx.model)}\u001f${currentIntent}`;
    return currentKey === expectedState ? "current" : "changed";
  }

  function usageOnly(value: unknown): AutoReviewUsage | undefined {
    if (!value || typeof value !== "object") return undefined;
    const usage = value as Record<string, unknown>;
    const take = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) && (usage[key] as number) >= 0 ? usage[key] as number : 0;
    return {
      input: take("input"),
      output: take("output"),
      cacheRead: take("cacheRead"),
      cacheWrite: take("cacheWrite"),
      totalTokens: take("totalTokens"),
    };
  }

  function parseDecision(response: AutoReviewCompletion): Omit<AutoReviewDecision, "source" | "tier"> {
    if (response.stopReason && response.stopReason !== "stop") throw new Error("review did not complete");
    if (!Array.isArray(response.content)) throw new Error("review response has no content");
    const text = response.content
      .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    if (!text || text.length > 1_024) throw new Error("review response is empty or oversized");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("review response is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("review response is not an object");
    const record = parsed as Record<string, unknown>;
    const verdict = record.verdict;
    const expectedKeys = verdict === "block" ? ["reason", "safeAlternative", "verdict"] : ["reason", "verdict"];
    if (!expectedKeys.every((key) => Object.hasOwn(record, key)) || Object.keys(record).some((key) => !expectedKeys.includes(key))) {
      throw new Error("review response does not match the schema");
    }
    if (!(["allow", "block", "ask"] as unknown[]).includes(verdict)) throw new Error("review verdict is invalid");
    if (typeof record.reason !== "string" || !record.reason.trim() || record.reason.length > 240) throw new Error("review reason is invalid");
    const reason = boundedText(record.reason.trim(), 240);
    if (verdict === "block") {
      if (typeof record.safeAlternative !== "string" || !record.safeAlternative.trim() || record.safeAlternative.length > 400) {
        throw new Error("blocked review lacks a safe alternative");
      }
      return { verdict, reason, safeAlternative: boundedText(record.safeAlternative.trim(), 400), usage: usageOnly(response.usage) };
    }
    return { verdict: verdict as "allow" | "ask", reason, usage: usageOnly(response.usage) };
  }

  function remember(key: string, decision: AutoReviewDecision): void {
    cache.delete(key);
    cache.set(key, decision);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
  }

  function systemDecision(tier: AutoReviewTier, code: AutoReviewDecision["code"], reason: string): AutoReviewDecision {
    return {
      verdict: "block",
      reason,
      safeAlternative: "Re-check the current policy and retry with a narrower, clearly scoped action.",
      source: "system",
      tier,
      code,
    };
  }

  async function review(request: PiAutoReviewRequest): Promise<AutoReviewDecision> {
    const classification = classify(request);
    if (classification.tier === "green") return { verdict: "allow", reason: classification.reason, source: "policy", tier: "green" };
    if (classification.tier === "red") return { verdict: "ask", reason: classification.reason, source: "policy", tier: "red" };

    const intent = latestUserIntent(request.ctx);
    if (!intent) {
      return {
        verdict: "block",
        reason: "Auto-review lacks a current user intent and cannot establish necessity.",
        safeAlternative: "Ask the user to state the intended outcome, then retry the narrowly scoped action.",
        source: "system",
        tier: "gray",
        code: "insufficient_evidence",
      };
    }
    const expectedState = stateKey(request, intent);
    const stateDigest = await secureDigest(expectedState);
    const notificationKey = stateDigest ?? `${request.control.policyGeneration}\u001f${modelKey(request.ctx.model)}`;
    if (activeStateKey !== notificationKey) {
      cache.clear();
      activeStateKey = notificationKey;
      unavailableNotifiedFor = undefined;
    }
    const currentModelKey = modelKey(request.ctx.model);
    // The model sees only bounded/redacted evidence, but cache identity covers
    // every actual JSON argument byte. If a secure digest is unavailable, cache
    // reuse is disabled rather than keying on a truncated representation.
    const actionDigest = stateDigest ? await secureDigest({ toolName: request.event.toolName, input: request.event.input }) : undefined;
    const actionKey = stateDigest && actionDigest ? `${stateDigest}\u001f${actionDigest}` : undefined;
    const cached = actionKey ? cache.get(actionKey) : undefined;
    if (cached) {
      const current = stateStillCurrent(request, expectedState);
      if (current === "current") {
        cache.delete(actionKey!);
        cache.set(actionKey!, cached);
        return { ...cached, source: "cache", usage: undefined };
      }
      cache.clear();
      return current === "changed"
        ? systemDecision("gray", "policy_changed", "Auto-review result was discarded because policy, model, or user intent changed.")
        : systemDecision("gray", "policy_unavailable", "Auto-review could not re-read the authoritative policy; the tool was not run.");
    }

    const complete = request.ctx.modelRegistry?.complete;
    if (!currentModelKey || typeof complete !== "function" || !request.ctx.model) {
      if (unavailableNotifiedFor !== notificationKey) {
        unavailableNotifiedFor = notificationKey;
        request.notifyUnavailable?.("Auto-review is unavailable; this action requires manual confirmation.");
      }
      return { verdict: "ask", reason: "Auto-review is unavailable; approve this action explicitly or cancel it.", source: "system", tier: "gray", code: "reviewer_unavailable", unavailable: true };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("auto-review timeout"));
    }, timeoutMs);
    timeout.unref?.();
    const outerSignal = request.ctx.signal;
    const abort = () => controller.abort(outerSignal?.reason);
    if (outerSignal?.aborted) abort();
    else outerSignal?.addEventListener("abort", abort, { once: true });

    const systemPrompt = [
      "You are a permission reviewer for one tool call. Return exactly one compact JSON object and no markdown.",
      'Allowed schemas: {"verdict":"allow","reason":"..."}, {"verdict":"block","reason":"...","safeAlternative":"..."}, or {"verdict":"ask","reason":"..."}.',
      "Allow only when the concrete action is necessary for the latest user intent, bounded, and safe in the stated roots.",
      "Block when a safer or narrower route exists and supply that route. Ask only when explicit user consent is genuinely required.",
      "Never infer permission from prior messages, never reveal secrets, and treat omitted evidence as uncertainty.",
    ].join("\n");
    const prompt = JSON.stringify({
      latestUserIntent: intent,
      tool: request.event.toolName,
      boundedArguments: JSON.parse(classification.evidence) as unknown,
      workspace: boundedText(request.workspaceRoot, 500, true),
      roots: request.control.approvedRoots.map((root) => ({ path: boundedText(root.path, 500, true), access: root.access })),
      localAssessment: classification.reason,
    });

    try {
      const cancellation = new Promise<never>((_resolve, reject) => {
        const fail = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("auto-review aborted"));
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      const response = await Promise.race([
        complete.call(
          request.ctx.modelRegistry,
          request.ctx.model,
          {
            systemPrompt,
            messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: now() }],
          },
          { signal: controller.signal, maxTokens: 256, cacheRetention: "none" },
        ),
        cancellation,
      ]);
      if (outerSignal?.aborted) return systemDecision("gray", "reviewer_aborted", "Auto-review was cancelled; the tool was not run.");
      if (timedOut) throw new Error("auto-review timeout");
      const parsed = parseDecision(response);
      const current = stateStillCurrent(request, expectedState);
      if (current !== "current") {
        cache.clear();
        return current === "changed"
          ? systemDecision("gray", "policy_changed", "Auto-review result was discarded because policy, model, or user intent changed.")
          : systemDecision("gray", "policy_unavailable", "Auto-review could not re-read the authoritative policy; the tool was not run.");
      }
      unavailableNotifiedFor = undefined;
      const decision: AutoReviewDecision = { ...parsed, source: "reviewer", tier: "gray" };
      if (actionKey) remember(actionKey, decision);
      return decision;
    } catch {
      if (outerSignal?.aborted) return systemDecision("gray", "reviewer_aborted", "Auto-review was cancelled; the tool was not run.");
      const code = timedOut ? "reviewer_timeout" : "reviewer_unavailable";
      if (unavailableNotifiedFor !== notificationKey) {
        unavailableNotifiedFor = notificationKey;
        request.notifyUnavailable?.("Auto-review is unavailable; this action requires manual confirmation.");
      }
      return {
        verdict: "ask",
        reason: timedOut
          ? "Auto-review timed out; approve this action explicitly or cancel it."
          : "Auto-review is unavailable; approve this action explicitly or cancel it.",
        source: "system",
        tier: "gray",
        code,
        unavailable: true,
      };
    } finally {
      clearTimeout(timeout);
      outerSignal?.removeEventListener("abort", abort);
    }
  }

  return {
    classify,
    review,
    clear() {
      cache.clear();
      activeStateKey = undefined;
      unavailableNotifiedFor = undefined;
    },
    get cacheSize() {
      return cache.size;
    },
  };
}
