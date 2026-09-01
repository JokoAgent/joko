interface MutableGltfResource {
  uri?: unknown;
}

export interface MaterializedWorkspaceGltfSource {
  readonly url: string;
  dispose(): void;
}

export interface MaterializeWorkspaceGltfSourceInput {
  readonly sourceUrl: string;
  readonly modelPath: string;
  readonly loadResource: (path: string) => Promise<Blob>;
  readonly fetchSource?: typeof fetch;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

export async function materializeWorkspaceModelSource(
  input: MaterializeWorkspaceGltfSourceInput
): Promise<MaterializedWorkspaceGltfSource> {
  return /\.glb$/iu.test(input.modelPath)
    ? materializeWorkspaceGlbSource(input)
    : materializeWorkspaceGltfSource(input);
}

/**
 * Rebinds relative glTF buffers and images to authenticated in-memory URLs.
 * Remote, absolute, and workspace-escaping resource references fail closed.
 */
export async function materializeWorkspaceGltfSource({
  sourceUrl,
  modelPath,
  loadResource,
  fetchSource = fetch,
  createObjectUrl = URL.createObjectURL,
  revokeObjectUrl = URL.revokeObjectURL
}: MaterializeWorkspaceGltfSourceInput): Promise<MaterializedWorkspaceGltfSource> {
  const ownedUrls: string[] = [];
  try {
    const response = await fetchSource(sourceUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("The model source could not be read.");
    const document = JSON.parse(await response.text()) as unknown;
    if (!isRecord(document)) throw new Error("The model source is not a glTF document.");
    const resources = gltfResourceSlots(document);
    const localUrls = new Map<string, string>();
    for (const resource of resources) {
      const uri = resource.uri;
      if (typeof uri !== "string" || uri === "") continue;
      if (/^data:/iu.test(uri)) continue;
      const path = resolveWorkspaceGltfResourcePath(modelPath, uri);
      if (path === undefined || path === modelPath) throw new Error("The model contains an unavailable resource reference.");
      let url = localUrls.get(path);
      if (url === undefined) {
        url = createObjectUrl(await loadResource(path));
        ownedUrls.push(url);
        localUrls.set(path, url);
      }
      resource.uri = url;
    }
    const url = createObjectUrl(new Blob([JSON.stringify(document)], { type: "model/gltf+json" }));
    ownedUrls.push(url);
    let disposed = false;
    return {
      url,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const owned of ownedUrls) revokeObjectUrl(owned);
      }
    };
  } catch (error) {
    for (const owned of ownedUrls) revokeObjectUrl(owned);
    throw error;
  }
}

export async function materializeWorkspaceGlbSource({
  sourceUrl,
  modelPath,
  loadResource,
  fetchSource = fetch,
  createObjectUrl = URL.createObjectURL,
  revokeObjectUrl = URL.revokeObjectURL
}: MaterializeWorkspaceGltfSourceInput): Promise<MaterializedWorkspaceGltfSource> {
  const ownedUrls: string[] = [];
  try {
    const response = await fetchSource(sourceUrl, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("The model source could not be read.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (
      bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2
      || view.getUint32(8, true) !== bytes.byteLength
    ) throw new Error("The model source is not a valid GLB document.");
    const jsonLength = view.getUint32(12, true);
    const jsonEnd = 20 + jsonLength;
    if (view.getUint32(16, true) !== GLB_JSON_CHUNK || jsonEnd > bytes.byteLength || jsonLength === 0) {
      throw new Error("The model source is not a valid GLB document.");
    }
    const jsonText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, jsonEnd)).replace(/[\u0000 ]+$/u, "");
    const document = JSON.parse(jsonText) as unknown;
    if (!isRecord(document)) throw new Error("The model source is not a glTF document.");
    const changed = await rebindGltfResources(document, modelPath, loadResource, createObjectUrl, ownedUrls);
    if (!changed) return disposableSource(sourceUrl, ownedUrls, revokeObjectUrl);

    const json = new TextEncoder().encode(JSON.stringify(document));
    const paddedJsonLength = Math.ceil(json.byteLength / 4) * 4;
    const tail = bytes.subarray(jsonEnd);
    const output = new Uint8Array(20 + paddedJsonLength + tail.byteLength);
    const outputView = new DataView(output.buffer);
    outputView.setUint32(0, GLB_MAGIC, true);
    outputView.setUint32(4, 2, true);
    outputView.setUint32(8, output.byteLength, true);
    outputView.setUint32(12, paddedJsonLength, true);
    outputView.setUint32(16, GLB_JSON_CHUNK, true);
    output.set(json, 20);
    output.fill(0x20, 20 + json.byteLength, 20 + paddedJsonLength);
    output.set(tail, 20 + paddedJsonLength);
    const url = createObjectUrl(new Blob([output], { type: "model/gltf-binary" }));
    ownedUrls.push(url);
    return disposableSource(url, ownedUrls, revokeObjectUrl);
  } catch (error) {
    for (const owned of ownedUrls) revokeObjectUrl(owned);
    throw error;
  }
}

export function resolveWorkspaceGltfResourcePath(modelPath: string, uri: string): string | undefined {
  if (
    modelPath === "" || uri === "" || uri.startsWith("/") || uri.startsWith("\\")
    || uri.startsWith("//") || uri.includes("\\") || /[\0-\x1f\x7f]/u.test(uri)
    || /^[a-z][a-z\d+.-]*:/iu.test(uri)
  ) return undefined;
  const rawPath = uri.split(/[?#]/u, 1)[0];
  if (rawPath === undefined || rawPath === "") return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decoded.startsWith("/") || decoded.includes("\\") || /[\0-\x1f\x7f:]/u.test(decoded)) return undefined;
  const modelParts = modelPath.split("/");
  if (modelParts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  const output = modelParts.slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (output.length === 0) return undefined;
      output.pop();
      continue;
    }
    output.push(part);
  }
  return output.length === 0 ? undefined : output.join("/");
}

function gltfResourceSlots(document: Record<string, unknown>): MutableGltfResource[] {
  return [
    ...resourceArray(document["buffers"]),
    ...resourceArray(document["images"])
  ];
}

async function rebindGltfResources(
  document: Record<string, unknown>,
  modelPath: string,
  loadResource: (path: string) => Promise<Blob>,
  createObjectUrl: (blob: Blob) => string,
  ownedUrls: string[]
): Promise<boolean> {
  const localUrls = new Map<string, string>();
  let changed = false;
  for (const resource of gltfResourceSlots(document)) {
    const uri = resource.uri;
    if (typeof uri !== "string" || uri === "") continue;
    if (/^data:/iu.test(uri)) continue;
    const path = resolveWorkspaceGltfResourcePath(modelPath, uri);
    if (path === undefined || path === modelPath) throw new Error("The model contains an unavailable resource reference.");
    let url = localUrls.get(path);
    if (url === undefined) {
      url = createObjectUrl(await loadResource(path));
      ownedUrls.push(url);
      localUrls.set(path, url);
    }
    resource.uri = url;
    changed = true;
  }
  return changed;
}

function disposableSource(
  url: string,
  ownedUrls: readonly string[],
  revokeObjectUrl: (url: string) => void
): MaterializedWorkspaceGltfSource {
  let disposed = false;
  return {
    url,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const owned of ownedUrls) revokeObjectUrl(owned);
    }
  };
}

function resourceArray(value: unknown): MutableGltfResource[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
