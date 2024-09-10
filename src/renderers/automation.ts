import { ScaleLinear, ScaleBand } from "d3";
import { Selection } from "d3-selection";
import { Renderer, WaveShaperState } from "../types";

export const TYPES = {
  ROOT: "automation",
  AUTOMATION_HANDLE: "automation-handle",
} as const;

export class AutomationRenderer implements Renderer {
  TYPE = TYPES.ROOT;

  bind(
    selection: Selection<any, any, any, any>,
    state: WaveShaperState,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ): void {}

  render(
    selection: Selection<any, any, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean
  ): void {}
}
