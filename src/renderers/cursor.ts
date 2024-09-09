import { BindData, BoundData, WaveShapeRenderer } from "../types";
import { INTERVAL_TYPE, RESIZE_LEFT_TYPE, RESIZE_RIGHT_TYPE } from "./interval";

const MOUSE_CURSOR = {
  [INTERVAL_TYPE]: "move",
  [RESIZE_LEFT_TYPE]: "ew-resize",
  [RESIZE_RIGHT_TYPE]: "ew-resize",
  default: "default",
} as Record<string, string>;

export class CursorRenderer extends WaveShapeRenderer {
  TYPE = "cursor";

  constructor(private readonly canvas: HTMLCanvasElement) {
    super();
  }

  override onMouseOver(
    _: MouseEvent,
    d: BoundData | undefined
  ): void | BindData {
    const cursor = MOUSE_CURSOR[d?.type ?? "default"];
    this.canvas.style.cursor = cursor ?? "default";
  }
}
