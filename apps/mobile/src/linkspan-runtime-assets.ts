/** Metro replaces this fixed module with only the explicitly prepared Asset IDs.
 * Unit tests and a source-only typecheck have no delivered relay capability. */
export const linkspanRuntimeAssets: Readonly<Partial<Record<'iroh' | 'tailcat', readonly [number, number, number]>>> = Object.freeze({});
export const linkspanNativeIrohSelected = false;
export const linkspanNativeHttpConnectSelected = false;
export const linkspanHttpConnectNoticesAsset: number | undefined = undefined;
export const linkspanWebRtcRuntimeAssets: readonly [number, number] | undefined = undefined;
