import { Download } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { ArtifactDownloadContext } from "../model.js";
import { Button, IconButton } from "./ui.js";
import { useArtifactDownload } from "./use-artifact-download.js";
import { RENDERED_SHARE_EXCLUDE_ATTRIBUTE } from "./rendered-share-dom.js";

export function ArtifactDownloadButton({ ownerKey, connectionOwner, action, label, errorLabel, iconOnly, className, tone, disabled, children }: {
  readonly ownerKey: string;
  readonly connectionOwner: unknown;
  readonly action: (context: ArtifactDownloadContext) => Promise<unknown> | unknown;
  readonly label: string;
  readonly errorLabel: string;
  readonly iconOnly?: boolean;
  readonly className?: string;
  readonly tone?: ComponentProps<typeof Button>["tone"];
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  const download = useArtifactDownload(ownerKey, connectionOwner);
  const props = {
    className,
    disabled,
    [RENDERED_SHARE_EXCLUDE_ATTRIBUTE]: "",
    "aria-disabled": disabled === true || download.pending,
    "aria-busy": download.pending,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => download.run(event.currentTarget.ownerDocument, action)
  };
  return <>
    {iconOnly ? <IconButton {...props} label={label}><Download aria-hidden="true" /></IconButton>
      : <Button {...props} tone={tone} title={disabled ? errorLabel : label}>{children ?? <><Download aria-hidden="true" />{label}</>}</Button>}
    {download.failed && <span {...{ [RENDERED_SHARE_EXCLUDE_ATTRIBUTE]: "" }} className="danger-text" role="alert">{errorLabel}</span>}
  </>;
}
