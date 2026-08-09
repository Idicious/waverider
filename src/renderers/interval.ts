import * as d3 from "d3";
import type {
  Renderer,
  Interval,
  WaveShaperState,
  UpdateFn,
  BoundData,
  Predicate,
  AudioData,
} from "../types";
import {
  ALWAYS,
  getDrawValue,
  invertYScale,
  type ModifierEvent,
} from "../utils";
import { AudioSummaryCache, DRAW_STRIDE } from "../audio";
import type { DrawData } from "../audio";

export const TYPES = {
  INTERVAL: Symbol("interval"),
  RESIZE_LEFT: Symbol("resize-left"),
  RESIZE_RIGHT: Symbol("resize-right"),
  FADE_IN: Symbol("fade-in"),
  FADE_OUT: Symbol("fade-out"),
} as const;

const RESIZE_HANDLE_WIDTH = 5;
const DEFAULT_COLOR = "steelblue";

/** The bind color for each interactive part of one interval. */
type IntervalBind = {
  interval: string;
  resizeLeft: string;
  resizeRight: string;
  fadeIn: string;
  fadeOut: string;
};

/**
 * Everything the render pass needs for one interval, in CSS pixels.
 *
 * This is held as a property on the element rather than as attributes because
 * the render pass reads it twice a frame for every interval, and attributes
 * would mean serialising each number to a string and parsing it back every
 * time. Keeping the bind colors here too means the handles no longer need
 * child elements of their own.
 */
type IntervalLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  fadeInX: number;
  fadeOutX: number;
  fill: string;
  bind: IntervalBind;
};

type LayoutNode = Element & { __waveShaperLayout?: IntervalLayout };

/**
 * The interval renderer is responsible for rendering the audio intervals on the canvas.
 * These are segments of audio when can be dragged, resized, cut and moved around within the same horizontal plane which represents a track,
 * as well as across different tracks.
 */
export class IntervalRenderer implements Renderer {
  TYPE = Symbol("intervals");

  #filterFn: Predicate = ALWAYS;
  #audioCache = new AudioSummaryCache();
  #drawDataCache = new Map<string, DrawData>();
  #bindFilter = { type: this.TYPE } as const;
  #colorMap = new Map<string, string>();
  #audioDataMap = new Map<string, AudioData>();
  #audioDataSource: AudioData[] | null = null;

