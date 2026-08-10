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
   * when something has actually changed. Every mutation ends in a "bind"
   * emit, which is where these get raised; the selection rectangle is the one
   * exception and marks itself.
   */
  #dirty = true;
  #hiddenDirty = true;

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
        bindData && this.#ee.emit("bind", bindData);
      });
    })
    .on("start.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;
      this.#dragData = this.getTargetElement(e);

      this.#onDragStart.forEach((fn) => {
        const bindData = fn(e, this.#dragData, this.#xScale, this.#yScale);
        bindData && this.#ee.emit("bind", bindData);
      });
    })
    .on("end.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;

      this.#onDragEnd.forEach((fn) => {
        const bindData = fn(e, this.#dragData, this.#xScale, this.#yScale);
        bindData && this.#ee.emit("bind", bindData);
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
        bindData && this.#ee.emit("bind", bindData);
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

        bindData && this.#ee.emit("bind", bindData);
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
        bindData && this.#ee.emit("bind", bindData);
      });

      this.#selectionStart = null;
      this.#selectionEnd = null;
      this.#selecting = false;
      this.invalidate();
    });

  #zoom = d3
    .zoom<HTMLCanvasElement, unknown>()
    .filter((e) => this.#hasModifier(e))
    // A non-positive scale factor would mirror or collapse the view; there is
    // no upper bound worth imposing, the audio just runs out.
    .scaleExtent([Number.MIN_VALUE, Infinity])
    .translateExtent([
      [0, 0],
      [Infinity, Infinity],
    ])
    .on("zoom", (e: d3.D3ZoomEvent<any, any>) => {
      this.#xScale = e.transform.rescaleX(this.#xScaleOriginal);

      this.#onZoom.forEach((fn) => fn(e));
      this.#ee.emit("bind");
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

  // canvas contexts
  #ctxHidden!: OffscreenCanvasRenderingContext2D;
  #ctxHiddenDraw!: OffscreenCanvasRenderingContext2D;
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

    // every path that changes what is on screen ends up emitting this
    this.#ee.on("bind", () => this.invalidate());

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
          bindData && this.#ee.emit("bind", bindData);
        });
      })
      .on("mousemove", (e) => {
        const target = this.getTargetElement(e);

        this.#onMouseOver.forEach((fn) => {
          const bindData = fn(e, target, this.#xScale, this.#yScale);
          bindData && this.#ee.emit("bind", bindData);
        });
      });

    this.registerRenderer(
      new IntervalRenderer(
        this.bindData.bind(this),
        this.releaseBindData.bind(this),
        this.updateState.bind(this),
        this.#hasModifier,
        () => this.#dpr,
        this.autoContext.sampleRate
      )
    );

    this.registerRenderer(new CursorRenderer(canvas));
    this.registerRenderer(
      new AutomationRenderer(
        canvas,
        this.bindData.bind(this),
        this.releaseBindData.bind(this),
        this.updateState.bind(this),
        this.#hasModifier
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

    this.#ee.emit("bind", bindData);

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

      this.#ee.on("render", (toHidden = false) => {
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
            this.state
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
    this.#ee.emit("bind");
    this.redrawHidden();
    this.redraw();
  }

  /** Ask for a repaint on the next frame. */
  invalidate() {
    this.#dirty = true;
    this.#hiddenDirty = true;
  }

  redraw() {
    this.#dirty = false;

    // The offscreen contexts are scaled, so they clear in CSS pixels; the
    // visible one is not, and clears its backing store directly.
    const { width, height } = this.state.configuration;

    this.#ctxHiddenDraw.clearRect(0, 0, width, height);
    this.#ctx.clearRect(0, 0, this.#width, this.#height);

    this.#ee.emit("render");
    this.#ctx.drawImage(this.#hiddenCanvasDraw, 0, 0);
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
      if (this.#dirty) this.redraw();
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

    this.#ee.emit("bind");
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

    // The visible context is only ever used to clear and to blit a buffer of
    // exactly this size, so it stays in device pixels and copies 1:1.
    this.#ctx = this.canvas.getContext("2d")!;
    this.#ctxHiddenDraw = this.#hiddenCanvasDraw.getContext("2d")!;
    this.#ctxHidden = this.#hiddenCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    this.#ctxHiddenDraw.scale(dpr, dpr);
    this.#ctxHidden.scale(dpr, dpr);

    this.invalidate();
  }
}
