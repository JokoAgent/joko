declare module "*.connjs" {
  interface MobileConnectionRuntimeAsset {
    readonly path: string;
    readonly byteSize: number;
    readonly sha256Hex: string;
  }

  interface MobileConnectionRuntimeBundle {
    readonly script: string;
    readonly css: string;
    readonly scriptByteSize: number;
    readonly cssByteSize: number;
    readonly scriptSha256Hex: string;
    readonly cssSha256Hex: string;
    readonly bundleSha256Hex: string;
    readonly stylesSourceByteSize: number;
    readonly stylesSourceSha256Hex: string;
    readonly assets: readonly MobileConnectionRuntimeAsset[];
  }

  const bundle: MobileConnectionRuntimeBundle;
  export default bundle;
}
