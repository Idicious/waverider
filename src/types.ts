import * as d3 from "d3";

export type Interval = {
  id: string;
  start: number;
  offsetStart: number;
  end: number;
  index: number;
  track: string;
  data: string;
  fadeIn: number;
  fadeOut: number;
};

export type Track = {
  id: string;
  name: string;
  color: string;
};

export type AudioData = {
  id: string;
  data: Float32Array;
};

export type Automation = {};

export interface ScaleData {
  x: {
    domain: [number, number];
    range: [number, number];
  };
  y: {
    domain: string[];
    range: [number, number];
  };
}

export interface WaveShaperState {
  intervals: Interval[];
  tracks: Track[];
  automation: Automation[];
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

export type StateUpdateFn = (state: WaveShaperState) => void;

export type ZoomFn = (e: d3.D3ZoomEvent<any, any>) => void;

export type UpdateFn<T extends WaveShaperState> = (
  state: T
) => [T, BindData | undefined, (() => void) | undefined];

export interface BoundData<T = any> {
  type: symbol;
  data: T;
}

export interface BindData {
  type: symbol;
}

export type Renderer = {
  TYPE: symbol;

  onBind?: (
    selection: d3.Selection<any, any, any, any>,
    state: WaveShaperState,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) => void;

  onRender?: (
    selection: d3.Selection<any, any, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean
  ) => void;

  onStateUpdate?: (state: WaveShaperState) => void;

  onDrag?: (
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) => void;

  onDragStart?: (
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<any>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) => void;

  onDragEnd?: (
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) => void;

  onClick?: (
    e: MouseEvent,
    d: BoundData,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) => void | BindData;

  onMouseOver?: (
    e: MouseEvent,
    d: BoundData | undefined,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) => void | BindData;

  onZoom?: (e: d3.D3ZoomEvent<any, any>) => void;
};

export type Predicate = (...args: any[]) => boolean;
