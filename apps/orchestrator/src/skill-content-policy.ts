/** Portable paths that may contain credentials or service-private state. */
export function isSensitiveSkillPath(value: string): boolean {
  const key = value.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "").toLowerCase();
  if (key === "") return false;
  const parts = key.split("/");
  const excludedDirectories = new Set([
    ".git", ".hg", ".svn", ".venv", "node_modules", "__macosx",
    ".aws", ".ssh", ".gnupg", ".kube", ".docker", ".azure"
  ]);
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  if (key === ".config/gcloud" || key.startsWith(".config/gcloud/")) return true;
  const name = parts.at(-1)!;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if ([".npmrc", ".pypirc", ".netrc", "_netrc", ".terraformrc", "terraform.rc", "credentials.tfrc.json", ".ds_store"].includes(name)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/u.test(name)) return true;
  if (/^(?:credentials|secrets?)(?:\.[a-z0-9_-]+)?\.(?:json|ya?ml|toml|ini|conf)$/u.test(name)) return true;
  if (/(?:^|\/)\.m2\/settings(?:-security)?\.xml$/u.test(key)) return true;
  if (name.endsWith(".xdt-tmp") || /^skill\.md\.xdt-rename-[a-f0-9-]+$/u.test(name) || name.startsWith("._")) return true;
  return false;
}

/** High-confidence secret material only; the matching value is never returned. */
export function looksLikeSecretMaterial(content: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)
    || /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b/u.test(content)
    || /(?:^|\n)[ \t]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)[ \t]*[:=][ \t]*["']?(?!\$\{|\{\{|<|example|replace|your[-_ ])[A-Za-z0-9._~+\/-]{12,}/iu.test(content);
}
