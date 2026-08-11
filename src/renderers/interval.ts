import * as d3 from "d3";
import type {
  Renderer,
  Interval,
  WaveShaperState,
  UpdateFn,
  BoundData,
  Predicate,
  AudioData,
  DirtyRect,
  ReportDirtyFn,
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

  /**
   * True while a zoom gesture is moving the view. Summaries computed in that
   * window may snap pixel edges to the summary's bucket grid for speed; the
   * gesture's end event clears this and rebinds, so what is on screen at
   * rest is always exact.
   */
  #zooming = false;

  constructor(
    private readonly bindFn: (data: Interval, type: symbol) => string,
    private readonly releaseFn: (color: string) => void,
    private readonly updateState: (fn: UpdateFn<WaveShaperState>) => void,
    private readonly hasModifier: (e: ModifierEvent) => boolean,
    /** Device pixels per CSS pixel, read fresh so a resize is picked up. */
    private readonly getPixelRatio: () => number,
    private readonly sampleRate: number,
    private readonly reportDirty: ReportDirtyFn
  ) {}

  /**
   * Report the screen region an interval's layout occupies, padded for the
   * fade handles that poke above the top edge and a pixel of antialiasing.
   * Reporting every changed layout is what lets a filtered bind - one
   * dragged interval - repaint only the pixels it actually touched.
   */
  #reportLayout(layout: IntervalLayout) {
    const margin = RESIZE_HANDLE_WIDTH + 1;
    this.reportDirty(
      layout.x - margin,
      layout.y - margin,
      layout.x + layout.width + margin,
      layout.y + layout.height + margin
    );
  }

  onStateUpdate(state: WaveShaperState) {
    this.#colorMap.clear();

    for (const track of state.tracks) {
      this.#colorMap.set(track.id, track.color);
    }
  }

  onZoom(e: d3.D3ZoomEvent<any, any>) {
    // Programmatic transforms carry no sourceEvent and never see a matching
    // end pass, so treating one as a gesture would leave summaries degraded
    // until the next real gesture settled.
    this.#zooming = e.type === "zoom" && e.sourceEvent != null;
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
      default:
        // Not this renderer's drag: requesting a rebind anyway would force
        // a re-layout of every interval on every tick of, say, an
        // automation point drag - and a repaint to go with it.
        return;
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

    // One summary bucket per *device* pixel. The scales are in CSS pixels, so
    // on a high density display that is devicePixelRatio buckets per CSS
    // pixel; summarizing per CSS pixel would draw a 1x waveform crisply
    // instead of drawing the detail the display can actually show.
    const samplesPerPixel =
      (msPerPixel * this.sampleRate) / 1000 / this.getPixelRatio();

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
          this.sampleRate,
          this.#zooming
        )
      );
    }
  }

  /** Release everything held for an interval that has gone away. */
  clearAudioCache(intervalId: string) {
    this.#drawDataCache.delete(intervalId);
    this.#audioCache.clear(intervalId);
  }

  onDiagnostics() {
    let widest = 0;
    for (const data of this.#drawDataCache.values()) {
      widest = Math.max(widest, data.length / DRAW_STRIDE);
    }

    // One bucket per device pixel, so this should track the widest interval's
    // on screen width times the device pixel ratio.
    return {
      waveformBuckets: widest,
      // 1 only mid-gesture; at rest this must read 0, or the exact
      // refinement pass never ran and approximate pixels are on screen.
      waveformApproximate: this.#zooming ? 1 : 0,
      ...this.#audioCache.diagnostics(),
    };
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

              that.#reportLayout(this.__waveShaperLayout);
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

            // both where the element was and where it is now need repainting
            that.#reportLayout(previous);
            that.#reportLayout(this.__waveShaperLayout);

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

              const layout = this.__waveShaperLayout;
              if (layout !== undefined) that.#reportLayout(layout);

              const bind = layout?.bind;
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
    state: WaveShaperState,
    clip?: DirtyRect
  ) {
    const that = this;
    return selection
      .selectAll<LayoutNode, Interval>(`custom.${TYPES.INTERVAL.description!}`)
      .each(function (d) {
        const layout = this.__waveShaperLayout;
        if (layout === undefined) return;

        // The context is clipped to the repaint region, so skipping an
        // element entirely outside it changes nothing on screen - it only
        // saves building the element's draw calls, of which the waveform
        // path is the expensive one.
        if (
          clip !== undefined &&
          (layout.x + layout.width + RESIZE_HANDLE_WIDTH < clip.x0 ||
            layout.x - RESIZE_HANDLE_WIDTH > clip.x1 ||
            layout.y + layout.height + RESIZE_HANDLE_WIDTH < clip.y0 ||
            layout.y - RESIZE_HANDLE_WIDTH > clip.y1)
        ) {
          return;
        }

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
              width,
              context,
              waveColor,
              state.configuration.showRmsBand,
              that.getPixelRatio()
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

/**
 * @param width  drawing width in CSS pixels
 * @param pixelRatio device pixels per CSS pixel; the summary holds one bucket
 *   per device pixel, so this is both the horizontal step and the grid the
 *   outline is snapped to vertically
 */
export function renderWave(
  data: DrawData,
  height: number,
  x: number,
  y: number,
  width: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  color: string,
  showRmsBand: boolean,
  pixelRatio: number
) {
  const scale = height / 2;
  const center = y + scale;

  const step = 1 / pixelRatio;
  const count = Math.min(
    Math.floor(width * pixelRatio),
    Math.floor(data.length / DRAW_STRIDE)
  );

  // Columns sit on the device pixel grid - the summary holds one bucket per
  // device pixel, so a fractional origin would smear every bucket across two
  // pixels and wash out anything one bucket wide.
  const left = Math.round(x * pixelRatio) / pixelRatio;
  const end = left + count * step;

  // Snapping keeps the outline off half-covered rows, which would otherwise
  // wash it out. It is a device pixel grid rather than a CSS one: rounding to
  // whole CSS pixels here would throw away the extra vertical precision the
  // display has, which is the whole point of summarizing this finely.
  const snap = (value: number) =>
    Math.ceil((value * scale + center) * pixelRatio) / pixelRatio;

  /**
   * A bucket must rise at least this far - in device rows - above both of
   * its neighbours before its vertex is drawn as a flat cap. Below it the
   * underdraw of a plain vertex is a fraction of a row, which no zoom level
   * can make visible.
   */
  const threshold = 2 / pixelRatio;

  /**
   * Fills between the centre line and a min/max pair of the packed summary,
   * interpolating through the bucket values exactly as it always has - with
   * one correction. A plain polygon vertex cuts an isolated extreme: the
   * fill around it is a one-pixel-wide sliver whose antialiased tip fades in
   * proportion to how far the bucket rises above its neighbours, and since
   * zooming changes the neighbours, the same transient read as a different
   * height at every zoom level. So a vertex that stands at least
   * `threshold` above both neighbours is drawn flat across its bucket's
   * full width instead, rounded outward to a whole device row: its true
   * peak row is covered completely and its height depends on its own
   * bucket alone. Everything else keeps the smooth interpolated outline -
   * capping every extreme was tried and made the whole waveform read
   * blocky, besides costing a multiple of this fill on busy audio.
   */
  const envelope = (minOffset: number, maxOffset: number) => {
    const region = new Path2D();

    const line = (
      offset: number,
      outwardSign: number,
      roundOut: typeof Math.ceil
    ) => {
      region.moveTo(left, center);

      // the path anchors to the centre line on both ends, so the missing
      // neighbours of the first and last buckets count as silence
      let previous = center;
      for (let i = 0; i < count; i++) {
        const value = data[i * DRAW_STRIDE + offset] * scale + center;
        const next =
          i + 1 < count
            ? data[(i + 1) * DRAW_STRIDE + offset] * scale + center
            : center;

        const prominent =
          outwardSign * (previous - value) >= threshold &&
          outwardSign * (next - value) >= threshold;

        if (prominent) {
          const capped =
            roundOut(value * pixelRatio) / pixelRatio;
          region.lineTo(left + i * step, capped);
          region.lineTo(left + (i + 1) * step, capped);
        } else {
          region.lineTo(left + i * step, snap(data[i * DRAW_STRIDE + offset]));
        }

        previous = value;
      }

      region.lineTo(end, center);
    };

    // canvas y grows downward: on the min side smaller y is further out, on
    // the max side larger y is - and the cap rounds outward accordingly
    line(minOffset, 1, Math.floor);
    line(maxOffset, -1, Math.ceil);
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
