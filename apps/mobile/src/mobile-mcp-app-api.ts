import type { MessageInitShape } from "@bufbuild/protobuf";
import type { McpAppNativeServiceOperateRequestSchema, McpAppNativeServiceOperateResponse, McpAppServiceOperateRequestSchema, McpAppServiceOperateResponse } from "@joko/contracts";

export interface MobileMcpAppApi {
  readonly ownerKey: string;
  metadata(request: MessageInitShape<typeof McpAppServiceOperateRequestSchema>, signal?: AbortSignal): Promise<McpAppServiceOperateResponse>;
  native(request: MessageInitShape<typeof McpAppNativeServiceOperateRequestSchema>, signal?: AbortSignal): Promise<McpAppNativeServiceOperateResponse>;
}
