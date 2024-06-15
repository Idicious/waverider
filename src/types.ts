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

export interface WaveShaperState {
  intervals: Interval[];
  tracks: Track[];
}

export type DragFn<TItem> = (
  e: d3.D3DragEvent<any, TItem, any>,
  d: TItem,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) => void | BindData;

export type ClickFn<TItem> = (
  e: MouseEvent,
  d: TItem,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) => void | BindData;

export type MouseOverFn<TItem> = (
  e: MouseEvent,
  d: TItem,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) => void | BindData;

export type UpdateFn<T extends WaveShaperState> = (
  state: T
) => [T, BindData | undefined];

export interface BoundData<T = any> {
  type: string;
  data: T;
}

export interface BindData {
  type?: string;
  filterFn?: (d: any) => boolean;
}

export interface RegisterableType<
  TState extends WaveShaperState,
  TCollection extends Array<TItem>,
  TItem
> {
  type: string;
  stateSelector: (state: TState) => TCollection;
  keyFn: (d: TItem) => string;
  bind: (
    selection: d3.Selection<any, TItem, any, any>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>,
    updateFilter: (d: TItem) => boolean
  ) => void;
  render: (
    selection: d3.Selection<any, TItem, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean
  ) => void;
  dragMap: Map<string, DragFn<TItem>>;
  dragStartMap: Map<string, DragFn<TItem>>;
  dragEndMap: Map<string, DragFn<TItem>>;
  clickMap: Map<string, ClickFn<TItem>>;
  mouseOverMap: Map<string, MouseOverFn<TItem>>;
}
