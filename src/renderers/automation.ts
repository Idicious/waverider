import { ScaleLinear, ScaleBand } from "d3";
import { Selection } from "d3-selection";
import { WaveShapeRenderer, WaveShaperState } from "../types";

export const TYPES = {
  ROOT: "automation",
  AUTOMATION_HANDLE: "automation-handle",
} as const;

export class AutomationRenderer extends WaveShapeRenderer {
  TYPE = TYPES.ROOT;

  override bind(
    selection: Selection<any, any, any, any>,
    state: WaveShaperState,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ): void {}

  override render(
    selection: Selection<any, any, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean
  ): void {}
}
