import type { ScaleLinear, ScaleBand } from "d3";
import * as d3 from "d3";
import {
  Automation,
  AutomationData,
  AutomationPoint,
  Selection,
  BoundData,
  Predicate,
  Renderer,
  UpdateFn,
  WaveShaperState,
} from "../types";
import { BIND_ATTR } from "../bind";
import { ALWAYS, getDrawValue, invertYScale } from "../utils";

export const AUTOMATION_HANDLE_RADIUS = 5;

export const TYPES = {
  AUTOMATION: Symbol("automation-group"),
  AUTOMATION_POINT: Symbol("automation-point"),
} as const;

type AutomationBindData = {
  automation: string;
  automationData: string;
  track: string;
  point: AutomationPoint;
};

export class AutomationRenderer implements Renderer {
  #automationMap = new Map<string, Automation>();
  #automationPointMap = new Map<string, AutomationPoint>();
  #automationDataMap = new Map<string, AutomationData>();
  #filterFn: Predicate = ALWAYS;
  #hoverX: number | null = null;
  #hoverY: number | null = null;
  #selectedSet = new Set<string>();
  #selectedOffsets = new Map<
    string,
    {
      offsetX: number;
      offsetY: number;
    }
  >();
  #selectedTrack: string | null = null;

  TYPE = Symbol("automation");

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly bindFn: (data: unknown, type: symbol) => string,
    private readonly updateState: (fn: UpdateFn<WaveShaperState>) => void
  ) {}

  onSelectStart(
    e: d3.D3DragEvent<any, any, any>,
    selection: Selection,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ) {
    this.#selectedTrack = invertYScale(yScale, selection.y1);
  }

  onSelect(
    e: d3.D3DragEvent<any, any, any>,
    selection: Selection,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ) {
    if (!this.#selectedTrack) return;

    const automationData = this.#automationDataMap.get(this.#selectedTrack);
    if (!automationData) return;

    for (const point of automationData.points) {
      const { x, y } = getPointPosition(
        automationData.track,
        point.time,
        point.value,
        xScale,
        yScale
      );

      if (
        x >= selection.x1 &&
        x <= selection.x2 &&
        y >= selection.y1 &&
        y <= selection.y2
      ) {
        this.#selectedSet.add(point.id);
      } else {
        this.#selectedSet.delete(point.id);
      }
    }
  }

  onStateUpdate(state: WaveShaperState): void {
    this.#automationMap.clear();
    this.#automationDataMap.clear();
    this.#automationPointMap.clear();

    for (const automation of state.automation) {
      this.#automationMap.set(automation.id, automation);
    }

    for (const automationData of state.automationData) {
      this.#automationDataMap.set(automationData.id, automationData);
    }

    for (const point of state.automationData.flatMap((data) => data.points)) {
      this.#automationPointMap.set(point.id, point);
    }
  }

  onDragStart(
    _e: d3.D3DragEvent<any, any, any>,
    d: BoundData | null,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ) {
    switch (d?.type) {
      case TYPES.AUTOMATION_POINT: {
        this.#filterFn = (data: AutomationBindData) =>
          data.automationData === d.data.automationData;

        if (this.hasSelection) {
          this.setDragOffsets(d.data, xScale, yScale);
        }

        break;
      }
      case TYPES.AUTOMATION: {
        this.#filterFn = (data: AutomationData) => data.id === d.data.id;
        break;
      }
    }
  }

  onDragEnd(_e: d3.D3DragEvent<any, any, any>, d: BoundData | null) {
    switch (d?.type) {
      case TYPES.AUTOMATION_POINT:
      case TYPES.AUTOMATION: {
        this.#filterFn = ALWAYS;
        break;
      }
    }
  }

  onDrag(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<AutomationBindData> | null,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) {
    switch (d?.type) {
      case TYPES.AUTOMATION_POINT: {
        if (!this.hasSelection) {
          this.onDragAutomationPoint(e, d, xScale, yScale);
        } else {
          this.#selectedSet.forEach((id) => {
            const data = this.#automationDataMap.get(d.data.automationData)!;
            const point = this.#automationPointMap.get(id)!;

            this.onDragAutomationPoint(
              e,
              {
                type: TYPES.AUTOMATION_POINT,
                data: {
                  automation: data.automation,
                  automationData: data.id,
                  track: data.track,
                  point,
                },
              },
              xScale,
              yScale
            );
          });
        }
        break;
      }
    }

    return { type: this.TYPE };
  }

  onClick(
    e: MouseEvent,
    d: BoundData | null,
    xScale: ScaleLinear<number, number>
  ) {
    this.clearSelection();

    switch (d?.type) {
      case TYPES.AUTOMATION: {
        this.updateState((state) => {
          this.onClickAutomation(e, d, xScale);
          return [state, { type: this.TYPE }, undefined];
        });
        break;
      }
    }
  }

  onMouseOver(
    e: MouseEvent,
    d: BoundData | null,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ) {
    switch (d?.type) {
      case TYPES.AUTOMATION:
      case TYPES.AUTOMATION_POINT: {
        this.#hoverX = d3.pointer(e, this.canvas)[0];
        this.#hoverY = yScale(d.data.track)!;
        break;
      }
      default: {
        this.#hoverX = null;
        this.#hoverY = null;
      }
    }
  }

  onBind(
    selection: d3.Selection<any, any, any, any>,
    state: WaveShaperState,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ): void {
    const trackHeight = yScale.bandwidth();
    const points = state.automationData.flatMap((d) =>
      d.points.map((p) => ({
        automationData: d.id,
        automation: d.automation,
        track: d.track,
        point: p,
      }))
    );

    selection
      .selectAll<Element, AutomationData>(
        `custom.${TYPES.AUTOMATION.description}`
      )
      .data(state.automationData, (d) => d.id)
      .join(
        (enter) => {
          return enter
            .append("custom")
            .attr("class", TYPES.AUTOMATION.description!)
            .attr("y", (d) => yScale(d.track)!)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.AUTOMATION))
            .each((d) => d.points.sort((a, b) => a.time - b.time));
        },
        (update) => {
          return update
            .filter(this.#filterFn)
            .attr("y", (d) => yScale(d.track)!)
            .each((d) => d.points.sort((a, b) => a.time - b.time));
        },
        (remove) => remove.remove()
      );

    selection
      .selectAll<Element, AutomationBindData>(
        `custom.${TYPES.AUTOMATION_POINT.description}`
      )
      .data(points, (d) => d.point.id)
      .join(
        (enter) => {
          return enter
            .append("custom")
            .attr("class", TYPES.AUTOMATION_POINT.description!)
            .attr(BIND_ATTR, (d) => this.bindFn(d, TYPES.AUTOMATION_POINT))
            .attr("r", AUTOMATION_HANDLE_RADIUS)
            .attr("x", (d) => xScale(d.point.time))
            .attr("fill", "purple")
            .attr("y", (d) => {
              return yScale(d.track)! + (1 - d.point.value) * trackHeight;
            });
        },
        (update) => {
          return update
            .filter((d) => this.#filterFn(d))
            .attr("x", (d) => xScale(d.point.time))
            .attr("y", (d) => {
              return yScale(d.track)! + (1 - d.point.value) * trackHeight;
            });
        },
        (remove) => remove.remove()
      );
  }

  onRender(
    selection: d3.Selection<any, any, any, any>,
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    toHidden: boolean,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>,
    state: WaveShaperState
  ): void {
    if (!state.configuration.showAutomation) return;

    const that = this;
    const trackHeight = yScale.bandwidth();

    selection
      .selectAll<any, AutomationData>(`custom.${TYPES.AUTOMATION.description}`)
      .each(function (d) {
        const node = d3.select(this);

        const uniqueColor = node.attr(BIND_ATTR);

        const fillColor = toHidden ? uniqueColor : "rgba(0,0,0,0.2)";
        const yStart = +node.attr("y");

        ctx.fillStyle = fillColor;
        ctx.fillRect(0, yStart, ctx.canvas.width, trackHeight);

        if (toHidden) return;

        const automation = that.#automationMap.get(d.automation)!;

        ctx.strokeStyle = "black";
        ctx.beginPath();
        // start at origin
        ctx.moveTo(0, yStart + trackHeight * automation.origin);

        // draw lines between automation points
        for (const point of d.points) {
          const x = xScale(point.time);
          const y = yStart + trackHeight * (1 - point.value);
          ctx.lineTo(x, y);
        }

        // end at value of last point
        ctx.lineTo(
          ctx.canvas.width,
          yStart + trackHeight * (1 - d.points[d.points.length - 1].value)
        );
        ctx.stroke();
      });

    selection
      .selectAll<any, AutomationBindData>(
        `custom.${TYPES.AUTOMATION_POINT.description}`
      )
      .each(function (d) {
        const node = d3.select(this);

        const uniqueColor = node.attr(BIND_ATTR);
        const selected = that.#selectedSet.has(d.point.id);
        const fillColor = toHidden
          ? uniqueColor
          : selected
          ? "red"
          : node.attr("fill");

        const x = getDrawValue(+node.attr("x"), toHidden);
        const y = getDrawValue(+node.attr("y"), toHidden);
        const r = getDrawValue(+node.attr("r"), toHidden);

        ctx.fillStyle = fillColor;

        if (toHidden) {
          // draw rect to hidden
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        } else {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fill();
        }
      });

    if (this.#hoverX && this.#hoverY && !toHidden) {
      ctx.fillStyle = "black";
      ctx.fillRect(this.#hoverX, this.#hoverY, 1, trackHeight);
    }
  }

  onDragAutomationPoint(
    e: d3.D3DragEvent<any, any, any>,
    d: BoundData<AutomationBindData>,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleBand<string>
  ) {
    const [x, y] = d3.pointer(e, this.canvas);

    const automationData = this.#automationDataMap.get(d.data.automationData)!;
    const automation = this.#automationMap.get(d.data.automation)!;
    const offsets = this.#selectedOffsets.get(d.data.point.id);
    const offsetX = offsets?.offsetX ?? 0;
    const offsetY = offsets?.offsetY ?? 0;

    const point = d.data.point;

    const time = xScale.invert(x + offsetX);
    const trackYStart = yScale(automationData.track)!;
    const valueInTrack = y - trackYStart + offsetY;

    const value = closestMultipleOf(
      1 - valueInTrack / yScale.bandwidth(),
      automation.step
    );

    const index = automationData.points.indexOf(point);
    const previousPoint = automationData.points[index - 1];
    const nextPoint = automationData.points[index + 1];
    const dataPoint = automationData.points[index];

    dataPoint.value = Math.min(1, Math.max(0, value));

    if (index === 0 && time < 0) {
      dataPoint.time = 0;
    } else if (previousPoint && time < previousPoint.time) {
      dataPoint.time = previousPoint.time;
    } else if (nextPoint && time > nextPoint.time) {
      dataPoint.time = nextPoint.time;
    } else {
      dataPoint.time = time;
    }
  }

  onClickAutomation(
    e: MouseEvent,
    d: BoundData<AutomationData>,
    xScale: ScaleLinear<number, number>
  ) {
    if (e.metaKey) {
      const [x] = d3.pointer(e, this.canvas);
      const time = xScale.invert(x);

      const automation = this.#automationMap.get(d.data.automation)!;
      addAutomationPointAt(d.data.points, automation, time);
    }
  }

  private clearSelection() {
    this.#selectedOffsets.clear();
    this.#selectedSet.clear();
    this.#selectedTrack = null;
  }

  private get hasSelection() {
    return this.#selectedSet.size > 0;
  }

  private setDragOffsets(
    data: AutomationBindData,
    xScale: ScaleLinear<number, number>,
    yScale: ScaleBand<string>
  ) {
    const { x, y } = getPointPosition(
      data.track,
      data.point.time,
      data.point.value,
      xScale,
      yScale
    );

    this.#selectedSet.forEach((_, key) => {
      const p = this.#automationPointMap.get(key)!;
      const { x: pX, y: pY } = getPointPosition(
        data.track,
        p.time,
        p.value,
        xScale,
        yScale
      );

      const offsetX = pX - x;
      const offsetY = pY - y;

      this.#selectedOffsets.set(p.id, { offsetX, offsetY });
    });
  }
}

function addAutomationPointAt(
  values: Array<AutomationPoint>,
  automation: Automation,
  time: number
) {
  const previous = values.findLast((v) => v.time < time);
  const next = values.find((v) => v.time > time);

  let value: number;
  if (previous && next) {
    value = lerp(
      previous.value,
      next.value,
      (time - previous.time) / (next.time - previous.time)
    );
  } else if (previous) {
    value = previous.value;
  } else if (next) {
    value = next.value;
  } else {
    value = automation.origin;
  }

  values.push({
    id: crypto.randomUUID(),
    value: closestMultipleOf(value, automation.step),
    time,
  });
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function closestMultipleOf(value: number, multiple: number) {
  return Math.round(value / multiple) * multiple;
}

function getPointPosition(
  track: string,
  time: number,
  value: number,
  xScale: ScaleLinear<number, number>,
  yScale: ScaleBand<string>
) {
  const x = xScale(time);
  const y = yScale(track)! + (1 - value) * yScale.bandwidth();

  return { x, y };
}
