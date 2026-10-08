import { assertBrowserActionCurrent, type BrowserActionContext } from "./browser-action.js";

export type NativeFileCopyOutcome = JokoDesktopCopyFileResult;
export type NativeFileOpenOutcome = JokoDesktopOpenFileResult;
export type NativeArtifactSourceRevealOutcome = JokoDesktopRevealArtifactSourceResult;
export interface NativeFileOpenApplication {
  readonly appId: string;
  readonly label: string;
  readonly iconDataUrl?: string;
}
export interface NativeFileOpenApplicationList {
  readonly listOccurrence: string;
  readonly applications: readonly NativeFileOpenApplication[];
}
export type NativeFileOpenApplicationListOutcome =
  | { readonly status: "listed"; readonly list: NativeFileOpenApplicationList }
  | { readonly status: "cancelled" | "unavailable" | "failed" };
export const NATIVE_FILE_COPY_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const NATIVE_FILE_OPEN_MAXIMUM_BYTES = 256 * 1024 * 1024;

type NativeFileOpenWithHost = Pick<
  NonNullable<Window["jokoDesktop"]>,
  "listOpenWithApps" | "retireOpenWithApps" | "openFileWithApp" | "cancelFileOpen"
>;

const nativeFileOpenApplicationListOwners = new WeakMap<NativeFileOpenApplicationList, NativeFileOpenWithHost>();

export function nativeFileCopyAvailable(): boolean {
  return typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("files.copy") === true;
}

export function nativeFileOpenAvailable(): boolean {
  return typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("files.open") === true;
}

export function nativeFileOpenWithAvailable(): boolean {
  return typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("files.openWith") === true;
}

export function nativeArtifactSourceRevealAvailable(): boolean {
  return typeof window !== "undefined" && window.jokoDesktop?.capabilities.includes("files.revealSource") === true;
}

/** Capture the trusted host before asynchronous retrieval, independently of the view Document. */
export function captureNativeFileCopy(): Pick<NonNullable<Window["jokoDesktop"]>, "copyFile" | "cancelFileCopy"> | undefined {
  if (!nativeFileCopyAvailable()) return undefined;
  const desktop = window.jokoDesktop!;
  return { copyFile: desktop.copyFile.bind(desktop), cancelFileCopy: desktop.cancelFileCopy.bind(desktop) };
}

/** Capture the trusted host before asynchronous retrieval, independently of the view Document. */
export function captureNativeFileOpen(): Pick<NonNullable<Window["jokoDesktop"]>, "openFile" | "cancelFileOpen"> | undefined {
  if (!nativeFileOpenAvailable()) return undefined;
  const desktop = window.jokoDesktop!;
  return { openFile: desktop.openFile.bind(desktop), cancelFileOpen: desktop.cancelFileOpen.bind(desktop) };
}

/** Capture one Document-scoped Windows application-list host before any asynchronous work. */
export function captureNativeFileOpenWith(): NativeFileOpenWithHost | undefined {
  if (!nativeFileOpenWithAvailable()) return undefined;
  const desktop = window.jokoDesktop!;
  return {
    listOpenWithApps: desktop.listOpenWithApps.bind(desktop),
    retireOpenWithApps: desktop.retireOpenWithApps.bind(desktop),
    openFileWithApp: desktop.openFileWithApp.bind(desktop),
    cancelFileOpen: desktop.cancelFileOpen.bind(desktop)
  };
}

export async function listNativeFileOpenApplications(
  name: string,
  context: BrowserActionContext,
  host: ReturnType<typeof captureNativeFileOpenWith> = captureNativeFileOpenWith()
): Promise<NativeFileOpenApplicationListOutcome> {
  assertBrowserActionCurrent(context);
  if (host === undefined) return { status: "unavailable" };
  const listOccurrence = context.ownerDocument.defaultView!.crypto.randomUUID();
  let retired = false;
  let retained = false;
  const retire = (): void => {
    if (retired) return;
    retired = true;
    void host.retireOpenWithApps(listOccurrence).catch(() => undefined);
  };
  context.signal.addEventListener("abort", retire, { once: true });
  try {
    let result: JokoDesktopListOpenWithAppsResult;
    try {
      result = await host.listOpenWithApps({ listOccurrence, name });
    } catch {
      return context.signal.aborted ? { status: "cancelled" } : { status: "failed" };
    }
    if (context.signal.aborted) return { status: "cancelled" };
    assertBrowserActionCurrent(context);
    if (result.status !== "listed") return result;
    if (result.listOccurrence !== listOccurrence) return { status: "failed" };
    const list: NativeFileOpenApplicationList = {
      listOccurrence,
      applications: result.apps.map((application) => ({
        appId: application.appId,
        label: application.label,
        ...(application.iconDataUrl === undefined ? {} : { iconDataUrl: application.iconDataUrl })
      }))
    };
    nativeFileOpenApplicationListOwners.set(list, host);
    retained = true;
    return { status: "listed", list };
  } finally {
    context.signal.removeEventListener("abort", retire);
    // Listed occurrences remain live until their menu owner explicitly retires them.
    if (!retained) retire();
  }
}

