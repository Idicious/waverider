import * as d3 from "d3";

export interface Interval {
  id: string;
  start: number;
  offsetStart: number;
  end: number;
  index: number;
  track: string;
  data: string;
  summary?: [number, number][];
}

export interface Track {
  id: string;
  name: string;
  color: string;
}

export interface AudioData {
  id: string;
  data: Float32Array;
}

export interface WaveShaperState {
  intervals: Interval[];
  tracks: Track[];
  colorMap: Map<string, string>;
  audioData: AudioData[];
}

export type DragFn<TItem> = (
  e: d3.D3DragEvent<any, TItem, any>,
  d: BoundData<TItem>,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) => void | BindData;

export type ClickFn<TItem> = (
  e: MouseEvent,
  d: BoundData<TItem>,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) => void | BindData;

export type MouseOverFn<TItem> = (
  e: MouseEvent,
  d: BoundData<TItem> | undefined,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) => void | BindData;

export type ZoomFn = (e: d3.D3ZoomEvent<any, any>) => void;

export type UpdateFn<T extends WaveShaperState> = (
  state: T
) => [T, BindData | undefined, (() => void) | undefined];

export interface BoundData<T = any> {
  type: string;
  data: T;
}

export interface BindData {
  type: string;
}

export abstract class WaveShapeRenderer {
  abstract TYPE: string;

  abstract bind(
    selection: d3.Selection<any, any, any, any>,
    state: WaveShaperState,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ): void;

  abstract render(
    selection: d3.Selection<any, any, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean
  ): void;

  abstract onDrag(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ): void | BindData;

  abstract onDragStart(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<any>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ): void | BindData;

  abstract onDragEnd(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ): void | BindData;

  abstract onClick(
    e: MouseEvent,
    d: BoundData,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ): void | BindData;

  abstract onMouseOver(
    e: MouseEvent,
    d: BoundData | undefined,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ): void | BindData;

  abstract onZoom(e: d3.D3ZoomEvent<any, any>): void;
}

export type Predicate = (...args: any[]) => boolean;