  #resetFilter = () => {
    this.#filterFn = ALWAYS;
  };

  constructor(
    private readonly bindFn: (data: Interval, type: symbol) => string,
    private readonly releaseFn: (color: string) => void,
    private readonly updateState: (fn: UpdateFn<WaveShaperState>) => void,
    private readonly hasModifier: (e: ModifierEvent) => boolean,
    private readonly sampleRate: number
  ) {}

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

  /**
   * Audio is looked up by id on every bind, so keep it in a map. This is
   * rebuilt on identity rather than in onStateUpdate because binding runs
   * before the state update handlers on the very first render.
   */
  #getAudioData(state: WaveShaperState, id: string) {
    if (this.#audioDataSource !== state.audioData) {
      this.#audioDataSource = state.audioData;
      this.#audioDataMap.clear();

      for (const audio of state.audioData) {
        this.#audioDataMap.set(audio.id, audio);
      }
    }

    return this.#audioDataMap.get(id);
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
    const samplesPerPixel = (msPerPixel * this.sampleRate) / 1000;
    const start = actualStart(interval);

    const msIntoInterval = Math.max(valueZero, start) - start;
    const intervalScreenDuration =
      Math.min(valueEnd, interval.end) - Math.max(valueZero, start);

    const audioData = this.#getAudioData(state, interval.data);

    // Interval is not in viewport, render nothing
    if (intervalScreenDuration <= 0 || audioData === undefined) {
      this.#drawDataCache.delete(interval.id);
    } else {
      this.#drawDataCache.set(
        interval.id,
        this.#audioCache.summarize(
          audioData.data,
          interval.id,
          msIntoInterval + interval.offsetStart,
          intervalScreenDuration,
          samplesPerPixel,
          this.sampleRate
        )
      );
    }
  }

  /** Release everything held for an interval that has gone away. */
  clearAudioCache(intervalId: string) {
    this.#drawDataCache.delete(intervalId);
    this.#audioCache.clear(intervalId);
  }

  /** Called when the owning WaveShaper is destroyed. */
  onDestroy() {
    this.#drawDataCache.clear();
    this.#audioCache.clearAll();
  }

  /** Recompute the drawing geometry for one interval. */
  #layout(
    d: Interval,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>,
    bind: IntervalBind
  ): IntervalLayout {
    return {
      x: xScale(actualStart(d)),
      y: yScale(d.track)!,
      width: getIntervalWidth(d, xScale),
      height: yScale.bandwidth(),
      fadeInX: xScale(actualStart(d) + (d.fadeIn ?? 0)),
      fadeOutX: xScale(d.end - (d.fadeOut ?? 0)),
      fill: this.#colorMap.get(d.track) ?? DEFAULT_COLOR,
      bind,
    };
  }

  onBind(
    selection: d3.Selection<HTMLElement, any, any, any>,
    state: WaveShaperState,
    xScale: d3.ScaleLinear<number, number, never>,
    yScale: d3.ScaleBand<string>
  ) {
    const that = this;

    return selection
      .selectAll<LayoutNode, Interval>(`custom.${TYPES.INTERVAL.description}`)
      .data(state.intervals, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append<LayoutNode>("custom")
            .attr("class", TYPES.INTERVAL.description!)
            .each(function (d) {
              this.__waveShaperLayout = that.#layout(d, xScale, yScale, {
                interval: that.bindFn(d, TYPES.INTERVAL),
                resizeLeft: that.bindFn(d, TYPES.RESIZE_LEFT),
                resizeRight: that.bindFn(d, TYPES.RESIZE_RIGHT),
                fadeIn: that.bindFn(d, TYPES.FADE_IN),
                fadeOut: that.bindFn(d, TYPES.FADE_OUT),
              });

              that.summarizeAudio(d, state, xScale);
            }),
        (update) => {
          // Only the filtered elements are recomputed, but the whole selection
          // is returned: the sort below is what sets z-order, and sorting a
          // subset would reorder the intervals against each other.
          update.filter(this.#filterFn).each(function (d) {
            const previous = this.__waveShaperLayout;
            if (previous === undefined) return;

            this.__waveShaperLayout = that.#layout(
              d,
              xScale,
              yScale,
              previous.bind
            );

            that.summarizeAudio(d, state, xScale);
          });

          return update;
        },
        (exit) =>
          exit
            .each(function (d) {
              // Everything keyed by interval id has to be released here or it
              // grows for the lifetime of the page.
              that.clearAudioCache(d.id);

              const bind = this.__waveShaperLayout?.bind;
              if (bind === undefined) return;

              that.releaseFn(bind.interval);
              that.releaseFn(bind.resizeLeft);
              that.releaseFn(bind.resizeRight);
              that.releaseFn(bind.fadeIn);
              that.releaseFn(bind.fadeOut);
            })
            .remove()
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
      .selectAll<LayoutNode, Interval>(`custom.${TYPES.INTERVAL.description!}`)
      .each(function (d) {
        const layout = this.__waveShaperLayout;
        if (layout === undefined) return;

        const bind = layout.bind;

        const fillColor = toHidden ? bind.interval : layout.fill;
        const waveColor = toHidden ? bind.interval : "black";
        const resizeLeftColor = toHidden ? bind.resizeLeft : "black";
        const resizeRightColor = toHidden ? bind.resizeRight : "black";
        const fadeInColor = toHidden ? bind.fadeIn : "purple";
        const fadeOutColor = toHidden ? bind.fadeOut : "purple";

        const x = getDrawValue(layout.x, toHidden);
        const y = getDrawValue(layout.y, toHidden);
        const width = getDrawValue(layout.width, toHidden);
        const height = getDrawValue(layout.height, toHidden);
        const fadeInX = getDrawValue(layout.fadeInX, toHidden);
        const fadeOutX = getDrawValue(layout.fadeOutX, toHidden);

        // background
        context.fillStyle = fillColor;
        context.fillRect(x, y, width, height);

        // audio waveform, not interactive so only render to display canvas
        if (toHidden === false) {
          const data = that.#drawDataCache.get(d.id);
          if (data !== undefined) {
            renderWave(
              data,
              height,
              Math.max(0, x),
              y,
              Math.min(Math.floor(width), data.length / DRAW_STRIDE),
              context,
              waveColor,
              state.configuration.showRmsBand
            );
          }
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
    if (this.hasModifier(e)) {
      // get the x position of the click
      const [x] = d3.pointer(e, e.currentTarget as Element);
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

/**
 * The peak outline is drawn washed out and the RMS band solid on top of it, so
 * the loud part of a pixel reads differently from its transients. With the
 * band turned off the outline is drawn solid instead - the wash only exists to
 * contrast with the band.
 */
const WAVE_PEAK_ALPHA = 0.45;

export function renderWave(
  data: DrawData,
  height: number,
  x: number,
  y: number,
  width: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  color: string,
  showRmsBand: boolean
) {
  const scale = height / 2;
  const end = x + width;

  const center = y + scale;

  /** Fills between the centre line and a min/max pair of the packed summary. */
  const envelope = (minOffset: number, maxOffset: number) => {
    const region = new Path2D();

    region.moveTo(x, center);
    for (let i = 0; i < width; i++) {
      const value = data[i * DRAW_STRIDE + minOffset];
      region.lineTo(i + x, Math.ceil(value * scale + center));
    }
    region.lineTo(end, center);

    region.moveTo(x, center);
    for (let i = 0; i < width; i++) {
      const value = data[i * DRAW_STRIDE + maxOffset];
      region.lineTo(i + x, Math.ceil(value * scale + center));
    }
    region.lineTo(end, center);
    region.closePath();

    return region;
  };

  ctx.fillStyle = color;

  if (!showRmsBand) {
    ctx.fill(envelope(0, 1));
    return;
  }

  const alpha = ctx.globalAlpha;

  ctx.globalAlpha = alpha * WAVE_PEAK_ALPHA;
  ctx.fill(envelope(0, 1));

  ctx.globalAlpha = alpha;
  ctx.fill(envelope(2, 3));
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
    context.strokeStyle = "black";
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
