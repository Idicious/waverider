import * as d3 from "d3";
import {
  Renderer,
  Interval,
  WaveShaperState,
  UpdateFn,
  BoundData,
  Predicate,
} from "../types";
import { BIND_ATTR } from "../bind";
import { ALWAYS, getDrawValue, invertYScale } from "../utils";
import { summarizeAudio } from "../audio";

export const TYPES = {
  INTERVAL: Symbol("interval"),
  RESIZE_LEFT: Symbol("resize-left"),
  RESIZE_RIGHT: Symbol("resize-right"),
  FADE_IN: Symbol("fade-in"),
  FADE_OUT: Symbol("fade-out"),
} as const;

const RESIZE_HANDLE_WIDTH = 5;
const DEFAULT_COLOR = "steelblue";

/**
 * The interval renderer is responsible for rendering the audio intervals on the canvas.
 * These are segments of audio when can be dragged, resized, cut and moved around within the same horizontal plane which represents a track,
 * as well as across different tracks.
 */
export class IntervalRenderer implements Renderer {
  TYPE = Symbol("intervals");

  #filterFn: Predicate = ALWAYS;
  #drawDataCache = new Map<string, [number, number][]>();
  #bindFilter = { type: this.TYPE } as const;
  #zoomFactor = 1;
  #colorMap = new Map<string, string>();