/** Invalidate the Main-side list occurrence as well as its renderer handle. */
export function retireNativeFileOpenApplicationList(list: NativeFileOpenApplicationList): void {
  const host = nativeFileOpenApplicationListOwners.get(list);
  nativeFileOpenApplicationListOwners.delete(list);
  if (host !== undefined) void host.retireOpenWithApps(list.listOccurrence).catch(() => undefined);
}

export function nativeFileOpenApplicationAvailable(
  list: NativeFileOpenApplicationList,
  application: NativeFileOpenApplication
): boolean {
  return nativeFileOpenApplicationListOwners.has(list) && list.applications.includes(application);
}

export function captureNativeArtifactSourceReveal(): Pick<
  NonNullable<Window["jokoDesktop"]>,
  "revealArtifactSource" | "cancelArtifactSourceReveal"
> | undefined {
  if (!nativeArtifactSourceRevealAvailable()) return undefined;
  const desktop = window.jokoDesktop!;
  return {
    revealArtifactSource: desktop.revealArtifactSource.bind(desktop),
    cancelArtifactSourceReveal: desktop.cancelArtifactSourceReveal.bind(desktop)
  };
}

export async function copyNativeArtifactFile(
  blob: Blob,
  name: string,
  context: BrowserActionContext,
  host: ReturnType<typeof captureNativeFileCopy>
): Promise<NativeFileCopyOutcome> {
  assertBrowserActionCurrent(context);
  if (host === undefined) return { status: "unavailable" };
  if (blob.size > NATIVE_FILE_COPY_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertBrowserActionCurrent(context);
  if (bytes.byteLength > NATIVE_FILE_COPY_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const requestId = context.ownerDocument.defaultView!.crypto.randomUUID();
  const cancel = (): void => { void host.cancelFileCopy(requestId).catch(() => undefined); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertBrowserActionCurrent(context);
    // A dispatched native request may already have changed the OS clipboard.
    // Neither a rejected IPC reply nor cancellation authorizes a fallback action.
    try { return await host.copyFile({ requestId, file: { name, mediaType: blob.type || "application/octet-stream", bytes } }); }
    catch { return { status: "unknown" }; }
  } finally {
    context.signal.removeEventListener("abort", cancel);
  }
}

export async function openNativeArtifactFile(
  blob: Blob,
  name: string,
  context: BrowserActionContext,
  host: ReturnType<typeof captureNativeFileOpen>
): Promise<NativeFileOpenOutcome> {
  assertBrowserActionCurrent(context);
  if (host === undefined) return { status: "unavailable" };
  if (blob.size > NATIVE_FILE_OPEN_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertBrowserActionCurrent(context);
  if (bytes.byteLength > NATIVE_FILE_OPEN_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const requestId = context.ownerDocument.defaultView!.crypto.randomUUID();
  const cancel = (): void => { void host.cancelFileOpen(requestId).catch(() => undefined); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertBrowserActionCurrent(context);
    // The default application may already have received the managed file. A
    // rejected acknowledgement is therefore unknown and never falls back.
    try { return await host.openFile({ requestId, file: { name, mediaType: blob.type || "application/octet-stream", bytes } }); }
    catch { return { status: "unknown" }; }
  } finally {
    context.signal.removeEventListener("abort", cancel);
  }
}

export async function openNativeArtifactFileWithApplication(
  blob: Blob,
  name: string,
  list: NativeFileOpenApplicationList,
  application: NativeFileOpenApplication,
  context: BrowserActionContext
): Promise<NativeFileOpenOutcome> {
  assertBrowserActionCurrent(context);
  const host = nativeFileOpenApplicationListOwners.get(list);
  if (host === undefined || !nativeFileOpenApplicationAvailable(list, application)) return { status: "unavailable" };
  if (blob.size > NATIVE_FILE_OPEN_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assertBrowserActionCurrent(context);
  if (bytes.byteLength > NATIVE_FILE_OPEN_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
  const requestId = context.ownerDocument.defaultView!.crypto.randomUUID();
  const cancel = (): void => { void host.cancelFileOpen(requestId).catch(() => undefined); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertBrowserActionCurrent(context);
    try {
      return await host.openFileWithApp({
        requestId,
        listOccurrence: list.listOccurrence,
        appId: application.appId,
        file: { name, mediaType: blob.type || "application/octet-stream", bytes }
      });
    } catch {
      return { status: "unknown" };
    }
  } finally {
    context.signal.removeEventListener("abort", cancel);
  }
}

export async function revealNativeArtifactSource(
  profileId: string,
  serverId: string,
  sessionId: string,
  artifactId: string,
  context: BrowserActionContext,
  host: ReturnType<typeof captureNativeArtifactSourceReveal>
): Promise<NativeArtifactSourceRevealOutcome> {
  assertBrowserActionCurrent(context);
  if (host === undefined) return { status: "unavailable" };
  const requestId = context.ownerDocument.defaultView!.crypto.randomUUID();
  const cancel = (): void => { void host.cancelArtifactSourceReveal(requestId).catch(() => undefined); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    assertBrowserActionCurrent(context);
    try {
      return await host.revealArtifactSource({ requestId, profileId, serverId, sessionId, artifactId });
    } catch {
      return { status: "unknown" };
    }
  } finally {
    context.signal.removeEventListener("abort", cancel);
  }
}
