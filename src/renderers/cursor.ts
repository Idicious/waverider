import { BindData, BoundData, Renderer } from "../types";
import { TYPES as AutomationTypes } from "./automation";
import { TYPES as IntervalTypes } from "./interval";

const MOUSE_CURSOR = {
  [AutomationTypes.AUTOMATION_HANDLE]: "move",
  [IntervalTypes.INTERVAL]: "move",
  [IntervalTypes.RESIZE_LEFT]: "ew-resize",
  [IntervalTypes.RESIZE_RIGHT]: "ew-resize",
  [IntervalTypes.FADE_IN]: "col-resize",
  [IntervalTypes.FADE_OUT]: "col-resize",
  default: "default",
} as Record<string, string>;

export const TYPES = {
  ROOT: "cursors",
} as const;

export class CursorRenderer implements Renderer {
  TYPE = TYPES.ROOT;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  onMouseOver(_: MouseEvent, d: BoundData | undefined): void | BindData {
    const cursor = MOUSE_CURSOR[d?.type ?? "default"];
    this.canvas.style.cursor = cursor ?? "default";
  }
}