  #resetFilter = () => {
    this.#filterFn = ALWAYS;
  };

  constructor(
    private readonly bindFn: (data: Interval, type: symbol) => string,
    private readonly updateState: (fn: UpdateFn<WaveShaperState>) => void
  ) {}

  onZoom(e: d3.D3ZoomEvent<any, any>) {
    this.#zoomFactor = e.transform.k;
  }

  onStateUpdate(state: WaveShaperState) {
    this.#colorMap.clear();

    for (const track of state.tracks) {
      this.#colorMap.set(track.id, track.color);
    }
  }

  onDrag(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<Interval> | null,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) {
    switch (d?.type) {
      case TYPES.INTERVAL: {
        dragInterval(e, d.data, xScale, yScale);
        break;
      }
      case TYPES.RESIZE_LEFT: {
        resizeLeft(e, d.data, xScale);
        break;
      }
      case TYPES.RESIZE_RIGHT: {
        resizeRight(e, d.data, xScale, yScale);
        break;
      }
      case TYPES.FADE_IN: {
        fadeIn(e, d.data, xScale);
        break;
      }
      case TYPES.FADE_OUT: {
        fadeOut(e, d.data, xScale);
        break;
      }
    }

    return this.#bindFilter;
  }

  onDragStart(_: d3.D3DragEvent<any, any, any>, d: BoundData<Interval> | null) {
    switch (d?.type) {
      case TYPES.INTERVAL:
      case TYPES.RESIZE_LEFT:
      case TYPES.RESIZE_RIGHT:
      case TYPES.FADE_IN:
      case TYPES.FADE_OUT: {
        this.#filterFn = (i: Interval) => i.id === d.data.id;
        this.updateState((state) => {
          const index = d3.max(state.intervals, (i) => i.index) ?? 1;
          d.data.index = index + 1;

          return [state, this.#bindFilter, undefined];
        });

        break;
      }
    }
  }

  onDragEnd(
    _: d3.D3DragEvent<any, Interval, any>,
    d: BoundData<Interval> | null
  ) {
    switch (d?.type) {
      case TYPES.INTERVAL:
      case TYPES.RESIZE_LEFT:
      case TYPES.RESIZE_RIGHT:
      case TYPES.FADE_IN:
      case TYPES.FADE_OUT: {
        this.#filterFn = ALWAYS;
        break;
      }
    }
  }

  onClick(
    e: MouseEvent,
    d: BoundData<Interval> | null,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>
  ) {
    switch (d?.type) {
      case TYPES.INTERVAL:
        this.cutInterval(e, d.data, xScale);
        break;
    }
  }

  summarizeAudio(
    interval: Interval,
    state: WaveShaperState,
    xScale: d3.ScaleLinear<number, number>
  ) {
    const valueOne = xScale.invert(1);
    const valueZero = xScale.invert(0);
    const valueEnd = xScale.invert(state.configuration.width);
    const msPerPixel = valueOne - valueZero;
    const samplesPerPixel = msPerPixel * 44.1;
    const start = actualStart(interval);

    const msIntoInterval = Math.max(valueZero, start) - start;
    const intervalScreenDuration =
      Math.min(valueEnd, interval.end) - Math.max(valueZero, start);

    const audioData = state.audioData.find((a) => a.id === interval.data);

    // Interval is not in viewport, render nothing
    if (intervalScreenDuration <= 0 || audioData === undefined) {
      this.#drawDataCache.set(interval.id, []);
    } else {
      this.#drawDataCache.set(
        interval.id,
        summarizeAudio(
          audioData.data,
          interval.id,
          msIntoInterval + interval.offsetStart,
          intervalScreenDuration,
          samplesPerPixel,
          this.#zoomFactor
        )
      );
    }
  }

  onBind(
    selection: d3.Selection<HTMLElement, any, any, any>,
    state: WaveShaperState,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>
  ) {
    return selection
      .selectAll<any, Interval>(`custom.${TYPES.INTERVAL.description}`)
      .data(state.intervals, (d) => d.id)
      .join(
        (enter) => {
          const container = enter
            .append("custom")
            .attr("class", TYPES.INTERVAL.description!)
            .attr("x", (d) => xScale(actualStart(d)))
            .attr("y", (d) => yScale(d.track)!)
            .attr("width", (d) => getIntervalWidth(d, xScale))
            .attr("height", yScale.bandwidth())
            .attr("fill", (d) => this.#colorMap.get(d.track) ?? DEFAULT_COLOR)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.INTERVAL))
            .each((d) => this.summarizeAudio(d, state, xScale));

          container
            .append("custom")
            .attr("class", TYPES.RESIZE_LEFT.description!)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.RESIZE_LEFT));

          container
            .append("custom")
            .attr("class", TYPES.RESIZE_RIGHT.description!)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.RESIZE_RIGHT));

          container
            .append("custom")
            .attr("class", TYPES.FADE_IN.description!)
            .attr("x", (d) => xScale(actualStart(d) + (d.fadeIn ?? 0)))
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.FADE_IN));

          container
            .append("custom")
            .attr("class", TYPES.FADE_OUT.description!)
            .attr("x", (d) => xScale(d.end - (d.fadeOut ?? 0)))
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.FADE_OUT));

          return container;
        },
        (update) => {
          const toUpdate = update.filter(this.#filterFn);

          toUpdate
            .attr("x", (d) => xScale(actualStart(d)))
            .attr("y", (d) => yScale(d.track)!)
            .attr("fill", (d) => this.#colorMap.get(d.track) ?? DEFAULT_COLOR)
            .attr("width", (d) => getIntervalWidth(d, xScale))
            .each((d) => this.summarizeAudio(d, state, xScale));

          toUpdate
            .select(`custom.${TYPES.FADE_IN.description!}`)
            .attr("x", (d) => xScale(actualStart(d) + (d.fadeIn ?? 0)));

          toUpdate
            .select(`custom.${TYPES.FADE_OUT.description!}`)
            .attr("x", (d) => xScale(d.end - (d.fadeOut ?? 0)));

          return update;
        },
        (exit) => exit.remove()
      )
      .sort((a, b) => a.index - b.index);
  }

  onRender(
    selection: d3.Selection<HTMLElement, any, any, any>,
    context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>,
    state: WaveShaperState
  ) {
    const that = this;
    return selection
      .selectAll<any, Interval>(`custom.${TYPES.INTERVAL.description!}`)
      .each(function (d) {
        const node = d3.select(this);
        const resizeLeft = node.select(
          `custom.${TYPES.RESIZE_LEFT.description!}`
        );
        const resizeRight = node.select(
          `custom.${TYPES.RESIZE_RIGHT.description!}`
        );
        const fadeIn = node.select(`custom.${TYPES.FADE_IN.description!}`);
        const fadeOut = node.select(`custom.${TYPES.FADE_OUT.description!}`);

        const fillUniqueColor = node.attr(BIND_ATTR);
        const resizeLeftUniqueColor = resizeLeft.attr(BIND_ATTR);
        const resizeRightUniqueColor = resizeRight.attr(BIND_ATTR);
        const fadeInUniqueColor = fadeIn.attr(BIND_ATTR);
        const fadeOutUniqueColor = fadeOut.attr(BIND_ATTR);

        const fillColor = toHidden ? fillUniqueColor : node.attr("fill");
        const waveColor = toHidden ? fillUniqueColor : "black";
        const resizeLeftColor = toHidden ? resizeLeftUniqueColor : "black";
        const resizeRightColor = toHidden ? resizeRightUniqueColor : "black";
        const fadeInColor = toHidden ? fadeInUniqueColor : "purple";
        const fadeOutColor = toHidden ? fadeOutUniqueColor : "purple";

        const x = getDrawValue(+node.attr("x"), toHidden);
        const y = getDrawValue(+node.attr("y"), toHidden);
        const width = getDrawValue(+node.attr("width"), toHidden);
        const height = getDrawValue(+node.attr("height"), toHidden);
        const fadeInX = getDrawValue(+fadeIn.attr("x"), toHidden);
        const fadeOutX = getDrawValue(+fadeOut.attr("x"), toHidden);

        // background
        context.fillStyle = fillColor;
        context.fillRect(x, y, width, height);

        // audio waveform, not interactive so only render to display canvas
        if (toHidden === false) {
          const data = that.#drawDataCache.get(d.id) ?? [];
          renderWave(
            data,
            height,
            Math.max(0, x),
            y,
            Math.min(Math.floor(width), data.length),
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

        renderFades(
          context,
          toHidden,
          state.configuration.showAutomation,
          x,
          y,
          width,
          height,
          fadeInX,
          fadeOutX,
          fadeInColor,
          fadeOutColor
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
        fadeIn: 0,
        fadeOut: Math.min(data.fadeOut, data.end - timeCut),
        id: crypto.randomUUID(),
      };

      // update existing interval
      data.end = timeCut;
      data.fadeOut = 0;
      data.fadeIn = Math.min(data.fadeIn, timeCut - data.start);

      this.#filterFn = (i: Interval) => i.id === data.id;
      this.updateState((state) => {
        state.intervals.push(newInterval);
        return [state, this.#bindFilter, this.#resetFilter];
      });
    }
  }
}

export function renderWave(
  data: [number, number][],
  height: number,
  x: number,
  y: number,
  width: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  color: string
) {
  const scale = height / 2;
  const end = x + width;

  const center = y + scale;

  ctx.fillStyle = color;
  const region = new Path2D();

  region.moveTo(x, center);
  for (let i = 0; i < width; i++) {
    region.lineTo(i + x, Math.ceil(data[i][0] * scale + center));
  }
  region.lineTo(end, center);

  region.moveTo(x, center);
  for (let i = 0; i < width; i++) {
    region.lineTo(i + x, Math.ceil(data[i][1] * scale + center));
  }
  region.lineTo(end, center);
  region.closePath();

  ctx.fill(region);
}

function renderFades(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  toHidden: boolean,
  renderAutomation: boolean,
  x: number,
  y: number,
  width: number,
  height: number,
  fadeInX: number,
  fadeOutX: number,
  fadeInColor: string,
  fadeOutColor: string
) {
  if (toHidden === false) {
    // background
    context.fillStyle = "rgba(0,0,0,0.2)";
    context.fillRect(x, y, fadeInX - x, height);

    // line
    context.beginPath();
    context.moveTo(x, y + height);
    context.lineTo(fadeInX, y);
    context.closePath();
    context.stroke();

    // background
    context.fillStyle = "rgba(0,0,0,0.2)";
    context.fillRect(fadeOutX, y, x + width - fadeOutX, height);

    // line
    context.beginPath();
    context.moveTo(fadeOutX, y);
    context.lineTo(x + width, y + height);
    context.closePath();
    context.stroke();

    if (!renderAutomation) {
      context.fillStyle = fadeInColor;
      context.beginPath();
      context.arc(fadeInX, y, RESIZE_HANDLE_WIDTH, 0, 2 * Math.PI);
      context.fill();

      context.fillStyle = fadeOutColor;
      context.beginPath();
      context.arc(fadeOutX, y, RESIZE_HANDLE_WIDTH, 0, 2 * Math.PI);
      context.fill();
    }
  } else {
    if (!renderAutomation) {
      context.fillStyle = fadeInColor;
      context.fillRect(
        fadeInX - RESIZE_HANDLE_WIDTH,
        y - RESIZE_HANDLE_WIDTH,
        RESIZE_HANDLE_WIDTH * 2,
        RESIZE_HANDLE_WIDTH * 2
      );

      context.fillStyle = fadeOutColor;
      context.fillRect(
        fadeOutX - RESIZE_HANDLE_WIDTH,
        y - RESIZE_HANDLE_WIDTH,
        RESIZE_HANDLE_WIDTH * 2,
        RESIZE_HANDLE_WIDTH * 2
      );
    }
  }
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
  xScale: d3.ScaleLinear<number, number>
) {
  const start = actualStart(data);

  let dx = xScale.invert(event.dx) - xScale.invert(0);

  // Prevent dragging past the end
  if (start + data.fadeIn + dx > data.end - data.fadeOut) {
    dx = data.end - data.fadeOut - start - data.fadeIn;
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
  const start = actualStart(data) + data.fadeIn;
  const end = data.end - data.fadeOut;

  let dx = xScale.invert(event.dx) - xScale.invert(0);

  // Prevent dragging past start
  if (start > end + dx) {
    data.end = start + data.fadeOut;
  } else {
    data.end = data.end + dx;
  }
}

function fadeIn(
  event: d3.D3DragEvent<any, Interval, any>,
  data: Interval,
  xScale: d3.ScaleLinear<number, number>
) {
  const start = actualStart(data);
  const time = Math.max(0, xScale.invert(event.x) - start);
  const fadeOutStart = data.end - start - data.fadeOut;

  // restrict fade in to between 0 and fade out start
  data.fadeIn = Math.max(0, Math.min(time, fadeOutStart));
}

function fadeOut(
  event: d3.D3DragEvent<any, Interval, any>,
  data: Interval,
  xScale: d3.ScaleLinear<number, number>
) {
  const time = Math.max(0, data.end - xScale.invert(event.x));
  const fadeInEnd = actualStart(data) + (data.fadeIn ?? 0);

  // restrict fade out to between 0 and fade in end
  data.fadeOut = Math.max(0, Math.min(time, data.end - fadeInEnd));
}
