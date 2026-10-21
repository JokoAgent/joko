import { requireOptionalNativeModule } from "expo-modules-core";

interface NativeMcpAppSurface {
  readonly appHostAvailable: boolean;
  startApp(root: string, entry: string, token: string, csp: string, files: string[][]): Promise<string>;
  stop(token: string): Promise<void>;
}
export default requireOptionalNativeModule<NativeMcpAppSurface>("JokoMcpAppSurface");
