import * as d3 from "d3";
import {
  WaveShapeRenderer,
  Interval,
  WaveShaperState,
  UpdateFn,
  BoundData,
  Predicate,
} from "../types";
import { BIND_ATTR } from "../bind";
import { ALWAYS, invertYScale } from "../utils";

const INTERVAL_RENDERER_TYPE = "interval";
const INTERVAL_TYPE = "interval";
const RESIZE_LEFT_TYPE = "resize-left";
const RESIZE_RIGHT_TYPE = "resize-right";
const RESIZE_HANDLE_WIDTH = 5;
const DEFAULT_COLOR = "steelblue";

const MOUSE_CURSOR = {
  [INTERVAL_TYPE]: "move",
  [RESIZE_LEFT_TYPE]: "ew-resize",
  [RESIZE_RIGHT_TYPE]: "ew-resize",
  default: "default",
} as Record<string, string>;

/**
 * The interval renderer is responsible for rendering the audio intervals on the canvas.
 * These are segments of audio when can be dragged, resized, cut and moved around within the same horizontal plane which represents a track,
 * as well as across different tracks.
 */
export class IntervalRenderer extends WaveShapeRenderer {
  TYPE = INTERVAL_RENDERER_TYPE;

  #filterFn: Predicate = ALWAYS;
  #bindFilter = { type: this.TYPE } as const;

  constructor(
    private readonly bindFn: (data: Interval, type: string) => string,
    private readonly updateState: (fn: UpdateFn<WaveShaperState>) => void,
    private readonly canvas: HTMLCanvasElement
  ) {
    super();
  }

  onDrag(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<Interval>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) {
    switch (d.type) {
      case INTERVAL_TYPE: {
        dragInterval(e, d.data, xScale, yScale);
        break;
      }
      case RESIZE_LEFT_TYPE: {
        resizeLeft(e, d.data, xScale, yScale);
        break;
      }
      case RESIZE_RIGHT_TYPE: {
        resizeRight(e, d.data, xScale, yScale);
        break;
      }
    }

    return this.#bindFilter;
  }

