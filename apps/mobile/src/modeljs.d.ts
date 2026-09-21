declare module "*.modeljs" {
  interface MobileModelRuntimeBundle {
    readonly modelViewerVersion: string;
    readonly threeVersion: string;
    readonly script: string;
    readonly scriptSha256Hex: string;
  }

  const bundle: MobileModelRuntimeBundle;
  export default bundle;
}
