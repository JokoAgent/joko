declare module "*.pdfjs" {
  interface MobilePdfJsRuntimeBundle {
    readonly version: string;
    readonly script: string;
    readonly scriptSha256Hex: string;
    readonly cMaps: Readonly<Record<string, string>>;
    readonly cMapByteSize: number;
    readonly cMapSha256Hex: string;
    readonly standardFonts: Readonly<Record<string, string>>;
    readonly standardFontByteSize: number;
    readonly standardFontSha256Hex: string;
  }

  const bundle: MobilePdfJsRuntimeBundle;
  export default bundle;
}
