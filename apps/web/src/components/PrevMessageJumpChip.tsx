import { ArrowUp } from "lucide-react";
import type { JSX } from "react";
import { IconButton } from "./ui.js";

export function PrevMessageJumpChip({ preview, label, onClick }: {
  readonly preview: string;
  readonly label: string;
  readonly onClick: () => void;
}): JSX.Element {
  return <IconButton className="prev-message-jump" label={label} tip={preview} onClick={onClick}><ArrowUp aria-hidden="true" /></IconButton>;
}