  onDragStart(_: d3.D3DragEvent<any, any, any>, d: BoundData<Interval>) {
    switch (d.type) {
      case INTERVAL_TYPE: {
        this.#filterFn = (i: Interval) => i.track === d.data.track;
        this.updateState((state) => {
          const index = d3.max(state.intervals, (i) => i.index) ?? 1;
          d.data.index = index + 1;

          return [state, this.#bindFilter];
        });
        break;
      }
    }
  }
  onDragEnd(_: d3.D3DragEvent<any, Interval, any>, d: BoundData<Interval>) {
    switch (d.type) {
      case INTERVAL_TYPE: {
        this.#filterFn = ALWAYS;
        break;
      }
    }
  }

  onClick(
    e: MouseEvent,
    d: BoundData<Interval>,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>
  ) {
    // TODO: implement cut interval

    switch (d.type) {
      case INTERVAL_TYPE:
        this.cutInterval(e, d.data, xScale);
        break;
    }
  }

  onMouseOver(
    _: MouseEvent,
    d: BoundData<Interval> | undefined,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>
  ) {
    const cursor = MOUSE_CURSOR[d?.type ?? "default"];
    this.canvas.style.cursor = cursor ?? "default";
  }

  bind(
    selection: d3.Selection<HTMLElement, any, any, any>,
    state: WaveShaperState,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>
  ) {
    return selection
      .selectAll<any, Interval>(`custom.${this.TYPE}`)
      .data(state.intervals, (d) => d.id)
      .join(
        (enter) => {
          const container = enter
            .append("custom")
            .attr("class", INTERVAL_TYPE)
            .attr("x", (d) => xScale(actualStart(d)))
            .attr("y", (d) => yScale(d.track)!)
            .attr("width", (d) => getIntervalWidth(d, xScale))
            .attr("height", yScale.bandwidth())
            .attr(
              "fill",
              (d) =>
                state.tracks.find((t) => t.id === d.track)?.color ??
                DEFAULT_COLOR
            )
            .attr(BIND_ATTR, (d) => this.bindFn(d, INTERVAL_TYPE))
            .each(function (d) {
              d.summary = [];
            });

          container
            .append("custom")
            .attr("class", RESIZE_LEFT_TYPE)
            .attr(BIND_ATTR, (d) => this.bindFn(d, RESIZE_LEFT_TYPE));

          container
            .append("custom")
            .attr("class", RESIZE_RIGHT_TYPE)
            .attr(BIND_ATTR, (d) => this.bindFn(d, RESIZE_RIGHT_TYPE));

          return container;
        },
        (update) => {
          update
            .filter(this.#filterFn)
            .attr("x", (d) => xScale(actualStart(d)))
            .attr("y", (d) => yScale(d.track)!)
            .attr(
              "fill",
              (d) =>
                state.tracks.find((t) => t.id === d.track)?.color ??
                DEFAULT_COLOR
            )
            .attr("width", (d) => getIntervalWidth(d, xScale))
            .each(function (d) {
              d.summary = [];
            });

          return update;
        },
        (exit) => exit.remove()
      )
      .sort((a, b) => a.index - b.index);
  }

  render(
    selection: d3.Selection<HTMLElement, any, any, any>,
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean
  ) {
    return selection
      .selectAll<any, Interval>(`custom.${this.TYPE}`)
      .each(function (d) {
        const node = d3.select(this);
        const resizeLeft = node.select(`custom.${RESIZE_LEFT_TYPE}`);
        const resizeRight = node.select(`custom.${RESIZE_RIGHT_TYPE}`);

        const fillUniqueColor = node.attr(BIND_ATTR);
        const resizeLeftUniqueColor = resizeLeft.attr(BIND_ATTR);
        const resizeRightUniqueColor = resizeRight.attr(BIND_ATTR);

        const fillColor = toHidden ? fillUniqueColor : node.attr("fill");
        const waveColor = toHidden ? fillUniqueColor : "black";
        const resizeLeftColor = toHidden ? resizeLeftUniqueColor : "black";
        const resizeRightColor = toHidden ? resizeRightUniqueColor : "black";

        const x = Math.round(+node.attr("x"));
        const y = Math.round(+node.attr("y"));
        const width = Math.round(+node.attr("width"));
        const height = Math.round(+node.attr("height"));

        // background
        context.fillStyle = fillColor;
        context.fillRect(x, y, width, height);

        // audio waveform, not interactive so only render to display canvas
        if (toHidden === false) {
          renderWave(
            d.summary ?? [],
            height,
            Math.max(0, x),
            y,
            context,
            waveColor
          );
        }

        // left resize handle
        context.fillStyle = resizeLeftColor;
        context.fillRect(x, y, RESIZE_HANDLE_WIDTH, height);

        // right resize handle
        context.fillStyle = resizeRightColor;
        context.fillRect(
          x + width - RESIZE_HANDLE_WIDTH,
          y,
          RESIZE_HANDLE_WIDTH,
          height
        );
      });
  }

  cutInterval(
    e: MouseEvent,
    data: Interval,
    xScale: d3.ScaleLinear<number, number>
  ) {
    if (e.metaKey) {
      // get the x position of the click
      const [x, y] = d3.pointer(e);
      const timeCut = xScale.invert(x);

      // create a new interval
      let newInterval = {
        start: data.start,
        offsetStart: timeCut - data.start,
        end: data.end,
        index: data.index,
        track: data.track,
        data: data.data,
        id: crypto.randomUUID(),
      };

      // update existing interval
      data.end = timeCut;

      this.updateState((state) => {
        state.intervals.push(newInterval);
        return [state, this.#bindFilter];
      });
    }
  }
}

export function renderWave(
  data: [number, number][],
  height: number,
  x: number,
  y: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  color: string
) {
  const scale = height / 2;
  const width = data.length;
  const end = x + width;

  const center = y + scale;

  ctx.fillStyle = color;
  const region = new Path2D();

  region.moveTo(x, center);
  for (let i = 0; i < width; i++) {
    region.lineTo(i + x, Math.round(data[i][0] * scale + center));
  }
  region.lineTo(end, center);

  region.moveTo(x, center);
  for (let i = 0; i < width; i++) {
    region.lineTo(i + x, Math.round(data[i][1] * scale + center));
  }
  region.lineTo(end, center);
  region.closePath();

  ctx.fill(region);
}

function getIntervalWidth(d: Interval, xScale: d3.ScaleLinear<number, number>) {
  return xScale(d.end) - xScale(actualStart(d));
}

function actualStart(d: Interval) {
  return d.start + d.offsetStart;
}

function dragInterval(
  event: d3.D3DragEvent<any, Interval, any>,
  data: Interval,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) {
  // change track is dragged past the track boundary
  const newTrack = invertYScale(yScale, event.sourceEvent.offsetY);
  if (newTrack && data.track !== newTrack) {
    data.track = newTrack;
  }

  let dx = xScale.invert(event.dx) - xScale.invert(0);
  const start = actualStart(data);

  // Prevent dragging the interval to a negative value
  if (start + dx < 0) dx = -start;

  data.start = data.start + dx;
  data.end = data.end + dx;
}

function resizeLeft(
  event: d3.D3DragEvent<any, Interval, any>,
  data: Interval,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) {
  const start = actualStart(data);

  let dx = xScale.invert(event.dx) - xScale.invert(0);

  // Prevent dragging past the end
  if (start + dx > data.end) {
    dx = data.end - start;
  }
  // Prevent dragging past the start
  else if (data.offsetStart + dx < 0) {
    dx = -data.offsetStart;
  }
  // Prevent dragging into negative value
  else if (start + dx < 0) dx = -start;

  data.offsetStart = data.offsetStart + dx;
}

function resizeRight(
  event: d3.D3DragEvent<any, Interval, any>,
  data: Interval,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleBand<string>
) {
  const start = actualStart(data);

  let dx = xScale.invert(event.dx) - xScale.invert(0);

  // Prevent dragging past start
  if (start > data.end + dx) {
    data.end = start;
  } else {
    data.end = data.end + dx;
  }
}
