import { Directory, File, Paths } from "expo-file-system";
import { getRandomBytes } from "expo-crypto";
import { base64Encode } from "@bufbuild/protobuf/wire";
import native from "../modules/joko-mcp-app-surface/src/JokoMcpAppSurfaceModule";
import type { MobileExtensionMainViewResource } from "./mobile-extensions";

export interface PreparedExtensionMainViewDocument {
  readonly documentId: string;
  readonly source: { readonly uri: string };
  readonly documentUrl: string;
  readonly documentUrls: readonly string[];
  close(): Promise<void>;
}

export const MOBILE_EXTENSION_DOCUMENT_CSP = "default-src 'none'; script-src data:; style-src data: 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
let swept = false;

/** The installed read-only host serves a local manifest; it never fetches a business URL or holds credentials. */
export async function prepareExtensionMainViewDocument(resource: MobileExtensionMainViewResource, entry: string, logicalUrl: string,
  signal?: AbortSignal): Promise<PreparedExtensionMainViewDocument> {
  signal?.throwIfAborted();
  if (native?.appHostAvailable !== true) throw new Error("The isolated Extension document host is unavailable.");
  if (resource.mimeType !== "text/html" || !entry || entry.length > 2048 || /[\\:\u0000-\u001f?#%]/u.test(entry)
    || entry.split("/").some(segment => !segment || segment.startsWith("."))) throw new Error("The isolated Extension document is invalid.");
  const parent = new Directory(Paths.cache, "mcp-apps", "extension-main-views");
  if (!swept) {
    swept = true;
    if (parent.exists) for (const child of parent.list()) {
      if (child instanceof Directory && /^[a-f0-9]{48}$/u.test(child.name)) {
        try { child.delete(); } catch { /* OS cache eviction remains available. */ }
      }
    }
  }
  const token = Array.from(getRandomBytes(24), byte => byte.toString(16).padStart(2, "0")).join("");
  const directory = new Directory(parent, token);
  directory.create({ intermediates: true });
  const server = native;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    try { await server.stop(token); }
    finally { if (directory.exists) directory.delete(); }
  })();
  const cancel = (): void => { void close().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const html = new TextDecoder("utf-8", { fatal: true }).decode(resource.bytes);
    const context = `globalThis[Symbol.for('joko.extension.surface.base')]=${JSON.stringify(logicalUrl)};globalThis[Symbol.for('joko.extension.surface.document')]=${JSON.stringify(token)};`;
    const bootstrap = `<script src="data:text/javascript;base64,${base64Encode(new TextEncoder().encode(context))}"></script>`;
    // A trusted data script runs before Extension modules even on Android,
    // where native before-content injection alone is not guaranteed to win.
    const preamble = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu.exec(html)?.[0] ?? "";
    const localHtml = preamble + bootstrap + html.slice(preamble.length);
    const document = new File(directory, "0"); document.create(); document.write(new TextEncoder().encode(localHtml));
    const bootstrapUrl = await server.startApp(decodeURIComponent(directory.uri.slice("file://".length)), entry, token,
      MOBILE_EXTENSION_DOCUMENT_CSP, [[entry, "0", "text/html"]]);
    if (signal?.aborted) {
      // A native start may finish after the cancellation's first stop completed.
      await server.stop(token);
      signal.throwIfAborted();
    }
    const origin = new URL(bootstrapUrl);
    if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== `/__joko/${token}`) throw new Error("The isolated Extension host returned an invalid origin.");
    const documentUrl = new URL(`/${entry.split("/").map(encodeURIComponent).join("/")}`, bootstrapUrl).href;
    return { documentId: token, source: { uri: bootstrapUrl }, documentUrl, documentUrls: [bootstrapUrl, documentUrl], close };
  } catch (error) { await close().catch(() => undefined); throw error; }
  finally { signal?.removeEventListener("abort", cancel); }
}

export function allowExtensionDocumentNavigation(document: PreparedExtensionMainViewDocument, candidate: string): boolean {
  try {
    const url = new URL(candidate); url.hash = "";
    return !url.username && !url.password && document.documentUrls.includes(url.href);
  } catch { return false; }
}
