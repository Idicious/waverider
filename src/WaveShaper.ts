import * as d3 from "d3";
import EventEmitter from "eventemitter3";
import {
  COLOR_TOLERANCE,
  genColor,
  numberToRGBString,
  rgbToNumber,
  roundToClosestMultipleOf,
} from "./bind";
import type {
  BindData,
  BoundData,
  ClickFn,
  DragFn,
  MouseOverFn,
  RegisterableType,
  UpdateFn,
  WaveShaperState,
} from "./types";
import { IntervalRenderer } from "./register/interval";

export const DEFAULT_TIME_DOMAIN = [0, 30000];
export const TRACK_HEIGHT = 100;
export const ALWAYS = () => true;

export class WaveShaper {
  #ee = new EventEmitter();
  #drag = d3
    .drag<HTMLCanvasElement, unknown>()
    .on("drag", (event: d3.D3DragEvent<any, any, any>) => {
      if (this.#dragData != null) {
        const drag = this.#dragMap.get(this.#dragData.type);

        if (drag == null) return;
        const bindData = drag(
          event,
          this.#dragData.data,
          this.#xScale,
          this.#yScale
        );
        bindData && this.#ee.emit("bind", bindData);
      }
    })
    .on("start", (event: d3.D3DragEvent<any, any, any>) => {
      const target = this.getTargetElement(event);
      if (target != null && this.#draggableSet.has(target.type)) {
        this.#dragData = target;

        const dragStart = this.#dragStartMap.get(this.#dragData.type);

        if (dragStart != null) {
          const bindData = dragStart(
            event,
            this.#dragData.data,
            this.#xScale,
            this.#yScale
          );
          bindData && this.#ee.emit("bind", bindData);
        }
      }
    })
    .on("end", (event: d3.D3DragEvent<any, any, any>) => {
      if (this.#dragData == null) return;
      const dragEnd = this.#dragEndMap.get(this.#dragData.type);

      if (dragEnd != null) {
        const bindData = dragEnd(
          event,
          this.#dragData.data,
          this.#xScale,
          this.#yScale
        );
        bindData && this.#ee.emit("bind", bindData);
      }

      this.#dragData = null;
      this.redrawHidden();
    });

  #zoom = d3
    .zoom<HTMLCanvasElement, unknown>()
    .filter((e) => e.metaKey)
    .on("zoom", (e: d3.D3ZoomEvent<any, any>) => {
      this.#xScale = e.transform.rescaleX(this.#xScaleOriginal);
      this.#ee.emit("bind");
    })
    .on("end", () => {
      this.redrawHidden();
    });

  #xScaleOriginal: d3.ScaleLinear<number, number>;
  #xScale: d3.ScaleLinear<number, number>;

  #yScale: d3.ScaleBand<string>;

  #hiddenCanvas: OffscreenCanvas;

  // canvas contexts
  #ctxHidden: OffscreenCanvasRenderingContext2D;
  #ctx: CanvasRenderingContext2D;

  #typeRoots = new Map<string, d3.Selection<HTMLElement, any, any, any>>();
  #bindMap = new Map<number, { type: string; data: unknown }>();
  #draggableSet = new Set<string>();
  #dragStartSet = new Set<string>();
  #dragEndSet = new Set<string>();
  #clickableSet = new Set<string>();
  #mouseOverSet = new Set<string>();
  #dragMap = new Map<string, DragFn<any>>();
  #dragStartMap = new Map<string, DragFn<any>>();
  #dragEndMap = new Map<string, DragFn<any>>();
  #clickMap = new Map<string, ClickFn<any>>();
  #mouseOverMap = new Map<string, MouseOverFn<any>>();
  #dragData: BoundData | null = null;
  #mouseOver: MouseOverFn<BindData | undefined>[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly trackHeight: number,
    private readonly canvas: HTMLCanvasElement,
    private state: WaveShaperState
  ) {
    canvas.width = width;
    canvas.height = height;

    this.#hiddenCanvas = new OffscreenCanvas(this.width, this.height);
    this.#ctx = this.canvas.getContext("2d")!;
    this.#ctxHidden = this.#hiddenCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;

    this.#yScale = d3
      .scaleBand()
      .domain(d3.map(state.tracks, (d) => d.id))
      .range([0, this.trackHeight * state.tracks.length]);

    this.#xScaleOriginal = d3
      .scaleLinear()
      .domain(DEFAULT_TIME_DOMAIN)
      .range([0, this.width]);
    this.#xScale = this.#xScaleOriginal.copy();

    d3.select(canvas)
      .call(this.#drag)
      .call(this.#zoom)
      .on("click", (e) => {
        const target = this.getTargetElement(e);
        if (target == null) return;

        const click = this.#clickMap.get(target.type);
        if (click == null) return;

        const bindData = click(e, target.data, this.#xScale, this.#yScale);
        bindData && this.#ee.emit("bind", bindData);
      })
      .on("mousemove", (e) => {
        const target = this.getTargetElement(e, false);

        if (target?.type === "interval") {
          console.log(target);
        }

        this.#mouseOver.forEach((fn) => {
          const bindData = fn(e, target, this.#xScale, this.#yScale);
          bindData && this.#ee.emit("bind", bindData);
        });

        if (target == null) return;
        const mouseOver = this.#mouseOverMap.get(target.type);
        if (mouseOver == null) return;

        const bindData = mouseOver(e, target.data, this.#xScale, this.#yScale);
        bindData && this.#ee.emit("bind", bindData);
      });

    this.registerType(
      new IntervalRenderer(
        this.bindData.bind(this),
        this.updateState.bind(this),
        this.canvas
      )
    );
  }

  updateState(fn: UpdateFn<WaveShaperState>) {
    const [state, bindData] = fn(this.state);
    this.state = state;

    this.#ee.emit("bind", bindData);
    this.redrawHidden();
  }

  registerType<TCollection extends Array<TItem>, TItem>(
    register: RegisterableType<WaveShaperState, TCollection, TItem>
  ) {
    if (this.#typeRoots.has(register.type))
      throw new Error(`Type already registered: ${register.type}`);

    register.dragMap.forEach((value, key) => {
      this.#draggableSet.add(key);
      this.#dragMap.set(key, value);
    });

    register.dragStartMap.forEach((value, key) => {
      this.#dragStartSet.add(key);
      this.#dragStartMap.set(key, value);
    });

    register.dragEndMap.forEach((value, key) => {
      this.#dragEndSet.add(key);
      this.#dragEndMap.set(key, value);
    });

    register.clickMap.forEach((value, key) => {
      this.#clickableSet.add(key);
      this.#clickMap.set(key, value);
    });

    register.mouseOverMap.forEach((value, key) => {
      if (key === "*") {
        this.#mouseOver.push(value as any);
      } else {
        this.#mouseOverSet.add(key);
        this.#mouseOverMap.set(key, value);
      }
    });

    const rootElement = document.createElement("custom");
    const rootSelection = d3.select(rootElement);

    this.#typeRoots.set(register.type, rootSelection);

    this.#ee.on("bind", (data?: BindData) => {
      if (data?.type && data.type !== register.type) return;

      const root = this.#typeRoots.get(register.type);
      if (root == null)
        throw new Error(`Type not registered: ${register.type}`);

      const selection = root
        .selectAll(`custom.${register.type}`)
        .data(register.stateSelector(this.state), register.keyFn as any);

      register.bind(
        selection,
        this.#xScale,
        this.#yScale,
        data?.filterFn ?? ALWAYS
      );
    });

    this.#ee.on("render", (toHidden = false) => {
      const rootSelection = this.#typeRoots.get(register.type);
      if (rootSelection == null)
        throw new Error(`Type not registered: ${register.type}`);

      const context = toHidden ? this.#ctxHidden : this.#ctx;

      register.render(
        rootSelection.selectAll(`custom.${register.type}`),
        context,
        toHidden
      );
    });
  }

  bindData(data: unknown, type: string) {
    const color = genColor();
    this.#bindMap.set(color, { type, data });
    return numberToRGBString(color);
  }

  getTargetElement(event: any, redraw = true) {
    redraw && this.redrawHidden();

    const [x, y] = d3.pointer(event);
    const color = this.#ctxHidden.getImageData(x, y, 1, 1).data;
    const uniqueColor = roundToClosestMultipleOf(
      rgbToNumber(color),
      COLOR_TOLERANCE
    );
    return this.#bindMap.get(uniqueColor);
  }

  process() {
    this.#ee.emit("bind");
    this.redrawHidden();
    this.redraw();
  }

  redraw() {
    this.#ctx.clearRect(0, 0, this.width, this.height);
    this.#ee.emit("render");
  }

  redrawHidden() {
    this.#ctxHidden.clearRect(0, 0, this.width, this.height);
    this.#ee.emit("render", true);
  }

  run = () => {
    this.redraw();
    requestAnimationFrame(this.run);
  };
}
