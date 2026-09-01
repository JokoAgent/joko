import { describe, expect, it } from "vitest";
import { sidebarListMenuPosition, sidebarSessionMenuPosition, sidebarSessionSubmenuPosition } from "./components/Sidebar.js";

describe("sidebar and settings overflow geometry", () => {
  it("flips and clamps the nested project menu independently", () => {
    expect(sidebarSessionSubmenuPosition(
      { left: 250, right: 426, top: 180 },
      { width: 224, height: 280 },
      { width: 1_280, height: 720 }
    )).toEqual({ x: 430, y: 180 });
    expect(sidebarSessionSubmenuPosition(
      { left: 1_050, right: 1_226, top: 650 },
      { width: 224, height: 280 },
      { width: 1_280, height: 720 }
    )).toEqual({ x: 822, y: 432 });
  });

  it("opens the portaled session menu beside its trigger and clamps it to the viewport", () => {
    expect(sidebarSessionMenuPosition(
      { left: 218, right: 246, top: 186 },
      { width: 180, height: 142 },
      { width: 1_280, height: 720 }
    )).toEqual({ x: 250, y: 190 });
    expect(sidebarSessionMenuPosition(
      { left: 1_190, right: 1_218, top: 650 },
      { width: 180, height: 142 },
      { width: 1_280, height: 720 }
    )).toEqual({ x: 1_006, y: 570 });
  });

  it("clamps the organizer trigger and blank-area context menu to the viewport", () => {
    expect(sidebarListMenuPosition(
      { kind: "trigger", right: 248, bottom: 153 },
      { width: 248, height: 388 },
      { width: 1_280, height: 720 }
    )).toEqual({ x: 8, y: 160 });
    expect(sidebarListMenuPosition(
      { kind: "point", x: 100, y: 470 },
      { width: 248, height: 388 },
      { width: 1_280, height: 720 }
    )).toEqual({ x: 100, y: 324 });
  });
});
