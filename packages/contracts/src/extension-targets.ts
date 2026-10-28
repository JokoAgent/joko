export type ExtensionTargetKind = "project" | "task" | "partner";
export type ExtensionTargetDelivery = "queue" | "steer";
export interface ExtensionTargetRef { readonly kind: ExtensionTargetKind; readonly id: string }
export interface ExtensionTargetView extends ExtensionTargetRef { readonly label: string; readonly detail: string }
/** Plugin-supplied bytes only. A Host path, media URL or existing Blob ID is not accepted. */
export interface ExtensionMessageAttachment { readonly base64: string; readonly name?: string }
export interface ExtensionTargetRoute {
  readonly backendId: string; readonly providerId: string; readonly modelId: string;
  readonly effort?: string; readonly fastMode: boolean | "ultrafast";
}
export type ExtensionTargetRequest =
  | { readonly kind: "list"; readonly targetKind: ExtensionTargetKind; readonly after?: string; readonly limit?: number }
  | { readonly kind: "resolve"; readonly target: ExtensionTargetRef }
  | { readonly kind: "send"; readonly requestKey: string; readonly target: ExtensionTargetRef; readonly text: string;
      readonly title?: string; readonly route?: ExtensionTargetRoute; readonly delivery?: ExtensionTargetDelivery; readonly attachments?: readonly ExtensionMessageAttachment[] }
  | { readonly kind: "cancel"; readonly requestKey: string };
