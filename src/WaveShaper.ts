import * as d3 from "d3";
import EventEmitter from "eventemitter3";
import {
  BindColorAllocator,
  numberToRGBString,
  rgbStringToNumber,
  toBindColor,
} from "./bind";
import { IntervalRenderer } from "./renderers/interval";
import type {
  BindData,
  BoundData,
  ClickFn,
  DragFn,
  MouseOverFn,
  StateUpdateFn,
  UpdateFn,
  Renderer,
  WaveShaperState,
  ZoomFn,
  DirtyRect,
  SelectFn,
} from "./types";
import { CursorRenderer } from "./renderers/cursor";
import { getDomainInMs } from "./zoom";
import { AutomationRenderer } from "./renderers/automation";
import {
  getPlatformModifierKey,
  getSelection,
  hasModifier,
  type ModifierEvent,
} from "./utils";

export class WaveShaper {
  #ee = new EventEmitter();

  /**
   * Nothing in the scene animates on its own, so the render loop only paints
   * when something has actually changed - and only where. The dirty region
   * accumulates in CSS pixels until the next paint consumes it; null means
   * clean. Every mutation ends in a "bind" emit, which is where it gets
   * raised: to the whole render area by default, or to just the regions the
   * responsible renderer reported for a type-filtered bind. The selection
   * rectangle is the one exception and marks itself.
   */
  #dirtyRegion: DirtyRect | null = null;
  #hiddenDirty = true;

  /**
   * Regions reported by renderers during the bind currently being emitted;
   * null outside one. See #emitBind.
   */
  #bindReports: Array<{ rect: DirtyRect; hitPixels: boolean }> | null = null;

  /** Last zoom transform seen, for recognising pure-translation gestures. */
  #lastTransform: { k: number; x: number } | null = null;

  /**
   * Pan distance the blits have not yet shown, in CSS pixels. Shifts move by
   * whole device pixels, so each tick leaves a sub-pixel remainder; carrying
   * it forward keeps the shifted canvas within half a device pixel of the
   * true view no matter how many fractional deltas arrive, where discarding
   * it froze the canvas outright on devices that pan in sub-pixel steps.
   */
  #panResidual = 0;

  /** Whichever modifier the configuration resolves to right now. */
  get modifierKey() {
    return this.state.configuration.modifierKey ?? getPlatformModifierKey();
  }

  #hasModifier = (e: ModifierEvent) => hasModifier(e, this.modifierKey);

