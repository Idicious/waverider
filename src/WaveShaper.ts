import * as d3 from "d3";
import EventEmitter from "eventemitter3";
import { genColor, numberToRGBString, toBindColor } from "./bind";
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

export class WaveShaper {
  #ee = new EventEmitter();

  #drag = d3
    .drag<HTMLCanvasElement, unknown>()
    .filter((event) => !event.metaKey)
    .on("drag.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;

      this.#onDrag.forEach((fn) => {
        const bindData = fn(e, this.#dragData, this.#xScale, this.#yScale);
        bindData && this.#ee.emit("bind", bindData);
      });
    })
    .on("start.drag", (e: d3.D3DragEvent<any, any, any>) => {
      if (e.sourceEvent.shiftKey) return;
      this.#dragData = this.getTargetElement(e, false);

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
      this.redrawHidden();
    })
    .on("drag.select", (e: d3.D3DragEvent<any, any, any>) => {
      if (!e.sourceEvent.shiftKey) return;
      if (!this.#selecting) return;

      this.#selectionEnd = d3.pointer(e, this.canvas);

      this.#onSelect.forEach((fn) => {
        const bindData = fn(
          e,
          this.#selectionStart!,
          this.#selectionEnd!,
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

      this.#onSelectStart.forEach((fn) => {
        const bindData = fn(
          e,
          this.#selectionStart!,
          null,
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
          this.#selectionStart!,
          this.#selectionEnd!,
          this.#xScale,
          this.#yScale
        );
        bindData && this.#ee.emit("bind", bindData);
      });

      this.#selectionStart = null;
      this.#selectionEnd = null;
      this.#selecting = false;
    });

  #zoom = d3
    .zoom<HTMLCanvasElement, unknown>()
    .filter((e) => e.metaKey)
    .scaleExtent([-Infinity, Infinity])
    .translateExtent([
      [0, 0],
      [Infinity, Infinity],
    ])
    .on("zoom", (e: d3.D3ZoomEvent<any, any>) => {
      this.#xScale = e.transform.rescaleX(this.#xScaleOriginal);

      this.#onZoom.forEach((fn) => fn(e));
      this.#ee.emit("bind");
    })
    .on("end", () => {
      this.redrawHidden();
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
  #onDrag: Array<DragFn<any>> = [];
  #onDragStart: Array<DragFn<any>> = [];
  #onDragEnd: Array<DragFn<any>> = [];
  #onClick: Array<ClickFn<any>> = [];
  #onMouseOver: Array<MouseOverFn<any>> = [];
  #onStateUpdate: Array<StateUpdateFn> = [];
  #onZoom: Array<ZoomFn> = [];
  #dragData: BoundData | null = null;
  #width!: number;
  #height!: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly autoContext: AudioContext,
    private state: WaveShaperState
  ) {
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

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
        const target = this.getTargetElement(e, false);

        this.#onClick.forEach((fn) => {
          const bindData = fn(e, target, this.#xScale, this.#yScale);
          bindData && this.#ee.emit("bind", bindData);
        });
      })
      .on("mousemove", (e) => {
        const target = this.getTargetElement(e, false);

        this.#onMouseOver.forEach((fn) => {
          const bindData = fn(e, target, this.#xScale, this.#yScale);
          bindData && this.#ee.emit("bind", bindData);
        });
      });

    this.registerRenderer(
      new IntervalRenderer(
        this.bindData.bind(this),
        this.updateState.bind(this)
      )
    );

    this.registerRenderer(new CursorRenderer(canvas));
    this.registerRenderer(
      new AutomationRenderer(
        canvas,
        this.bindData.bind(this),
        this.updateState.bind(this)
      )
    );

    this.#ee.on("render", () => {
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

  getScaleData() {
    return {
      x: {
        domain: this.#xScale.domain(),
        range: this.#xScale.range(),
      },
      y: {
        domain: this.#yScale.domain(),
        range: this.#yScale.range(),
      },
    };
  }

  /**
   * Zoom to given level and scroll position
   * @param samplesPerPixel Zoom level in terms of samples per pixel
   * @param scrollPositionInMs Left bound of the view in milliseconds
   */
  zoom(samplesPerPixel: number, scrollPositionInMs: number) {
    this.#xScaleOriginal.domain(
      getDomainInMs(
        scrollPositionInMs,
        samplesPerPixel,
        this.autoContext.sampleRate,
        this.state.configuration.width
      )
    );
    this.#xScale = this.#xScaleOriginal.copy();

    this.#ee.emit("bind");
    this.redrawHidden();
  }

  updateState(fn: UpdateFn<WaveShaperState>, initialize = false) {
    const [state, bindData, cb] = fn(this.state);
    this.state = state;
    initialize && this.initialize(state);

    this.#ee.emit("bind", bindData);
    this.redrawHidden();

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

        register.onRender!(
          rootSelection,
          context,
          toHidden,
          this.#xScale,
          this.#yScale,
          this.state
        );
      });
    }
  }

  bindData(data: unknown, type: symbol) {
    const color = genColor();
    this.#bindMap.set(color, { type, data });
    return numberToRGBString(color);
  }

  getTargetElement(event: any, redraw = true) {
    redraw && this.redrawHidden();

    const [x, y] = d3.pointer(event, this.canvas);
    const rgb = this.#ctxHidden.getImageData(x, y, 1, 1).data;
    const bindColor = toBindColor(rgb);
    return this.#bindMap.get(bindColor) ?? null;
  }

  process() {
    this.#ee.emit("bind");
    this.redrawHidden();
    this.redraw();
  }

  redraw() {
    this.#ctxHiddenDraw.clearRect(0, 0, this.#width, this.#height);
    this.#ctx.clearRect(0, 0, this.#width, this.#height);

    this.#ee.emit("render");
    this.#ctx.drawImage(this.#hiddenCanvasDraw, 0, 0);
  }

  redrawHidden() {
    this.#ctxHidden.clearRect(0, 0, this.#width, this.#height);
    this.#ee.emit("render", true);
  }

  run = () => {
    this.redraw();
    requestAnimationFrame(this.run);
  };

  initialize(state: WaveShaperState) {
    const config = state.configuration;
    const dpr = window.devicePixelRatio;
    const width = config.width;
    const height = config.height;

    this.#width = width * dpr;
    this.#height = height * dpr;

    this.canvas.width = this.#width;
    this.canvas.height = this.#height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.#hiddenCanvas = new OffscreenCanvas(this.#width, this.#height);
    this.#hiddenCanvasDraw = new OffscreenCanvas(this.#width, this.#height);

    this.#ctx = this.canvas.getContext("2d")!;
    this.#ctxHiddenDraw = this.#hiddenCanvasDraw.getContext("2d")!;
    this.#ctxHidden = this.#hiddenCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    this.#ctx.scale(dpr, dpr);
  }
}
