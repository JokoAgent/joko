export interface MobileKeyboardFrame {
  readonly screenX: number;
  readonly screenY: number;
  readonly width: number;
  readonly height: number;
}

export function mobileKeyboardObstructionHeight(input: {
  readonly platform: "ios" | "android" | "other";
  readonly visible: boolean;
  readonly frame: MobileKeyboardFrame | null;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): number {
  const frame = input.visible ? input.frame : null;
  if (!frame || input.platform === "other") return 0;
  if (input.platform === "android") return clamp(frame.height, 0, input.viewportHeight);
  const docked = frame.width >= input.viewportWidth * 0.95;
  const reachesBottom = frame.screenY + frame.height >= input.viewportHeight - 1;
  if (!docked || !reachesBottom || frame.screenY <= 0) return 0;
  return clamp(input.viewportHeight - frame.screenY, 0, frame.height);
}

export function mobileKeyboardAvoidancePadding(
  obstructionHeight: number,
  consumedBottomInset: number,
  verticalOffset = 0
): number {
  return Math.max(0, obstructionHeight - Math.max(0, consumedBottomInset) + verticalOffset);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}