  #drag = d3
    .drag<HTMLCanvasElement, unknown>()
    .filter((event) => !this.#hasModifier(event))
    .on("drag.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;

      this.#onDrag.forEach((fn) => {
        const bindData = fn(e, this.#dragData, this.#xScale, this.#yScale);
        bindData && this.#emitBind(bindData);
      });
    })
    .on("start.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;
      this.#dragData = this.getTargetElement(e);

      this.#onDragStart.forEach((fn) => {
        const bindData = fn(e, this.#dragData, this.#xScale, this.#yScale);
        bindData && this.#emitBind(bindData);
      });
    })
    .on("end.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;

      this.#onDragEnd.forEach((fn) => {
        const bindData = fn(e, this.#dragData, this.#xScale, this.#yScale);
        bindData && this.#emitBind(bindData);
      });

      this.#dragData = null;
    })
    .on("drag.select", (e: d3.D3DragEvent<any, any, any>) => {
      if (!e.sourceEvent.shiftKey) return;
      if (!this.#selecting) return;

      this.#selectionEnd = d3.pointer(e, this.canvas);
      this.invalidate();

      this.#onSelect.forEach((fn) => {
        const bindData = fn(
          e,
          getSelection(this.#selectionStart!, this.#selectionEnd!),
          this.#xScale,
          this.#yScale
        );
        bindData && this.#emitBind(bindData);
      });
    })
    .on("start.select", (e: d3.D3DragEvent<any, any, any>) => {
      if (!e.sourceEvent.shiftKey) return;

      this.#selecting = true;
      this.#selectionStart = d3.pointer(e, this.canvas);
      this.#selectionEnd = this.#selectionStart;
      this.invalidate();

      this.#onSelectStart.forEach((fn) => {
        const bindData = fn(
          e,
          getSelection(this.#selectionStart!, this.#selectionEnd!),
          this.#xScale,
          this.#yScale
        );

        bindData && this.#emitBind(bindData);
      });
    })
    .on("end.select", (e: d3.D3DragEvent<any, any, any>) => {
      if (!e.sourceEvent.shiftKey) return;
      this.#selectionEnd = d3.pointer(e, this.canvas);

      this.#onSelectEnd.forEach((fn) => {
        const bindData = fn(
          e,
          getSelection(this.#selectionStart!, this.#selectionEnd!),
          this.#xScale,
          this.#yScale
        );
        bindData && this.#emitBind(bindData);
      });

      this.#selectionStart = null;
      this.#selectionEnd = null;
      this.#selecting = false;
      this.invalidate();
    });

  #zoom = d3
    .zoom<HTMLCanvasElement, unknown>()
    .filter((e) => this.#hasModifier(e))
    // d3's default wheelDelta multiplies by ten whenever ctrlKey is held,
    // because browsers report trackpad pinch as a ctrl+wheel gesture with tiny
    // deltas. Ctrl is our ordinary zoom modifier everywhere except macOS, so
    // that boost would make one wheel notch zoom ten times further on Linux and
    // Windows than the same notch does on a Mac. This is d3's formula with the
    // ctrlKey term dropped, so a notch means the same thing on every platform.
    .wheelDelta(
      (e: WheelEvent) =>
        -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002)
    )
    // A non-positive scale factor would mirror or collapse the view; there is
    // no upper bound worth imposing, the audio just runs out.
    .scaleExtent([Number.MIN_VALUE, Infinity])
    .translateExtent([
      [0, 0],
      [Infinity, Infinity],
    ])
    // Seed the transform tracker as the gesture begins, so its very first
    // tick can already tell a pure translation from a zoom.
    .on("start", (e: d3.D3ZoomEvent<any, any>) => {
      this.#lastTransform = { k: e.transform.k, x: e.transform.x };
      this.#panResidual = 0;
    })
    .on("zoom", (e: d3.D3ZoomEvent<any, any>) => {
      const previous = this.#lastTransform;
      this.#lastTransform = { k: e.transform.k, x: e.transform.x };

      this.#xScale = e.transform.rescaleX(this.#xScaleOriginal);

      this.#onZoom.forEach((fn) => fn(e));

      // A gesture that only translates moves every pixel already on screen:
      // shift them and repaint just the strip the shift exposed. Zooming
      // changes what every pixel means, so it keeps the full repaint.
      const translation =
        e.sourceEvent != null &&
        previous !== null &&
        e.transform.k === previous.k;

      if (translation && this.#panShift(e.transform.x - previous.x)) {
        this.#emitBind(undefined, true);
      } else {
        // a full repaint draws the true view, absorbing any pan remainder
        this.#panResidual = 0;
        this.#emitBind();
      }
    })
    // Fires when the gesture settles - mouseup, touchend, or the wheel going
    // idle. Renderers that degrade quality while the view is in motion use
    // this pass to refine, so it rebinds even though the scale is unchanged.
    //
    // Programmatic transforms fire end too, with no sourceEvent - those come
    // from #setView, which computes at full quality and emits its own bind,
    // so refining behind it would only repeat a full pass per call.
    .on("end", (e: d3.D3ZoomEvent<any, any>) => {
      if (e.sourceEvent == null) return;

      this.#onZoom.forEach((fn) => fn(e));
      this.#emitBind();
    });

  #selecting = false;
  #selectionStart: [number, number] | null = null;
  #selectionEnd: [number, number] | null = null;

  #onSelectStart: Array<SelectFn> = [];
  #onSelect: Array<SelectFn> = [];
  #onSelectEnd: Array<SelectFn> = [];

  #xScaleOriginal!: d3.ScaleLinear<number, number>;
  #xScale!: d3.ScaleLinear<number, number>;

  #yScale!: d3.ScaleBand<string>;

  #hiddenCanvas!: OffscreenCanvas;
  #hiddenCanvasDraw!: OffscreenCanvas;
  /** Spare buffer the pan fast path shifts into, then swaps with the draw buffer. */
  #scratchCanvas!: OffscreenCanvas;

  // canvas contexts
  #ctxHidden!: OffscreenCanvasRenderingContext2D;
  #ctxHiddenDraw!: OffscreenCanvasRenderingContext2D;
  #ctxScratch!: OffscreenCanvasRenderingContext2D;
  #ctx!: CanvasRenderingContext2D;

  #typeRoots = new Map<symbol, d3.Selection<HTMLElement, any, any, any>>();
  #bindMap = new Map<number, { type: symbol; data: unknown }>();
  #bindColors = new BindColorAllocator();
  #onDrag: Array<DragFn<any>> = [];
  #onDragStart: Array<DragFn<any>> = [];
  #onDragEnd: Array<DragFn<any>> = [];
  #onClick: Array<ClickFn<any>> = [];
  #onMouseOver: Array<MouseOverFn<any>> = [];
  #onStateUpdate: Array<StateUpdateFn> = [];
  #onZoom: Array<ZoomFn> = [];
  #onDestroy: Array<() => void> = [];
  #onDiagnostics: Array<() => Record<string, number>> = [];
  #dragData: BoundData | null = null;

  /** Backing store size, in device pixels. */
  #width!: number;
  #height!: number;
  /** Real value is set by #resizeCanvases before anything binds or renders. */
  #dpr = 1;

  #raf: number | null = null;
  #destroyed = false;
  /** Fires on destroy, which is what detaches the DOM listeners below. */
  #abort = new AbortController();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly autoContext: AudioContext,
    private state: WaveShaperState
  ) {
    canvas.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal: this.#abort.signal,
    });

    // Every path that changes what is on screen ends up going through
    // #emitBind, which raises the dirty region - there is deliberately no
    // listener here, so a bind can dirty less than the whole area.

    const config = state.configuration;
    this.#yScale = d3
      .scaleBand()
      .domain(d3.map(state.tracks, (d) => d.id))
      .range([0, config.trackHeight * state.tracks.length])
      .padding(0.1);

    this.#xScaleOriginal = d3
      .scaleLinear()
      .domain(
        getDomainInMs(
          config.scrollPosition,
          config.samplesPerPixel,
          this.autoContext.sampleRate,
          config.width
        )
      )
      .range([0, config.width]);

    this.#xScale = this.#xScaleOriginal.copy();

    d3.select(canvas)
      .call(this.#drag)
      .call(this.#zoom)
      .on("click", (e) => {
        const target = this.getTargetElement(e);

        this.#onClick.forEach((fn) => {
          const bindData = fn(e, target, this.#xScale, this.#yScale);
          bindData && this.#emitBind(bindData);
        });
      })
      .on("mousemove", (e) => {
        const target = this.getTargetElement(e);

        this.#onMouseOver.forEach((fn) => {
          const bindData = fn(e, target, this.#xScale, this.#yScale);
          bindData && this.#emitBind(bindData);
        });
      });

    this.registerRenderer(
      new IntervalRenderer(
        this.bindData.bind(this),
        this.releaseBindData.bind(this),
        this.updateState.bind(this),
        this.#hasModifier,
        () => this.#dpr,
        this.autoContext.sampleRate,
        this.#reportDirty
      )
    );

    this.registerRenderer(new CursorRenderer(canvas));
    this.registerRenderer(
      new AutomationRenderer(
        canvas,
        this.bindData.bind(this),
        this.releaseBindData.bind(this),
        this.updateState.bind(this),
        this.#hasModifier,
        this.#reportDirty
      )
    );

    this.#ee.on("render", (toHidden = false) => {
      // The selection rectangle is not interactive, so it must stay off the
      // hit canvas - and this handler draws into the display buffer, which a
      // hidden pass does not clear.
      if (toHidden) return;

      if (this.#selecting) {
        this.#ctxHiddenDraw.fillStyle = "rgba(0, 0, 0, 0.1)";
        this.#ctxHiddenDraw.fillRect(
          this.#selectionStart![0],
          this.#selectionStart![1],
          this.#selectionEnd![0] - this.#selectionStart![0],
          this.#selectionEnd![1] - this.#selectionStart![1]
        );
      }
    });

    this.updateState(() => [state, undefined, undefined], true);
  }

  getState() {
    const { audioData, ...state } = this.state;
    return state;
  }

  /**
   * Counts worth watching in a long running session: boundElements should
   * track the number of interactive things on screen, not the number that
   * have ever existed.
   */
  getDiagnostics() {
    const fromRenderers = Object.assign(
      {},
      ...this.#onDiagnostics.map((fn) => fn())
    ) as Record<string, number>;

    return {
      boundElements: this.#bindMap.size,
      running: this.#raf !== null,
      pixelRatio: this.#dpr,
      lastPaintFraction: this.#lastPaintFraction,
      ...fromRenderers,
    };
  }

  getScaleData() {
    return {
      x: {
        domain: this.#xScale.domain(),
        range: this.#xScale.range(),
      },
      y: {
        domain: this.#yScale.domain(),
        range: this.#yScale.range(),
        padding: this.#yScale.padding(),
      },
    };
  }

  /**
   * Zoom to given level and scroll position
   * @param samplesPerPixel Zoom level in terms of samples per pixel
   * @param scrollPositionInMs Left bound of the view in milliseconds
   */
  zoom(samplesPerPixel: number, scrollPositionInMs: number) {
    const width = this.state.configuration.width;
    const [startMs, endMs] = getDomainInMs(
      scrollPositionInMs,
      samplesPerPixel,
      this.autoContext.sampleRate,
      width
    );

    this.#setView(startMs, endMs, width);
  }

  updateState(fn: UpdateFn<WaveShaperState>, initialize = false) {
    const [state, bindData, cb] = fn(this.state);
    this.state = state;
    initialize && this.#resizeCanvases();

    this.#emitBind(bindData);

    cb?.();

    this.#onStateUpdate.forEach((fn) => fn(this.state));
  }

  registerRenderer<T extends Renderer>(register: T) {
    if (this.#typeRoots.has(register.TYPE))
      throw new Error(`Type already registered: ${register.TYPE.description}`);

    if (
      (register.onRender && !register.onBind) ||
      (!register.onRender && register.onBind)
    ) {
      throw new Error(
        `Renderer must implement both bind and render methods or neither`
      );
    }

    register.onDrag && this.#onDrag.push(register.onDrag.bind(register));
    register.onDragStart &&
      this.#onDragStart.push(register.onDragStart.bind(register));
    register.onDragEnd &&
      this.#onDragEnd.push(register.onDragEnd.bind(register));
    register.onClick && this.#onClick.push(register.onClick.bind(register));
    register.onMouseOver &&
      this.#onMouseOver.push(register.onMouseOver.bind(register));
    register.onZoom && this.#onZoom.push(register.onZoom.bind(register));
    register.onStateUpdate &&
      this.#onStateUpdate.push(register.onStateUpdate.bind(register));
    register.onDestroy && this.#onDestroy.push(register.onDestroy.bind(register));
    register.onDiagnostics &&
      this.#onDiagnostics.push(register.onDiagnostics.bind(register));
    register.onSelectStart &&
      this.#onSelectStart.push(register.onSelectStart.bind(register));
    register.onSelect && this.#onSelect.push(register.onSelect.bind(register));
    register.onSelectEnd &&
      this.#onSelectEnd.push(register.onSelectEnd.bind(register));

    if (register.onBind && register.onRender) {
      const rootElement = document.createElement("custom");
      const rootSelection = d3.select(rootElement);

      this.#typeRoots.set(register.TYPE, rootSelection);

      this.#ee.on("bind", (data?: BindData) => {
        if (data?.type && data.type !== register.TYPE) return;

        const root = this.#typeRoots.get(register.TYPE);

        if (root == null) {
          throw new Error(`Type not registered: ${register.TYPE.description}`);
        }

        register.onBind!(root, this.state, this.#xScale, this.#yScale);
      });

      this.#ee.on("render", (toHidden = false, clip?: DirtyRect) => {
        const rootSelection = this.#typeRoots.get(register.TYPE);

        if (rootSelection == null) {
          throw new Error(`Type not registered: ${register.TYPE.description}`);
        }

        const context = toHidden ? this.#ctxHidden : this.#ctxHiddenDraw;

        // Renderers share one context, so fillStyle, strokeStyle, lineWidth
        // and globalAlpha would otherwise leak from whichever ran last and
        // make the result depend on registration order.
        context.save();
        try {
          register.onRender!(
            rootSelection,
            context,
            toHidden,
            this.#xScale,
            this.#yScale,
            this.state,
            clip
          );
        } finally {
          context.restore();
        }
      });
    }
  }

  bindData(data: unknown, type: symbol) {
    const color = this.#bindColors.acquire();
    this.#bindMap.set(color, { type, data });
    return numberToRGBString(color);
  }

  /**
   * Give a bind color back. Renderers must call this for every element they
   * remove, otherwise the binding outlives the thing it identified and both
   * the map and the color space grow for the lifetime of the page.
   */
  releaseBindData(color: string) {
    const key = rgbStringToNumber(color);
    if (key === null) return;

    if (this.#bindMap.delete(key)) {
      this.#bindColors.release(key);
    }
  }

  getTargetElement(event: any, force = false) {
    // Mid gesture the hit canvas is not worth rebuilding, and mousemove would
    // otherwise rebuild it on every event: the drag target was latched at the
    // start of the gesture, and hover is only feeding a cursor style.
    const gesture = this.#dragData !== null || this.#selecting;

    if (force || (this.#hiddenDirty && !gesture)) this.redrawHidden();

    // d3.pointer reports CSS pixels but the hit canvas is drawn at device
    // resolution, so the read has to be scaled to match.
    const [x, y] = d3.pointer(event, this.canvas);
    const rgb = this.#ctxHidden.getImageData(
      Math.round(x * this.#dpr),
      Math.round(y * this.#dpr),
      1,
      1
    ).data;

    const bindColor = toBindColor(rgb);
    return this.#bindMap.get(bindColor) ?? null;
  }

  process() {
    this.#emitBind();
    this.redrawHidden();
    this.redraw();
  }

  /** Ask for a full repaint on the next frame. */
  invalidate() {
    const { width, height } = this.state.configuration;
    this.#dirtyRegion = { x0: 0, y0: 0, x1: width, y1: height };
    this.#hiddenDirty = true;
  }

  /**
   * Ask for a repaint of one region on the next frame. Regions accumulate
   * into their bounding box until the paint consumes them.
   */
  invalidateRect(rect: DirtyRect) {
    this.#unionRegion(rect);
    this.#hiddenDirty = true;
  }

  #unionRegion(rect: DirtyRect) {
    const region = this.#dirtyRegion;

    this.#dirtyRegion =
      region === null
        ? { ...rect }
        : {
            x0: Math.min(region.x0, rect.x0),
            y0: Math.min(region.y0, rect.y0),
            x1: Math.max(region.x1, rect.x1),
            y1: Math.max(region.y1, rect.y1),
          };
  }

  /**
   * Runs a bind and decides what it dirtied. A type-filtered bind whose
   * renderer reported every region it changed repaints only those regions;
   * anything else - an unfiltered bind, or a renderer that reports nothing -
   * falls back to repainting the whole render area, so a renderer that has
   * never heard of reporting cannot end up under-painted.
   *
   * `silent` skips the invalidation decision entirely, for callers that
   * already marked what changed - the pan fast path, which dirties only the
   * strip its blit exposed.
   */
  #emitBind(data?: BindData, silent = false) {
    const reports: Array<{ rect: DirtyRect; hitPixels: boolean }> = [];

    // updateState can run inside a bind handler and emit its own bind, so
    // the collector nests instead of clobbering the outer one.
    const previous = this.#bindReports;
    this.#bindReports = reports;

    try {
      this.#ee.emit("bind", data);
    } finally {
      this.#bindReports = previous;
    }

    if (silent) return;

    if (data?.type !== undefined && reports.length > 0) {
      for (const report of reports) {
        this.#unionRegion(report.rect);
        // display-only regions - a hover marker - repaint without forcing
        // the hit canvas to rebuild on the next probe
        if (report.hitPixels) this.#hiddenDirty = true;
      }
    } else {
      this.invalidate();
    }
  }

  /** Handed to renderers so they can report regions during a bind. */
  #reportDirty = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    hitPixels = true
  ) => {
    this.#bindReports?.push({ rect: { x0, y0, x1, y1 }, hitPixels });
  };

  /**
   * Shift the draw buffer sideways by a pan delta and dirty only the strip
   * the shift exposed. The shift is a whole number of device pixels - the
   * same trick the audio summaries use, one level up - so the copy is exact;
   * the sub-pixel remainder is at most half a device pixel of placement
   * error, and the full repaint on the gesture's end heals it.
   *
   * Returns false when the delta is too small to move a whole device pixel
   * (nothing to do - the caller must not repaint, or the sub-pixel move
   * would be paid at full price) or so large nothing survives the shift, in
   * which case a full repaint is the same work and simpler.
   */
  #panShift(deltaCss: number): boolean {
    const { width, height } = this.state.configuration;

    const total = deltaCss + this.#panResidual;
    const deltaDevice = Math.round(total * this.#dpr);

    if (Math.abs(deltaDevice) >= this.#width) {
      this.#panResidual = 0;
      return false;
    }

    // what the shift cannot show this tick is carried into the next one
    this.#panResidual = total - deltaDevice / this.#dpr;

    if (deltaDevice === 0) return true;

    // Copy shifted into the spare buffer, then swap the pair - one copy
    // instead of copy-out-and-back, and no reliance on overlapping
    // self-drawImage behaviour.
    this.#ctxScratch.save();
    this.#ctxScratch.setTransform(1, 0, 0, 1, 0, 0);
    this.#ctxScratch.clearRect(0, 0, this.#width, this.#height);
    this.#ctxScratch.drawImage(this.#hiddenCanvasDraw, deltaDevice, 0);
    this.#ctxScratch.restore();

    [this.#hiddenCanvasDraw, this.#scratchCanvas] = [
      this.#scratchCanvas,
      this.#hiddenCanvasDraw,
    ];
    [this.#ctxHiddenDraw, this.#ctxScratch] = [
      this.#ctxScratch,
      this.#ctxHiddenDraw,
    ];

    const deltaShifted = deltaDevice / this.#dpr;

    // A region already waiting to be painted describes pixels that just
    // moved with the shift - carry it along, or two pans inside one frame
    // leave the first tick's exposed strip stranded at its old coordinates.
    if (this.#dirtyRegion !== null) {
      this.#dirtyRegion.x0 += deltaShifted;
      this.#dirtyRegion.x1 += deltaShifted;
    }

    if (deltaShifted > 0) {
      this.invalidateRect({ x0: 0, y0: 0, x1: deltaShifted, y1: height });
    } else {
      this.invalidateRect({
        x0: width + deltaShifted,
        y0: 0,
        x1: width,
        y1: height,
      });
    }

    return true;
  }

  /**
   * Fraction of the render area the last paint actually repainted, 0..1.
   * Partial redraws are the whole point of region tracking, so this is the
   * number to watch: a drag should score far below 1, a zoom exactly 1.
   */
  #lastPaintFraction = 1;

  redraw() {
    const region = this.#dirtyRegion ?? {
      x0: 0,
      y0: 0,
      x1: this.state.configuration.width,
      y1: this.state.configuration.height,
    };
    this.#dirtyRegion = null;

    const { width, height } = this.state.configuration;

    // Snap the region outward to whole device pixels so the clear, the clip
    // and the final blit all cut on the same texel boundaries.
    const x0 = Math.max(0, Math.floor(region.x0 * this.#dpr) / this.#dpr);
    const y0 = Math.max(0, Math.floor(region.y0 * this.#dpr) / this.#dpr);
    const x1 = Math.min(width, Math.ceil(region.x1 * this.#dpr) / this.#dpr);
    const y1 = Math.min(height, Math.ceil(region.y1 * this.#dpr) / this.#dpr);

    const partial = x0 > 0 || y0 > 0 || x1 < width || y1 < height;

    this.#lastPaintFraction =
      x1 > x0 && y1 > y0
        ? ((x1 - x0) * (y1 - y0)) / (width * height)
        : 0;

    if (x1 > x0 && y1 > y0) {
      // The offscreen context is scaled, so it clears in CSS pixels. Only
      // the dirty region is cleared and repainted; everything outside keeps
      // the pixels it already has.
      this.#ctxHiddenDraw.save();
      this.#ctxHiddenDraw.clearRect(x0, y0, x1 - x0, y1 - y0);

      let clip: DirtyRect | undefined;
      if (partial) {
        const path = new Path2D();
        path.rect(x0, y0, x1 - x0, y1 - y0);
        this.#ctxHiddenDraw.clip(path);
        clip = { x0, y0, x1, y1 };
      }

      this.#ee.emit("render", false, clip);
      this.#ctxHiddenDraw.restore();
    }

    // The visible canvas always receives the full buffer: after a pan blit
    // every pixel of it has moved, and a full-surface copy is one drawImage
    // either way. The visible context is unscaled and works in device pixels.
    this.#ctx.clearRect(0, 0, this.#width, this.#height);
    this.#ctx.drawImage(this.#hiddenCanvasDraw, 0, 0);

    // Drawn after the blit and only onto the visible canvas, so the overlay
    // never reaches the buffer that pan blits shift around; the next paint's
    // blit wipes it. It survives until then, which reads better than a
    // one-frame flash under paint-on-change.
    if (this.state.configuration.showPaintRegions && x1 > x0 && y1 > y0) {
      const dx = Math.round(x0 * this.#dpr);
      const dy = Math.round(y0 * this.#dpr);
      const dw = Math.round((x1 - x0) * this.#dpr);
      const dh = Math.round((y1 - y0) * this.#dpr);
      const edge = Math.max(1, Math.round(this.#dpr));

      this.#ctx.fillStyle = "rgba(255, 0, 255, 0.15)";
      this.#ctx.fillRect(dx, dy, dw, dh);

      // an opaque border, as filled rects so its color reads back exactly
      this.#ctx.fillStyle = "rgb(255, 0, 255)";
      this.#ctx.fillRect(dx, dy, dw, edge);
      this.#ctx.fillRect(dx, dy + dh - edge, dw, edge);
      this.#ctx.fillRect(dx, dy, edge, dh);
      this.#ctx.fillRect(dx + dw - edge, dy, edge, dh);
    }
  }

  redrawHidden() {
    this.#hiddenDirty = false;

    const { width, height } = this.state.configuration;

    this.#ctxHidden.clearRect(0, 0, width, height);
    this.#ee.emit("render", true);
  }

  /**
   * Start painting. Idempotent, so calling it twice will not run two loops.
   */
  run = () => {
    if (this.#raf !== null || this.#destroyed) return;

    const tick = () => {
      // the tick still happens every frame, so a missed invalidate shows up as
      // one late frame rather than a permanently stale canvas
      if (this.#dirtyRegion !== null) this.redraw();
      this.#raf = requestAnimationFrame(tick);
    };

    this.#raf = requestAnimationFrame(tick);
  };

  /** Stop painting without tearing anything down; run() resumes. */
  stop() {
    if (this.#raf === null) return;

    cancelAnimationFrame(this.#raf);
    this.#raf = null;
  }

  /**
   * Resize the render area, keeping the left edge of the view and the current
   * zoom level fixed so that only the amount of visible time changes.
   */
  resize(width: number, height: number) {
    const [startMs, endMs] = this.#xScale.domain();
    const msPerPixel = (endMs - startMs) / this.state.configuration.width;

    this.updateState((state) => {
      state.configuration.width = width;
      state.configuration.height = height;
      return [state, undefined, undefined];
    });

    this.#resizeCanvases();
    this.#setView(startMs, startMs + msPerPixel * width, width);
  }

  /**
   * Detach from the canvas and release everything held. The instance is not
   * reusable afterwards; callers that need one again should construct a new
   * one.
   */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.stop();

    // removes the contextmenu listener registered with this signal
    this.#abort.abort();

    d3.select(this.canvas)
      .on(".drag", null)
      .on(".zoom", null)
      .on("click", null)
      .on("mousemove", null);

    this.#onDestroy.forEach((fn) => fn());

    this.#ee.removeAllListeners();
    this.#bindMap.clear();
    this.#typeRoots.clear();

    this.#onDrag.length = 0;
    this.#onDragStart.length = 0;
    this.#onDragEnd.length = 0;
    this.#onClick.length = 0;
    this.#onMouseOver.length = 0;
    this.#onStateUpdate.length = 0;
    this.#onZoom.length = 0;
    this.#onSelectStart.length = 0;
    this.#onSelect.length = 0;
    this.#onSelectEnd.length = 0;
    this.#onDestroy.length = 0;
    this.#onDiagnostics.length = 0;
  }

  /**
   * Point the view at a time range.
   *
   * The d3 zoom transform is folded back to identity and the range baked into
   * the base scale, because the behaviour keeps its transform on the canvas
   * node: leaving a stale one there means the next wheel event reapplies it on
   * top of the new domain and the view jumps.
   */
  #setView(startMs: number, endMs: number, width: number) {
    this.#xScaleOriginal.domain([startMs, endMs]).range([0, width]);
    this.#xScale = this.#xScaleOriginal.copy();

    d3.select(this.canvas).call(this.#zoom.transform, d3.zoomIdentity);

    this.#emitBind();
  }

  /**
   * Size the backing stores to the device pixel ratio and scale every context
   * so that renderers can keep working in CSS pixels.
   *
   * The offscreen contexts are scaled too, not just the visible one: they are
   * what the renderers actually draw into, so leaving them at 1x renders the
   * waveform at a fraction of the resolution its buffer was allocated for and
   * then upscales it on the blit.
   */
  #resizeCanvases() {
    const config = this.state.configuration;
    const dpr = window.devicePixelRatio || 1;
    const width = config.width;
    const height = config.height;

    this.#dpr = dpr;
    this.#width = Math.round(width * dpr);
    this.#height = Math.round(height * dpr);

    this.canvas.width = this.#width;
    this.canvas.height = this.#height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.#hiddenCanvas = new OffscreenCanvas(this.#width, this.#height);
    this.#hiddenCanvasDraw = new OffscreenCanvas(this.#width, this.#height);
    this.#scratchCanvas = new OffscreenCanvas(this.#width, this.#height);

    // The visible context is only ever used to clear and to blit a buffer of
    // exactly this size, so it stays in device pixels and copies 1:1.
    this.#ctx = this.canvas.getContext("2d")!;
    this.#ctxHiddenDraw = this.#hiddenCanvasDraw.getContext("2d")!;
    this.#ctxScratch = this.#scratchCanvas.getContext("2d")!;
    this.#ctxHidden = this.#hiddenCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    // The scratch buffer gets the same scale as the draw buffer, because the
    // pan fast path swaps the two and renderers keep working in CSS pixels.
    this.#ctxHiddenDraw.scale(dpr, dpr);
    this.#ctxScratch.scale(dpr, dpr);
    this.#ctxHidden.scale(dpr, dpr);

    this.invalidate();
  }
}
