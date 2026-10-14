export function mobileTaskHeaderLayout(input: {
  readonly platform: string;
  readonly barEdge: "none" | "left" | "right";
  readonly persistent: boolean;
  readonly selection: boolean;
  readonly partner: boolean;
  readonly drawerMounted: boolean;
}): "horizontal" | "rail" | "inline" | "selection" | "hidden" {
  if (input.selection) return "selection";
  if (input.platform !== "ios" || input.partner) return "inline";
  if (input.drawerMounted) return "hidden";
  if (input.barEdge !== "none") return "rail";
  return input.persistent ? "inline" : "horizontal";
}

export function mobileTaskHeaderTitleWidth(width: number, quickSwitch: boolean, detailsOnly: boolean): number {
  return Math.max(0, Math.min(240, width - 40 - 44 * ((quickSwitch ? 5 : 4) - (detailsOnly ? 2 : 0))
    - (quickSwitch ? 8 : 0) - 16));
}
